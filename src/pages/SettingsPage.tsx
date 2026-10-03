import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ask, message } from "@tauri-apps/plugin-dialog";
import type {
  AppState,
  EnvironmentInfo,
  HuggingFaceModel,
  ModelInstallProgress,
  Notice,
  TtsConfig,
  TtsStatus,
} from "../types";
import { MODEL_FAMILIES } from "../constants";
import { call, errorText, formatBytes, pathLabel, serviceState } from "../utils";
import { DiagLine, StatusRow } from "../components/common";
import { AutoInstallPanel } from "../components/InstallPanel";

export function FriendlyDiagnosticsPage({
  state,
  onNotice,
}: {
  state: AppState;
  onNotice: (notice: Notice) => void;
}) {
  const [environment, setEnvironment] = useState(state.environment);
  const [installing, setInstalling] = useState("");
  const [message, setMessage] = useState("");
  async function install(component: string) {
    setInstalling(component);
    setMessage(component === "auto" ? "不足している項目を確認しています…" : "選択した項目を準備しています…");
    try {
      const result = await call<{ message: string }>("install_environment", { component });
      setMessage(result.message);
      setEnvironment(await call<EnvironmentInfo>("check_environment"));
    } catch (error) {
      setMessage(errorText(error));
      onNotice({
        kind: "error",
        title: "インストールに失敗しました",
        body: "インターネット接続と空き容量を確認してください。",
        detail: errorText(error),
      });
    } finally {
      setInstalling("");
    }
  }
  return (
    <div className="diagnostics-stack">
      <div className="surface diagnostics-card">
        <div className="page-intro">
          <span className="section-label">環境確認</span>
          <h2>環境の状態</h2>
          <p>音声生成に必要な環境を確認します。文章と音声は外部の音声生成サービスへ送信しません。</p>
        </div>
        <div className="diagnostic-grid">
          <DiagLine
            label="Windows"
            value={`${environment.windows} · ${environment.architecture}`}
            state="ok"
          />
          <DiagLine label="CPU" value={environment.cpu} state="muted" />
          <DiagLine
            label="GPU"
            value={environment.gpu}
            state={environment.cudaAvailable ? "ok" : "warning"}
          />
          <DiagLine
            label="CUDA"
            value={environment.cudaAvailable ? "利用可能" : "利用不可 · CPUを使用"}
            state={environment.cudaAvailable ? "ok" : "warning"}
          />
          <DiagLine label="Python" value={environment.python} state="muted" />
          <DiagLine label="実行環境" value={environment.uv} state="muted" />
          <DiagLine label="音声変換機能" value={environment.ffmpeg} state="muted" />
          <DiagLine
            label="空き容量"
            value={
              environment.freeSpaceGb == null ? "取得できません" : `${environment.freeSpaceGb.toFixed(1)} GB`
            }
            state="muted"
          />
          <DiagLine label="音声生成プログラム" value={environment.irodoriRoot} state="muted" />
        </div>
      </div>
      <AutoInstallPanel
        environment={environment}
        installing={installing}
        message={message}
        onInstall={install}
      />
    </div>
  );
}

