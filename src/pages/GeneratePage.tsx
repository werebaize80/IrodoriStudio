import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import type { EmojiTag, Generation, Notice, Segment, TtsStatus, Voice } from "../types";
import { EMOJI_PALETTE, PRESETS } from "../constants";
import {
  analyzeText,
  call,
  dataAudio,
  errorText,
  moveEmojiInOrder,
  normalizeEmojiOrder,
  nowLabel,
  readDraftText,
  readEmojiOrder,
  sameEmojiOrder,
  saveDraftText,
  saveEmojiOrder,
  serviceState,
} from "../utils";
import { StatusRow, VoiceAvatar } from "../components/common";

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
          onClick={() => {
            if (!reorderMode) onInsert(tag);
          }}
        >
          <span>{tag.emoji}</span>
          <b>{tag.name}</b>
          <small>{tag.description}</small>
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
  const [manualMode, setManualMode] = useState(false);
  const stopRef = useRef(false);
  useEffect(() => {
    if (voices.length && !voices.some((voice) => voice.id === voiceId)) setVoiceId(voices[0].id);
  }, [voices]);
  const selectedVoice = voices.find((voice) => voice.id === voiceId);
  const selected = segments[selectedSegment] ?? segments[0];
  function updateText(value: string) {
    setText(value);
    saveDraftText(value);
    setSegments(analyzeText(value));
    setSelectedSegment(0);
  }
  function toggleMode() {
    const next = !manualMode;
    setManualMode(next);
    if (!next) setSegments(analyzeText(text));
  }
  function addEmoji(tag: EmojiTag) {
    const textarea = document.querySelector<HTMLTextAreaElement>(".composer-card > textarea");
    const start = textarea?.selectionStart ?? text.length;
    const end = textarea?.selectionEnd ?? start;
    const nextText = `${text.slice(0, start)}${tag.emoji}${text.slice(end)}`;
    updateText(nextText);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      const position = start + tag.emoji.length;
      textarea?.setSelectionRange(position, position);
    });
  }
  function removeEmoji(index: number) {
    setSegments((current) =>
      current.map((item, segmentIndex) =>
        segmentIndex === selectedSegment
          ? { ...item, tags: item.tags.filter((_, tagIndex) => tagIndex !== index) }
          : item,
      ),
    );
  }
  function moveEmoji(index: number, delta: number) {
    setSegments((current) =>
      current.map((item, segmentIndex) => {
        if (segmentIndex !== selectedSegment) return item;
        const next = [...item.tags];
        const target = index + delta;
        if (target < 0 || target >= next.length) return item;
        [next[index], next[target]] = [next[target], next[index]];
        return { ...item, tags: next };
      }),
    );
  }
  function addQueueItem() {
    const source = text.trim();
    if (!source) return;
    const nextText = text.includes(source) ? text : `${text}\n${source}`;
    setText(nextText);
    saveDraftText(nextText);
    onNotice({
      kind: "success",
      title: "生成リストに追加しました",
      body: "入力した文章を生成リストに追加しました。",
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
          : "設定画面または左下のボタンからサーバーを起動してください。",
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
    stopRef.current = false;
    try {
      for (const item of items) {
        if (stopRef.current) break;
        const generation = await generateOne(item.text, item.tags);
        setGenerations((current) => [generation, ...current]);
      }
      if (!stopRef.current)
        onNotice({
          kind: "success",
          title: "音声を生成しました",
          body: "生成結果を下に表示しました。保存する場合は星のボタンを選択してください。",
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
  return (
    <section className="generate-page">
      <div className="model-strip">
        <div>
          <span className="section-label">使用モデル</span>
          <b>Irodori-TTS v4.1</b>
          <small>{preset === "cpu" ? "CPUで処理" : "ローカル処理"}</small>
        </div>
        <div className="model-strip-status">
          <StatusRow
            label="サーバー"
            state={serviceState(ttsStatus)}
            detail={ttsStatus?.message ?? "状態を確認しています"}
          />
          <StatusRow
            label="モデル"
            state={ttsStatus?.modelLoaded ? "ready" : "warning"}
            detail={ttsStatus?.modelLoaded ? "準備済み" : "音声生成時に読み込み"}
          />
        </div>
      </div>
      <div className="generate-grid">
        <div className="composer-column">
          <div className="surface composer-card">
            <div className="card-heading">
              <div>
                <span className="section-label">文章と感情</span>
                <h2>話してほしい文章</h2>
              </div>
              <div className="text-tools">
                <span>{text.length.toLocaleString("ja-JP")} 文字</span>
                <button onClick={() => updateText("")}>クリア</button>
              </div>
            </div>
            <textarea
              value={text}
              onChange={(event) => updateText(event.target.value)}
              placeholder="ここに文章を入力してください"
              aria-label="話してほしい文章"
            />
            <div className="composer-footer">
              <span>日本語 · ローカル解析</span>
              <span>絵文字はカーソル位置に挿入</span>
              <button className={`toggle ${manualMode ? "on" : ""}`} onClick={toggleMode}>
                <i /> {manualMode ? "手動編集" : "自動解析"}
              </button>
            </div>
          </div>
          <div className="surface emoji-card">
            <div className="card-heading">
              <div>
                <span className="section-label">絵文字による表現</span>
                <h2>文章の感情表現</h2>
              </div>
              <span className="helper-text">1文あたり最大3個</span>
            </div>
            <div className="segment-tabs">
              {segments.map((segment, index) => (
                <button
                  key={segment.id}
                  className={index === selectedSegment ? "selected" : ""}
                  onClick={() => setSelectedSegment(index)}
                >
                  {segment.text.slice(0, 18) || "空の区間"}
                  {segment.tags.length > 0 && <em>{segment.tags.length}</em>}
                </button>
              ))}
            </div>
            <div className="selected-expression">
              <div className="selected-expression-top">
                <b>{selected?.text || "文章を入力すると表示されます"}</b>
                <small>{selected?.tags.length ?? 0} 個の絵文字</small>
              </div>
              <div className="tag-list">
                {selected?.tags.map((tag, index) => (
                  <div
                    className={`emoji-tag ${tag.supported ? "" : "unsupported"}`}
                    key={`${tag.emoji}-${index}`}
                  >
                    <span>{tag.emoji}</span>
                    <div>
                      <b>{tag.name}</b>
                      <small>{tag.description}</small>
                    </div>
                    <button aria-label={`${tag.name}を削除`} onClick={() => removeEmoji(index)}>
                      ×
                    </button>
                    <button aria-label="左へ移動" disabled={index === 0} onClick={() => moveEmoji(index, -1)}>
                      ‹
                    </button>
                    <button
                      aria-label="右へ移動"
                      disabled={index === (selected?.tags.length ?? 1) - 1}
                      onClick={() => moveEmoji(index, 1)}
                    >
                      ›
                    </button>
                  </div>
                ))}
              </div>
              <EmojiPalette onInsert={addEmoji} onNotice={onNotice} />
            </div>
          </div>
          <div className="surface queue-card">
            <div className="card-heading">
              <div>
                <span className="section-label">生成リスト</span>
                <h2>生成する文章</h2>
              </div>
              <button className="button subtle small" onClick={addQueueItem}>
                ＋ 文章を追加
              </button>
            </div>
            <div className="queue-row">
              <span className="queue-number">01</span>
              <div>
                <b>{text.split(/[。！？!?\n]/u)[0] || "新しい文章"}</b>
                <small>
                  {segments.length}区間 · {generations.length}件生成済み
                </small>
              </div>
              <span className="queue-status">{busy ? "処理中" : stopRequested ? "停止済み" : "待機中"}</span>
            </div>
          </div>
        </div>
        <aside className="control-column">
          <div className="surface voice-card">
            <div className="card-heading">
              <div>
                <span className="section-label">声の設定</span>
                <h2>ボイス</h2>
              </div>
            </div>
            <select
              value={voiceId}
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
            <div className="selected-voice">
              <VoiceAvatar voice={selectedVoice} />
              <div>
                <b>{selectedVoice?.name ?? "VoiceDesign"}</b>
                <small>
                  {selectedVoice?.references.length
                    ? `${selectedVoice.references.length}件の参照音声`
                    : "参照音声なし"}
                </small>
              </div>
              <button
                aria-label="試聴"
                onClick={() =>
                  onNotice({
                    kind: "warning",
                    title: "試聴",
                    body: "文章を生成すると、生成結果から再生できます。",
                  })
                }
              >
                ▶
              </button>
            </div>
          </div>
          <div className="surface preset-card">
            <div className="card-heading">
              <div>
                <span className="section-label">簡単設定</span>
                <h2>生成設定</h2>
              </div>
            </div>
            <label className="preset-select-label" htmlFor="generation-preset">
              設定を選択
            </label>
            <select
              id="generation-preset"
              className="preset-select"
              value={preset}
              onChange={(event) => setPreset(event.target.value)}
            >
              {PRESETS.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.label}：{item.note}
                </option>
              ))}
            </select>
            <small className="preset-select-detail">
              {PRESETS.find((item) => item.id === preset)?.detail}
            </small>
          </div>
          <div className="generate-actions">
            <button
              className="button primary generate-button"
              onClick={() => void generateAll()}
              disabled={busy || !ttsStatus?.healthy}
            >
              {busy
                ? "音声を生成しています…"
                : !ttsStatus?.healthy
                  ? "サーバーを準備してください"
                  : "▶ 音声を生成"}
              <small>
                {busy
                  ? "処理中です。しばらくお待ちください"
                  : !ttsStatus?.healthy
                    ? ttsStatus?.running
                      ? "起動が完了するまでお待ちください"
                      : "設定画面または左下から起動できます"
                    : "入力した文章をまとめて生成"}
              </small>
            </button>
            <button className="button stop-button" onClick={stopGeneration} disabled={!busy}>
              ■ 生成を停止
            </button>
          </div>
        </aside>
      </div>
      <ResultsPanel generations={generations} onFavorite={favorite} onNotice={onNotice} />
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
  if (!generations.length)
    return (
      <div className="surface empty-result">
        <span className="empty-icon">♫</span>
        <div>
          <b>生成結果はここに表示されます</b>
          <small>保存する音声は星のボタンでお気に入りに追加できます。</small>
        </div>
      </div>
    );
  return (
    <section className="surface results-card">
      <div className="card-heading">
        <div>
          <span className="section-label">生成結果</span>
          <h2>生成結果</h2>
        </div>
        <span className="helper-text">お気に入り以外は終了時に一時ファイルを削除</span>
      </div>
      <div className="results-list">
        {generations.map((item) => (
          <article className="result-item" key={item.id}>
            <div className="result-index">♫</div>
            <div className="result-main">
              <div className="result-meta">
                <b>{item.voiceName}</b>
                <span>{nowLabel(item.createdAt)}</span>
                <span>{item.preset}</span>
              </div>
              <p>{item.text}</p>
              <div className="result-tags">
                {item.emojis.map((tag, index) => (
                  <span key={`${tag.emoji}-${index}`}>
                    {tag.emoji} {tag.name}
                  </span>
                ))}
              </div>
              <audio controls src={dataAudio(item.audioBase64)} />
            </div>
            <div className="result-actions">
              <button
                className={item.isFavorite ? "favorite active" : "favorite"}
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
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
