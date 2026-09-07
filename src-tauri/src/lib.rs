use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::blocking::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Manager, RunEvent, State};
use uuid::Uuid;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const NOTICE_VERSION: &str = "2026-09-04-v1";
const CREATE_NO_WINDOW: u32 = 0x08000000;
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(30);
const FFMPEG_DOWNLOAD_URLS: [&str; 2] = [
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
];

#[derive(Default)]
pub struct RuntimeState {
    process: Mutex<Option<ManagedProcess>>,
}

struct ManagedProcess {
    child: Child,
    pid: u32,
    started_at: SystemTime,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PortablePaths {
    root: String,
    data: String,
    voices: String,
    favorites: String,
    history: String,
    temp: String,
    models: String,
    logs: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ComponentStatus {
    id: String,
    label: String,
    installed: bool,
    required: bool,
    detail: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EnvironmentInfo {
    windows: String,
    architecture: String,
    cpu: String,
    gpu: String,
    cuda_available: bool,
    python: String,
    uv: String,
    ffmpeg: String,
    free_space_gb: Option<f64>,
    writable: bool,
    irodori_root: String,
    server_root: String,
    components: Vec<ComponentStatus>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppState {
    setup_required: bool,
    notice_version: String,
    notice_acknowledged_at: Option<String>,
    paths: PortablePaths,
    environment: EnvironmentInfo,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SetupRecord {
    notice_version: String,
    notice_acknowledged_at: Option<String>,
    install_step: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TtsConfig {
    server_root: String,
    irodori_root: String,
    python_path: String,
    voices_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    portable_root: Option<String>,
    server_url: String,
    port: u16,
    api_key: String,
    model: String,
    model_revision: String,
    default_voice: String,
    speed: f32,
    num_steps: u32,
    cfg_scale_text: f32,
    cfg_scale_speaker: f32,
    seed: Option<i64>,
    model_precision: String,
    codec_precision: String,
    model_device: String,
    codec_device: String,
    schedule: String,
    sway_coefficient: f32,
    auto_start: bool,
    stop_on_exit: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsStatus {
    healthy: bool,
    running: bool,
    owned_by_studio: bool,
    pid: Option<u32>,
    port: u16,
    model_loaded: bool,
    message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Voice {
    id: String,
    name: String,
    icon_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_data_url: Option<String>,
    caption: String,
    voice_design: String,
    references: Vec<String>,
    updated_at: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VoiceDraft {
    id: Option<String>,
    name: String,
    icon_path: Option<String>,
    caption: String,
    voice_design: String,
    references: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Upload {
    name: String,
    data: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Generation {
    id: String,
    audio_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    audio_base64: Option<String>,
    text: String,
    voice_id: Option<String>,
    voice_name: String,
    emojis: Vec<String>,
    caption: String,
    seed: Option<i64>,
    preset: String,
    model: String,
    model_revision: String,
    created_at: String,
    is_favorite: bool,
    exists: bool,
    duration_seconds: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallResult {
    component: String,
    installed: bool,
    message: String,
    path: String,
}

#[derive(Debug, PartialEq, Eq)]
struct HfCheckpointSource {
    repo_id: String,
    subfolder: Option<String>,
}

fn split_hf_checkpoint_source(source: &str) -> Result<HfCheckpointSource, String> {
    let raw = source.trim().trim_matches('/');
    if raw.is_empty() {
        return Err("音声モデルの指定が空です。".to_string());
    }

    let parts = raw.split('/').collect::<Vec<_>>();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(format!("音声モデルの指定が正しくありません: {source}"));
    }

    match parts.as_slice() {
        [owner, repository] => Ok(HfCheckpointSource {
            repo_id: format!("{owner}/{repository}"),
            subfolder: None,
        }),
        [owner, repository, subfolder] => Ok(HfCheckpointSource {
            repo_id: format!("{owner}/{repository}"),
            subfolder: Some((*subfolder).to_string()),
        }),
        _ => Err(format!(
            "音声モデルは owner/repository または owner/repository/variant の形式で指定してください: {source}"
        )),
    }
}

fn app_root() -> Result<PathBuf, String> {
    env::current_exe()
        .map_err(|error| format!("アプリの場所を取得できない: {error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "アプリの親フォルダを取得できない".to_string())
}

fn portable_paths() -> Result<PortablePaths, String> {
    let root = app_root()?;
    Ok(PortablePaths {
        data: root.join("data").to_string_lossy().into_owned(),
        voices: root
            .join("data")
            .join("voices")
            .to_string_lossy()
            .into_owned(),
        favorites: root
            .join("data")
            .join("favorites")
            .to_string_lossy()
            .into_owned(),
        history: root
            .join("data")
            .join("history")
            .to_string_lossy()
            .into_owned(),
        temp: root
            .join("data")
            .join("temp")
            .to_string_lossy()
            .into_owned(),
        models: root.join("models").to_string_lossy().into_owned(),
        logs: root
            .join("data")
            .join("logs")
            .to_string_lossy()
            .into_owned(),
        root: root.to_string_lossy().into_owned(),
    })
}

fn paths_as_path() -> Result<(PathBuf, PortablePaths), String> {
    let root = app_root()?;
    let paths = portable_paths()?;
    Ok((root, paths))
}

fn ensure_directories() -> Result<PortablePaths, String> {
    let (root, paths) = paths_as_path()?;
    for path in [
        root.join("runtime"),
        root.join("irodori"),
        root.join("server"),
        root.join("models"),
        root.join("licenses"),
        PathBuf::from(&paths.data),
        PathBuf::from(&paths.voices),
        PathBuf::from(&paths.favorites),
        PathBuf::from(&paths.history),
        PathBuf::from(&paths.temp),
        PathBuf::from(&paths.logs),
    ] {
        fs::create_dir_all(&path)
            .map_err(|error| format!("フォルダを作れない {}: {error}", path.display()))?;
    }
    repair_portable_venv(&root);
    Ok(paths)
}

fn json_path(paths: &PortablePaths, file: &str) -> PathBuf {
    PathBuf::from(&paths.data).join(file)
}

fn load_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)
        .map_err(|error| format!("{}を読めない: {error}", path.display()))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("{}の形式が壊れている: {error}", path.display()))
}

fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp = path.with_extension("tmp");
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&temp, text).map_err(|error| error.to_string())?;
    fs::rename(&temp, path).map_err(|error| error.to_string())
}

fn iso_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("unix:{seconds}")
}

fn path_is_within(path: &Path, parent: &Path) -> bool {
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    let Ok(parent) = parent.canonicalize() else {
        return false;
    };
    path.starts_with(parent)
}

fn safe_file_name(value: &str) -> String {
    let stem = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio.wav");
    let sanitized: String = stem
        .chars()
        .map(|ch| {
            if "<>:\"/\\|?*".contains(ch) || ch.is_control() {
                '_'
            } else {
                ch
            }
        })
        .collect();
    if sanitized.is_empty() {
        "audio.wav".to_string()
    } else {
        sanitized
    }
}

fn normalized_path_text(value: &str) -> String {
    value
        .trim()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn relative_to_portable_root(value: &str, root: &Path) -> Option<String> {
    if !Path::new(value).is_absolute() {
        return None;
    }
    let value_text = normalized_path_text(value);
    let root_text = normalized_path_text(root.to_string_lossy().as_ref());
    if value_text == root_text {
        return Some(String::new());
    }
    value_text
        .strip_prefix(&(root_text + "\\"))
        .map(str::to_string)
}

fn rebase_path(value: &mut String, old_root: &Path, new_root: &Path) -> bool {
    let Some(relative) = relative_to_portable_root(value, old_root) else {
        return false;
    };
    let next = if relative.is_empty() {
        new_root.to_path_buf()
    } else {
        new_root.join(relative)
    };
    let next = next.to_string_lossy().into_owned();
    if *value == next {
        return false;
    }
    *value = next;
    true
}

fn parent_named(value: &str, name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute()
        || !path
            .file_name()
            .is_some_and(|file_name| file_name.eq_ignore_ascii_case(name))
    {
        return None;
    }
    path.parent().map(Path::to_path_buf)
}

fn runtime_parent(value: &str) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return None;
    }
    let mut current = path.parent();
    while let Some(directory) = current {
        if directory
            .file_name()
            .is_some_and(|file_name| file_name.eq_ignore_ascii_case("runtime"))
        {
            return directory.parent().map(Path::to_path_buf);
        }
        current = directory.parent();
    }
    None
}

fn infer_legacy_portable_root(config: &TtsConfig) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for candidate in [
        parent_named(&config.server_root, "server"),
        parent_named(&config.irodori_root, "irodori"),
        parent_named(&config.voices_dir, "voices")
            .and_then(|data| parent_named(&data.to_string_lossy(), "data")),
        runtime_parent(&config.python_path),
    ] {
        let Some(candidate) = candidate else {
            continue;
        };
        if !candidates.iter().any(|existing: &PathBuf| {
            normalized_path_text(existing.to_string_lossy().as_ref())
                == normalized_path_text(candidate.to_string_lossy().as_ref())
        }) {
            candidates.push(candidate);
        }
    }

    let values = [
        config.server_root.as_str(),
        config.irodori_root.as_str(),
        config.python_path.as_str(),
        config.voices_dir.as_str(),
    ];
    candidates.into_iter().find(|candidate| {
        values
            .iter()
            .filter(|value| relative_to_portable_root(value, candidate).is_some())
            .count()
            >= 2
    })
}

fn rebase_portable_config_paths(config: &mut TtsConfig, root: &Path) -> bool {
    let current_root = root.to_string_lossy().into_owned();
    let old_root = config
        .portable_root
        .as_deref()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| infer_legacy_portable_root(config));
    let mut changed = false;

    if let Some(old_root) = old_root {
        if normalized_path_text(old_root.to_string_lossy().as_ref())
            != normalized_path_text(&current_root)
        {
            changed |= rebase_path(&mut config.server_root, &old_root, root);
            changed |= rebase_path(&mut config.irodori_root, &old_root, root);
            changed |= rebase_path(&mut config.python_path, &old_root, root);
            changed |= rebase_path(&mut config.voices_dir, &old_root, root);
        }
    }

    if config.portable_root.as_deref() != Some(current_root.as_str()) {
        config.portable_root = Some(current_root);
        changed = true;
    }
    changed
}

fn default_roots(root: &Path) -> (PathBuf, PathBuf) {
    (root.join("irodori"), root.join("server"))
}

fn find_file_recursive(root: &Path, file_name: &str) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    for entry in fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case(file_name))
        {
            return Some(path);
        }
        let skip_directory = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| matches!(name, ".venv" | "env" | "Lib" | "site-packages"));
        if path.is_dir() && !skip_directory {
            if let Some(found) = find_file_recursive(&path, file_name) {
                return Some(found);
            }
        }
    }
    None
}