export function ModelSelector({
  config,
  installedModels,
  onSelect,
}: {
  config: TtsConfig;
  installedModels: string[];
  onSelect: (model: string, revision: string) => void;
}) {
  const [knownModels, setKnownModels] = useState(installedModels);
  const [downloading, setDownloading] = useState("");
  useEffect(() => setKnownModels(installedModels), [installedModels]);

  const visibleFamilies = MODEL_FAMILIES.filter(
    (family) => knownModels.includes(family.normal) || knownModels.includes(family.quantized),
  );
  const currentFamily =
    MODEL_FAMILIES.find((family) => family.normal === config.model || family.quantized === config.model) ??
    null;
  const selectedFamily = visibleFamilies.find((family) => family.id === currentFamily?.id) ?? null;
  const customInstalled = knownModels.includes(config.model) && !currentFamily;
  const selectedValue = selectedFamily?.id ?? (customInstalled ? "custom" : "");

  function chooseFamily(familyId: string) {
    const family = visibleFamilies.find((item) => item.id === familyId);
    if (!family) return;
    if (knownModels.includes(family.normal)) return onSelect(family.normal, family.normalRevision);
    if (knownModels.includes(family.quantized)) onSelect(family.quantized, family.quantizedRevision);
  }

  async function chooseVariant(model: string, revision: string, label: string) {
    if (knownModels.includes(model)) {
      onSelect(model, revision);
      return;
    }
    const approved = await ask(
      `「${label}」はまだ導入されていません。アプリのフォルダ内へダウンロードします。続けますか？`,
      {
        title: "音声モデルを導入",
        kind: "warning",
        okLabel: "ダウンロードする",
        cancelLabel: "キャンセル",
      },
    );
    if (!approved) return;

    setDownloading(model);
    try {
      await call("install_model", { model, revision });
      setKnownModels((current) => (current.includes(model) ? current : [...current, model].sort()));
      onSelect(model, revision);
    } catch (error) {
      await message(errorText(error), { title: "音声モデルを導入できません", kind: "error" });
    } finally {
      setDownloading("");
    }
  }

  const variants = currentFamily
    ? [
        { model: currentFamily.normal, revision: currentFamily.normalRevision, label: "通常モデル" },
        { model: currentFamily.quantized, revision: currentFamily.quantizedRevision, label: "量子化モデル" },
      ]
    : [];

  return (
    <div className="model-selector">
      <label className="field-label model-select-label">
        使用するモデル
        <select
          className="model-select"
          value={selectedValue}
          onChange={(event) => chooseFamily(event.target.value)}
        >
          <option value="" disabled>
            {knownModels.length ? "現在のモデルは未導入です" : "モデルが未導入です"}
          </option>
          <optgroup label="モデルの種類">
            {visibleFamilies.map((family) => (
              <option value={family.id} key={family.id}>
                {family.label}
              </option>
            ))}
            {customInstalled && <option value="custom">追加モデル</option>}
          </optgroup>
        </select>
      </label>
      {currentFamily && (
        <div className="model-variant-area">
          <span className="model-variant-label">モデルの形式</span>
          <div className="model-variant-switch">
            {variants.map((variant) => {
              const installed = knownModels.includes(variant.model);
              const active = config.model === variant.model;
              return (
                <button
                  key={variant.model}
                  className={`${active ? "selected" : ""} ${installed ? "" : "needs-install"}`.trim()}
                  disabled={Boolean(downloading)}
                  onClick={() =>
                    void chooseVariant(
                      variant.model,
                      variant.revision,
                      `${currentFamily.label} ${variant.label}`,
                    )
                  }
                >
                  <b>{downloading === variant.model ? "導入中…" : variant.label}</b>
                  <small>{installed ? "導入済み" : "未導入 · クリックして導入"}</small>
                </button>
              );
            })}
          </div>
          {downloading && (
            <small className="model-not-installed">
              モデルを導入しています。完了までこの画面を閉じないでください。
            </small>
          )}
        </div>
      )}
      {customInstalled && (
        <div className="model-variant-area">
          <span className="model-variant-label">追加モデル</span>
          <small className="model-not-installed">{config.model}</small>
        </div>
      )}
      {!visibleFamilies.length && !customInstalled && !currentFamily && (
        <div className="model-variant-area">
          <small className="model-not-installed">
            導入済みのモデルがありません。下の検索欄からモデルを導入してください。
          </small>
        </div>
      )}
    </div>
  );
}

export type SettingsTab = "model" | "server" | "diagnostics" | "app";

