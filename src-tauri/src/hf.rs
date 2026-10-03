// Hugging Faceのモデル検索・互換性確認・導入。
// 数GBを落としてから「使えなかった」とならないよう、導入前にsafetensorsのヘッダーだけを取得して
// Irodori-TTSのチェックポイントかどうかを確認する。

use crate::download::{self, Expected};
use crate::{
    emit_model_progress, model_destination, split_hf_checkpoint_source, InstallResult,
    ModelInstallProgress,
};
use reqwest::blocking::Client;
use reqwest::header::RANGE;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::Path;
use tauri::AppHandle;

pub const MARKER_FILE: &str = ".irodori-model.json";
const MAX_HEADER_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct TreeEntry {
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    lfs: Option<LfsInfo>,
}

#[derive(Debug, Deserialize)]
struct LfsInfo {
    oid: String,
    size: u64,
}

#[derive(Debug, Deserialize)]
struct RevisionInfo {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct SearchEntry {
    id: String,
    #[serde(default)]
    downloads: Option<u64>,
    #[serde(default)]
    likes: Option<u64>,
    #[serde(default)]
    siblings: Vec<Sibling>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    library_name: Option<String>,
}

/// PyTorch版のIrodori-TTSでは読めない変換済み形式（Apple MLX・GGUF・ONNXなど）。
/// テンソル名が同じでも中身の並びが違うため、ヘッダー確認だけでは見分けられない。
const FOREIGN_FORMATS: [&str; 5] = ["mlx", "mlx-audio", "gguf", "ggml", "onnx"];
/// チェックポイントと同じ名前のファイルを持つが、TTS本体ではないフォルダ（音声コーデックなど）。
const NON_CHECKPOINT_FOLDERS: [&str; 2] = ["dacvae", "codec"];

impl SearchEntry {
    fn is_foreign_format(&self) -> bool {
        // タグが付いていない変換版もあるため、リポジトリ名に含まれる形式名も見る。
        let name = self.id.to_ascii_lowercase();
        let named_foreign = ["-mlx", "_mlx", "mlx-", "gguf", "ggml", "onnx"]
            .iter()
            .any(|marker| name.contains(marker));
        named_foreign
            || self
                .library_name
            .iter()
            .chain(self.tags.iter())
            .any(|tag| FOREIGN_FORMATS.contains(&tag.to_ascii_lowercase().as_str()))
    }
}

#[derive(Debug, Deserialize)]
struct Sibling {
    rfilename: String,
}

/// 検索結果。`installable` には導入できるモデルID（owner/model または owner/model/variant）が入る。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub downloads: Option<u64>,
    pub likes: Option<u64>,
    pub installable: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledFile {
    pub path: String,
    pub size: u64,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMarker {
    pub model: String,
    /// 利用者が指定したrevision（ブランチ名やタグを含む）
    pub requested_revision: String,
    /// 実際に取得したコミット
    pub commit: String,
    pub files: Vec<InstalledFile>,
}

pub fn read_marker(destination: &Path) -> Option<InstalledMarker> {
    let text = fs::read_to_string(destination.join(MARKER_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

fn api_get<T: for<'de> Deserialize<'de>>(client: &Client, url: &str, what: &str) -> Result<T, String> {
    client
        .get(url)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("{what}を取得できません: {error}"))?
        .json::<T>()
        .map_err(|error| format!("{what}を読み込めません: {error}"))
}

/// リポジトリ内のファイル一覧から、導入できるチェックポイントの場所を探す。
/// tokenizerは同梱されていなくても実行時に取得されるため条件にしない。
fn installable_variants<'a>(repo_id: &str, files: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut variants = Vec::new();
    for file in files.collect::<BTreeSet<_>>() {
        let Some(folder) = file.strip_suffix("model.safetensors") else {
            continue;
        };
        let folder = folder.trim_end_matches('/');
        if folder.is_empty() {
            variants.push(repo_id.to_string());
        } else if !folder.contains('/') && !NON_CHECKPOINT_FOLDERS.contains(&folder) {
            // owner/model/variant の形式までしか扱えないため、1階層のフォルダだけを対象にする。
            variants.push(format!("{repo_id}/{folder}"));
        }
    }
    variants
}

pub fn search(query: &str) -> Result<Vec<SearchResult>, String> {
    let query = query.trim();
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let client = download::client()?;
    let entries = client
        .get("https://huggingface.co/api/models")
        .query(&[("search", query), ("limit", "100"), ("sort", "downloads"), ("full", "true")])
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("Hugging Faceを検索できません: {error}"))?
        .json::<Vec<SearchEntry>>()
        .map_err(|error| format!("Hugging Faceの検索結果を読み込めません: {error}"))?;
    Ok(entries
        .into_iter()
        .filter(|entry| !entry.is_foreign_format())
        .map(|entry| SearchResult {
            installable: installable_variants(
                &entry.id,
                entry.siblings.iter().map(|sibling| sibling.rfilename.as_str()),
            ),
            id: entry.id,
            downloads: entry.downloads,
            likes: entry.likes,
        })
        .filter(|result| !result.installable.is_empty())
        .collect())
}

fn resolve_url(repo_id: &str, commit: &str, path: &str) -> String {
    format!("https://huggingface.co/{repo_id}/resolve/{commit}/{path}")
}

/// safetensorsのヘッダーを読む。ファイル全体は取得しない。
fn fetch_safetensors_header(client: &Client, url: &str) -> Result<Map<String, Value>, String> {
    let fetch_range = |start: u64, end: u64| -> Result<Vec<u8>, String> {
        let mut response = client
            .get(url)
            .header(RANGE, format!("bytes={start}-{end}"))
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|error| format!("モデル情報を取得できません: {error}"))?;
        let mut bytes = Vec::new();
        response
            .by_ref()
            .take(end - start + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("モデル情報を取得できません: {error}"))?;
        Ok(bytes)
    };
    let length_bytes = fetch_range(0, 7)?;
    let length = u64::from_le_bytes(
        length_bytes
            .get(..8)
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or("モデル情報の形式が正しくありません。")?,
    );
    if length == 0 || length > MAX_HEADER_BYTES {
        return Err("モデル情報の形式が正しくありません。".to_string());
    }
    let header = fetch_range(8, 8 + length - 1)?;
    serde_json::from_slice::<Map<String, Value>>(&header)
        .map_err(|_| "モデル情報の形式が正しくありません。".to_string())
}

/// 同梱しているIrodori-TTS（IRODORI_TTS_REVISION）のモデルが持つ最上位モジュール。
/// 読み込みはstrictなload_state_dictのため、これ以外のモジュールを含む派生モデル
/// （画像で条件付けするものや、新しい版の機能を使うものなど）は読み込めない。
const KNOWN_MODULES: [&str; 14] = [
    "blocks",
    "caption_encoder",
    "caption_norm",
    "cond_module",
    "delta_cond_module",
    "duration_predictor",
    "in_proj",
    "out_norm",
    "out_proj",
    "pretrained_text_backbone",
    "speaker_encoder",
    "speaker_norm",
    "text_encoder",
    "text_norm",
];
/// 同梱のIrodori-TTS（IRODORI_TTS_REVISION）が読み込めるモデル設定（config_json）の項目。
/// irodori_tts/config.py の ModelConfig の全項目と、inference_runtime.py が生成用に受け付ける4項目。
/// これ以外の項目があると読み込み時に「Unknown keys」で失敗する。revisionを上げたら作り直すこと。
const KNOWN_CONFIG_KEYS: [&str; 52] = [
    "flow_parameterization",
    "latent_dim",
    "latent_patch_size",
    "model_dim",
    "num_layers",
    "num_heads",
    "mlp_ratio",
    "text_mlp_ratio",
    "speaker_mlp_ratio",
    "dropout",
    "text_vocab_size",
    "text_tokenizer_repo",
    "text_encoder_revision",
    "text_add_bos",
    "text_encoder_type",
    "pretrained_projector_type",
    "pretrained_projector_hidden_ratio",
    "pretrained_projector_dropout",
    "text_dim",
    "text_layers",
    "text_heads",
    "use_caption_condition",
    "use_speaker_condition",
    "caption_vocab_size",
    "caption_tokenizer_repo",
    "caption_add_bos",
    "caption_dim",
    "caption_layers",
    "caption_heads",
    "caption_mlp_ratio",
    "speaker_dim",
    "speaker_layers",
    "speaker_heads",
    "speaker_patch_size",
    "timestep_embed_dim",
    "adaln_rank",
    "norm_eps",
    "use_duration_predictor",
    "duration_aux_dim",
    "duration_hidden_dim",
    "duration_layers",
    "duration_dropout",
    "duration_attention_heads",
    "duration_architecture",
    "duration_token_init_frames",
    "duration_speaker_fusion",
    "duration_caption_fusion",
    "duration_caption_pooling",
    "max_text_len",
    "max_caption_len",
    "fixed_target_latent_steps",
    "ref_max_seconds",
];
/// Irodori-TTSのモデルなら必ず持つモジュール。
const REQUIRED_MODULES: [&str; 5] = ["blocks", "cond_module", "in_proj", "out_proj", "text_encoder"];

/// safetensorsのヘッダーから、同梱のIrodori-TTSで読み込めるチェックポイントかを判定する。
fn check_compatibility(header: &Map<String, Value>) -> Result<(), String> {
    let modules = header
        .keys()
        .filter(|key| key.as_str() != "__metadata__")
        .filter_map(|key| key.split('.').next())
        .collect::<BTreeSet<_>>();
    let has_config = header
        .get("__metadata__")
        .and_then(|metadata| metadata.get("config_json"))
        .is_some();
    if !has_config || REQUIRED_MODULES.iter().any(|module| !modules.contains(module)) {
        return Err("Irodori-TTS用のモデルではありません。".to_string());
    }
    let unknown = modules
        .iter()
        .filter(|module| !KNOWN_MODULES.contains(module))
        .copied()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(format!(
            "Irodori-TTSの派生モデルで、このアプリの音声生成プログラムには無い機能（{}）を使っています。",
            unknown.join(", ")
        ));
    }
    let config = header
        .get("__metadata__")
        .and_then(|metadata| metadata.get("config_json"))
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str::<Map<String, Value>>(text).ok())
        .ok_or("Irodori-TTS用のモデルではありません。")?;
    let unknown_settings = config
        .keys()
        .filter(|key| !KNOWN_CONFIG_KEYS.contains(&key.as_str()))
        .map(String::as_str)
        .collect::<Vec<_>>();
    if !unknown_settings.is_empty() {
        return Err(format!(
            "このアプリの音声生成プログラムより新しい形式のモデルで、読み込めない設定（{}）があります。",
            unknown_settings.join(", ")
        ));
    }
    Ok(())
}

