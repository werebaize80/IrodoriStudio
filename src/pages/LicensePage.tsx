import { openUrl } from "@tauri-apps/plugin-opener";

export function LicensePage() {
  const entries = [
    ["Irodori-TTS", "MIT", "https://github.com/Aratako/Irodori-TTS"],
    ["Irodori-TTS-Server", "MIT", "https://github.com/Aratako/Irodori-TTS-Server"],
    ["Irodori-TTS-v4.1-Small", "モデル利用条件", "https://huggingface.co/Aratako/Irodori-TTS-v4.1-Small"],
    [
      "Semantic-DACVAE-Japanese-32dim",
      "モデル利用条件",
      "https://huggingface.co/Aratako/Semantic-DACVAE-Japanese-32dim",
    ],
    ["SilentCipher", "upstream LICENSEを参照", "https://github.com/SesameAILabs/silentcipher"],
    ["PyTorch / Transformers / FastAPI", "各公式利用条件を参照", "https://pytorch.org/"],
  ];
  return (
    <section className="license-page">
      <div className="page-intro">
        <span className="section-label">利用条件と通知</span>
        <h2>ライセンス</h2>
        <p>
          使用しているソフトウェアとモデルの利用条件を表示します。詳細は同梱ファイルまたは公式ページを確認してください。
        </p>
      </div>
      <div className="surface cloning-card">
        <span>ⓘ</span>
        <div>
          <b>音声クローンの利用について</b>
          <p>
            第三者の同意や必要な権利がない音声のクローン、なりすまし、詐欺などへの利用は禁止されています。公開・配布時は必要な権利を確認してください。
          </p>
        </div>
      </div>
      <div className="surface license-table">
        <div className="license-table-head">
          <span>コンポーネント</span>
          <span>ライセンス</span>
          <span>配布元</span>
        </div>
        {entries.map(([name, license, url]) => (
          <div className="license-row" key={name}>
            <b>{name}</b>
            <span>{license}</span>
            <button onClick={() => void openUrl(url)}>公式ページ ↗</button>
          </div>
        ))}
      </div>
      <div className="surface notice-files">
        <b>同梱ファイル</b>
        <div>
          <span>VOICE_CLONING_NOTICE.txt</span>
          <span>THIRD_PARTY_NOTICES.txt</span>
          <span>licenses/</span>
        </div>
      </div>
    </section>
  );
}