export function SettingsPage({
  state,
  ttsStatus,
  setTtsStatus,
  onNotice,
  tabRequest,
}: {
  state: AppState;
  ttsStatus: TtsStatus | null;
  setTtsStatus: (status: TtsStatus) => void;
  onNotice: (notice: Notice) => void;
  /** 他の画面から特定のタブを開くための指示。`at` が変わるたびに切り替える */
  tabRequest?: { tab: SettingsTab; at: number } | null;
}) {
  const [config, setConfig] = useState<TtsConfig | null>(null);
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [tab, setTab] = useState<SettingsTab>(tabRequest?.tab ?? "model");
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest?.at]);
  const [busy, setBusy] = useState(false);
  const [hfQuery, setHfQuery] = useState("phasefield-audio/Irodori-TTS-v4.1-Anime");
  const [hfResults, setHfResults] = useState<HuggingFaceModel[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [modelInstalling, setModelInstalling] = useState(false);
  const [modelProgress, setModelProgress] = useState<ModelInstallProgress | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [nextConfig, models] = await Promise.all([
          call<TtsConfig>("get_tts_config"),
          call<string[]>("list_installed_models"),
        ]);
        setConfig(nextConfig);
        setInstalledModels(models);
      } catch (error) {
        onNotice({ kind: "error", title: "設定を読み込めません", body: errorText(error) });
      }
    })();
  }, []);
  useEffect(() => {
    let active = true;
    let stopListening: (() => void) | null = null;
    void listen<ModelInstallProgress>("model-install-progress", (event) => {
      if (active) setModelProgress(event.payload);
    }).then((unlisten) => {
      stopListening = unlisten;
      if (!active) unlisten();
    });
    return () => {
      active = false;
      stopListening?.();
    };
  }, []);
  function update<K extends keyof TtsConfig>(key: K, value: TtsConfig[K]) {
    const current = config;
    if (!current) return;
    const next: TtsConfig = { ...current, [key]: value };
    if (key === "modelDevice") {
      next.codecDevice = String(value);
      setConfig(next);
      void saveProcessingDevice(next);
      return;
    }
    setConfig(next);
  }
  function chooseModel(model: string, revision: string) {
    const current = config;
    if (!current || current.model === model) return;
    const next = { ...current, model, modelRevision: revision };
    setConfig(next);
    setBusy(true);
    void call<TtsConfig>("save_tts_config", { config: next })
      .then(setConfig)
      .catch((error) =>
        onNotice({ kind: "error", title: "モデルの選択を保存できません", body: errorText(error) }),
      )
      .finally(() => setBusy(false));
  }
  async function saveConfig(nextConfig = config) {
    if (!nextConfig) return false;
    setBusy(true);
    try {
      const saved = await call<TtsConfig>("save_tts_config", { config: nextConfig });
      setConfig(saved);
      onNotice({
        kind: "success",
        title: "設定を保存しました",
        body: "次回のサーバー起動から設定を使用します。",
      });
      return true;
    } catch (error) {
      onNotice({ kind: "error", title: "設定を保存できません", body: errorText(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function saveProcessingDevice(nextConfig: TtsConfig) {
    setBusy(true);
    try {
      const saved = await call<TtsConfig>("save_tts_config", { config: nextConfig });
      setConfig(saved);
      if (ttsStatus?.running && ttsStatus.ownedByStudio) {
        const restarted = await call<TtsStatus>("restart_tts");
        setTtsStatus(restarted);
        onNotice({
          kind: "success",
          title: "機器の設定を保存しました",
          body: `モデルと音声データを ${saved.modelDevice.toUpperCase()} に設定し、サーバーを再起動しました。`,
        });
      } else {
        onNotice({
          kind: "success",
          title: "機器の設定を保存しました",
          body: `モデルと音声データを ${saved.modelDevice.toUpperCase()} に設定しました。次回のサーバー起動から使用します。`,
        });
      }
    } catch (error) {
      onNotice({
        kind: "error",
        title: "機器の設定を適用できません",
        body: "設定の保存またはサーバーの再起動に失敗しました。",
        detail: errorText(error),
      });
    } finally {
      setBusy(false);
    }
  }
  async function searchModels() {
    const query = hfQuery.trim();
    if (query.length < 2)
      return onNotice({
        kind: "warning",
        title: "検索語を入力してください",
        body: "Hugging Faceのモデル名を2文字以上で入力してください。",
      });
    setSearching(true);
    try {
      setHfResults(await call<HuggingFaceModel[]>("search_huggingface_models", { query }));
    } catch (error) {
      onNotice({ kind: "error", title: "モデルを検索できません", body: errorText(error) });
    } finally {
      setSearching(false);
    }
  }
  async function installModel() {
    if (!config) return;
    const model = hfQuery.trim();
    if (!/^[^/]+\/[^/]+(?:\/[^/]+)?$/u.test(model))
      return onNotice({
        kind: "warning",
        title: "モデルIDを確認してください",
        body: "owner/model または owner/model/variant の形式で入力してください。",
      });
    const revision = model === config.model ? config.modelRevision.trim() || "main" : "main";
    setModelInstalling(true);
    setModelProgress({ model, file: "準備中", percent: 0, downloadedBytes: 0, totalBytes: 0 });
    try {
      await call("install_model", { model, revision });
      const next = { ...config, model, modelRevision: revision };
      setConfig(next);
      setInstalledModels((current) => (current.includes(model) ? current : [...current, model].sort()));
      await call<TtsConfig>("save_tts_config", { config: next });
      onNotice({
        kind: "success",
        title: "音声モデルを導入しました",
        body: "このモデルを使って音声を生成できます。",
      });
    } catch (error) {
      onNotice({
        kind: "error",
        title: "音声モデルを導入できません",
        body: "インターネット接続と空き容量を確認してください。",
        detail: errorText(error),
      });
    } finally {
      setModelInstalling(false);
    }
  }
  async function serverAction(action: "start_tts" | "stop_tts" | "restart_tts") {
    setBusy(true);
    try {
      const next = await call<TtsStatus>(action);
      setTtsStatus(next);
      onNotice({
        kind: "success",
        title:
          action === "start_tts"
            ? "サーバーを起動しました"
            : action === "stop_tts"
              ? "サーバーを停止しました"
              : "サーバーを再起動しました",
        body: next.message,
      });
    } catch (error) {
      onNotice({
        kind: "error",
        title: "サーバーを操作できません",
        body: "環境確認で必要な項目を準備してください。",
        detail: errorText(error),
      });
    } finally {
      setBusy(false);
    }
  }
  if (!config)
    return (
      <div className="loading-inline">
        <div className="loader-orb" />
        設定を読み込んでいます…
      </div>
    );
  // bf16はRTX 30系以降のGPUでのみ動き、CPUでは使えない（選ぶとモデルを読み込めなくなる）
  const bf16Usable = Boolean(state.environment.bf16Supported) && config.modelDevice !== "cpu";
  const progress =
    modelProgress && modelProgress.model === (modelInstalling ? hfQuery.trim() : modelProgress.model)
      ? modelProgress
      : null;
  return (
    <section className="settings-page">
      <div className="settings-tabs">
        {(
          [
            ["model", "モデル"],
            ["server", "サーバー"],
            ["diagnostics", "環境確認"],
            ["app", "詳細設定"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "model" && (
        <div className="settings-layout">
          <div className="surface settings-main">
            <div className="page-intro">
              <span className="section-label">音声モデル</span>
              <h2>使用するモデル</h2>
              <p>Anime版を初期モデルにしています。Hugging Faceから別のモデルもアプリ内へ導入できます。</p>
            </div>
            <ModelSelector config={config} installedModels={installedModels} onSelect={chooseModel} />
            <div className="model-download-box">
              <div className="card-heading">
                <div>
                  <span className="section-label">HUGGING FACE</span>
                  <h3>モデルを導入</h3>
                </div>
                <span className="model-download-hint">アプリのフォルダ内に保存</span>
              </div>
              <div className="model-search-row">
                <input
                  value={hfQuery}
                  onChange={(event) => setHfQuery(event.target.value)}
                  placeholder="例：phasefield-audio/Irodori-TTS-v4.1-Anime"
                  aria-label="Hugging Faceモデル検索"
                />
                <button
                  className="button subtle"
                  onClick={() => void searchModels()}
                  disabled={searching || modelInstalling}
                >
                  {searching ? "検索中…" : "検索"}
                </button>
                <button
                  className="button primary"
                  onClick={() => void installModel()}
                  disabled={modelInstalling}
                >
                  {modelInstalling ? "導入中…" : "このモデルを導入"}
                </button>
              </div>
              <small className="muted">
                Irodori-TTS形式のモデルだけを表示します。導入前に中身を確認し、使えないモデルはダウンロードしません。
              </small>
              {hfResults && hfResults.length === 0 && (
                <p className="muted">導入できるIrodori-TTSのモデルが見つかりませんでした。</p>
              )}
              {hfResults && hfResults.length > 0 && (
                <div className="model-search-results">
                  {hfResults.map((result) => (
                    <div key={result.id} className="model-search-result">
                      <div>
                        <b>{result.id}</b>
                        <small>
                          {result.downloads == null
                            ? "ダウンロード数不明"
                            : `${result.downloads.toLocaleString()} downloads`}
                        </small>
                      </div>
                      <div className="model-variants">
                        {result.installable.map((model) => (
                          <button
                            key={model}
                            className={hfQuery.trim() === model ? "active" : ""}
                            onClick={() => setHfQuery(model)}
                            title={model}
                          >
                            {model === result.id ? "標準" : model.slice(result.id.length + 1)}
                            {installedModels.includes(model) && " ✓"}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {progress && (
                <div className="model-progress">
                  <div className="model-progress-heading">
                    <b>{progress.percent >= 100 ? "導入完了" : "モデルを導入しています"}</b>
                    <strong>{Math.min(100, Math.max(0, progress.percent)).toFixed(1)}%</strong>
                  </div>
                  <div className="progress-track">
                    <span style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }} />
                  </div>
                  <small>
                    {progress.file} · {formatBytes(progress.downloadedBytes)} /{" "}
                    {formatBytes(progress.totalBytes)}
                  </small>
                </div>
              )}
            </div>
            <div className="form-grid">
              <label className="field-label">
                モデルのバージョン
                <input
                  value={config.modelRevision}
                  onChange={(event) => update("modelRevision", event.target.value)}
                  placeholder="main"
                />
              </label>
              <label className="field-label">
                モデルの精度
                <select
                  value={config.modelPrecision}
                  onChange={(event) => update("modelPrecision", event.target.value)}
                >
                  <option value="fp32">fp32</option>
                  <option value="bf16" disabled={!bf16Usable}>
                    bf16{bf16Usable ? "" : "（このPCでは使えません）"}
                  </option>
                </select>
              </label>
              <label className="field-label">
                音声データの精度
                <select
                  value={config.codecPrecision}
                  onChange={(event) => update("codecPrecision", event.target.value)}
                >
                  <option value="fp32">fp32</option>
                  <option value="bf16" disabled={!bf16Usable}>
                    bf16{bf16Usable ? "" : "（このPCでは使えません）"}
                  </option>
                </select>
              </label>
              <label className="field-label">
                使用する機器
                <select
                  value={config.modelDevice}
                  onChange={(event) => {
                    // CPUではbf16を使えないため、切り替えたら精度もfp32に戻す
                    const device = event.target.value;
                    setConfig((current) =>
                      current
                        ? {
                            ...current,
                            modelDevice: device,
                            ...(device === "cpu" ? { modelPrecision: "fp32", codecPrecision: "fp32" } : {}),
                          }
                        : current,
                    );
                  }}
                >
                  <option>auto</option>
                  <option>cuda</option>
                  <option>cpu</option>
                </select>
              </label>
            </div>
            {!bf16Usable && (
              <p className="muted">
                bf16はRTX 30系以降のGPUで使えます。
                {config.modelDevice === "cpu" ? "使用する機器がCPUのため選べません。" : "このPCのGPUは対応していないため選べません。"}
              </p>
            )}
            <button className="button primary" onClick={() => void saveConfig()} disabled={busy}>
              設定を保存
            </button>
          </div>
          <aside className="surface settings-side">
            <h3>現在の環境</h3>
            <DiagLine
              label="GPU"
              value={state.environment.gpu}
              state={state.environment.cudaAvailable ? "ok" : "warning"}
            />
            <DiagLine
              label="CUDA"
              value={state.environment.cudaAvailable ? "利用可能" : "CPUを使用"}
              state={state.environment.cudaAvailable ? "ok" : "warning"}
            />
            <div className="settings-callout">
              Anime版の通常モデルは約3GBあります。量子化版を使う場合は、同じAnime版グループ内の「量子化モデル」を選んでください。
            </div>
          </aside>
        </div>
      )}
      {tab === "server" && (
        <div className="settings-layout">
          <div className="surface settings-main">
            <div className="page-intro">
              <span className="section-label">音声生成サーバー</span>
              <h2>サーバー設定</h2>
              <p>音声生成に必要なサーバーを起動・停止します。</p>
            </div>
            <div className="server-hero">
              <StatusRow
                label="サーバー"
                state={serviceState(ttsStatus)}
                detail={ttsStatus?.message ?? "状態を確認しています"}
              />
              <span className="server-url">
                {config.serverUrl}:{config.port}
              </span>
            </div>
            <div className="button-row">
              <button
                className="button primary"
                disabled={busy || ttsStatus?.healthy}
                onClick={() => void serverAction("start_tts")}
              >
                ▶ 起動
              </button>
              <button
                className="button subtle"
                disabled={busy || !ttsStatus?.running}
                onClick={() => void serverAction("restart_tts")}
              >
                ↻ 再起動
              </button>
              <button
                className="button danger"
                disabled={busy || !ttsStatus?.ownedByStudio}
                onClick={() => void serverAction("stop_tts")}
              >
                ■ 停止
              </button>
            </div>
            <div className="form-grid">
              <label className="field-label">
                サーバーの保存場所
                <input
                  value={config.serverRoot}
                  onChange={(event) => update("serverRoot", event.target.value)}
                />
              </label>
              <label className="field-label">
                音声生成プログラムの場所
                <input
                  value={config.irodoriRoot}
                  onChange={(event) => update("irodoriRoot", event.target.value)}
                />
              </label>
              <label className="field-label">
                Pythonの場所
                <input
                  value={config.pythonPath}
                  onChange={(event) => update("pythonPath", event.target.value)}
                />
              </label>
              <label className="field-label">
                ボイス保存場所
                <input
                  value={config.voicesDir}
                  onChange={(event) => update("voicesDir", event.target.value)}
                />
              </label>
              <label className="field-label">
                ポート番号
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={config.port}
                  onChange={(event) => update("port", Number(event.target.value))}
                />
              </label>
              <label className="field-label checkbox-field">
                <input
                  type="checkbox"
                  checked={config.autoStart}
                  onChange={(event) => update("autoStart", event.target.checked)}
                />{" "}
                アプリ起動時にサーバーを自動起動
              </label>
            </div>
            <button className="button primary" onClick={() => void saveConfig()} disabled={busy}>
              設定を保存
            </button>
          </div>
        </div>
      )}
      {tab === "diagnostics" && <FriendlyDiagnosticsPage state={state} onNotice={onNotice} />}
      {tab === "app" && (
        <div className="settings-layout">
          <div className="surface settings-main">
            <div className="page-intro">
              <span className="section-label">詳細設定</span>
              <h2>保存場所と生成設定</h2>
              <p>通常は変更する必要はありません。内容が分からない場合は初期値を使用してください。</p>
            </div>
            <div className="path-list">
              {Object.entries(state.paths).map(([key, value]) => (
                <div className="path-line" key={key}>
                  <span>{pathLabel(key)}</span>
                  <code>{value}</code>
                </div>
              ))}
            </div>
            <div className="form-grid">
              <label className="field-label">
                生成ステップ数
                <input
                  type="number"
                  min="1"
                  value={config.numSteps}
                  onChange={(event) => update("numSteps", Number(event.target.value))}
                />
              </label>
              <label className="field-label">
                文章の反映度
                <input
                  type="number"
                  step="0.1"
                  value={config.cfgScaleText}
                  onChange={(event) => update("cfgScaleText", Number(event.target.value))}
                />
              </label>
              <label className="field-label">
                声の反映度
                <input
                  type="number"
                  step="0.1"
                  value={config.cfgScaleSpeaker}
                  onChange={(event) => update("cfgScaleSpeaker", Number(event.target.value))}
                />
              </label>
              <label className="field-label">
                変化量
                <input
                  type="number"
                  step="0.1"
                  value={config.swayCoefficient}
                  onChange={(event) => update("swayCoefficient", Number(event.target.value))}
                />
              </label>
            </div>
            <button className="button primary" onClick={() => void saveConfig()} disabled={busy}>
              詳細設定を保存
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
