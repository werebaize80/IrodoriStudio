import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { EnvironmentInfo, ModelInstallProgress } from "../types";
import { INSTALL_ORDER } from "../constants";
import { estimateRequiredGb, formatBytes, isTauriRuntime } from "../utils";

export function AutoInstallPanel({
  environment,
  installing,
  message,
  onInstall,
}: {
  environment: EnvironmentInfo;
  installing: string;
  message: string;
  onInstall: (component: string) => Promise<boolean | void>;
}) {
  const actions = [
    { id: "runtime", label: "実行環境", detail: "音声生成に必要な基本機能", required: true },
    { id: "python", label: "Python", detail: "音声処理を実行するための機能", required: true },
    { id: "sources", label: "音声生成プログラム", detail: "Irodori-TTS / Server", required: true },
    { id: "dependencies", label: "必要な部品", detail: "CPUまたはGPU用の部品", required: true },
    { id: "model", label: "音声モデル", detail: "音声を生成するためのデータ", required: true },
    { id: "ffmpeg", label: "音声変換機能", detail: "音声ファイルを変換するための機能", required: true },
  ];
  const statuses = environment.components ?? [];
  const missing = statuses.filter((item) => item.required && !item.installed);
  const [liveLine, setLiveLine] = useState("");
  const [modelProgress, setModelProgress] = useState<ModelInstallProgress | null>(null);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    const stops: (() => void)[] = [];
    const keep = (stop: () => void) => (active ? stops.push(stop) : stop());
    void listen<{ component: string; message: string }>("install-progress", (event) =>
      setLiveLine(event.payload.message),
    ).then(keep);
    void listen<ModelInstallProgress>("model-install-progress", (event) =>
      setModelProgress(event.payload),
    ).then(keep);
    return () => {
      active = false;
      stops.forEach((stop) => stop());
    };
  }, []);
  useEffect(() => {
    setLiveLine("");
    setModelProgress(null);
  }, [installing]);
  const neededGb = estimateRequiredGb(
    missing.map((item) => item.id),
    environment.cudaAvailable,
  );
  const lowSpace = environment.freeSpaceGb != null && neededGb > 0 && environment.freeSpaceGb < neededGb;
  async function installAll() {
    const missingIds = INSTALL_ORDER.filter((id) =>
      statuses.some((item) => item.id === id && !item.installed),
    );
    for (const id of missingIds) {
      const success = await onInstall(id);
      if (success === false) break;
    }
  }
  return (
    <div className="surface install-panel">
      <div className="page-intro">
        <span className="section-label">環境の自動確認</span>
        <h2>{missing.length ? `${missing.length}項目の準備が必要です` : "必要な項目は準備済みです"}</h2>
        <p>使用できる項目を自動で確認しました。必須項目を1つずつ順番に準備します。</p>
        {neededGb > 0 && (
          <p className={lowSpace ? "inline-message warning" : "muted"}>
            ダウンロード量の目安: 約{neededGb}GB
            {environment.freeSpaceGb != null && `（空き容量 ${environment.freeSpaceGb.toFixed(1)}GB）`}
            {lowSpace &&
              " · 空き容量が足りない可能性があります。不要なファイルを削除してから実行してください。"}
            {!lowSpace &&
              " · 回線によっては30分以上かかります。途中で止まっても、もう一度実行すると続きから再開します。"}
          </p>
        )}
      </div>
      <button
        className="button primary"
        onClick={() => void installAll()}
        disabled={Boolean(installing) || !missing.length}
      >
        {installing ? "準備しています…" : missing.length ? "不足項目をまとめて準備" : "準備完了"}
      </button>
      <div className="install-actions">
        {actions.map(({ id, label, detail }) => {
          const status = statuses.find((item) => item.id === id);
          const installed = status?.installed ?? false;
          return (
            <button
              key={id}
              className={installed ? "installed" : ""}
              onClick={() => void onInstall(id)}
              disabled={Boolean(installing) || installed}
            >
              <span>{installing === id ? "◌" : installed ? "✓" : "＋"}</span>
              <div>
                <b>{label}</b>
                <small>{installed ? "準備済み" : detail}</small>
              </div>
              <em>{installed ? "完了" : "未準備"}</em>
            </button>
          );
        })}
      </div>
      {message && (
        <div className="install-message">
          <span className={`status-dot ${installing ? "processing" : "ready"}`} />
          {message}
        </div>
      )}
      {installing && modelProgress && modelProgress.totalBytes > 0 && (
        <div className="install-live">
          <div className="progress-track">
            <span style={{ width: `${Math.min(100, modelProgress.percent)}%` }} />
          </div>
          <small>
            {modelProgress.file} · {formatBytes(modelProgress.downloadedBytes)} /{" "}
            {formatBytes(modelProgress.totalBytes)}（{modelProgress.percent.toFixed(1)}%）
          </small>
        </div>
      )}
      {installing && liveLine && !(modelProgress && modelProgress.totalBytes > 0) && (
        <div className="install-live">
          <small title={liveLine}>{liveLine}</small>
        </div>
      )}
    </div>
  );
}
