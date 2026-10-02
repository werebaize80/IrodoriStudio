// NVIDIA GPUの検出と、CUDA版PyTorchを入れてよいかの判定。
// nvidia-smiが動くだけではCUDA版が使えるとは限らないため、ドライバとGPU世代も確認する。

use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// 同梱するPyTorch（cu128版）が対応する最も古いGPU世代（Turing / RTX 20系）。
const MIN_COMPUTE_CAPABILITY: (u32, u32) = (7, 5);
/// CUDA 12系をWindowsで動かすために必要な最低ドライバ。
const MIN_DRIVER: (u32, u32) = (528, 33);

#[derive(Debug, Clone, PartialEq)]
pub struct GpuInfo {
    pub name: String,
    pub driver: String,
    pub compute_capability: Option<(u32, u32)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CudaSupport {
    Supported(GpuInfo),
    /// GPUはあるがCUDA版を使えない。理由を利用者向けの文で持つ。
    Unsupported(GpuInfo, String),
    NotFound,
}

impl CudaSupport {
    pub fn is_supported(&self) -> bool {
        matches!(self, CudaSupport::Supported(_))
    }

    pub fn summary(&self) -> String {
        match self {
            CudaSupport::Supported(gpu) => format!("{}（ドライバ {}）", gpu.name, gpu.driver),
            CudaSupport::Unsupported(gpu, reason) => format!("{}：{}", gpu.name, reason),
            CudaSupport::NotFound => "対応GPUを検出できない".to_string(),
        }
    }
}

fn parse_pair(value: &str) -> Option<(u32, u32)> {
    let mut parts = value.trim().split('.');
    let major = parts.next()?.trim().parse().ok()?;
    let minor = parts.next().unwrap_or("0").trim().parse().ok()?;
    Some((major, minor))
}

/// nvidia-smiのCSV出力（name, driver_version, compute_cap）から判定する。
/// 複数GPUがある場合は、対応している最初のGPUを使う。
pub fn classify(csv: &str) -> CudaSupport {
    let mut first_unsupported = None;
    for line in csv.lines().filter(|line| !line.trim().is_empty()) {
        let columns = line.split(',').map(str::trim).collect::<Vec<_>>();
        let gpu = GpuInfo {
            name: columns.first().copied().unwrap_or("NVIDIA GPU").to_string(),
            driver: columns.get(1).copied().unwrap_or("").to_string(),
            compute_capability: columns.get(2).and_then(|value| parse_pair(value)),
        };
        let reason = match (parse_pair(&gpu.driver), gpu.compute_capability) {
            (Some(driver), _) if driver < MIN_DRIVER => Some(format!(
                "ドライバが古いためCPUで動作します（{}.{}以上に更新するとGPUを使えます）",
                MIN_DRIVER.0, MIN_DRIVER.1
            )),
            (_, Some(capability)) if capability < MIN_COMPUTE_CAPABILITY => {
                Some("このGPUの世代はPyTorchが対応していないためCPUで動作します".to_string())
            }
            _ => None,
        };
        match reason {
            None => return CudaSupport::Supported(gpu),
            Some(reason) => {
                first_unsupported.get_or_insert(CudaSupport::Unsupported(gpu, reason));
            }
        }
    }
    first_unsupported.unwrap_or(CudaSupport::NotFound)
}

pub fn detect() -> CudaSupport {
    let mut command = Command::new("nvidia-smi");
    command.args([
        "--query-gpu=name,driver_version,compute_cap",
        "--format=csv,noheader",
    ]);
    #[cfg(target_os = "windows")]
    command.creation_flags(crate::CREATE_NO_WINDOW);
    let output = match command.output() {
        Ok(output) if output.status.success() => output,
        // 古いドライバはcompute_capを知らないため、項目を減らして再試行する。
        _ => {
            let mut fallback = Command::new("nvidia-smi");
            fallback.args(["--query-gpu=name,driver_version", "--format=csv,noheader"]);
            #[cfg(target_os = "windows")]
            fallback.creation_flags(crate::CREATE_NO_WINDOW);
            match fallback.output() {
                Ok(output) if output.status.success() => output,
                _ => return CudaSupport::NotFound,
            }
        }
    };
    classify(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modern_gpu_is_supported() {
        assert!(classify("NVIDIA GeForce RTX 4070, 576.02, 8.9").is_supported());
    }

    #[test]
    fn old_driver_or_old_gpu_falls_back_to_cpu() {
        assert!(matches!(
            classify("NVIDIA GeForce RTX 3060, 472.12, 8.6"),
            CudaSupport::Unsupported(..)
        ));
        assert!(matches!(
            classify("NVIDIA GeForce GTX 1080, 576.02, 6.1"),
            CudaSupport::Unsupported(..)
        ));
    }

    #[test]
    fn missing_compute_capability_relies_on_driver_only() {
        assert!(classify("NVIDIA GeForce RTX 2060, 560.94").is_supported());
    }

    #[test]
    fn any_supported_gpu_wins() {
        assert!(classify("GTX 1050, 576.02, 6.1\nRTX 4090, 576.02, 8.9").is_supported());
        assert_eq!(classify(""), CudaSupport::NotFound);
    }
}
