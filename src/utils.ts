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
