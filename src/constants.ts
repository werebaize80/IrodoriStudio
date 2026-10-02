import type { EmojiTag, ModelFamily, Page } from "./types";

export const NOTICE_VERSION = "2026-09-04-v1";
export const CLONING_NOTICE = `音声クローン利用時の注意

第三者の明示的な同意、または必要な権利を得ていない音声のクローン・なりすましは禁止しています。

詐欺、虚偽情報の作成、本人の発言であると誤認させる目的での利用は禁止しています。

生成した音声を公開・配布する場合は、必要な権利や許可を利用者自身で確認してください。

本アプリの利用にあたっては、法令および利用規約を遵守してください。違法行為や規約に反する利用については、利用者自身が責任を負います。`;
export const EMOJI_PALETTE: EmojiTag[] = [
  ["👂", "囁き", "耳元の音"],
  ["😮‍💨", "吐息", "溜息、寝息"],
  ["⏸️", "間", "沈黙"],
  ["🤭", "笑い", "くすくす、含み笑い"],
  ["🥵", "喘ぎ", "うめき声、唸り声"],
  ["📢", "エコー", "リバーブ"],
  ["😏", "からかう", "甘えるように"],
  ["🥺", "震え声", "自信なさげに"],
  ["🌬️", "息切れ", "荒い息遣い、呼吸音"],
  ["😮", "息をのむ", "Gasp"],
  ["👅", "舐める音", "咀嚼音、水音"],
  ["💋", "リップノイズ", "Lip smack"],
  ["🫶", "優しく", "Tenderly"],
  ["😭", "泣き声", "嗚咽、悲しみ"],
  ["😱", "悲鳴", "叫び、絶叫"],
  ["😪", "眠そう", "気だるげに"],
  ["😴", "寝言", "いびき"],
  ["⏩", "早口", "一気に、急いで"],
  ["📞", "電話越し", "スピーカー越し"],
  ["🐢", "ゆっくり", "Slowly"],
  ["🥤", "飲み込む", "唾を飲む音"],
  ["🤧", "咳・鼻", "咳き込み、鼻すすり"],
  ["😒", "舌打ち", "Tutting"],
  ["😰", "慌てる", "動揺、緊張、どもり"],
  ["😆", "喜び", "嬉しそうに"],
  ["💥", "勢いよく", "力強い勢い"],
  ["😠", "怒り", "不満げ、拗ねる"],
  ["😲", "驚き", "感嘆"],
  ["🥱", "あくび", "Yawn"],
  ["😖", "苦しげ", "Agonizingly"],
  ["😟", "心配", "不安そうに"],
  ["🫣", "照れ", "恥ずかしそうに"],
  ["🙄", "呆れ", "Exasperatedly"],
  ["😊", "楽しげ", "嬉しそうに"],
  ["😎", "得意げ", "自信ありげに"],
  ["👌", "相槌", "頷く音"],
  ["🙏", "懇願", "お願いするように"],
  ["🥴", "酔う", "Drunkenly"],
  ["🎵", "鼻歌", "Humming"],
  ["🤐", "口を塞ぐ", "Muffled"],
  ["😌", "安堵", "満足げに"],
  ["🤔", "疑問", "Questioning"],
  ["💪", "力強く", "力を込めて"],
  ["👃", "嗅ぐ音", "匂いを嗅ぐ音"],
  ["📖", "朗読", "ナレーション"],
].map(([emoji, name, description]) => ({ emoji, name, description, supported: true }));
export const navItems: { page: Page; label: string; detail: string }[] = [
  { page: "generate", label: "音声生成", detail: "文章から音声を作成" },
  { page: "favorites", label: "お気に入り", detail: "保存した音声" },
  { page: "voices", label: "ボイス管理", detail: "声の設定と参照音声" },
  { page: "settings", label: "設定", detail: "モデル・サーバー・環境確認" },
  { page: "license", label: "ライセンス", detail: "利用条件と第三者通知" },
];
export const MODEL_FAMILIES: ModelFamily[] = [
  {
    id: "anime",
    label: "Anime版",
    normal: "phasefield-audio/Irodori-TTS-v4.1-Anime",
    quantized: "phasefield-audio/Irodori-TTS-v4.1-Anime/int8-weight-only",
    normalRevision: "main",
    quantizedRevision: "main",
  },
  {
    id: "original",
    label: "オリジナル版",
    normal: "Aratako/Irodori-TTS-v4.1-Small",
    quantized: "Aratako/Irodori-TTS-v4.1-Small-Quantized/int8-weight-only",
    normalRevision: "2b28324dc263ed5e6638b3cf3dd94c82ead07b4b",
    quantizedRevision: "ef04e6c3ba56138ae23e86a2eabc004f76990e37",
  },
];
export const PRESETS = [
  { id: "standard", label: "標準", note: "速度と品質のバランス", detail: "通常のGPU利用を想定" },
  { id: "quality", label: "高品質", note: "品質優先", detail: "時間とVRAMが増える可能性" },
  { id: "vram", label: "VRAM節約", note: "メモリ使用量を抑える", detail: "GPUメモリが少ない環境向け" },
  { id: "cpu", label: "グラボ無し", note: "CPUのみで生成", detail: "生成に数十秒以上かかる場合あり" },
  { id: "custom", label: "カスタム", note: "詳細設定を使用", detail: "設定画面の値を反映" },
];
export const INSTALL_ORDER = ["runtime", "python", "sources", "dependencies", "model", "ffmpeg"] as const;
export const INSTALL_LABELS: Record<string, string> = {
  runtime: "実行環境",
  python: "Python",
  sources: "音声生成プログラム",
  dependencies: "必要な部品",
  model: "音声モデル",
  ffmpeg: "音声変換機能",
};

export const INITIAL_DRAFT_TEXT = "こんにちは。IrodoriStudioで音声を生成します。";
export const DRAFT_TEXT_KEY = "irodoriStudio.draftText";