fn find_bundled_python(root: &Path) -> Option<PathBuf> {
    find_file_recursive(&root.join("runtime").join("python"), "python.exe")
}

fn repair_portable_venv(root: &Path) {
    let Some(python) = find_bundled_python(root) else {
        return;
    };
    let Some(python_home) = python.parent() else {
        return;
    };
    let portable_python_root = root.join("runtime").join("python");
    if !path_is_within(python_home, &portable_python_root) {
        return;
    }

    let config_path = root.join("runtime").join("env").join("pyvenv.cfg");
    let Ok(contents) = fs::read_to_string(&config_path) else {
        return;
    };
    let mut changed = false;
    let repaired = contents
        .lines()
        .map(|line| {
            let Some(value) = line.strip_prefix("home =") else {
                return line.to_string();
            };
            let configured_home = PathBuf::from(value.trim());
            if configured_home.is_absolute()
                && !path_is_within(&configured_home, &portable_python_root)
            {
                changed = true;
                format!("home = {}", python_home.display())
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\r\n");
    if !changed {
        return;
    }

    let temp = config_path.with_extension("cfg.tmp");
    if fs::write(&temp, format!("{repaired}\r\n")).is_ok() {
        let _ = fs::rename(temp, config_path);
    }
}

fn find_python(root: &Path, server_root: &Path, irodori_root: &Path) -> PathBuf {
    find_bundled_python(root)
        .or_else(|| {
            [
                root.join("runtime")
                    .join("env")
                    .join("Scripts")
                    .join("python.exe"),
                root.join("runtime").join("python.exe"),
                server_root.join(".venv").join("Scripts").join("python.exe"),
                irodori_root
                    .join(".venv")
                    .join("Scripts")
                    .join("python.exe"),
            ]
            .into_iter()
            .find(|path| path.is_file())
        })
        .unwrap_or_else(|| root.join("runtime").join("python.exe"))
}

fn default_tts_config() -> Result<TtsConfig, String> {
    let root = app_root()?;
    let (irodori_root, server_root) = default_roots(&root);
    Ok(TtsConfig {
        python_path: find_python(&root, &server_root, &irodori_root)
            .to_string_lossy()
            .into_owned(),
        server_root: server_root.to_string_lossy().into_owned(),
        irodori_root: irodori_root.to_string_lossy().into_owned(),
        voices_dir: root
            .join("data")
            .join("voices")
            .to_string_lossy()
            .into_owned(),
        portable_root: Some(root.to_string_lossy().into_owned()),
        server_url: "http://127.0.0.1".to_string(),
        port: 8088,
        api_key: String::new(),
        model: "Aratako/Irodori-TTS-v4.1-Small-Quantized/int8-weight-only".to_string(),
        model_revision: "main".to_string(),
        default_voice: "none".to_string(),
        speed: 1.0,
        num_steps: 40,
        cfg_scale_text: 3.0,
        cfg_scale_speaker: 5.0,
        seed: None,
        model_precision: "fp32".to_string(),
        codec_precision: "fp32".to_string(),
        model_device: "auto".to_string(),
        codec_device: "auto".to_string(),
        schedule: "linear".to_string(),
        sway_coefficient: -1.0,
        auto_start: false,
        stop_on_exit: true,
    })
}

fn read_tts_config(paths: &PortablePaths) -> Result<TtsConfig, String> {
    let mut config = load_json(&json_path(paths, "settings.json"))
        .and_then(|value| value.map_or_else(default_tts_config, Ok))?;
    let root = PathBuf::from(&paths.root);
    let mut changed = rebase_portable_config_paths(&mut config, &root);
    let configured = PathBuf::from(&config.python_path);
    let portable_env = root.join("runtime").join("env");
    if configured.is_file() && path_is_within(&configured, &portable_env) {
        if let Some(python) = find_bundled_python(&root) {
            let python = python.to_string_lossy().into_owned();
            if config.python_path != python {
                config.python_path = python;
                changed = true;
            }
        }
    }
    if changed {
        let _ = save_json(&json_path(paths, "settings.json"), &config);
    }
    Ok(config)
}

fn probe_command(command: &str, args: &[&str]) -> String {
    let mut process = Command::new(command);
    process.args(args);
    #[cfg(target_os = "windows")]
    process.creation_flags(CREATE_NO_WINDOW);
    process
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .map(str::trim)
                    .map(str::to_string)
            } else {
                None
            }
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "未検出".to_string())
}

fn check_writable(root: &Path) -> bool {
    let test = root.join(".irodori-write-test");
    match fs::write(&test, b"ok") {
        Ok(()) => {
            let _ = fs::remove_file(test);
            true
        }
        Err(_) => false,
    }
}

fn component_status(
    id: &str,
    label: &str,
    installed: bool,
    required: bool,
    detail: &str,
) -> ComponentStatus {
    ComponentStatus {
        id: id.to_string(),
        label: label.to_string(),
        installed,
        required,
        detail: detail.to_string(),
    }
}

fn has_dependencies(root: &Path, server_root: &Path, irodori_root: &Path) -> bool {
    let site_packages = [
        root.join("runtime")
            .join("env")
            .join("Lib")
            .join("site-packages"),
        server_root.join(".venv").join("Lib").join("site-packages"),
    ];
    let server_package_available = server_root.join("src").join("irodori_openai_tts").is_dir()
        || server_root.join("irodori_openai_tts").is_dir()
        || site_packages
            .iter()
            .any(|path| path.join("irodori_openai_tts").is_dir());
    let python_dependencies_installed = site_packages.iter().any(|path| {
        path.join("fastapi").is_dir()
            && path.join("uvicorn").is_dir()
            && path.join("torch").is_dir()
    });
    let irodori_package_available = irodori_root.join("irodori_tts").is_dir()
        || site_packages
            .iter()
            .any(|path| path.join("irodori_tts").is_dir());
    server_package_available
        && python_dependencies_installed
        && irodori_package_available
        && server_root.join("pyproject.toml").is_file()
}

fn has_model(root: &Path) -> bool {
    find_file_recursive(&root.join("models"), "model.safetensors").is_some()
}

fn environment_info(root: &Path) -> EnvironmentInfo {
    let (irodori_root, server_root) = default_roots(root);
    let gpu_output = probe_command("nvidia-smi", &["--query-gpu=name", "--format=csv,noheader"]);
    let cuda_available = gpu_output != "未検出";
    let uv_path = root.join("runtime").join("uv.exe");
    let ffmpeg_path = find_file_recursive(&root.join("runtime"), "ffmpeg.exe");
    let python_path = find_python(root, &server_root, &irodori_root);
    let sources_installed = irodori_root.join("infer.py").is_file()
        && server_root.join("pyproject.toml").is_file()
        && root
            .join("vendor")
            .join("silentcipher")
            .join("pyproject.toml")
            .is_file()
        && root
            .join("vendor")
            .join("dacvae")
            .join("setup.py")
            .is_file();
    let python_installed = python_path.is_file();
    let dependencies_installed = has_dependencies(root, &server_root, &irodori_root);
    EnvironmentInfo {
        windows: probe_command("cmd", &["/C", "ver"]),
        architecture: env::consts::ARCH.to_string(),
        cpu: env::var("PROCESSOR_IDENTIFIER").unwrap_or_else(|_| "Windows CPU".to_string()),
        gpu: if cuda_available {
            gpu_output
        } else {
            "対応GPUを検出できない".to_string()
        },
        cuda_available,
        python: if python_installed {
            python_path.to_string_lossy().into_owned()
        } else {
            "runtime\\python（未準備）".to_string()
        },
        uv: if uv_path.is_file() {
            uv_path.to_string_lossy().into_owned()
        } else {
            "runtime\\uv.exe（未準備）".to_string()
        },
        ffmpeg: if let Some(path) = ffmpeg_path.as_ref() {
            path.to_string_lossy().into_owned()
        } else {
            "runtime\\ffmpeg.exe（未準備）".to_string()
        },
        free_space_gb: None,
        writable: check_writable(root),
        irodori_root: irodori_root.to_string_lossy().into_owned(),
        server_root: server_root.to_string_lossy().into_owned(),
        components: vec![
            component_status(
                "runtime",
                "実行環境",
                uv_path.is_file(),
                true,
                "uv（アプリ内で使用する実行ツール）",
            ),
            component_status("python", "Python", python_installed, true, "Python 3.10"),
            component_status(
                "sources",
                "音声生成プログラム",
                sources_installed,
                true,
                "Irodori-TTS / Server",
            ),
            component_status(
                "dependencies",
                "必要な部品",
                dependencies_installed,
                true,
                if cuda_available {
                    "CUDA対応"
                } else {
                    "CPU対応"
                },
            ),
            component_status(
                "model",
                "音声モデル",
                has_model(root),
                true,
                "選択したモデル",
            ),
            component_status(
                "ffmpeg",
                "音声変換機能",
                ffmpeg_path.is_some(),
                true,
                "FFmpeg（音声変換に必要）",
            ),
        ],
    }
}

fn app_state() -> Result<AppState, String> {
    let paths = ensure_directories()?;
    let root = PathBuf::from(&paths.root);
    let setup =
        load_json::<SetupRecord>(&json_path(&paths, "setup.json"))?.unwrap_or(SetupRecord {
            notice_version: String::new(),
            notice_acknowledged_at: None,
            install_step: "environment".to_string(),
        });
    let environment = environment_info(&root);
    let missing_required = environment
        .components
        .iter()
        .any(|component| component.required && !component.installed);
    Ok(AppState {
        setup_required: setup.notice_version != NOTICE_VERSION
            || setup.notice_acknowledged_at.is_none()
            || missing_required,
        notice_version: NOTICE_VERSION.to_string(),
        notice_acknowledged_at: setup.notice_acknowledged_at,
        paths,
        environment,
    })
}

fn default_voice() -> Voice {
    Voice {
        id: "none".to_string(),
        name: "VoiceDesign（参照なし）".to_string(),
        icon_path: None,
        icon_data_url: None,
        caption: "落ち着いた自然な声".to_string(),
        voice_design: String::new(),
        references: Vec::new(),
        updated_at: iso_now(),
    }
}

fn load_voices(paths: &PortablePaths) -> Result<Vec<Voice>, String> {
    let voices_dir = PathBuf::from(&paths.voices);
    let path = voices_dir.join("studio-voices.json");
    let mut voices = load_json::<Vec<Voice>>(&path)?.unwrap_or_default();
    let mut changed = false;
    if !voices.iter().any(|voice| voice.id == "none") {
        voices.insert(0, default_voice());
    }
    for voice in &mut voices {
        if let Some(icon_path) = voice.icon_path.clone() {
            if let Some(relative) = normalize_voice_file_reference(&icon_path, &voices_dir) {
                if voice.icon_path.as_deref() != Some(relative.as_str()) {
                    voice.icon_path = Some(relative);
                    changed = true;
                }
            }
        }
        let references = voice
            .references
            .iter()
            .map(|reference| {
                if let Some(relative) = normalize_voice_file_reference(reference, &voices_dir) {
                    if relative != *reference {
                        changed = true;
                    }
                    relative
                } else {
                    reference.clone()
                }
            })
            .collect();
        voice.references = references;
        hydrate_voice_icon(voice, &voices_dir);
    }
    if changed {
        let _ = save_voice_catalog(&voices_dir, &voices);
    }
    Ok(voices)
}

const MAX_VOICE_ICON_BYTES: usize = 5 * 1024 * 1024;

fn image_format(value: &str) -> Option<(&'static str, &'static str)> {
    let extension = Path::new(value)
        .extension()
        .and_then(|extension| extension.to_str())?
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some(("image/png", "png")),
        "jpg" | "jpeg" => Some(("image/jpeg", "jpg")),
        "webp" => Some(("image/webp", "webp")),
        "gif" => Some(("image/gif", "gif")),
        "bmp" => Some(("image/bmp", "bmp")),
        _ => None,
    }
}

