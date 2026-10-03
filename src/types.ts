export type Page = "generate" | "favorites" | "voices" | "settings" | "license";
export type ServiceState = "ready" | "processing" | "warning" | "error";

export type PortablePaths = {
  root: string;
  data: string;
  voices: string;
  favorites: string;
  history: string;
  temp: string;
  models: string;
  logs: string;
};
export type ComponentStatus = {
  id: string;
  label: string;
  installed: boolean;
  required: boolean;
  detail: string;
};
export type EnvironmentInfo = {
  windows: string;
  architecture: string;
  cpu: string;
  gpu: string;
  cudaAvailable: boolean;
  /** bf16で計算できるGPUがあるか（RTX 30系以降） */
  bf16Supported?: boolean;
  python: string;
  uv: string;
  ffmpeg: string;
  freeSpaceGb: number | null;
  writable: boolean;
  irodoriRoot: string;
  serverRoot: string;
  components?: ComponentStatus[];
};
export type AppState = {
  setupRequired: boolean;
  noticeVersion: string;
  noticeAcknowledgedAt: string | null;
  paths: PortablePaths;
  environment: EnvironmentInfo;
};
export type TtsConfig = {
  serverRoot: string;
  irodoriRoot: string;
  pythonPath: string;
  voicesDir: string;
  portableRoot?: string;
  serverUrl: string;
  port: number;
  apiKey: string;
  model: string;
  modelRevision: string;
  defaultVoice: string;
  speed: number;
  numSteps: number;
  cfgScaleText: number;
  cfgScaleSpeaker: number;
  seed: number | null;
  modelPrecision: string;
  codecPrecision: string;
  modelDevice: string;
  codecDevice: string;
  schedule: string;
  swayCoefficient: number;
  autoStart: boolean;
  autoStartMigrated?: boolean;
  stopOnExit: boolean;
};
export type TtsStatus = {
  healthy: boolean;
  running: boolean;
  ownedByStudio: boolean;
  pid: number | null;
  port: number;
  modelLoaded: boolean;
  message: string;
};
export type Voice = {
  id: string;
  name: string;
  iconPath: string | null;
  iconDataUrl?: string | null;
  caption: string;
  voiceDesign: string;
  references: string[];
  updatedAt: string;
};
export type VoiceDraft = Omit<Voice, "id" | "updatedAt"> & { id: string | null };
export type EmojiTag = { emoji: string; name: string; description: string; supported: boolean };
export type Segment = { id: string; text: string; tags: EmojiTag[] };
export type Generation = {
  id: string;
  audioPath: string;
  audioBase64: string | null;
  text: string;
  voiceId: string | null;
  voiceName: string;
  emojis: EmojiTag[];
  caption: string;
  seed: number | null;
  preset: string;
  model: string;
  modelRevision: string;
  createdAt: string;
  isFavorite: boolean;
  exists: boolean;
  durationSeconds: number | null;
};
export type Notice = {
  kind: "error" | "warning" | "success";
  title: string;
  body: string;
  detail?: string;
  action?: { label: string; onClick: () => Promise<void> };
};
export type HuggingFaceModel = {
  id: string;
  downloads: number | null;
  likes: number | null;
  /** 導入できるモデルID（owner/model または owner/model/variant） */
  installable: string[];
};
export type ModelInstallProgress = {
  model: string;
  file: string;
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
};
export type ModelFamily = {
  id: string;
  label: string;
  normal: string;
  quantized: string;
  normalRevision: string;
  quantizedRevision: string;
};
