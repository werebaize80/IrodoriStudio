import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import type { EmojiTag, Generation, Notice, Segment, TtsStatus, Voice } from "../types";
import { EMOJI_PALETTE, PRESETS } from "../constants";
import {
  analyzeText,
  call,
  errorText,
  moveEmojiInOrder,
  normalizeEmojiOrder,
  nowLabel,
  readDraftText,
  readEmojiOrder,
  sameEmojiOrder,
  saveDraftText,
  saveEmojiOrder,
  segmentIndexAt,
  serviceState,
} from "../utils";
import { VoiceAvatar } from "../components/common";
import { WavePlayer } from "../components/WavePlayer";

export function EmojiPalette({
  onInsert,
  onNotice,
}: {
  onInsert: (tag: EmojiTag) => void;
  onNotice: (notice: Notice) => void;
}) {
  const [savedOrder, setSavedOrder] = useState(readEmojiOrder);
  const [reorderMode, setReorderMode] = useState(false);
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  const [draggingEmoji, setDraggingEmoji] = useState<string | null>(null);
  const dragRef = useRef<{
    emoji: string;
    baseOrder: string[];
    previewOrder: string[];
    pointerId: number;
    cleanup: () => void;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void call<string[]>("get_emoji_palette_order")
      .then((saved) => {
        if (active) setSavedOrder(normalizeEmojiOrder(saved));
      })
      .catch(() => {
        /* 開発ブラウザでは既定順を使用する */
      });
    return () => {
      active = false;
    };
  }, []);
  function endDrag(commit: boolean) {
    const drag = dragRef.current;
    if (!drag) return;
    drag.cleanup();
    dragRef.current = null;
    setDraggingEmoji(null);
    setPreviewOrder(null);
    if (!commit || sameEmojiOrder(drag.baseOrder, drag.previewOrder)) return;
    const next = drag.previewOrder;
    setSavedOrder(next);
    void saveEmojiOrder(next).catch(() => {
      setSavedOrder(drag.baseOrder);
      onNotice({
        kind: "warning",
        title: "並び順を保存できませんでした",
        body: "保存先を確認して、もう一度並べ替えてください。",
      });
    });
  }
  useEffect(() => {
    if (!reorderMode) endDrag(false);
  }, [reorderMode]);
  useEffect(
    () => () => {
      const drag = dragRef.current;
      drag?.cleanup();
      dragRef.current = null;
    },
    [],
  );
  const orderedTags = useMemo(() => {
    const order = normalizeEmojiOrder(previewOrder ?? savedOrder);
    const tags = new Map(EMOJI_PALETTE.map((tag) => [tag.emoji, tag]));
    return order.map((emoji) => tags.get(emoji)).filter((tag): tag is EmojiTag => Boolean(tag));
  }, [previewOrder, savedOrder]);
  function previewAt(clientX: number, clientY: number) {
    const drag = dragRef.current;
    if (!drag) return;
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-emoji-palette-item]");
    const targetEmoji = target?.dataset.emoji;
    let next = drag.previewOrder;
    if (targetEmoji && targetEmoji !== drag.emoji) {
      const rect = target.getBoundingClientRect();
      next = moveEmojiInOrder(drag.baseOrder, drag.emoji, targetEmoji, clientX >= rect.left + rect.width / 2);
    }
    if (!sameEmojiOrder(next, drag.previewOrder)) {
      drag.previewOrder = next;
      setPreviewOrder(next);
    }
  }
  function startDrag(event: ReactPointerEvent<HTMLSpanElement>, emoji: string) {
    if (!reorderMode) return;
    event.preventDefault();
    event.stopPropagation();
    endDrag(false);
    const baseOrder = normalizeEmojiOrder(savedOrder);
    const pointerId = event.pointerId;
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      previewAt(moveEvent.clientX, moveEvent.clientY);
    };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      upEvent.preventDefault();
      previewAt(upEvent.clientX, upEvent.clientY);
      endDrag(true);
    };
    const onCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      endDrag(false);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
    };
    dragRef.current = { emoji, baseOrder, previewOrder: baseOrder, pointerId, cleanup };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    setDraggingEmoji(emoji);
    setPreviewOrder(baseOrder);
  }
  return (
    <div className={`palette emoji-palette ${reorderMode ? "reorder-mode" : ""}`}>
      <div className="emoji-palette-toolbar">
        <span className="palette-label">絵文字を文章に挿入</span>
        <button
          type="button"
          className={`emoji-reorder-toggle ${reorderMode ? "on" : ""}`}
          aria-pressed={reorderMode}
          onClick={() => setReorderMode((current) => !current)}
        >
          <span>並べ替え</span>
          <i />
        </button>
      </div>
      {orderedTags.map((tag) => (
        <button
          key={tag.emoji}
          type="button"
          className={`palette-item ${draggingEmoji === tag.emoji ? "dragging" : ""}`}
          data-emoji-palette-item="true"
          data-emoji={tag.emoji}
          title={`${tag.name}：${tag.description}`}
          onClick={() => {
            if (!reorderMode) onInsert(tag);
          }}
        >
          <span>{tag.emoji}</span>
          <b>{tag.name}</b>
          {reorderMode && (
            <span
              className="palette-drag-handle"
              role="button"
              aria-label={`${tag.name}をドラッグして移動`}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => startDrag(event, tag.emoji)}
            >
              ⠿
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
export function GeneratePage({
  voices,
  ttsStatus = null,
  onNotice,
}: {
  voices: Voice[];
  ttsStatus?: TtsStatus | null;
  onNotice: (notice: Notice) => void;
}) {
  const [text, setText] = useState(readDraftText);
  const [segments, setSegments] = useState<Segment[]>(() => analyzeText(readDraftText()));
  const [selectedSegment, setSelectedSegment] = useState(0);
  const [voiceId, setVoiceId] = useState(voices[0]?.id ?? "none");
  const [preset, setPreset] = useState("standard");
  const [caption, setCaption] = useState(voices[0]?.caption ?? "");
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [busy, setBusy] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  // 生成中の区間と、今回の実行で生成し終えた区間数（生成リストの状態表示に使う）
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [doneCount, setDoneCount] = useState(0);
  const stopRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (voices.length && !voices.some((voice) => voice.id === voiceId)) setVoiceId(voices[0].id);
  }, [voices]);
  const selectedVoice = voices.find((voice) => voice.id === voiceId);
  function updateText(value: string) {
    setText(value);
    saveDraftText(value);
    setSegments(analyzeText(value));
    setSelectedSegment(0);
  }
  function addEmoji(tag: EmojiTag) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? text.length;
    const end = textarea?.selectionEnd ?? start;
    const nextText = `${text.slice(0, start)}${tag.emoji}${text.slice(end)}`;
    updateText(nextText);
    setSelectedSegment(segmentIndexAt(nextText, start + tag.emoji.length));
    window.requestAnimationFrame(() => {
      textarea?.focus();
      const position = start + tag.emoji.length;
      textarea?.setSelectionRange(position, position);
    });
  }
  async function generateOne(sourceText: string, tags: EmojiTag[]) {
    const result = await call<{
      id: string;
      audioPath: string;
      audioBase64: string;
      voiceName: string;
      seed: number | null;
      model: string;
      modelRevision: string;
      durationSeconds: number | null;
    }>("generate_speech", {
      text: sourceText,
      voiceId: voiceId || null,
      emojis: tags.map((tag) => tag.emoji),
      caption,
      preset,
    });
    return {
      id: result.id,
      audioPath: result.audioPath,
      audioBase64: result.audioBase64,
      text: sourceText,
      voiceId: voiceId || null,
      voiceName: result.voiceName || selectedVoice?.name || "VoiceDesign",
      emojis: tags,
      caption,
      seed: result.seed,
      preset: PRESETS.find((item) => item.id === preset)?.label ?? "標準",
      model: result.model,
      modelRevision: result.modelRevision,
      createdAt: new Date().toISOString(),
      isFavorite: false,
      exists: true,
      durationSeconds: result.durationSeconds,
    } satisfies Generation;
  }
  async function generateAll() {
    if (!ttsStatus?.healthy)
      return onNotice({
        kind: "warning",
        title: "サーバーの準備が完了していません",
        body: ttsStatus?.running
          ? "サーバーと音声モデルの準備が終わるまで待ってください。"
          : "右上の↻ボタンからサーバーを起動してください。",
        detail: ttsStatus?.message ?? "サーバーの状態を確認しています。",
      });
    const items = segments.length ? segments : analyzeText(text);
    if (!items.some((item) => item.text.trim()))
      return onNotice({
        kind: "warning",
        title: "文章が入力されていません",
        body: "音声に変換する文章を入力してください。",
      });
    setBusy(true);
    setStopRequested(false);
    setDoneCount(0);
    stopRef.current = false;
    try {
      for (const [index, item] of items.entries()) {
        if (stopRef.current) break;
        setActiveIndex(index);
        const generation = await generateOne(item.text, item.tags);
        setGenerations((current) => [generation, ...current]);
        setDoneCount(index + 1);
      }
      if (!stopRef.current)
        onNotice({
          kind: "success",
          title: "音声を生成しました",
          body: "生成結果に追加しました。残したい音声は星のボタンでお気に入りに保存してください。",
        });
    } catch (error) {
      onNotice({
        kind: "error",
        title: "音声を生成できませんでした",
        body: "サーバーが起動しているか、必要な環境が準備されているか確認してください。",
        detail: errorText(error),
      });
    } finally {
      setBusy(false);
      setActiveIndex(null);
    }
  }
  function stopGeneration() {
    stopRef.current = true;
    setStopRequested(true);
  }
  async function favorite(item: Generation) {
    try {
      const updated = await call<Generation>("favorite_generation", { generationId: item.id });
      setGenerations((current) =>
        current.map((entry) =>
          entry.id === item.id ? { ...entry, isFavorite: true, audioPath: updated.audioPath } : entry,
        ),
      );
      onNotice({
        kind: "success",
        title: "お気に入りに保存しました",
        body: "音声をお気に入りフォルダに保存しました。",
      });
    } catch (error) {
      onNotice({
        kind: "error",
        title: "保存できませんでした",
        body: "お気に入りへの保存に失敗しました。",
        detail: errorText(error),
      });
    }
  }
  const serverState = serviceState(ttsStatus);
  const ready = Boolean(ttsStatus?.healthy);
  const trackStatus = (index: number) =>
    busy && activeIndex === index
      ? "生成中"
      : index < doneCount
        ? "完了"
        : stopRequested && !busy
          ? "停止"
          : "待機";
  return (
    <section className="generate-page studio">
      <div className="studio-main">
        <section className="deck composer-deck">
          <header className="deck-head">
            <span className="deck-index">01</span>
            <h2>台本</h2>
            <span className="deck-note">話してほしい文章。改行ごとに1区間として生成します</span>
            <div className="deck-tools">
              <span className="mono">{text.length.toLocaleString("ja-JP")}字</span>
              <button className="text-button" onClick={() => updateText("")}>
                クリア
              </button>
            </div>
          </header>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => updateText(event.target.value)}
            placeholder="ここに文章を入力してください"
            aria-label="話してほしい文章"
          />
          <p className="composer-hint">
            声が途中で崩れる・早口になる・語句が抜けるときは、長い文を改行で短い区間に分けてみてください。
          </p>
        </section>

        <section className="deck track-deck">
          <header className="deck-head">
            <span className="deck-index">02</span>
            <h2>生成リスト</h2>
            <span className="deck-note">
              {segments.length}区間 · 絵文字は文章のカーソル位置に入ります
            </span>
          </header>
          <ol className="track-list">
            {segments.map((segment, index) => (
              <li key={segment.id}>
                <button
                  className={`track-row ${index === selectedSegment ? "selected" : ""}`}
                  onClick={() => setSelectedSegment(index)}
                >
                  <span className="track-number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="track-text">{segment.text || "空の区間"}</span>
                  <span className="track-tags">{segment.tags.map((tag) => tag.emoji).join(" ")}</span>
                  <span className={`track-status ${trackStatus(index) === "生成中" ? "live" : ""}`}>
                    {trackStatus(index)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div className="expression-editor">
            <EmojiPalette onInsert={addEmoji} onNotice={onNotice} />
          </div>
        </section>

        <div className="transport">
          <button className="rec-button" onClick={() => void generateAll()} disabled={busy || !ready}>
            <span className="rec-lamp" />
            {busy ? "生成中…" : "音声を生成"}
          </button>
          <button className="stop-button" onClick={stopGeneration} disabled={!busy}>
            ■ 停止
          </button>
          <span className="transport-status mono">
            {busy
              ? `${(activeIndex ?? 0) + 1} / ${segments.length} 区間を生成しています`
              : !ready
                ? ttsStatus?.running
                  ? "サーバーの起動を待っています"
                  : "サーバーが停止中です。右上の↻ボタンから起動できます"
                : stopRequested
                  ? `停止しました（${doneCount}区間を生成）`
                  : `${segments.length}区間を順番に生成します`}
          </span>
        </div>

        <ResultsPanel generations={generations} onFavorite={favorite} onNotice={onNotice} />
      </div>

      <aside className="studio-side">
        <section className="deck">
          <header className="deck-head compact">
            <span className="deck-index">CH</span>
            <h2>声</h2>
          </header>
          <select
            value={voiceId}
            aria-label="使用するボイス"
            onChange={(event) => {
              setVoiceId(event.target.value);
              setCaption(voices.find((voice) => voice.id === event.target.value)?.caption ?? "");
            }}
          >
            {voices.map((voice) => (
              <option value={voice.id} key={voice.id}>
                {voice.name}
              </option>
            ))}
          </select>
          <div className="channel-strip">
            <VoiceAvatar voice={selectedVoice} />
            <div>
              <b>{selectedVoice?.name ?? "VoiceDesign"}</b>
              <small>
                {selectedVoice?.references.length
                  ? `参照音声 ${selectedVoice.references.length}件`
                  : "参照音声なし"}
              </small>
            </div>
          </div>
          {caption && <p className="channel-caption">{caption}</p>}
        </section>

        <section className="deck">
          <header className="deck-head compact">
            <span className="deck-index">SET</span>
            <h2>プリセット</h2>
          </header>
          <select
            id="generation-preset"
            aria-label="生成設定"
            value={preset}
            onChange={(event) => setPreset(event.target.value)}
          >
            {PRESETS.map((item) => (
              <option value={item.id} key={item.id}>
                {item.label}：{item.note}
              </option>
            ))}
          </select>
          <small className="side-detail">{PRESETS.find((item) => item.id === preset)?.detail}</small>
        </section>

        <section className="deck monitor">
          <header className="deck-head compact">
            <span className="deck-index">MON</span>
            <h2>モニター</h2>
          </header>
          <div className="lamp-row">
            <span className={`lamp ${serverState}`} />
            <span>サーバー</span>
            <b>{ttsStatus?.message ?? "確認中"}</b>
          </div>
          <div className="lamp-row">
            <span className={`lamp ${ttsStatus?.modelLoaded ? "ready" : "warning"}`} />
            <span>モデル</span>
            <b>{ttsStatus?.modelLoaded ? "読み込み済み" : "生成時に読み込み"}</b>
          </div>
        </section>
      </aside>
    </section>
  );
}

export function ResultsPanel({
  generations,
  onFavorite,
  onNotice,
}: {
  generations: Generation[];
  onFavorite: (generation: Generation) => Promise<void>;
  onNotice: (notice: Notice) => void;
}) {
  return (
    <section className="deck results-deck">
      <header className="deck-head">
        <span className="deck-index">03</span>
        <h2>生成結果</h2>
        <span className="deck-note">お気に入り以外は3日後に自動で削除されます</span>
      </header>
      {!generations.length ? (
        <p className="results-empty">まだありません。生成するとここに波形で並びます。</p>
      ) : (
        <ol className="results-list">
          {generations.map((item, index) => (
            <li className="result-row" key={item.id}>
              <span className="track-number">{String(generations.length - index).padStart(2, "0")}</span>
              <div className="result-body">
                <WavePlayer audioBase64={item.audioBase64} durationSeconds={item.durationSeconds} />
                <p>{item.text}</p>
                <span className="result-meta mono">
                  {item.voiceName} · {item.preset} · {nowLabel(item.createdAt)}
                  {item.seed != null && ` · SEED ${item.seed}`}
                </span>
              </div>
              <button
                className={`favorite ${item.isFavorite ? "active" : ""}`}
                aria-label={item.isFavorite ? "お気に入り登録済み" : "お気に入りに追加"}
                onClick={() =>
                  void (item.isFavorite
                    ? onNotice({
                        kind: "warning",
                        title: "お気に入り",
                        body: "お気に入りを解除する場合は、お気に入り画面を使用してください。",
                      })
                    : onFavorite(item))
                }
              >
                {item.isFavorite ? "★" : "☆"}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