fn resolve_voice_file(value: &str, voices_dir: &Path) -> Option<PathBuf> {
    let raw = PathBuf::from(value);
    let mut candidates = vec![raw.clone()];
    if !raw.is_absolute() {
        candidates.push(voices_dir.join(&raw));
        if let Some(file_name) = raw.file_name() {
            candidates.push(voices_dir.join(file_name));
        }
    } else if let Some(file_name) = raw.file_name() {
        // Old portable builds stored absolute paths. After moving the bundle,
        // the same file still exists beside the new executable.
        candidates.push(voices_dir.join(file_name));
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file() && path_is_within(candidate, voices_dir))
}

fn normalize_voice_file_reference(value: &str, voices_dir: &Path) -> Option<String> {
    resolve_voice_file(value, voices_dir).and_then(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string)
    })
}

fn load_voice_icon_data(value: &str, voices_dir: &Path) -> Option<String> {
    let (mime, _) = image_format(value)?;
    let path = resolve_voice_file(value, voices_dir)?;
    let bytes = fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_VOICE_ICON_BYTES {
        return None;
    }
    Some(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

fn hydrate_voice_icon(voice: &mut Voice, voices_dir: &Path) {
    voice.icon_data_url = voice
        .icon_path
        .as_deref()
        .and_then(|path| load_voice_icon_data(path, voices_dir));
}

fn save_voice_catalog(voices_dir: &Path, voices: &[Voice]) -> Result<(), String> {
    let storage = voices
        .iter()
        .cloned()
        .map(|mut voice| {
            voice.icon_data_url = None;
            voice
        })
        .collect::<Vec<_>>();
    save_json(&voices_dir.join("studio-voices.json"), &storage)
}

fn load_generations(paths: &PortablePaths) -> Result<Vec<Generation>, String> {
    let history_path = PathBuf::from(&paths.history).join("generations.json");
    let mut generations: Vec<Generation> = load_json(&history_path)?.unwrap_or_default();
    let mut changed = false;
    for generation in &mut generations {
        if let Some(path) =
            resolve_generation_audio_path(&generation.audio_path, paths, generation.is_favorite)
        {
            let path = path.to_string_lossy().into_owned();
            if generation.audio_path != path {
                generation.audio_path = path;
                changed = true;
            }
        }
    }
    if changed {
        let _ = save_json(&history_path, &generations);
    }
    Ok(generations)
}

fn resolve_generation_audio_path(
    value: &str,
    paths: &PortablePaths,
    is_favorite: bool,
) -> Option<PathBuf> {
    let root = PathBuf::from(&paths.root);
    let data = PathBuf::from(&paths.data);
    let temp = PathBuf::from(&paths.temp);
    let favorites = PathBuf::from(&paths.favorites);
    let raw = PathBuf::from(value);
    let mut candidates = Vec::new();
    if raw.is_absolute() {
        candidates.push(raw.clone());
    } else {
        candidates.push(root.join(&raw));
        candidates.push(temp.join(&raw));
        candidates.push(favorites.join(&raw));
    }
    if let Some(file_name) = raw.file_name() {
        if is_favorite {
            candidates.push(favorites.join(file_name));
            candidates.push(temp.join(file_name));
        } else {
            candidates.push(temp.join(file_name));
            candidates.push(favorites.join(file_name));
        }
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file() && path_is_within(candidate, &data))
}
fn save_generations(paths: &PortablePaths, generations: &[Generation]) -> Result<(), String> {
    save_json(
        &PathBuf::from(&paths.history).join("generations.json"),
        &generations,
    )
}

fn server_base_url(config: &TtsConfig) -> String {
    let raw = config.server_url.trim().trim_end_matches('/');
    if let Ok(mut url) = reqwest::Url::parse(raw) {
        if url.port().is_none() {
            let _ = url.set_port(Some(config.port));
        }
        return url.as_str().trim_end_matches('/').to_string();
    }
    format!("{raw}:{}", config.port)
}

fn health(config: &TtsConfig) -> (bool, bool) {
    let url = format!("{}/health", server_base_url(config));
    let client = Client::builder()
        .timeout(Duration::from_millis(700))
        .build()
        .unwrap_or_else(|_| Client::new());
    let Ok(response) = client.get(url).send() else {
        return (false, false);
    };
    if !response.status().is_success() {
        return (false, false);
    }
    let payload: Value = response.json().unwrap_or_default();
    let loaded = payload
        .get("runtime")
        .and_then(|runtime| runtime.get("loaded"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    (true, loaded)
}

fn process_command_line(pid: u32) -> String {
    let script = format!("$p = Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}'; if ($p) {{ $p.CommandLine }}");
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default()
}

fn process_exists(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        let filter = format!("PID eq {pid}");
        let mut command = Command::new("tasklist");
        command.args(["/FI", &filter, "/NH"]);
        command.creation_flags(CREATE_NO_WINDOW);
        return command
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| {
                let pid = pid.to_string();
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .any(|line| line.split_whitespace().any(|token| token == pid))
            })
            .unwrap_or(false);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
        false
    }
}

fn managed_marker(paths: &PortablePaths) -> PathBuf {
    PathBuf::from(&paths.data).join("managed-server.json")
}

fn is_expected_server(pid: u32, config: &TtsConfig) -> bool {
    let command_line = process_command_line(pid).to_ascii_lowercase();
    command_line.contains("irodori_openai_tts")
        && (command_line.contains(&config.server_root.to_ascii_lowercase())
            || command_line.contains("irodori-tts"))
}

fn status_for(runtime: &RuntimeState, paths: &PortablePaths, config: &TtsConfig) -> TtsStatus {
    let (healthy, model_loaded) = health(config);
    let mut owned_pid = None;
    let mut clear_marker = false;
    let mut startup_timed_out = false;
    if let Ok(mut guard) = runtime.process.lock() {
        let mut clear_owned_process = false;
        if let Some(process) = guard.as_mut() {
            match process.child.try_wait() {
                Ok(Some(_)) | Err(_) => {
                    clear_owned_process = true;
                    clear_marker = true;
                }
                Ok(None) => {
                    let timed_out = !healthy
                        && process
                            .started_at
                            .elapsed()
                            .map(|elapsed| elapsed >= SERVER_START_TIMEOUT)
                            .unwrap_or(false);
                    if timed_out {
                        let _ = process.child.kill();
                        let _ = process.child.wait();
                        clear_owned_process = true;
                        clear_marker = true;
                        startup_timed_out = true;
                    } else {
                        owned_pid = Some(process.pid);
                    }
                }
            }
        }
        if clear_owned_process {
            *guard = None;
        }
    }
    if owned_pid.is_none() && !startup_timed_out {
        if let Ok(Some(marker)) = load_json::<Value>(&managed_marker(paths)) {
            let pid = marker
                .get("pid")
                .and_then(Value::as_u64)
                .unwrap_or_default() as u32;
            if pid > 0 && process_exists(pid) && is_expected_server(pid, config) {
                owned_pid = Some(pid);
            } else {
                clear_marker = true;
            }
        }
    }
    if clear_marker {
        let _ = fs::remove_file(managed_marker(paths));
    }
    let running = owned_pid.is_some() || healthy;
    TtsStatus {
        healthy,
        running,
        owned_by_studio: owned_pid.is_some(),
        pid: owned_pid,
        port: config.port,
        model_loaded,
        message: if healthy && model_loaded {
            "利用可能".to_string()
        } else if healthy {
            "サーバー接続済み。音声モデルを準備しています".to_string()
        } else if startup_timed_out {
            "サーバーの起動に時間がかかっています。ログを確認してもう一度お試しください".to_string()
        } else if running {
            "起動中です。しばらくお待ちください".to_string()
        } else {
            "停止中。設定画面から起動できます".to_string()
        },
    }
}

fn log_file(paths: &PortablePaths) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(PathBuf::from(&paths.logs).join("irodori-server.log"))
        .map_err(|error| error.to_string())
}

fn server_log_tail(paths: &PortablePaths) -> String {
    let path = PathBuf::from(&paths.logs).join("irodori-server.log");
    let Ok(contents) = fs::read_to_string(path) else {
        return String::new();
    };
    let mut lines = contents.lines().rev().take(12).collect::<Vec<_>>();
    lines.reverse();
    lines.join("\n")
}

fn build_server_command(
    root: &Path,
    paths: &PortablePaths,
    config: &TtsConfig,
) -> Result<(Command, String, Vec<String>), String> {
    let server_root = PathBuf::from(&config.server_root);
    let irodori_root = PathBuf::from(&config.irodori_root);
    let configured = PathBuf::from(&config.python_path);
    let portable_env = root.join("runtime").join("env");
    let python = if configured.is_file() && !path_is_within(&configured, &portable_env) {
        configured
    } else {
        find_python(root, &server_root, &irodori_root)
    };
    let mut command;
    let executable;
    let args: Vec<String>;
    if python.is_file() {
        executable = python.to_string_lossy().into_owned();
        args = vec![
            "-m".to_string(),
            "irodori_openai_tts".to_string(),
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            config.port.to_string(),
        ];
        command = Command::new(&python);
        command.args(&args);
    } else {
        let Some(uv) = bundled_uv(root) else {
            return Err(
                "アプリ内のPythonまたは実行環境が見つかりません。設定画面の「環境確認」から準備してください。"
                    .to_string(),
            );
        };
        executable = uv.to_string_lossy().into_owned();
        args = vec![
            "run".to_string(),
            "--no-sync".to_string(),
            "--project".to_string(),
            config.server_root.clone(),
            "python".to_string(),
            "-m".to_string(),
            "irodori_openai_tts".to_string(),
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            config.port.to_string(),
        ];
        command = Command::new(&uv);
        command.args(&args);
    }
    command.current_dir(&server_root);
    command.env_remove("PYTHONPATH");
    command.env("PYTHONNOUSERSITE", "1");
    let mut python_path = Vec::new();
    for source_root in [&server_root, &irodori_root] {
        for source in [source_root.join("src"), source_root.clone()] {
            let contains_python_package =
                source.join("irodori_openai_tts").is_dir() || source.join("irodori_tts").is_dir();
            if source.is_dir() && contains_python_package {
                python_path.push(source.to_string_lossy().into_owned());
            }
        }
    }
    if !python_path.is_empty() {
        if path_is_within(&python, &root.join("runtime")) {
            for site_packages in [
                root.join("runtime")
                    .join("env")
                    .join("Lib")
                    .join("site-packages"),
                server_root.join(".venv").join("Lib").join("site-packages"),
                irodori_root.join(".venv").join("Lib").join("site-packages"),
            ] {
                if site_packages.is_dir() {
                    python_path.push(site_packages.to_string_lossy().into_owned());
                }
            }
        }
        command.env("PYTHONPATH", python_path.join(";"));
    }
    command.env("IRODORI_HOST", "127.0.0.1");
    command.env("IRODORI_PORT", config.port.to_string());
    command.env("IRODORI_HF_CHECKPOINT", &config.model);
    command.env("IRODORI_VOICES_DIR", &config.voices_dir);
    command.env("IRODORI_ALLOW_NO_REF_VOICE", "true");
    command.env("IRODORI_MODEL_DEVICE", &config.model_device);
    command.env("IRODORI_CODEC_DEVICE", &config.codec_device);
    command.env("IRODORI_MODEL_PRECISION", &config.model_precision);
    command.env("IRODORI_CODEC_PRECISION", &config.codec_precision);
    command.env("IRODORI_DEFAULT_NUM_STEPS", config.num_steps.to_string());
    command.env("IRODORI_DEFAULT_T_SCHEDULE_MODE", &config.schedule);
    command.env(
        "IRODORI_DEFAULT_SWAY_COEFF",
        config.sway_coefficient.to_string(),
    );
    command.env("IRODORI_MODEL_LOAD_TIMEOUT", "900");
    let hf_home = root.join("models").join("hf-cache");
    command.env("HF_HOME", &hf_home);
    command.env("HF_HUB_CACHE", hf_home.join("hub"));
    command.env("TORCH_HOME", root.join("models").join("torch-cache"));
    if !config.api_key.is_empty() {
        command.env("IRODORI_API_KEY", &config.api_key);
    }
    let log = log_file(paths)?;
    let err = log.try_clone().map_err(|error| error.to_string())?;
    command.stdout(Stdio::from(log));
    command.stderr(Stdio::from(err));
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    Ok((command, executable, args))
}

fn stop_process(
    runtime: &RuntimeState,
    paths: &PortablePaths,
    config: &TtsConfig,
) -> Result<(), String> {
    if let Ok(mut guard) = runtime.process.lock() {
        if let Some(mut process) = guard.take() {
            let _ = process.child.kill();
            let _ = process.child.wait();
            let _ = fs::remove_file(managed_marker(paths));
            return Ok(());
        }
    }
    if let Some(marker) = load_json::<Value>(&managed_marker(paths))? {
        let pid = marker
            .get("pid")
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32;
        if pid > 0 && process_exists(pid) && is_expected_server(pid, config) {
            let mut taskkill = Command::new("taskkill");
            taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
            #[cfg(target_os = "windows")]
            taskkill.creation_flags(CREATE_NO_WINDOW);
            let _ = taskkill.output();
        }
        let _ = fs::remove_file(managed_marker(paths));
    }
    Ok(())
}

fn decode_audio(data: &str) -> Result<Vec<u8>, String> {
    BASE64
        .decode(data)
        .map_err(|error| format!("音声データを読めない: {error}"))
}

fn wav_duration(bytes: &[u8]) -> Option<f64> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" {
        return None;
    }
    let channels = u16::from_le_bytes([bytes[22], bytes[23]]) as f64;
    let rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]) as f64;
    let bits = u16::from_le_bytes([bytes[34], bytes[35]]) as f64;
    if channels <= 0.0 || rate <= 0.0 || bits <= 0.0 {
        return None;
    }
    let data_size = bytes
        .windows(4)
        .position(|window| window == b"data")
        .and_then(|index| bytes.get(index + 4..index + 8))
        .map(|value| u32::from_le_bytes([value[0], value[1], value[2], value[3]]) as f64)
        .unwrap_or(bytes.len() as f64);
    Some(data_size / (rate * channels * bits / 8.0))
}

