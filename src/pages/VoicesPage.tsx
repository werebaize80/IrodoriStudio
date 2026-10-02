import { type DragEvent, useEffect, useRef, useState } from "react";
import type { Notice, Voice, VoiceDraft } from "../types";
import { call, errorText, fileToData, isTauriRuntime } from "../utils";
import { Toast, VoiceAvatar } from "../components/common";

export function VoicesPage({
  voices,
  setVoices,
  onNotice,
}: {
  voices: Voice[];
  setVoices: (voices: Voice[]) => void;
  onNotice: (notice: Notice) => void;
}) {
  const [draft, setDraft] = useState<VoiceDraft | null>(null);
  async function openEditor(id: string | null) {
    if (isTauriRuntime()) {
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const label = `voice-editor-${id ?? "new"}-${Date.now()}`;
        const editor = new WebviewWindow(label, {
          url: `index.html?voiceEditor=${encodeURIComponent(id ?? "new")}`,
          title: "ボイス編集 · IrodoriStudio",
          width: 780,
          height: 720,
          resizable: true,
          dragDropEnabled: false,
        });
        void editor.once("tauri://error", (event) =>
          onNotice({
            kind: "error",
            title: "編集画面を開けません",
            body: "ボイス編集ウインドウを作成できませんでした。",
            detail: errorText(event.payload),
          }),
        );
      } catch (error) {
        onNotice({ kind: "error", title: "編集画面を開けません", body: errorText(error) });
      }
    } else
      setDraft(
        id
          ? voices.find((voice) => voice.id === id)
            ? { ...voices.find((voice) => voice.id === id)! }
            : null
          : { id: null, name: "新しいボイス", iconPath: null, caption: "", voiceDesign: "", references: [] },
      );
  }
  async function refresh() {
    try {
      setVoices(await call<Voice[]>("list_voices"));
    } catch (error) {
      onNotice({ kind: "error", title: "ボイスを読み込めません", body: errorText(error) });
    }
  }
  useEffect(() => {
    const handler = () => void refresh();
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, []);
  if (draft)
    return (
      <FriendlyVoiceEditorForm
        initial={draft}
        onDone={(voice) => {
          setVoices(
            voices.some((item) => item.id === voice.id)
              ? voices.map((item) => (item.id === voice.id ? voice : item))
              : [voice, ...voices],
          );
          setDraft(null);
        }}
        onCancel={() => setDraft(null)}
        onNotice={onNotice}
      />
    );
  return (
    <section className="voices-page">
      <div className="page-intro split">
        <div>
          <span className="section-label">ボイス設定</span>
          <h2>登録済みボイス</h2>
          <p>使用する声を登録・編集します。参照音声を追加すると、声の特徴を再現できます。</p>
        </div>
        <button className="button primary" onClick={() => void openEditor(null)}>
          ＋ ボイスを追加
        </button>
      </div>
      <div className="voice-grid">
        {voices.map((voice) => (
          <button className="voice-tile" key={voice.id} onClick={() => void openEditor(voice.id)}>
            <VoiceAvatar voice={voice} large />
            <div>
              <b>{voice.name}</b>
              <small>
                {voice.references.length ? `${voice.references.length}件の参照音声` : "参照音声なし"}
              </small>
            </div>
            <span className="tile-arrow">↗</span>
          </button>
        ))}
      </div>
      {!voices.length && (
        <div className="surface blank-state">
          <span>◉</span>
          <b>登録されているボイスはありません</b>
          <small>「ボイスを追加」から声の設定を登録できます。</small>
        </div>
      )}
    </section>
  );
}
export function FriendlyVoiceEditorStandalone({ voiceId }: { voiceId: string }) {
  const [voice, setVoice] = useState<VoiceDraft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    document.body.classList.add("editor-mode");
    return () => document.body.classList.remove("editor-mode");
  }, []);
  async function closeEditor() {
    if (isTauriRuntime()) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } else {
      window.close();
    }
  }
  useEffect(() => {
    void (async () => {
      try {
        const next =
          voiceId === "new"
            ? { id: null, name: "新しいボイス", iconPath: null, caption: "", voiceDesign: "", references: [] }
            : await call<Voice>("get_voice", { voiceId });
        setVoice(next);
      } catch (reason) {
        setError(errorText(reason));
      }
    })();
  }, [voiceId]);
  if (error)
    return (
      <div className="editor-window">
        <h1>ボイス編集</h1>
        <p>{error}</p>
      </div>
    );
  if (!voice)
    return (
      <div className="loading-inline">
        <div className="loader-orb" />
        ボイスを読み込んでいます…
      </div>
    );
  return (
    <>
      <FriendlyVoiceEditorForm
        initial={voice}
        onDone={() => void closeEditor()}
        onCancel={() => void closeEditor()}
        onNotice={setNotice}
      />
      <Toast notice={notice} onClose={() => setNotice(null)} />
    </>
  );
}
export function FriendlyVoiceEditorForm({
  initial,
  onDone,
  onCancel,
  onNotice,
}: {
  initial: VoiceDraft;
  onDone: (voice: Voice) => void;
  onCancel: () => void;
  onNotice: (notice: Notice) => void;
}) {
  const [draft, setDraft] = useState<VoiceDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState<{ name: string; data: string }[]>([]);
  const [iconFile, setIconFile] = useState<{ name: string; data: string; mimeType: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  function update<K extends keyof VoiceDraft>(key: K, value: VoiceDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  async function addFiles(selected: File[]) {
    const encoded = await Promise.all(
      selected.map(async (file) => ({ name: file.name, data: await fileToData(file) })),
    );
    setFiles((current) => [...current, ...encoded]);
  }
  /** ドロップされたファイルを種類で振り分ける（音声→参考ファイル、画像→アイコン） */
  async function addDropped(dropped: File[]) {
    const audio = dropped.filter(isAudioFile);
    const images = dropped.filter(isImageFile);
    const others = dropped.filter((file) => !isAudioFile(file) && !isImageFile(file));
    if (audio.length) await addFiles(audio);
    if (images.length) await addIcon(images[0]);
    if (others.length)
      onNotice({
        kind: "warning",
        title: "追加できないファイルがあります",
        body: `音声ファイルか画像ファイルをドロップしてください: ${others.map((file) => file.name).join("、")}`,
      });
  }
  function onDragEnter(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }
  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }
  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void addDropped(Array.from(event.dataTransfer.files));
  }
  async function addIcon(file: File | undefined) {
    if (!file) return;
    const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];
    if (file.type && !allowed.includes(file.type))
      return onNotice({
        kind: "warning",
        title: "画像形式を確認してください",
        body: "PNG、JPG、WEBP、GIF、BMPの画像を選択してください。",
      });
    if (file.size > 5 * 1024 * 1024)
      return onNotice({
        kind: "warning",
        title: "画像が大きすぎます",
        body: "アイコン画像は5MB以下にしてください。",
      });
    try {
      setIconFile({ name: file.name, data: await fileToData(file), mimeType: file.type || "image/png" });
    } catch (error) {
      onNotice({ kind: "error", title: "画像を読み込めません", body: errorText(error) });
    }
  }
  async function saveVoice() {
    if (!draft.name.trim())
      return onNotice({
        kind: "warning",
        title: "ボイス名が未入力です",
        body: "ボイス名を入力してください。",
      });
    setSaving(true);
    try {
      onDone(
        await call<Voice>("save_voice", {
          voice: draft,
          uploads: files,
          icon: iconFile ? { name: iconFile.name, data: iconFile.data } : null,
        }),
      );
    } catch (error) {
      onNotice({ kind: "error", title: "ボイスを保存できません", body: errorText(error) });
    } finally {
      setSaving(false);
    }
  }
  async function deleteVoice() {
    if (!draft.id || !window.confirm("このボイスを削除しますか？参照音声も削除されます。")) return;
    setSaving(true);
    try {
      await call("delete_voice", { voiceId: draft.id });
      onCancel();
    } catch (error) {
      onNotice({ kind: "error", title: "削除できません", body: errorText(error) });
    } finally {
      setSaving(false);
    }
  }
  return (
    <section
      className={`editor-window ${dragging ? "drop-active" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <b>ここにドロップ</b>
          <small>音声ファイル → 声の参考ファイル　／　画像 → アイコン</small>
        </div>
      )}
      <div className="editor-heading">
        <div>
          <span className="section-label">ボイス設定</span>
          <h1>ボイス編集</h1>
        </div>
        <button className="icon-button" aria-label="閉じる" onClick={onCancel}>
          ×
        </button>
      </div>
      <div className="editor-form">
        <label className="field-label">
          ボイス名
          <input value={draft.name} onChange={(event) => update("name", event.target.value)} />
        </label>
        <div className="icon-picker">
          <VoiceAvatar
            voice={
              iconFile
                ? { name: draft.name, iconDataUrl: `data:${iconFile.mimeType};base64,${iconFile.data}` }
                : draft
            }
            large
          />
          <div className="icon-picker-copy">
            <b>アイコン画像</b>
            <small>ボイス一覧に表示する画像（PNG / JPG / WEBP / GIF / BMP）。画像をドロップしても設定できます</small>
            <label className="button subtle small">
              画像を選ぶ
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                hidden
                onChange={(event) => void addIcon(event.target.files?.[0])}
              />
            </label>
            {iconFile && <span className="icon-file-name">{iconFile.name}</span>}
          </div>
        </div>
        <div className="editor-two">
          <label className="field-label">
            声の特徴（VoiceDesign）
            <textarea
              value={draft.voiceDesign}
              onChange={(event) => update("voiceDesign", event.target.value)}
              placeholder="例：落ち着いた、明るい声"
            />
          </label>
          <label className="field-label">
            話し方の説明（Caption）
            <textarea
              value={draft.caption}
              onChange={(event) => update("caption", event.target.value)}
              placeholder="例：ゆっくり、自然な話し方"
            />
          </label>
        </div>
        <div className="reference-box">
          <div className="card-heading">
            <div>
              <span className="section-label">参照音声</span>
              <h2>声の参考ファイル</h2>
            </div>
            <label className="button subtle small">
              ＋ 追加
              <input
                type="file"
                accept="audio/*"
                multiple
                hidden
                onChange={(event) => void addFiles(Array.from(event.target.files ?? []))}
              />
            </label>
          </div>
          <div className="reference-list">
            {draft.references.map((reference, index) => (
              <div className="reference-item" key={reference}>
                <span className="drag-handle">⠿</span>
                <span>♫</span>
                <b>{reference.split(/[\\/]/u).pop()}</b>
                <small>保存済み</small>
                <button
                  aria-label="参照音声を削除"
                  onClick={() =>
                    update(
                      "references",
                      draft.references.filter((_, refIndex) => refIndex !== index),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ))}
            {files.map((file, index) => (
              <div className="reference-item new" key={`${file.name}-${index}`}>
                <span className="drag-handle">⠿</span>
                <span>♫</span>
                <b>{file.name}</b>
                <small>保存時に追加</small>
                <button
                  aria-label="追加予定ファイルを削除"
                  onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}
                >
                  ×
                </button>
              </div>
            ))}
            {!draft.references.length && !files.length && (
              <small className="muted">
                参照音声を使用しない場合は、声の特徴と話し方の説明を入力してください。
              </small>
            )}
          </div>
          <div className="reference-summary">音声ファイルをこの画面にドロップしても追加できます · 合計120秒以内を推奨</div>
        </div>
        <div className="editor-actions">
          <button className="button subtle" onClick={onCancel}>
            キャンセル
          </button>
          {draft.id && (
            <button className="button danger" onClick={() => void deleteVoice()} disabled={saving}>
              削除
            </button>
          )}
          <button className="button primary" onClick={() => void saveVoice()} disabled={saving}>
            {saving ? "保存しています…" : "保存"}
          </button>
        </div>
      </div>
    </section>
  );
}

const AUDIO_EXTENSIONS = /\.(wav|mp3|flac|ogg|m4a|aac|opus|webm)$/iu;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp)$/iu;

function isAudioFile(file: File) {
  return file.type.startsWith("audio/") || AUDIO_EXTENSIONS.test(file.name);
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS.test(file.name);
}
