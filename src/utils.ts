import { invoke } from "@tauri-apps/api/core";
import type { EmojiTag, Generation, Notice, Segment, ServiceState, TtsStatus } from "./types";
import { DRAFT_TEXT_KEY, EMOJI_PALETTE, INITIAL_DRAFT_TEXT } from "./constants";

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}
export function errorText(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : JSON.stringify(error);
}
export function isUnsupportedCudaKernel(value: string) {
  const message = value.toLowerCase();
  return (
    message.includes("no kernel image is available for execution on the device") ||
    message.includes("cudaerrornokernelimagefordevice")
  );
}
export function nowLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "日時不明"
    : new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
export function dataAudio(base64: string | null) {
  return base64 ? `data:audio/wav;base64,${base64}` : "";
}
export function normalizeGeneration(value: unknown): Generation {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const emojis = Array.isArray(raw.emojis)
    ? raw.emojis
        .map((item) => {
          if (typeof item === "string") return paletteTag(item);
          if (!item || typeof item !== "object") return null;
          const tag = item as Record<string, unknown>;
          if (typeof tag.emoji !== "string") return null;
          const fallback = paletteTag(tag.emoji);
          return {
            emoji: tag.emoji,
            name: typeof tag.name === "string" ? tag.name : fallback.name,
            description: typeof tag.description === "string" ? tag.description : fallback.description,
            supported: tag.supported !== false,
          };
        })
        .filter((item): item is EmojiTag => item !== null)
    : [];
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    audioPath: typeof raw.audioPath === "string" ? raw.audioPath : "",
    audioBase64: typeof raw.audioBase64 === "string" ? raw.audioBase64 : null,
    text: typeof raw.text === "string" ? raw.text : "",
    voiceId: typeof raw.voiceId === "string" ? raw.voiceId : null,
    voiceName: typeof raw.voiceName === "string" && raw.voiceName ? raw.voiceName : "VoiceDesign",
    emojis,
    caption: typeof raw.caption === "string" ? raw.caption : "",
    seed: typeof raw.seed === "number" ? raw.seed : null,
    preset: typeof raw.preset === "string" ? raw.preset : "標準",
    model: typeof raw.model === "string" ? raw.model : "",
    modelRevision: typeof raw.modelRevision === "string" ? raw.modelRevision : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    isFavorite: raw.isFavorite === true,
    exists: raw.exists !== false,
    durationSeconds: typeof raw.durationSeconds === "number" ? raw.durationSeconds : null,
  };
}
export function paletteTag(emoji: string): EmojiTag {
  return (
    EMOJI_PALETTE.find((tag) => tag.emoji === emoji) ?? {
      emoji,
      name: "未対応絵文字",
      description: "入力と保存は可能だが音声効果は保証されない",
      supported: false,
    }
  );
}
export function readDraftText() {
  try {
    return sessionStorage.getItem(DRAFT_TEXT_KEY) ?? INITIAL_DRAFT_TEXT;
  } catch {
    return INITIAL_DRAFT_TEXT;
  }
}
export function saveDraftText(text: string) {
  try {
    sessionStorage.setItem(DRAFT_TEXT_KEY, text);
  } catch {
    /* 保存できない環境でも入力は継続する */
  }
}
export function normalizeEmojiOrder(saved: unknown) {
  const defaultOrder = EMOJI_PALETTE.map((tag) => tag.emoji);
  if (!Array.isArray(saved)) return defaultOrder;
  const known = new Set(defaultOrder);
  const order = saved.filter((emoji): emoji is string => typeof emoji === "string" && known.has(emoji));
  return [...order, ...defaultOrder.filter((emoji) => !order.includes(emoji))];
}
export function readEmojiOrder() {
  return normalizeEmojiOrder([]);
}
export async function saveEmojiOrder(order: string[]) {
  await call("save_emoji_palette_order", { order });
}
export function analyzeText(text: string): Segment[] {
  const chunks = text
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  return (chunks.length ? chunks : [text.trim() || ""]).map((value, index) => {
    const emojis = Array.from(
      value.matchAll(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu),
    ).map((match) => match[0]);
    return { id: `segment-${index}`, text: value, tags: Array.from(new Set(emojis)).map(paletteTag) };
  });
}

/**
 * 文章中の位置 `offset` を含む行が、analyzeText で何番目の区間に当たるかを返す。
 * 区間は空行を除いた行単位なので、その行より前にある空でない行の数がそのまま番号になる。
 */