fn load_audio_base64(path: &Path) -> Option<String> {
    fs::read(path).ok().map(|bytes| BASE64.encode(bytes))
}

#[tauri::command]
fn initialize_app() -> Result<AppState, String> {
    app_state()
}

#[tauri::command]
fn check_environment() -> Result<EnvironmentInfo, String> {
    let root = app_root()?;
    Ok(environment_info(&root))
}

#[tauri::command]
fn prepare_runtime() -> Result<(), String> {
    let paths = ensure_directories()?;
    let (root, _) = paths_as_path()?;
    for entry in fs::read_dir(&paths.temp)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let path = entry.path();
        if path.is_file() {
            let _ = fs::remove_file(path);
        }
    }
    let notice = root.join("VOICE_CLONING_NOTICE.txt");
    if !notice.is_file() {
        fs::write(notice, include_str!("../../VOICE_CLONING_NOTICE.txt"))
            .map_err(|error| error.to_string())?;
    }
    let third_party = root.join("THIRD_PARTY_NOTICES.txt");
    if !third_party.is_file() {
        fs::write(third_party, include_str!("../../THIRD_PARTY_NOTICES.txt"))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn acknowledge_notice(version: String) -> Result<(), String> {
    if version != NOTICE_VERSION {
        return Err("注意事項のバージョンが一致しません。".to_string());
    }
    let paths = ensure_directories()?;
    let record = SetupRecord {
        notice_version: version,
        notice_acknowledged_at: Some(iso_now()),
        install_step: "ready".to_string(),
    };
    save_json(&json_path(&paths, "setup.json"), &record)
}

#[tauri::command]
fn list_voices() -> Result<Vec<Voice>, String> {
    load_voices(&ensure_directories()?)
}

#[tauri::command(rename_all = "camelCase")]
fn get_voice(voice_id: String) -> Result<Voice, String> {
    load_voices(&ensure_directories()?).map(|voices| {
        voices
            .into_iter()
            .find(|voice| voice.id == voice_id)
            .ok_or_else(|| "ボイスが見つかりません。".to_string())
    })?
}

fn write_voice_aliases(voices_dir: &Path, voices: &[Voice]) -> Result<(), String> {
    let mut aliases = Map::new();
    for voice in voices
        .iter()
        .filter(|voice| voice.id != "none" && !voice.references.is_empty())
    {
        let files: Vec<String> = voice
            .references
            .iter()
            .filter_map(|path| {
                Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_string)
            })
            .collect();
        if files.len() == 1 {
            aliases.insert(voice.id.clone(), Value::String(files[0].clone()));
        } else if !files.is_empty() {
            aliases.insert(voice.id.clone(), json!({ "ref_wavs": files }));
        }
    }
    save_json(&voices_dir.join("voices.json"), &aliases)
}

