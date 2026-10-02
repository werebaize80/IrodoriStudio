import { useState } from "react";
import type { AppState, EnvironmentInfo, Notice } from "../types";
import { CLONING_NOTICE, INSTALL_LABELS, INSTALL_ORDER, NOTICE_VERSION } from "../constants";
import { call, errorText } from "../utils";
import { EnvTile } from "./common";
import { AutoInstallPanel } from "./InstallPanel";

export function NeutralSetupWizard({
  state,
  onComplete,
  onNotice,
}: {
  state: AppState;
  onComplete: () => Promise<void>;
  onNotice: (notice: Notice) => void;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [environment, setEnvironment] = useState(state.environment);
  const [step, setStep] = useState(1);
  const [installing, setInstalling] = useState("");
  const [installMessage, setInstallMessage] = useState("");
  async function check() {
    try {
      setEnvironment(await call<EnvironmentInfo>("check_environment"));
      setStep(state.noticeAcknowledgedAt ? 3 : 2);
    } catch (error) {
      setMessage(errorText(error));
    }
  }
  async function finish() {
    if (!checked) return;
    setBusy(true);
    try {
      await call("prepare_runtime");
      await call("acknowledge_notice", { version: NOTICE_VERSION });
      setInstallMessage("保存先を準備しました。必要な項目を選択してください。");
      setStep(3);
    } catch (error) {
      setMessage(errorText(error));
      onNotice({
        kind: "error",
        title: "初回設定に失敗しました",
        body: "アプリの保存先を準備できませんでした。",
        detail: errorText(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function install(component: string): Promise<boolean> {
    if (component === "auto") {
      const targets = INSTALL_ORDER.filter((id) =>
        (environment.components ?? []).some((item) => item.id === id && !item.installed),
      );
      for (const target of targets) {
        if (!(await install(target))) return false;
      }
      setInstallMessage(
        targets.length ? "不足項目の準備が完了しました。" : "必要な項目はすべて準備済みです。",
      );
      return true;
    }
    setInstalling(component);
    setInstallMessage(`${INSTALL_LABELS[component] ?? component}を準備しています…`);
    try {
      const result = await call<{ message: string }>("install_environment", { component });
      setInstallMessage(result.message);
      setEnvironment(await call<EnvironmentInfo>("check_environment"));
      return true;
    } catch (error) {
      setInstallMessage(errorText(error));
      onNotice({
        kind: "error",
        title: "インストールに失敗しました",
        body: "インターネット接続と空き容量を確認してください。",
        detail: errorText(error),
      });
      return false;
    } finally {
      setInstalling("");
    }
  }
  return (
    <div className="setup-screen">
      <div className="setup-panel">
        <div className="setup-brand">
          <div>
            <b>IRODORI/ST</b>
            <small>初回セットアップ</small>
          </div>
        </div>
        <div className="setup-progress">
          <span className={step >= 1 ? "active" : ""}>1 環境確認</span>
          <i />
          <span className={step >= 2 ? "active" : ""}>2 利用条件</span>
          <i />
          <span className={step >= 3 ? "active" : ""}>3 準備</span>
        </div>
        {step === 1 && (
          <section className="setup-content">
            <span className="section-label">初回セットアップ</span>
            <h1>音声生成の準備</h1>
            <p>このPCで音声生成を使用できるか確認します。必要なファイルはアプリのフォルダ内に保存します。</p>
            <div className="environment-grid">
              <EnvTile label="CPU" value={environment.cpu} ok />
              <EnvTile
                label="GPU / CUDA"
                value={environment.gpu}
                ok={environment.cudaAvailable}
                warning={!environment.cudaAvailable}
              />
              <EnvTile
                label="保存先"
                value={environment.writable ? "書き込み可能" : "確認が必要"}
                ok={environment.writable}
              />
            </div>
            <div className="setup-note">
              <span>ⓘ</span>
              <div>
                <b>{environment.cudaAvailable ? "対応GPUを検出しました" : "CPUで使用できます"}</b>
                <p>
                  {environment.cudaAvailable
                    ? "GPUを使用した音声生成が可能です。"
                    : "CPUで音声生成できます。GPUを使用する場合より時間がかかることがあります。"}
                </p>
              </div>
            </div>
            <button className="button primary wide" onClick={() => void check()}>
              環境を確認して次へ <span>→</span>
            </button>
          </section>
        )}
        {step === 2 && (
          <section className="setup-content">
            <span className="section-label">利用条件</span>
            <h1>音声クローンの利用について</h1>
            <p>音声クローンを使用する前に、以下の注意事項を確認してください。</p>
            <div className="notice-scroll">
              {CLONING_NOTICE.split("\n").map((line, index) => (
                <p key={index}>{line || <>&nbsp;</>}</p>
              ))}
            </div>
            <label className="notice-check">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => setChecked(event.target.checked)}
              />
              <span>注意事項を確認し、利用条件に同意します</span>
            </label>
            <div className="button-row">
              <button className="button subtle" onClick={() => setStep(1)}>
                ← 戻る
              </button>
              <button className="button primary" disabled={!checked || busy} onClick={() => void finish()}>
                同意して次へ
              </button>
            </div>
            {message && <p className="inline-message">{message}</p>}
          </section>
        )}
        {step === 3 && (
          <section className="setup-content">
            <span className="section-label">環境の準備</span>
            <h1>不足している項目を準備</h1>
            <p>
              自動検出した不足項目だけを、アプリのフォルダ内へ準備します。後から設定画面でも実行できます。
            </p>
            <AutoInstallPanel
              environment={environment}
              installing={installing}
              message={installMessage}
              onInstall={install}
            />
            <div className="button-row">
              <button
                className="button subtle"
                disabled={Boolean(installing)}
                onClick={() => void onComplete()}
              >
                後で開く
              </button>
              <button
                className="button primary"
                disabled={Boolean(installing)}
                onClick={() => void onComplete()}
              >
                アプリを開く <span>→</span>
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
