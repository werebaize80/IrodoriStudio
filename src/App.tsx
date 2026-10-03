import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { AppState, Notice, Page, TtsConfig, TtsStatus, Voice } from "./types";
import { NOTICE_VERSION, navItems } from "./constants";
import { version as appVersion } from "../package.json";
import { call, errorText, explainError, isTauriRuntime, isUnsupportedCudaKernel, serviceState } from "./utils";
import { Toast } from "./components/common";
import { NeutralSetupWizard } from "./components/SetupWizard";
import { GeneratePage } from "./pages/GeneratePage";
import { FavoritesPage } from "./pages/FavoritesPage";
import { FriendlyVoiceEditorStandalone, VoicesPage } from "./pages/VoicesPage";
import { SettingsPage, type SettingsTab } from "./pages/SettingsPage";
import { LicensePage } from "./pages/LicensePage";

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>("generate");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [fatalError, setFatalError] = useState("");
  async function load() {
    try {
      const nextState = await call<AppState>("initialize_app");
      setState(nextState);
      setVoices(await call<Voice[]>("list_voices"));
    } catch (error) {
      if (!isTauriRuntime()) {
        setState({
          setupRequired: false,
          noticeVersion: NOTICE_VERSION,
          noticeAcknowledgedAt: new Date().toISOString(),
          paths: {
            root: "アプリフォルダ",
            data: "アプリフォルダ\\data",
            voices: "アプリフォルダ\\data\\voices",
            favorites: "アプリフォルダ\\data\\favorites",
            history: "アプリフォルダ\\data\\history",
            temp: "アプリフォルダ\\data\\temp",
            models: "アプリフォルダ\\models",
            logs: "アプリフォルダ\\data\\logs",
          },
          environment: {
            windows: "開発ブラウザ",
            architecture: "x64",
            cpu: "—",
            gpu: "—",
            cudaAvailable: false,
            python: "アプリフォルダ\\runtime\\python",
            uv: "アプリフォルダ\\runtime\\uv.exe",
            ffmpeg: "アプリフォルダ\\runtime\\ffmpeg.exe",
            freeSpaceGb: null,
            writable: true,
            irodoriRoot: "アプリフォルダ\\irodori",
            serverRoot: "アプリフォルダ\\server",
          },
        });
        setVoices([
          {
            id: "none",
            name: "VoiceDesign（参照なし）",
            iconPath: null,
            caption: "落ち着いた自然な声",
            voiceDesign: "",
            references: [],
            updatedAt: new Date().toISOString(),
          },
        ]);
      } else setFatalError(errorText(error));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function acknowledgeNotice() {
    await call("acknowledge_notice", { version: NOTICE_VERSION });
    const next = await call<AppState>("initialize_app");
    setState({ ...next, setupRequired: false });
  }
  if (fatalError)
    return (
      <div className="fatal-screen">
        <div className="fatal-card">
          <span className="brand-mark">i</span>
          <h1>初期化できませんでした</h1>
          <p>{fatalError}</p>
          <button
            className="button primary"
            onClick={() => {
              setFatalError("");
              void load();
            }}
          >
            再試行
          </button>
        </div>
      </div>
    );
  if (!state)
    return (
      <div className="loading-screen">
        <div className="loader-orb" />
        <p>IrodoriStudioを準備中…</p>
      </div>
    );
  const editorId = new URLSearchParams(window.location.search).get("voiceEditor");
  if (editorId) return <FriendlyVoiceEditorStandalone voiceId={editorId} />;
  if (state.setupRequired)
    return (
      <>
        <NeutralSetupWizard state={state} onComplete={acknowledgeNotice} onNotice={setNotice} />
        <Toast notice={notice} onClose={() => setNotice(null)} />
      </>
    );
  return (
    <>
      <AppShell
        state={state}
        voices={voices}
        setVoices={setVoices}
        page={page}
        setPage={setPage}
        onNotice={setNotice}
      />
      <Toast notice={notice} onClose={() => setNotice(null)} />
    </>
  );
}

function AppShell({
  state,
  voices,
  setVoices,
  page,
  setPage,
  onNotice,
}: {
  state: AppState;
  voices: Voice[];
  setVoices: (voices: Voice[]) => void;
  page: Page;
  setPage: (page: Page) => void;
  onNotice: (notice: Notice) => void;
}) {
  const [ttsStatus, setTtsStatus] = useState<TtsStatus | null>(null);
  const [serverBusy, setServerBusy] = useState(false);
  const [settingsTabRequest, setSettingsTabRequest] = useState<{ tab: SettingsTab; at: number } | null>(null);
  function openSettingsTab(tab: SettingsTab) {
    setSettingsTabRequest({ tab, at: Date.now() });
    setPage("settings");
  }
  const active = navItems.find((item) => item.page === page) ?? navItems[0];
  async function refreshStatus() {
    if (!isTauriRuntime()) return;
    try {
      setTtsStatus(await call<TtsStatus>("get_tts_status"));
    } catch (error) {
      onNotice({ kind: "warning", title: "サーバー状態を取得できません", body: errorText(error) });
    }
  }
  /** 停止中なら起動し、起動中・稼働中なら確認してから再起動する（右上のボタン） */
  async function startOrRestartServer() {
    if (serverBusy) return;
    const restart = Boolean(ttsStatus?.running);
    if (
      restart &&
      !(await ask("音声生成サーバーを再起動します。生成中の処理は中断されます。", {
        title: "サーバーの再起動",
        kind: "warning",
        okLabel: "再起動",
        cancelLabel: "キャンセル",
      }))
    )
      return;
    setServerBusy(true);
    try {
      const next = await call<TtsStatus>(restart ? "restart_tts" : "start_tts");
      setTtsStatus(next);
      onNotice({
        kind: "success",
        title: restart ? "サーバーを再起動しました" : "サーバーを起動しました",
        body: next.message,
      });
    } catch (error) {
      const detail = errorText(error);
      onNotice({
        kind: "error",
        title: restart ? "サーバーを再起動できません" : "サーバーを起動できません",
        body: detail.includes("準備してください")
          ? "環境確認で必要な項目を準備してください。"
          : explainError(detail),
        detail,
      });
    } finally {
      setServerBusy(false);
    }
  }
  async function switchToCpu() {
    try {
      const current = await call<TtsConfig>("get_tts_config");
      const saved = await call<TtsConfig>("save_tts_config", {
        config: { ...current, modelDevice: "cpu", codecDevice: "cpu" },
      });
      if (ttsStatus?.running && ttsStatus.ownedByStudio) {
        setTtsStatus(await call<TtsStatus>("restart_tts"));
        onNotice({
          kind: "success",
          title: "CPUに切り替えました",
          body: "モデルと音声データをCPUに設定し、サーバーを再起動しました。もう一度生成してください。",
        });
        return;
      }
      onNotice({
        kind: "success",
        title: "CPU設定を保存しました",
        body: ttsStatus?.running
          ? "モデルと音声データをCPUに設定しました。サーバーを再起動してから生成してください。"
          : "モデルと音声データをCPUに設定しました。次回のサーバー起動から使用します。",
      });
    } catch (error) {
      onNotice({
        kind: "error",
        title: "CPU設定に切り替えられませんでした",
        body: "設定の保存またはサーバーの再起動に失敗しました。",
        detail: errorText(error),
      });
    }
  }
  function handleGenerationNotice(notice: Notice) {
    if (notice.kind !== "error" || !notice.detail || !isUnsupportedCudaKernel(notice.detail)) {
      onNotice(notice);
      return;
    }
    void call<TtsConfig>("get_tts_config")
      .then((config) => {
        const cpuAlreadySelected = config.modelDevice === "cpu" && config.codecDevice === "cpu";
        if (cpuAlreadySelected && !(ttsStatus?.running && ttsStatus.ownedByStudio)) {
          onNotice(notice);
          return;
        }
        onNotice({
          ...notice,
          title: cpuAlreadySelected
            ? "CPU設定をサーバーへ適用できていません"
            : "このGPUでは音声生成を実行できません",
          body: cpuAlreadySelected
            ? "サーバーが変更前の機器設定を使っている可能性があります。CPU設定でサーバーを再起動できます。"
            : "自動選択されたCUDA設定がこのGPUに対応していない可能性があります。モデルと音声データをCPUに切り替えて再試行できます。",
          action: {
            label: cpuAlreadySelected ? "CPU設定でサーバーを再起動" : "CPUに切り替える",
            onClick: switchToCpu,
          },
        });
      })
      .catch(() => onNotice(notice));
  }
  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 2500);
    return () => window.clearInterval(timer);
  }, []);
  // 「アプリ起動時にサーバーを自動起動」が有効なら、アプリを開いたときに1回だけ起動する。
  // 必要な部品がそろっていない間は、起動しても失敗するだけなので何もしない。
  const autoStartTried = useRef(false);
  useEffect(() => {
    // 開発時のStrictModeなどで2回呼ばれても、起動を試みるのは1回だけにする
    if (!isTauriRuntime() || autoStartTried.current) return;
    autoStartTried.current = true;
    const ready = (state.environment.components ?? []).every((item) => !item.required || item.installed);
    if (!ready) return;
    void (async () => {
      try {
        const [config, status] = await Promise.all([
          call<TtsConfig>("get_tts_config"),
          call<TtsStatus>("get_tts_status"),
        ]);
        setTtsStatus(status);
        if (config.autoStart && !status.running) await startOrRestartServer();
      } catch {
        /* 状態を取得できない場合は、右上のボタンから手動で起動できる */
      }
    })();
  }, []);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <b>IRODORI/ST</b>
          <small>ローカル音声生成</small>
        </div>
        <nav className="nav-list" aria-label="メインメニュー">
          {navItems.map((item, index) => (
            <button
              key={item.page}
              className={`nav-item ${item.page === page ? "active" : ""}`}
              onClick={() => setPage(item.page)}
            >
              <span className="nav-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="nav-label">
                {item.label}
                <small>{item.detail}</small>
              </span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="portable-card"
            title="保存場所を確認する"
            onClick={() => openSettingsTab("app")}
          >
            <div>
              <span className={`status-dot ${state.environment.writable ? "ready" : "error"}`} />{" "}
              データの保存場所
            </div>
            <small>{state.environment.writable ? "書き込み可能" : "確認が必要"}</small>
            <small>クリックで保存場所を確認</small>
          </button>
          <small className="version">IrodoriStudio v{appVersion} · Windows x64</small>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <span className="topbar-index">{String(navItems.indexOf(active) + 1).padStart(2, "0")}</span>
          <h1>{active.label}</h1>
          <span className="topbar-detail">{active.detail}</span>
          <div className="top-actions">
            {/* 初回は↻だけだと起動方法が分かりにくいため、停止中だけ目立つ起動ボタンを出す */}
            {!ttsStatus?.running && (
              <button
                className="top-start-button"
                disabled={serverBusy}
                onClick={() => void startOrRestartServer()}
              >
                {serverBusy ? "起動しています…" : "▶ サーバーを起動"}
              </button>
            )}
            <span className="top-lamp">
              <span className={`lamp ${serviceState(ttsStatus)}`} />
              {ttsStatus?.healthy ? "SERVER READY" : ttsStatus?.running ? "SERVER STARTING" : "SERVER OFF"}
            </span>
            <button
              className={`icon-button server-button ${serverBusy ? "busy" : ""}`}
              aria-label={ttsStatus?.running ? "サーバーを再起動" : "サーバーを起動"}
              title={ttsStatus?.running ? "サーバーを再起動" : "サーバーを起動"}
              disabled={serverBusy}
              onClick={() => void startOrRestartServer()}
            >
              <span>↻</span>
            </button>
          </div>
        </header>
        <div className="page-body">
          {/* 台本・選んだ声・生成結果を残すため、音声生成ページは隠すだけで破棄しない */}
          <div hidden={page !== "generate"}>
            <GeneratePage voices={voices} ttsStatus={ttsStatus} onNotice={handleGenerationNotice} />
          </div>
          {page === "favorites" && <FavoritesPage onNotice={onNotice} />}
          {page === "voices" && <VoicesPage voices={voices} setVoices={setVoices} onNotice={onNotice} />}
          {page === "settings" && (
            <SettingsPage
              state={state}
              ttsStatus={ttsStatus}
              setTtsStatus={setTtsStatus}
              onNotice={onNotice}
              tabRequest={settingsTabRequest}
            />
          )}
          {page === "license" && <LicensePage />}
        </div>
      </main>
    </div>
  );
}
export default App;