#[tauri::command(rename_all = "camelCase")]
fn save_voice(
    voice: VoiceDraft,
    uploads: Vec<Upload>,
    icon: Option<Upload>,
) -> Result<Voice, String> {
    if voice.name.trim().is_empty() {
        return Err("ボイス名を入力してください。".to_string());
    }
    let paths = ensure_directories()?;
    let voices_dir = PathBuf::from(&paths.voices);
    let mut voices = load_voices(&paths)?;
    let id = voice
        .id
        .unwrap_or_else(|| format!("voice-{}", &Uuid::new_v4().to_string()[..8]));
    let previous_icon = voices
        .iter()
        .find(|item| item.id == id)
        .and_then(|item| item.icon_path.clone());
    let mut references = voice
        .references
        .into_iter()
        .filter_map(|path| {
            normalize_voice_file_reference(&path, &voices_dir)
                .or_else(|| Path::new(&path).is_file().then_some(path))
        })
        .collect::<Vec<_>>();
    for upload in uploads {
        let filename = format!("{}-{}", id, safe_file_name(&upload.name));
        let path = voices_dir.join(filename);
        fs::write(&path, decode_audio(&upload.data)?).map_err(|error| error.to_string())?;
        references.push(
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("audio.wav")
                .to_string(),
        );
    }
    let mut icon_path = voice
        .icon_path
        .map(|path| normalize_voice_file_reference(&path, &voices_dir).unwrap_or(path));
    if let Some(upload) = icon {
        let (_, extension) = image_format(&upload.name).ok_or_else(|| {
            "アイコン画像はPNG、JPG、WEBP、GIF、BMPのいずれかを選択してください。".to_string()
        })?;
        let bytes = BASE64
            .decode(&upload.data)
            .map_err(|error| format!("アイコン画像を読み込めません: {error}"))?;
        if bytes.is_empty() || bytes.len() > MAX_VOICE_ICON_BYTES {
            return Err("アイコン画像は5MB以下にしてください。".to_string());
        }
        let path = voices_dir.join(format!("{id}-icon.{extension}"));
        fs::write(&path, bytes).map_err(|error| error.to_string())?;
        icon_path = Some(
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("icon.png")
                .to_string(),
        );
        if let Some(previous) = previous_icon {
            if let Some(previous_path) = resolve_voice_file(&previous, &voices_dir) {
                if previous_path != path {
                    let _ = fs::remove_file(previous_path);
                }
            }
        }
    }
    let saved = Voice {
        id: id.clone(),
        name: voice.name.trim().to_string(),
        icon_path,
        icon_data_url: None,
        caption: voice.caption,
        voice_design: voice.voice_design,
        references,
        updated_at: iso_now(),
    };
    let mut saved = saved;
    hydrate_voice_icon(&mut saved, &voices_dir);
    if let Some(index) = voices.iter().position(|item| item.id == id) {
        voices[index] = saved.clone();
    } else {
        voices.push(saved.clone());
    }
    save_voice_catalog(&voices_dir, &voices)?;
    write_voice_aliases(&voices_dir, &voices)?;
    Ok(saved)
}

#[tauri::command(rename_all = "camelCase")]
fn delete_voice(voice_id: String) -> Result<(), String> {
    if voice_id == "none" {
        return Err("VoiceDesignは削除できません。".to_string());
    }
    let paths = ensure_directories()?;
    let voices_dir = PathBuf::from(&paths.voices);
    let mut voices = load_voices(&paths)?;
    let Some(removed) = voices.iter().find(|voice| voice.id == voice_id).cloned() else {
        return Err("ボイスが見つかりません。".to_string());
    };
    voices.retain(|voice| voice.id != voice_id);
    save_voice_catalog(&voices_dir, &voices)?;
    write_voice_aliases(&voices_dir, &voices)?;
    for reference in removed.references {
        if let Some(path) = resolve_voice_file(&reference, &voices_dir) {
            let _ = fs::remove_file(path);
        }
    }
    if let Some(icon) = removed.icon_path {
        if let Some(path) = resolve_voice_file(&icon, &voices_dir) {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

#[tauri::command]
fn get_tts_config() -> Result<TtsConfig, String> {
    read_tts_config(&ensure_directories()?)
}

#[tauri::command]
fn save_tts_config(config: TtsConfig) -> Result<TtsConfig, String> {
    if config.port == 0 || config.server_url.trim().is_empty() {
        return Err("サーバーのURLとポート番号を確認してください。".to_string());
    }
    let paths = ensure_directories()?;
    save_json(&json_path(&paths, "settings.json"), &config)?;
    Ok(config)
}

#[tauri::command]
fn get_tts_status(runtime: State<'_, RuntimeState>) -> Result<TtsStatus, String> {
    let paths = ensure_directories()?;
    let config = read_tts_config(&paths)?;
    Ok(status_for(&runtime, &paths, &config))
}

#[tauri::command]
fn start_tts(runtime: State<'_, RuntimeState>) -> Result<TtsStatus, String> {
    let paths = ensure_directories()?;
    let config = read_tts_config(&paths)?;
    let current = status_for(&runtime, &paths, &config);
    if current.running {
        return Ok(current);
    }
    let root = PathBuf::from(&paths.root);
    let missing = environment_info(&root)
        .components
        .iter()
        .filter(|component| {
            component.required
                && !component.installed
                && matches!(
                    component.id.as_str(),
                    "runtime" | "python" | "sources" | "dependencies"
                )
        })
        .map(|component| component.label.clone())
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "サーバーを起動するために、次の項目を準備してください: {}。設定画面の「環境確認」から準備できます。",
            missing.join("、")
        ));
    }
    let (mut command, executable, args) = build_server_command(&root, &paths, &config)?;
    let child = command
        .spawn()
        .map_err(|error| format!("Irodori-TTS Serverを起動できない: {error}"))?;
    let pid = child.id();
    if let Ok(mut guard) = runtime.process.lock() {
        *guard = Some(ManagedProcess {
            child,
            pid,
            started_at: SystemTime::now(),
        });
    }
    save_json(
        &managed_marker(&paths),
        &json!({ "pid": pid, "port": config.port, "executable": executable, "args": args }),
    )?;
    std::thread::sleep(Duration::from_millis(250));
    let status = status_for(&runtime, &paths, &config);
    if !status.running && !status.healthy {
        let detail = server_log_tail(&paths);
        let _ = fs::remove_file(managed_marker(&paths));
        return Err(if detail.is_empty() {
            "Irodori-TTS Serverが起動直後に終了しました。設定画面の環境確認とログを確認してください。"
                .to_string()
        } else {
            format!("Irodori-TTS Serverが起動直後に終了しました。\n\nログ:\n{detail}")
        });
    }
    Ok(status)
}

#[tauri::command]
fn stop_tts(runtime: State<'_, RuntimeState>) -> Result<TtsStatus, String> {
    let paths = ensure_directories()?;
    let config = read_tts_config(&paths)?;
    stop_process(&runtime, &paths, &config)?;
    Ok(status_for(&runtime, &paths, &config))
}

#[tauri::command]
fn restart_tts(runtime: State<'_, RuntimeState>) -> Result<TtsStatus, String> {
    let paths = ensure_directories()?;
    let config = read_tts_config(&paths)?;
    stop_process(&runtime, &paths, &config)?;
    drop(config);
    start_tts(runtime)
}

#[tauri::command(rename_all = "camelCase")]
async fn generate_speech(
    text: String,
    voice_id: Option<String>,
    emojis: Vec<String>,
    caption: String,
    preset: String,
) -> Result<Generation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        generate_speech_sync(text, voice_id, emojis, caption, preset)
    })
    .await
    .map_err(|error| format!("音声生成処理が中断されました: {error}"))?
}

