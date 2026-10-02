import { useEffect, useState } from "react";
import type { Notice, ServiceState, Voice } from "../types";
import { copyText, errorReportText } from "../utils";

export function VoiceAvatar({
  voice,
  large = false,
}: {
  voice?: Pick<Voice, "name" | "iconDataUrl"> | null;
  large?: boolean;
}) {
  const icon = voice?.iconDataUrl;
  return (
    <span className={`voice-avatar${large ? " large" : ""}${icon ? " image" : ""}`}>
      {icon ? <img src={icon} alt="" /> : (voice?.name.slice(0, 1) ?? "V")}
    </span>
  );
}
export function StatusRow({
  label,
  state,
  detail,
  readyLabel,
}: {
  label: string;
  state: ServiceState;
  detail: string;
  readyLabel?: string;
}) {
  const labelMap: Record<ServiceState, string> = {
    ready: readyLabel ?? (label.includes("サーバー") ? "サーバー接続済み" : "利用可能"),
    processing: "起動中",
    warning: "確認が必要",
    error: "停止中",
  };
  return (
    <div className="status-row">
      <span className={`status-dot ${state}`} />
      <div>
        <b>
          {label} · {labelMap[state]}
        </b>
        <small>{detail}</small>
      </div>
    </div>
  );
}

export function EnvTile({
  label,
  value,
  ok,
  warning = false,
}: {
  label: string;
  value: string;
  ok: boolean;
  warning?: boolean;
}) {
  return (
    <div className="env-tile">
      <span>{label}</span>
      <b>{value}</b>
      <small className={ok ? "ok" : warning ? "warning" : "bad"}>
        {ok ? "✓ 使用可能" : warning ? "! CPUを使用" : "確認が必要"}
      </small>
    </div>
  );
}

export function DiagLine({
  label,
  value,
  state,
}: {
  label: string;
  value: string;
  state: "ok" | "warning" | "muted";
}) {
  return (
    <div className="diag-line">
      <span className={`status-dot ${state}`} />
      <b>{label}</b>
      <code>{value}</code>
    </div>
  );
}
export function Toast({ notice, onClose }: { notice: Notice | null; onClose: () => void }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  useEffect(() => {
    setDetailOpen(false);
    setCopied(false);
    setActionBusy(false);
    if (!notice || notice.kind === "error") return;
    const timer = window.setTimeout(onClose, 5200);
    return () => window.clearTimeout(timer);
  }, [notice, onClose]);
  if (!notice) return null;
  const activeNotice = notice;
  async function copyReport() {
    const ok = await copyText(errorReportText(activeNotice));
    setCopied(ok);
  }
  async function runAction() {
    if (!activeNotice.action || actionBusy) return;
    setActionBusy(true);
    try {
      await activeNotice.action.onClick();
    } finally {
      setActionBusy(false);
    }
  }
  return (
    <div className={`toast ${activeNotice.kind}`} role="status">
      <span className="toast-icon">
        {activeNotice.kind === "error" ? "!" : activeNotice.kind === "warning" ? "△" : "✓"}
      </span>
      <div className="toast-copy">
        <b>{activeNotice.title}</b>
        <p>{activeNotice.body}</p>
        {activeNotice.action && (
          <button className="toast-action-button" disabled={actionBusy} onClick={() => void runAction()}>
            {actionBusy ? "切り替えています…" : activeNotice.action.label}
          </button>
        )}
        {activeNotice.detail && (
          <>
            <button className="toast-detail-button" onClick={() => setDetailOpen((current) => !current)}>
              詳細を見る
            </button>
            {detailOpen && <pre>{activeNotice.detail}</pre>}
          </>
        )}
        {activeNotice.kind === "error" && (
          <button className="toast-copy-button" onClick={() => void copyReport()}>
            {copied ? "コピーしました" : "報告用テキストをコピー"}
          </button>
        )}
      </div>
      <button className="toast-close" aria-label="通知を閉じる" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