export function segmentIndexAt(text: string, offset: number) {
  const lines = text.slice(0, offset).split(/\r?\n/u);
  lines.pop();
  return lines.filter((line) => line.trim()).length;
}

export function serviceState(status: TtsStatus | null): ServiceState {
  if (!status) return "warning";
  if (status.healthy) return "ready";
  if (status.running) return "processing";
  return "error";
}
export function sameEmojiOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((emoji, index) => emoji === right[index]);
}
export function moveEmojiInOrder(
  order: string[],
  draggedEmoji: string,
  targetEmoji: string,
  placeAfter: boolean,
) {
  const next = order.filter((emoji) => emoji !== draggedEmoji);
  const targetIndex = next.indexOf(targetEmoji);
  if (targetIndex < 0) return order;
  next.splice(targetIndex + (placeAfter ? 1 : 0), 0, draggedEmoji);
  return next;
}
export function formatBytes(value: number) {
  if (!value) return "サイズ不明";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

/** 未準備の項目から、ダウンロード量の目安（GB）を出す。実測値を切り上げた概算。 */
export function estimateRequiredGb(missingIds: string[], cuda: boolean) {
  const sizes: Record<string, number> = {
    runtime: 0.1,
    python: 0.1,
    sources: 0.1,
    dependencies: cuda ? 6 : 2,
    model: 3,
    ffmpeg: 0.3,
  };
  const total = missingIds.reduce((sum, id) => sum + (sizes[id] ?? 0), 0);
  return total > 0 ? Math.ceil(total) : 0;
}
export function pathLabel(key: string) {
  return (
    (
      {
        root: "アプリルート",
        data: "データ",
        voices: "ボイス",
        favorites: "お気に入り",
        history: "履歴",
        temp: "一時音声",
        models: "モデル",
        logs: "ログ",
      } as Record<string, string>
    )[key] ?? key
  );
}
export function errorReportText(notice: Notice) {
  return [
    `IrodoriStudio エラー報告`,
    `発生日時: ${new Date().toLocaleString("ja-JP")}`,
    `タイトル: ${notice.title}`,
    `メッセージ: ${notice.body}`,
    notice.detail ? `詳細:\n${notice.detail}` : "詳細: なし",
  ].join("\n");
}
export async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}
export function safeFileName(value: string) {
  return value.replace(/[<>:"\\/|?*\u0000-\u001F]/gu, "_").trim() || "irodori-audio";
}
export function fileToData(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * WAV（base64）から波形表示用のピーク値（0〜1）を求める。
 * Irodori-TTSの出力は16bit PCMだが、32bit floatにも対応する。読めない形式は空配列を返す。
 */
export function wavPeaks(base64: string | null, bars: number): number[] {
  if (!base64) return [];
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const view = new DataView(bytes.buffer);
    let offset = 12;
    let format = 0;
    let channels = 1;
    let bits = 16;
    while (offset + 8 <= view.byteLength) {
      const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      const size = view.getUint32(offset + 4, true);
      const body = offset + 8;
      if (id === "fmt ") {
        format = view.getUint16(body, true);
        channels = view.getUint16(body + 2, true);
        bits = view.getUint16(body + 14, true);
      } else if (id === "data") {
        const bytesPerSample = bits / 8;
        const frameSize = bytesPerSample * channels;
        const frames = Math.floor(Math.min(size, view.byteLength - body) / frameSize);
        const perBar = Math.max(1, Math.floor(frames / bars));
        const read =
          format === 3 && bits === 32
            ? (at: number) => view.getFloat32(at, true)
            : bits === 16
              ? (at: number) => view.getInt16(at, true) / 32768
              : null;
        if (!read) return [];
        const peaks: number[] = [];
        for (let bar = 0; bar < bars; bar += 1) {
          let peak = 0;
          const start = bar * perBar;
          // 1本あたり最大256点だけ調べれば、長い音声でも表示は十分正確
          const step = Math.max(1, Math.floor(perBar / 256));
          for (let frame = start; frame < Math.min(start + perBar, frames); frame += step) {
            peak = Math.max(peak, Math.abs(read(body + frame * frameSize)));
          }
          peaks.push(Math.min(1, peak));
        }
        return peaks;
      }
      offset = body + size + (size % 2);
    }
  } catch {
    /* 壊れたデータは波形なしで表示する */
  }
  return [];
}

export function formatSeconds(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--:--";
  const total = Math.max(0, Math.round(value * 10) / 10);
  const minutes = Math.floor(total / 60);
  const seconds = (total % 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${seconds}`;
}