fn generate_speech_sync(
    text: String,
    voice_id: Option<String>,
    emojis: Vec<String>,
    caption: String,
    preset: String,
) -> Result<Generation, String> {
    let input = text.trim();
    if input.is_empty() {
        return Err("音声に変換する文章を入力してください。".to_string());
    }
    if input.chars().count() > 4096 {
        return Err("1回に入力できる文章は4096文字までです。".to_string());
    }
    let paths = ensure_directories()?;
    let config = read_tts_config(&paths)?;
    let (healthy, _) = health(&config);
    if !healthy {
        return Err(
            "音声生成サーバーが起動していません。設定画面から起動してください。".to_string(),
        );
    }
    let voices = load_voices(&paths)?;
    let selected = voice_id
        .as_deref()
        .and_then(|id| voices.iter().find(|voice| voice.id == id));
    let effective_voice = if selected
        .map(|voice| voice.references.is_empty())
        .unwrap_or(true)
    {
        "none".to_string()
    } else {
        selected
            .map(|voice| voice.id.clone())
            .unwrap_or_else(|| config.default_voice.clone())
    };
    let voice_name = selected
        .map(|voice| voice.name.clone())
        .unwrap_or_else(|| "VoiceDesign（参照なし）".to_string());
    let payload = json!({ "model": "irodori-tts", "input": input, "voice": effective_voice, "response_format": "wav", "speed": config.speed, "irodori": { "caption": if caption.trim().is_empty() { Value::Null } else { Value::String(caption.clone()) }, "num_steps": config.num_steps, "cfg_scale_text": config.cfg_scale_text, "cfg_scale_speaker": config.cfg_scale_speaker, "seed": config.seed, "t_schedule_mode": config.schedule, "sway_coeff": config.sway_coefficient, "no_ref": selected.map(|voice| voice.references.is_empty()).unwrap_or(true) } });
    let client = Client::builder()
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .post(format!("{}/v1/audio/speech", server_base_url(&config)))
        .json(&payload);
    if !config.api_key.is_empty() {
        request = request.bearer_auth(&config.api_key);
    }
    let response = request
        .send()
        .map_err(|error| format!("Serverへ接続できない: {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .map_err(|error| error.to_string())?
        .to_vec();
    if !status.is_success() {
        return Err(String::from_utf8_lossy(&bytes).to_string());
    }
    let id = Uuid::new_v4().to_string();
    let path = PathBuf::from(&paths.temp).join(format!("{id}.wav"));
    let temp = path.with_extension("wav.tmp");
    fs::write(&temp, &bytes).map_err(|error| error.to_string())?;
    fs::rename(&temp, &path).map_err(|error| error.to_string())?;
    let generation = Generation {
        id,
        audio_path: path.to_string_lossy().into_owned(),
        audio_base64: Some(BASE64.encode(&bytes)),
        text: input.to_string(),
        voice_id,
        voice_name,
        emojis,
        caption,
        seed: config.seed,
        preset,
        model: config.model,
        model_revision: config.model_revision,
        created_at: iso_now(),
        is_favorite: false,
        exists: true,
        duration_seconds: wav_duration(&bytes),
    };
    let response = generation.clone();
    let mut record = generation;
    record.audio_base64 = None;
    let mut history = load_generations(&paths)?;
    history.push(record);
    save_generations(&paths, &history)?;
    Ok(response)
}

#[tauri::command(rename_all = "camelCase")]
fn favorite_generation(generation_id: String) -> Result<Generation, String> {
    let paths = ensure_directories()?;
    let mut history = load_generations(&paths)?;
    let Some(index) = history
        .iter()
        .position(|generation| generation.id == generation_id)
    else {
        return Err("生成履歴が見つかりません。".to_string());
    };
    let source = PathBuf::from(&history[index].audio_path);
    if !source.is_file() {
        return Err("一時音声がすでに削除されています。もう一度生成してください。".to_string());
    }
    let target = PathBuf::from(&paths.favorites).join(format!("{}.wav", generation_id));
    fs::copy(&source, &target).map_err(|error| error.to_string())?;
    history[index].audio_path = target.to_string_lossy().into_owned();
    history[index].is_favorite = true;
    history[index].exists = true;
    let saved = history[index].clone();
    save_generations(&paths, &history)?;
    Ok(saved)
}

#[tauri::command(rename_all = "camelCase")]
fn unfavorite_generation(generation_id: String) -> Result<(), String> {
    let paths = ensure_directories()?;
    let mut history = load_generations(&paths)?;
    let Some(index) = history
        .iter()
        .position(|generation| generation.id == generation_id)
    else {
        return Err("お気に入りが見つかりません。".to_string());
    };
    let audio = PathBuf::from(&history[index].audio_path);
    if path_is_within(&audio, Path::new(&paths.favorites)) {
        let _ = fs::remove_file(&audio);
    }
    history[index].is_favorite = false;
    history[index].exists = false;
    save_generations(&paths, &history)
}

#[tauri::command]
fn list_favorites() -> Result<Vec<Generation>, String> {
    let paths = ensure_directories()?;
    let mut result = load_generations(&paths)?
        .into_iter()
        .filter(|generation| generation.is_favorite)
        .collect::<Vec<_>>();
    for generation in &mut result {
        let path = PathBuf::from(&generation.audio_path);
        generation.exists = path.is_file();
        generation.audio_base64 = load_audio_base64(&path);
    }
    result.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
fn export_favorite(
    generation_id: String,
    destination: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let paths = ensure_directories()?;
    let history = load_generations(&paths)?;
    let Some(generation) = history
        .iter()
        .find(|generation| generation.id == generation_id && generation.is_favorite)
    else {
        return Err("お気に入り音声が見つかりません。".to_string());
    };
    let source = PathBuf::from(&generation.audio_path);
    if !source.is_file() {
        return Err("お気に入りの元ファイルが見つかりません。".to_string());
    }
    let destination = PathBuf::from(destination);
    if destination.exists() && !overwrite.unwrap_or(false) {
        return Err(
            "保存先に同名ファイルがあります。上書き確認後にもう一度保存してください。".to_string(),
        );
    }
    fs::copy(source, destination)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn open_audio_folder(generation_id: String) -> Result<(), String> {
    let paths = ensure_directories()?;
    let history = load_generations(&paths)?;
    let Some(generation) = history
        .iter()
        .find(|generation| generation.id == generation_id && generation.is_favorite)
    else {
        return Err("お気に入り音声が見つかりません。".to_string());
    };
    let path = PathBuf::from(&generation.audio_path);
    if !path.is_file() {
        return Err("お気に入りの元ファイルが見つかりません。".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer");
        command.arg(format!("/select,{}", path.display()));
        command.creation_flags(CREATE_NO_WINDOW);
        command.spawn().map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("xdg-open")
            .arg(path.parent().unwrap_or(Path::new(".")))
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn copy_dir(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!("{}が見つかりません。", source.display()));
    }
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let from = entry.path();
        let to = destination.join(entry.file_name());
        if from.is_dir() {
            if from.file_name().and_then(|name| name.to_str()) == Some(".venv") {
                continue;
            }
            copy_dir(&from, &to)?;
        } else {
            fs::copy(from, to).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn bundled_uv(root: &Path) -> Option<PathBuf> {
    let path = root.join("runtime").join("uv.exe");
    path.is_file().then_some(path)
}

fn download_zip(url: &str, destination: &Path) -> Result<(), String> {
    let client = Client::builder()
        .user_agent("IrodoriStudio/0.1")
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|error| error.to_string())?;
    let partial = destination.with_extension("zip.part");
    let result = (|| {
        let mut response = client
            .get(url)
            .send()
            .map_err(|error| format!("ダウンロードに失敗: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "ダウンロード先がHTTP {}を返しました。",
                response.status()
            ));
        }
        let mut file = File::create(&partial).map_err(|error| error.to_string())?;
        let bytes = response
            .copy_to(&mut file)
            .map_err(|error| format!("ファイルの保存に失敗: {error}"))?;
        if bytes == 0 {
            return Err("ダウンロードされたファイルが空です。".to_string());
        }
        drop(file);
        if destination.is_file() {
            fs::remove_file(destination).map_err(|error| error.to_string())?;
        }
        fs::rename(&partial, destination).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result.map_err(|error| format!("{url}: {error}"))
}

fn download_zip_with_fallback(urls: &[&str], destination: &Path) -> Result<(), String> {
    let mut errors = Vec::new();
    for url in urls {
        match download_zip(url, destination) {
            Ok(()) => return Ok(()),
            Err(error) => errors.push(error),
        }
    }
    Err(format!(
        "FFmpegをダウンロードできませんでした。通信環境を確認して、もう一度実行してください。\n{}",
        errors.join("\n")
    ))
}

fn extract_zip(zip_path: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(enclosed) = entry.enclosed_name().map(|path| path.to_path_buf()) else {
            continue;
        };
        let output = destination.join(enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| error.to_string())?;
        } else {
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut out = File::create(output).map_err(|error| error.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn install_source(
    root: &Path,
    destination: &Path,
    staging: &Path,
    archive_name: &str,
    url: &str,
    marker: &str,
) -> Result<(), String> {
    if destination.join(marker).is_file() {
        return Ok(());
    }
    if root.join(marker).is_file() && root != destination {
        return copy_dir(root, destination);
    }
    let archive = staging.join(format!("{archive_name}.zip"));
    download_zip(url, &archive)?;
    let extracted = staging.join(archive_name);
    fs::create_dir_all(&extracted).map_err(|error| error.to_string())?;
    extract_zip(&archive, &extracted)?;
    let source = fs::read_dir(&extracted)
        .map_err(|error| error.to_string())?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && path.join(marker).is_file())
        .ok_or_else(|| format!("{archive_name}の展開先が見つかりません。"))?;
    copy_dir(&source, destination)
}

fn patch_project_dependency_sources(
    path: &Path,
    replacements: &[(&str, &str)],
    source_lines: &[&str],
) -> Result<(), String> {
    let original =
        fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut updated = original.clone();
    for (from, to) in replacements {
        if updated.contains(from) {
            updated = updated.replace(from, to);
        } else if !updated.contains(to) {
            return Err(format!(
                "{}にportable用の依存設定を追加できません。対象が見つかりません: {from}",
                path.display()
            ));
        }
    }
    if !source_lines.is_empty() {
        let marker = "[tool.uv.sources]\n";
        let insert_at = updated
            .find(marker)
            .map(|index| index + marker.len())
            .ok_or_else(|| format!("{}に[tool.uv.sources]がありません。", path.display()))?;
        let missing_lines = source_lines
            .iter()
            .copied()
            .filter(|line| !updated.contains(line))
            .collect::<Vec<_>>();
        if !missing_lines.is_empty() {
            let source_text = missing_lines.join("\n") + "\n";
            updated.insert_str(insert_at, &source_text);
        }
    }
    if updated != original {
        fs::write(path, updated).map_err(|error| format!("{}: {error}", path.display()))?;
    }
    Ok(())
}

fn rewrite_project_text(path: &Path, from: &str, to: &str) -> Result<(), String> {
    let original =
        fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let updated = original.replace(from, to);
    if updated != original {
        fs::write(path, updated).map_err(|error| format!("{}: {error}", path.display()))?;
    }
    Ok(())
}

fn limit_uv_to_windows(path: &Path) -> Result<(), String> {
    let original =
        fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if original
        .lines()
        .any(|line| line.trim_start().starts_with("environments ="))
    {
        return Ok(());
    }
    let marker = "[tool.uv]\n";
    let insert_at = original
        .find(marker)
        .map(|index| index + marker.len())
        .ok_or_else(|| format!("{}に[tool.uv]がありません。", path.display()))?;
    let mut updated = original;
    updated.insert_str(insert_at, "environments = [\"sys_platform == 'win32'\"]\n");
    fs::write(path, updated).map_err(|error| format!("{}: {error}", path.display()))
}

fn prepare_portable_dependency_sources(root: &Path, staging: &Path) -> Result<(), String> {
    let vendor = root.join("vendor");
    fs::create_dir_all(&vendor).map_err(|error| error.to_string())?;
    install_source(
        &vendor,
        &vendor.join("silentcipher"),
        staging,
        "silentcipher-d46d7d0893a583d8968ab3a6626e2289faec9152",
        "https://github.com/SesameAILabs/silentcipher/archive/d46d7d0893a583d8968ab3a6626e2289faec9152.zip",
        "pyproject.toml",
    )?;
    install_source(
        &vendor,
        &vendor.join("dacvae"),
        staging,
        "dacvae-main",
        "https://github.com/facebookresearch/dacvae/archive/refs/heads/main.zip",
        "setup.py",
    )?;

    let server_project = root.join("server").join("pyproject.toml");
    patch_project_dependency_sources(
        &server_project,
        &[(
            "irodori-tts @ git+https://github.com/Aratako/Irodori-TTS.git",
            "irodori-tts",
        )],
        &["irodori-tts = { path = \"../irodori\" }"],
    )?;
    limit_uv_to_windows(&server_project)?;
    let irodori_project = root.join("irodori").join("pyproject.toml");
    rewrite_project_text(&irodori_project, "silentcipher==1.0.5", "silentcipher")?;
    rewrite_project_text(
        &irodori_project,
        "silentcipher = { path = \"../vendor/silentcipher\" }\n",
        "",
    )?;
    patch_project_dependency_sources(
        &irodori_project,
        &[
            (
                "silentcipher @ git+https://github.com/SesameAILabs/silentcipher.git@d46d7d0893a583d8968ab3a6626e2289faec9152",
                "silentcipher",
            ),
            (
                "dacvae = { git = \"https://github.com/facebookresearch/dacvae\" }",
                "dacvae = { path = \"../vendor/dacvae\" }",
            ),
        ],
        &["silentcipher = { path = \"../vendor/silentcipher\" }"],
    )?;
    let lockfile = root.join("server").join("uv.lock");
    if lockfile.is_file() {
        fs::remove_file(lockfile).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_huggingface_hub(
    uv: &Path,
    python: &Path,
    root: &Path,
    runtime: &Path,
) -> Result<(), String> {
    let environment_python = runtime.join("env").join("Scripts").join("python.exe");
    let target_python = if environment_python.is_file() {
        environment_python
    } else {
        python.to_path_buf()
    };
    let mut command = Command::new(uv);
    command.args(["pip", "install", "--python"]);
    command.arg(target_python);
    command.arg("huggingface-hub>=0.34.0");
    command.env("UV_PROJECT_ENVIRONMENT", runtime.join("env"));
    command.env("UV_PYTHON_INSTALL_DIR", runtime.join("python"));
    command.env("UV_CACHE_DIR", root.join("data").join("uv-cache"));
    command.env("PYTHONNOUSERSITE", "1");
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .map_err(|error| format!("Hugging Faceの取得部品を準備できませんでした: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Hugging Faceの取得部品を準備できませんでした。{detail}"
        ));
    }
    Ok(())
}

fn install_environment_one(component: String) -> Result<InstallResult, String> {
    let paths = ensure_directories()?;
    let root = PathBuf::from(&paths.root);
    let runtime = root.join("runtime");
    let staging = root.join("data").join("temp").join("installer");
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    match component.as_str() {
        "runtime" => {
            let archive = staging.join("uv.zip");
            download_zip("https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip", &archive)?;
            extract_zip(&archive, &runtime)?;
            Ok(InstallResult {
                component,
                installed: runtime.join("uv.exe").is_file(),
                message: "実行環境を準備しました。次にPythonと必要な部品を準備できます。"
                    .to_string(),
                path: runtime.to_string_lossy().into_owned(),
            })
        }
        "python" => {
            let Some(uv) = bundled_uv(&root) else {
                return Err("先に実行環境を準備してください。".to_string());
            };
            let mut command = Command::new(uv);
            command.args([
                "python",
                "install",
                "3.10",
                "--install-dir",
                runtime.join("python").to_string_lossy().as_ref(),
            ]);
            command.env("UV_PYTHON_INSTALL_DIR", runtime.join("python"));
            #[cfg(target_os = "windows")]
            command.creation_flags(CREATE_NO_WINDOW);
            let output = command.output().map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            Ok(InstallResult {
                component,
                installed: find_file_recursive(&runtime.join("python"), "python.exe").is_some(),
                message: "Python 3.10をアプリ内へ準備しました。".to_string(),
                path: runtime.join("python").to_string_lossy().into_owned(),
            })
        }
        "ffmpeg" => {
            if find_file_recursive(&runtime, "ffmpeg.exe").is_some() {
                return Ok(InstallResult {
                    component,
                    installed: true,
                    message: "音声変換機能は準備済みです。".to_string(),
                    path: runtime.to_string_lossy().into_owned(),
                });
            }
            let archive = staging.join("ffmpeg.zip");
            download_zip_with_fallback(&FFMPEG_DOWNLOAD_URLS, &archive)?;
            extract_zip(&archive, &runtime)?;
            if find_file_recursive(&runtime, "ffmpeg.exe").is_none() {
                return Err("FFmpegの展開後にffmpeg.exeが見つかりません。".to_string());
            }
            Ok(InstallResult {
                component,
                installed: find_file_recursive(&runtime, "ffmpeg.exe").is_some(),
                message: "音声変換機能を準備しました。".to_string(),
                path: runtime.to_string_lossy().into_owned(),
            })
        }
        "sources" => {
            let (irodori_source, server_source) = default_roots(&root);
            install_source(
                &irodori_source,
                &root.join("irodori"),
                &staging,
                "Irodori-TTS-main",
                "https://github.com/Aratako/Irodori-TTS/archive/refs/heads/main.zip",
                "infer.py",
            )?;
            install_source(
                &server_source,
                &root.join("server"),
                &staging,
                "Irodori-TTS-Server-main",
                "https://github.com/Aratako/Irodori-TTS-Server/archive/refs/heads/main.zip",
                "pyproject.toml",
            )?;
            prepare_portable_dependency_sources(&root, &staging)?;
            Ok(InstallResult {
                component,
                installed: root.join("server").join("pyproject.toml").is_file()
                    && root
                        .join("vendor")
                        .join("dacvae")
                        .join("setup.py")
                        .is_file(),
                message: "音声生成プログラムをアプリ内へ準備しました。".to_string(),
                path: root.to_string_lossy().into_owned(),
            })
        }
        "dependencies" => {
            let Some(uv) = bundled_uv(&root) else {
                return Err("先に実行環境を準備してください。".to_string());
            };
            let Some(python) = find_bundled_python(&root) else {
                return Err("先にPython 3.10を準備してください。".to_string());
            };
            let (detected_irodori_root, detected_server_root) = default_roots(&root);
            let server_project = if root.join("server").join("pyproject.toml").is_file() {
                root.join("server")
            } else {
                detected_server_root
            };
            if !root.join("irodori").join("pyproject.toml").is_file()
                || !server_project.join("pyproject.toml").is_file()
            {
                return Err("先に音声生成プログラムを準備してください。".to_string());
            }
            prepare_portable_dependency_sources(&root, &staging)?;
            let extra = if environment_info(&root).cuda_available {
                "cu128"
            } else {
                "cpu"
            };
            let mut command = Command::new(uv);
            command.args([
                "sync",
                "--project",
                server_project.to_string_lossy().as_ref(),
                "--extra",
                extra,
            ]);
            command.arg("--python").arg(&python);
            command.env("UV_PROJECT_ENVIRONMENT", runtime.join("env"));
            command.env("UV_PYTHON_INSTALL_DIR", runtime.join("python"));
            command.env("UV_CACHE_DIR", root.join("data").join("uv-cache"));
            #[cfg(target_os = "windows")]
            command.creation_flags(CREATE_NO_WINDOW);
            let output = command.output().map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            Ok(InstallResult {
                component,
                installed: has_dependencies(&root, &server_project, &detected_irodori_root),
                message: format!("{extra}用の必要な部品を準備しました。"),
                path: runtime.join("env").to_string_lossy().into_owned(),
            })
        }
        "model" => {
            let config = read_tts_config(&paths)?;
            let Some(uv) = bundled_uv(&root) else {
                return Err("先に実行環境を準備してください。".to_string());
            };
            let Some(python) = find_bundled_python(&root) else {
                return Err("先にPythonと必要な部品を準備してください。".to_string());
            };
            ensure_huggingface_hub(&uv, &python, &root, &runtime)?;
            let checkpoint = split_hf_checkpoint_source(&config.model)?;
            let model_dir = root
                .join("models")
                .join(config.model.replace(['/', '\\'], "__"));
            let repo_json =
                serde_json::to_string(&checkpoint.repo_id).map_err(|error| error.to_string())?;
            let subfolder_json =
                serde_json::to_string(&checkpoint.subfolder).map_err(|error| error.to_string())?;
            let revision_json =
                serde_json::to_string(&config.model_revision).map_err(|error| error.to_string())?;
            let destination_json = serde_json::to_string(&model_dir.to_string_lossy())
                .map_err(|error| error.to_string())?;
            let code = format!(
                "from pathlib import Path\n\
import shutil\n\
from huggingface_hub import snapshot_download\n\
repo_id = {repo_json}\n\
subfolder = {subfolder_json}\n\
checkpoint_relative = Path(f'{{subfolder}}/model.safetensors') if subfolder else Path('model.safetensors')\n\
allow_patterns = ([f'{{subfolder}}/model.safetensors', f'{{subfolder}}/tokenizer/*', 'tokenizer/*'] if subfolder else ['model.safetensors', 'tokenizer/*'])\n\
snapshot_root = Path(snapshot_download(repo_id=repo_id, revision={revision_json}, allow_patterns=allow_patterns))\n\
destination = Path({destination_json})\n\
destination.mkdir(parents=True, exist_ok=True)\n\
source_checkpoint = snapshot_root / checkpoint_relative\n\
target_checkpoint = destination / checkpoint_relative\n\
if not source_checkpoint.is_file(): raise FileNotFoundError(f'No model.safetensors found for {{repo_id}}/{{subfolder}}')\n\
target_checkpoint.parent.mkdir(parents=True, exist_ok=True)\n\
shutil.copy2(source_checkpoint, target_checkpoint)\n\
tokenizer_relatives = [Path('tokenizer')] + ([Path(f'{{subfolder}}/tokenizer')] if subfolder else [])\n\
[shutil.copytree(snapshot_root / relative, destination / relative, dirs_exist_ok=True) for relative in tokenizer_relatives if (snapshot_root / relative).is_dir()]"
            );
            let mut command = Command::new(&python);
            command.args(["-c", &code]);
            let site_packages = runtime.join("env").join("Lib").join("site-packages");
            if site_packages.is_dir() {
                command.env("PYTHONPATH", site_packages);
            }
            let hf_home = root.join("models").join("hf-cache");
            command.env("HF_HOME", &hf_home);
            command.env("HF_HUB_CACHE", hf_home.join("hub"));
            command.env("TORCH_HOME", root.join("models").join("torch-cache"));
            command.env("PYTHONNOUSERSITE", "1");
            #[cfg(target_os = "windows")]
            command.creation_flags(CREATE_NO_WINDOW);
            let output = command.output().map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            Ok(InstallResult {
                component,
                installed: model_dir.is_dir(),
                message: "選択した音声モデルをアプリ内へ保存しました。".to_string(),
                path: model_dir.to_string_lossy().into_owned(),
            })
        }
        _ => Err("指定されたインストール項目は利用できません。".to_string()),
    }
}

fn install_environment_sync(component: String) -> Result<InstallResult, String> {
    if component != "auto" {
        return install_environment_one(component);
    }
    let paths = ensure_directories()?;
    let root = PathBuf::from(&paths.root);
    let order = [
        "runtime",
        "python",
        "sources",
        "dependencies",
        "model",
        "ffmpeg",
    ];
    let environment = environment_info(&root);
    let missing: Vec<&str> = environment
        .components
        .iter()
        .filter(|item| item.required && !item.installed)
        .map(|item| item.id.as_str())
        .collect();
    if missing.is_empty() {
        return Ok(InstallResult {
            component,
            installed: true,
            message: "必要なコンポーネントはすべて準備済みです。".to_string(),
            path: root.to_string_lossy().into_owned(),
        });
    }
    let mut completed = Vec::new();
    for item in order {
        if missing.contains(&item) {
            completed.push(install_environment_one(item.to_string())?.message);
        }
    }
    let remaining = environment_info(&root)
        .components
        .iter()
        .filter(|item| item.required && !item.installed)
        .map(|item| item.label.clone())
        .collect::<Vec<_>>();
    Ok(InstallResult {
        component,
        installed: remaining.is_empty(),
        message: if remaining.is_empty() {
            format!("環境の準備が完了しました。{}", completed.join(" "))
        } else {
            format!(
                "一部の準備が完了しました。未準備: {}。{}",
                remaining.join("、"),
                completed.join(" ")
            )
        },
        path: root.to_string_lossy().into_owned(),
    })
}

#[tauri::command(rename_all = "camelCase")]
async fn install_environment(component: String) -> Result<InstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || install_environment_sync(component))
        .await
        .map_err(|error| format!("環境の準備に失敗しました: {error}"))?
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            initialize_app,
            check_environment,
            prepare_runtime,
            acknowledge_notice,
            list_voices,
            get_voice,
            save_voice,
            delete_voice,
            get_tts_config,
            save_tts_config,
            get_tts_status,
            start_tts,
            stop_tts,
            restart_tts,
            generate_speech,
            favorite_generation,
            unfavorite_generation,
            list_favorites,
            export_favorite,
            open_audio_folder,
            install_environment
        ]);
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building IrodoriStudio");
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            let runtime = app_handle.state::<RuntimeState>();
            if let Ok(paths) = ensure_directories() {
                if let Ok(config) = read_tts_config(&paths) {
                    if config.stop_on_exit {
                        let _ = stop_process(&runtime, &paths, &config);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hf_checkpoint_source_splits_quantized_variant() {
        assert_eq!(
            split_hf_checkpoint_source("Aratako/Irodori-TTS-v4.1-Small-Quantized/int8-weight-only")
                .expect("valid Hugging Face source"),
            HfCheckpointSource {
                repo_id: "Aratako/Irodori-TTS-v4.1-Small-Quantized".to_string(),
                subfolder: Some("int8-weight-only".to_string()),
            }
        );
    }

    #[test]
    fn hf_checkpoint_source_keeps_plain_repository() {
        assert_eq!(
            split_hf_checkpoint_source("Aratako/Irodori-TTS-v4.1-Small")
                .expect("valid Hugging Face source"),
            HfCheckpointSource {
                repo_id: "Aratako/Irodori-TTS-v4.1-Small".to_string(),
                subfolder: None,
            }
        );
    }

    #[test]
    fn hf_checkpoint_source_rejects_too_many_path_parts() {
        assert!(split_hf_checkpoint_source("owner/repository/variant/extra").is_err());
    }

    #[test]
    fn server_base_url_adds_configured_port() {
        let mut config = default_tts_config().expect("default config");
        config.port = 8088;
        assert_eq!(server_base_url(&config), "http://127.0.0.1:8088");
    }

    #[test]
    fn server_base_url_keeps_explicit_port() {
        let mut config = default_tts_config().expect("default config");
        config.server_url = "http://localhost:9090/".to_string();
        config.port = 8088;
        assert_eq!(server_base_url(&config), "http://localhost:9090");
    }

    #[test]
    fn portable_config_rebases_old_bundle_paths() {
        let old_root = PathBuf::from(r"C:\old\IrodoriStudio");
        let new_root = PathBuf::from(r"D:\new\IrodoriStudio");
        let mut config = default_tts_config().expect("default config");
        config.portable_root = None;
        config.server_root = old_root.join("server").to_string_lossy().into_owned();
        config.irodori_root = old_root.join("irodori").to_string_lossy().into_owned();
        config.python_path = old_root
            .join("runtime")
            .join("env")
            .join("Scripts")
            .join("python.exe")
            .to_string_lossy()
            .into_owned();
        config.voices_dir = old_root
            .join("data")
            .join("voices")
            .to_string_lossy()
            .into_owned();

        assert!(rebase_portable_config_paths(&mut config, &new_root));
        assert_eq!(
            config.server_root,
            new_root.join("server").to_string_lossy()
        );
        assert_eq!(
            config.irodori_root,
            new_root.join("irodori").to_string_lossy()
        );
        assert_eq!(
            config.python_path.to_ascii_lowercase(),
            new_root
                .join("runtime")
                .join("env")
                .join("Scripts")
                .join("python.exe")
                .to_string_lossy()
                .to_ascii_lowercase()
        );
        assert_eq!(
            config.voices_dir,
            new_root.join("data").join("voices").to_string_lossy()
        );
        assert_eq!(
            config.portable_root,
            Some(new_root.to_string_lossy().into_owned())
        );
    }
}