pub fn install(
    root: &Path,
    model: &str,
    revision: &str,
    app: Option<&AppHandle>,
) -> Result<InstallResult, String> {
    let source = split_hf_checkpoint_source(model)?;
    let revision = match revision.trim() {
        "" => "main",
        value => value,
    };
    let client = download::client()?;
    let commit = api_get::<RevisionInfo>(
        &client,
        &format!("https://huggingface.co/api/models/{}/revision/{revision}", source.repo_id),
        "モデルの版情報",
    )?
    .sha;
    let destination = model_destination(root, model);
    let previous = read_marker(&destination);
    if previous.as_ref().is_some_and(|marker| {
        marker.commit == commit
            && marker
                .files
                .iter()
                .all(|file| file_len(&destination.join(&file.path)) == Some(file.size))
    }) {
        emit_model_progress(app, done_progress(model, 0));
        return Ok(result(model, &destination, "このモデルは導入済みです。"));
    }

    let entries = client
        .get(format!("https://huggingface.co/api/models/{}/tree/{commit}", source.repo_id))
        .query(&[("recursive", "true"), ("expand", "false")])
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("モデルのファイル一覧を取得できません: {error}"))?
        .json::<Vec<TreeEntry>>()
        .map_err(|error| format!("モデルのファイル一覧を読み込めません: {error}"))?;
    let checkpoint_path = source
        .subfolder
        .as_deref()
        .map(|folder| format!("{folder}/model.safetensors"))
        .unwrap_or_else(|| "model.safetensors".to_string());
    let variant_tokenizer = source.subfolder.as_deref().map(|folder| format!("{folder}/tokenizer/"));
    let mut files = entries
        .into_iter()
        .filter(|entry| entry.entry_type == "file")
        .filter(|entry| {
            entry.path == checkpoint_path
                || entry.path.starts_with("tokenizer/")
                || variant_tokenizer
                    .as_deref()
                    .is_some_and(|prefix| entry.path.starts_with(prefix))
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    if !files.iter().any(|entry| entry.path == checkpoint_path) {
        return Err(format!("{model} に model.safetensors が見つかりません。"));
    }

    emit_model_progress(
        app,
        ModelInstallProgress {
            model: model.to_string(),
            file: "互換性を確認しています".to_string(),
            percent: 0.0,
            downloaded_bytes: 0,
            total_bytes: 0,
        },
    );
    let header = fetch_safetensors_header(&client, &resolve_url(&source.repo_id, &commit, &checkpoint_path))?;
    if let Err(reason) = check_compatibility(&header) {
        return Err(format!("{model} は導入できません。{reason}ダウンロードは行っていません。"));
    }

    let total_bytes = files
        .iter()
        .map(|entry| entry.lfs.as_ref().map(|lfs| lfs.size).or(entry.size).unwrap_or(0))
        .sum::<u64>();
    fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
    // 途中で失敗しても、古い版のマーカーが新しいファイルを指さないよう先に消しておく。
    let _ = fs::remove_file(destination.join(MARKER_FILE));
    let mut completed = 0_u64;
    let mut installed_files = Vec::new();
    for entry in files {
        let size = entry.lfs.as_ref().map(|lfs| lfs.size).or(entry.size);
        let sha256 = entry.lfs.as_ref().map(|lfs| lfs.oid.clone());
        let expected = Expected { size, sha256: sha256.as_deref() };
        let target = destination.join(&entry.path);
        let unchanged = previous.as_ref().is_some_and(|marker| {
            marker.files.iter().any(|file| {
                file.path == entry.path && file.size == size.unwrap_or(0) && file.sha256 == sha256
            })
        }) && file_len(&target) == size;
        if !(unchanged || download::is_complete(&target, &expected)) {
            let url = resolve_url(&source.repo_id, &commit, &entry.path);
            let base = completed;
            download::download_file(&client, &url, &target, &expected, &mut |file_bytes| {
                let current = base + file_bytes;
                emit_model_progress(
                    app,
                    ModelInstallProgress {
                        model: model.to_string(),
                        file: entry.path.clone(),
                        percent: if total_bytes == 0 { 0.0 } else { current as f64 * 100.0 / total_bytes as f64 },
                        downloaded_bytes: current,
                        total_bytes,
                    },
                );
            })?;
        }
        completed += size.unwrap_or(0);
        installed_files.push(InstalledFile { path: entry.path, size: size.unwrap_or(0), sha256 });
    }
    let marker = InstalledMarker {
        model: model.to_string(),
        requested_revision: revision.to_string(),
        commit,
        files: installed_files,
    };
    fs::write(
        destination.join(MARKER_FILE),
        serde_json::to_string_pretty(&marker).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    emit_model_progress(app, done_progress(model, total_bytes));
    Ok(result(model, &destination, &format!("{model} をアプリ内へ保存しました。")))
}

fn file_len(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().filter(|meta| meta.is_file()).map(|meta| meta.len())
}

fn done_progress(model: &str, total_bytes: u64) -> ModelInstallProgress {
    ModelInstallProgress {
        model: model.to_string(),
        file: "完了".to_string(),
        percent: 100.0,
        downloaded_bytes: total_bytes,
        total_bytes,
    }
}

fn result(model: &str, destination: &Path, message: &str) -> InstallResult {
    InstallResult {
        component: "model".to_string(),
        installed: crate::installed_model_checkpoint_in(destination, model).is_some(),
        message: message.to_string(),
        path: destination.to_string_lossy().into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn variants_skip_codec_and_nested_folders() {
        let files = [
            "model.safetensors",
            "tokenizer/tokenizer.json",
            "int8-weight-only/model.safetensors",
            "dacvae/model.safetensors",
            "deep/nested/model.safetensors",
            "README.md",
        ];
        assert_eq!(
            installable_variants("a/b", files.into_iter()),
            vec!["a/b/int8-weight-only".to_string(), "a/b".to_string()]
        );
        assert!(installable_variants("a/b", ["README.md"].into_iter()).is_empty());
    }

    fn header(modules: &[&str], config: bool) -> Map<String, Value> {
        let mut header = modules
            .iter()
            .map(|module| (format!("{module}.0.weight"), json!({})))
            .collect::<Map<_, _>>();
        if config {
            header.insert("__metadata__".to_string(), json!({ "config_json": "{}" }));
        }
        header
    }

    #[test]
    fn stock_checkpoints_are_compatible() {
        let v41 = header(&KNOWN_MODULES, true);
        let v2 = header(
            &["blocks", "cond_module", "in_proj", "out_norm", "out_proj", "speaker_encoder", "speaker_norm", "text_encoder", "text_norm"],
            true,
        );
        assert!(check_compatibility(&v41).is_ok());
        assert!(check_compatibility(&v2).is_ok());
    }

    #[test]
    fn newer_config_formats_are_rejected_before_download() {
        let mut newer = header(&KNOWN_MODULES, false);
        newer.insert(
            "__metadata__".to_string(),
            json!({ "config_json": "{\"model_dim\":2048,\"future_option\":true}" }),
        );
        assert!(check_compatibility(&newer).unwrap_err().contains("future_option"));

        let mut current = header(&KNOWN_MODULES, false);
        current.insert(
            "__metadata__".to_string(),
            json!({ "config_json": "{\"model_dim\":1280,\"max_text_len\":256,\"ref_max_seconds\":120.0}" }),
        );
        assert!(check_compatibility(&current).is_ok());
    }

    #[test]
    fn forks_and_other_models_are_rejected() {
        let image_conditioned = header(
            &["blocks", "character_encoder", "cond_module", "in_proj", "out_norm", "out_proj", "text_encoder", "text_norm"],
            true,
        );
        let unrelated = header(&["encoder", "pooler"], false);
        assert!(check_compatibility(&image_conditioned).unwrap_err().contains("character_encoder"));
        assert!(check_compatibility(&unrelated).is_err());
    }
}

/// 実際のHugging Faceへ接続する確認。通常のテストでは実行しない（cargo test -- --ignored）。
#[cfg(test)]
mod network_tests {
    use super::*;

    #[test]
    #[ignore]
    fn search_returns_only_installable_irodori_repositories() {
        let results = search("Irodori-TTS").unwrap();
        assert!(!results.is_empty());
        for result in &results {
            println!("{} -> {:?}", result.id, result.installable);
        }
        assert!(results.iter().all(|result| !result.installable.is_empty()));
    }

    #[test]
    #[ignore]
    fn header_check_accepts_irodori_and_rejects_other_models() {
        let client = download::client().unwrap();
        let commit = api_get::<RevisionInfo>(
            &client,
            "https://huggingface.co/api/models/Aratako/Irodori-TTS-v4.1-Small/revision/main",
            "rev",
        )
        .unwrap()
        .sha;
        let irodori = fetch_safetensors_header(
            &client,
            &resolve_url("Aratako/Irodori-TTS-v4.1-Small", &commit, "model.safetensors"),
        )
        .unwrap();
        assert!(check_compatibility(&irodori).is_ok());
        let other = fetch_safetensors_header(
            &client,
            &resolve_url("sentence-transformers/all-MiniLM-L6-v2", "main", "model.safetensors"),
        )
        .unwrap();
        assert!(check_compatibility(&other).is_err());
    }

    #[test]
    #[ignore]
    fn real_models_are_judged_like_the_bundled_irodori_tts() {
        let client = download::client().unwrap();
        for (repo, path, expected) in [
            ("phasefield-audio/Irodori-TTS-v4.1-Anime", "model.safetensors", true),
            ("Aratako/Irodori-TTS-v4.1-Small", "model.safetensors", true),
            ("Aratako/Irodori-TTS-v4-Large", "model.safetensors", true),
            ("Aratako/Irodori-TTS-v4-Large-Quantized", "int8-weight-only/model.safetensors", true),
            ("Aratako/Irodori-TTS-v4.1-Small-MF", "model.safetensors", true),
        ] {
            let header = fetch_safetensors_header(&client, &resolve_url(repo, "main", path)).unwrap();
            let result = check_compatibility(&header);
            println!("{repo}/{path}: {:?}", result);
            assert_eq!(result.is_ok(), expected, "{repo}");
        }
    }

    #[test]
    #[ignore]
    fn download_resumes_from_a_partial_file() {
        let client = download::client().unwrap();
        let entries = client
            .get("https://huggingface.co/api/models/sentence-transformers/all-MiniLM-L6-v2/tree/main")
            .send()
            .unwrap()
            .json::<Vec<TreeEntry>>()
            .unwrap();
        let entry = entries.iter().find(|entry| entry.path == "model.safetensors").unwrap();
        let lfs = entry.lfs.as_ref().unwrap();
        let url = resolve_url("sentence-transformers/all-MiniLM-L6-v2", "main", "model.safetensors");
        let dir = std::env::temp_dir().join(format!("irodori-resume-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("model.safetensors");
        // 前半だけ取得した状態を作る
        let mut head = Vec::new();
        client
            .get(&url)
            .header(RANGE, format!("bytes=0-{}", lfs.size / 2 - 1))
            .send()
            .unwrap()
            .read_to_end(&mut head)
            .unwrap();
        fs::write(dir.join("model.safetensors.part"), &head).unwrap();
        let mut first_report = None;
        download::download_file(
            &client,
            &url,
            &target,
            &Expected { size: Some(lfs.size), sha256: Some(&lfs.oid) },
            &mut |bytes| {
                first_report.get_or_insert(bytes);
            },
        )
        .unwrap();
        assert_eq!(first_report, Some(lfs.size / 2), "should resume from the middle");
        assert_eq!(fs::metadata(&target).unwrap().len(), lfs.size);
        let _ = fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod install_tests {
    use super::*;

    fn root() -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var("IRODORI_TEST_ROOT").expect("IRODORI_TEST_ROOT"))
    }

    #[test]
    #[ignore]
    fn existing_files_are_verified_without_downloading_again() {
        let root = root();
        let model = "phasefield-audio/Irodori-TTS-v4.1-Anime/int8-weight-only";
        let started = std::time::Instant::now();
        let first = install(&root, model, "main", None).unwrap();
        println!("first: {} ({:?})", first.message, started.elapsed());
        assert!(first.installed);
        let marker = read_marker(&model_destination(&root, model)).unwrap();
        println!("commit {} files {:?}", marker.commit, marker.files.iter().map(|f| &f.path).collect::<Vec<_>>());
        let started = std::time::Instant::now();
        let second = install(&root, model, "main", None).unwrap();
        println!("second: {} ({:?})", second.message, started.elapsed());
        assert_eq!(second.message, "このモデルは導入済みです。");
    }

    #[test]
    #[ignore]
    fn non_tts_checkpoint_is_rejected_before_download() {
        let root = root();
        let model = "p1atdev/Irodori-TTS-500M-v2-Character-Voice-Tagger";
        let error = install(&root, model, "main", None).unwrap_err();
        println!("{error}");
        let destination = model_destination(&root, model);
        let downloaded = fs::read_dir(&destination).map(|entries| entries.count()).unwrap_or(0);
        assert_eq!(downloaded, 0, "nothing should be downloaded");
    }
}
