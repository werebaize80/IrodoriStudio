// 大容量ファイル用のダウンロード処理。
// 回線が切れても `.part` から続きを取得し、サイズとSHA-256で中身を確認してから本来の名前へ置き換える。

use reqwest::blocking::Client;
use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::StatusCode;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_ATTEMPTS: u32 = 6;
/// 中身（サイズ・SHA-256）の不一致は、この回数で打ち切る。
const MAX_CONTENT_MISMATCHES: u32 = 2;
const BUFFER_SIZE: usize = 1024 * 1024;

/// ダウンロード用のHTTPクライアント。
/// blockingクライアントの `timeout` は1回の読み込みごとに効くため、全体の時間制限にはならない。
/// 60秒データが届かなければ通信が止まったとみなし、続きから再試行する。
pub fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("IrodoriStudio/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(60))
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())
}

pub struct Expected<'a> {
    pub size: Option<u64>,
    pub sha256: Option<&'a str>,
}

fn partial_path(destination: &Path) -> PathBuf {
    let mut name = destination.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; BUFFER_SIZE];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify(path: &Path, expected: &Expected) -> Result<(), String> {
    let size = fs::metadata(path).map_err(|error| error.to_string())?.len();
    if let Some(expected_size) = expected.size {
        if size != expected_size {
            return Err(format!(
                "サイズが一致しません（期待値 {expected_size} / 実際 {size} バイト）"
            ));
        }
    }
    if size == 0 {
        return Err("ダウンロードされたファイルが空です。".to_string());
    }
    if let Some(sha) = expected.sha256 {
        let actual = sha256_file(path)?;
        if !actual.eq_ignore_ascii_case(sha) {
            return Err("ファイルの内容が一致しません（SHA-256不一致）。".to_string());
        }
    }
    Ok(())
}

/// 既存ファイルが期待どおりならダウンロードを省略できるかを判定する。
pub fn is_complete(path: &Path, expected: &Expected) -> bool {
    path.is_file() && verify(path, expected).is_ok()
}

/// `url` を `destination` へ保存する。`on_progress` にはこのファイルで受け取った累計バイト数を渡す。
pub fn download_file(
    client: &Client,
    url: &str,
    destination: &Path,
    expected: &Expected,
    on_progress: &mut dyn FnMut(u64),
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let partial = partial_path(destination);
    let mut last_error = String::new();
    let mut mismatches = 0;
    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(2_u64.pow(attempt.min(4))));
        }
        match fetch_into_partial(client, url, &partial, expected, on_progress) {
            Ok(()) => {}
            Err(FetchError::Retry(error)) => {
                last_error = error;
                continue;
            }
            Err(FetchError::Fatal(error)) => {
                return Err(format!("{url}: {error}"));
            }
        }
        if let Err(error) = verify(&partial, expected) {
            // 中身が壊れている場合は続きから取っても直らないため、最初から取り直す。
            // ただし2回続けて一致しないなら配布元のファイル自体が違うので、通信を無駄にせず中止する。
            let _ = fs::remove_file(&partial);
            mismatches += 1;
            if mismatches >= MAX_CONTENT_MISMATCHES {
                return Err(format!(
                    "{url}: ダウンロードしたファイルが想定と異なるため中止しました。{error}"
                ));
            }
            last_error = error;
            continue;
        }
        if destination.is_file() {
            fs::remove_file(destination).map_err(|error| error.to_string())?;
        }
        fs::rename(&partial, destination).map_err(|error| error.to_string())?;
        return Ok(());
    }
    Err(format!(
        "{url}: {MAX_ATTEMPTS}回試しましたがダウンロードできませんでした。{last_error}"
    ))
}

enum FetchError {
    Retry(String),
    Fatal(String),
}

fn fetch_into_partial(
    client: &Client,
    url: &str,
    partial: &Path,
    expected: &Expected,
    on_progress: &mut dyn FnMut(u64),
) -> Result<(), FetchError> {
    let mut offset = fs::metadata(partial).map(|meta| meta.len()).unwrap_or(0);
    if expected.size.is_some_and(|size| offset >= size) {
        if expected.size == Some(offset) {
            on_progress(offset);
            return Ok(());
        }
        let _ = fs::remove_file(partial);
        offset = 0;
    }
    let mut request = client.get(url);
    if offset > 0 {
        request = request.header(RANGE, format!("bytes={offset}-"));
    }
    let mut response = request
        .send()
        .map_err(|error| FetchError::Retry(format!("接続できません: {error}")))?;
    let status = response.status();
    let append = match status {
        StatusCode::PARTIAL_CONTENT => {
            // サーバーが要求と違う位置から返した場合は取り直す。
            let starts_at_offset = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("bytes "))
                .and_then(|value| value.split('-').next())
                .and_then(|value| value.parse::<u64>().ok())
                == Some(offset);
            if !starts_at_offset {
                let _ = fs::remove_file(partial);
                return Err(FetchError::Retry("再開位置が一致しません".to_string()));
            }
            true
        }
        StatusCode::OK => false,
        StatusCode::RANGE_NOT_SATISFIABLE => {
            let _ = fs::remove_file(partial);
            return Err(FetchError::Retry("途中ファイルを破棄して取り直します".to_string()));
        }
        status if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS => {
            return Err(FetchError::Retry(format!("HTTP {status}")));
        }
        status => return Err(FetchError::Fatal(format!("HTTP {status}"))),
    };
    let mut file = if append {
        OpenOptions::new().append(true).open(partial)
    } else {
        offset = 0;
        File::create(partial)
    }
    .map_err(|error| FetchError::Fatal(error.to_string()))?;
    on_progress(offset);
    let mut buffer = vec![0_u8; BUFFER_SIZE];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| FetchError::Retry(format!("通信が途切れました: {error}")))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| FetchError::Fatal(format!("保存できません: {error}")))?;
        offset += read as u64;
        on_progress(offset);
    }
    file.flush()
        .map_err(|error| FetchError::Fatal(error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_path_keeps_the_original_extension() {
        assert_eq!(
            partial_path(Path::new("models/a/model.safetensors")),
            PathBuf::from("models/a/model.safetensors.part")
        );
    }

    #[test]
    fn verify_checks_size_and_hash() {
        let path = std::env::temp_dir().join(format!("irodori-dl-{}", uuid::Uuid::new_v4()));
        fs::write(&path, b"abc").unwrap();
        let sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(verify(&path, &Expected { size: Some(3), sha256: Some(sha) }).is_ok());
        assert!(verify(&path, &Expected { size: Some(4), sha256: None }).is_err());
        assert!(verify(&path, &Expected { size: None, sha256: Some(&"0".repeat(64)) }).is_err());
        let _ = fs::remove_file(path);
    }
}
