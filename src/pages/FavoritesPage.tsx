import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import type { Generation, Notice } from "../types";
import { call, errorText, normalizeGeneration, nowLabel, safeFileName } from "../utils";
import { WavePlayer } from "../components/WavePlayer";

export function FavoritesPage({ onNotice }: { onNotice: (notice: Notice) => void }) {
  const [items, setItems] = useState<Generation[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void (async () => {
      try {
        const result = await call<unknown[]>("list_favorites");
        setItems(result.map(normalizeGeneration).filter((item) => item.id));
      } catch (error) {
        onNotice({
          kind: "error",
          title: "お気に入りを読み込めません",
          body: "保存した音声の一覧を読み込めませんでした。",
          detail: errorText(error),
        });
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  const grouped = useMemo(
    () =>
      Array.from(new Set(items.map((item) => item.voiceName))).map((name) => ({
        name,
        items: items.filter((item) => item.voiceName === name),
      })),
    [items],
  );
  async function remove(item: Generation) {
    if (!window.confirm("この音声をお気に入りから削除しますか？生成履歴は残ります。")) return;
    try {
      await call("unfavorite_generation", { generationId: item.id });
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      onNotice({
        kind: "success",
        title: "お気に入りから削除しました",
        body: "音声ファイルを削除し、生成履歴を残しました。",
      });
    } catch (error) {
      onNotice({ kind: "error", title: "削除できませんでした", body: errorText(error) });
    }
  }
  async function exportFile(item: Generation) {
    try {
      const path = await save({
        defaultPath: `${safeFileName(item.text.slice(0, 24))}.wav`,
        filters: [{ name: "WAV音声", extensions: ["wav"] }],
      });
      if (!path) return;
      try {
        await call("export_favorite", { generationId: item.id, destination: path });
      } catch (error) {
        if (!window.confirm("保存先に同名ファイルがあります。上書きしますか？")) return;
        await call("export_favorite", { generationId: item.id, destination: path, overwrite: true });
      }
      onNotice({
        kind: "success",
        title: "ファイルを保存しました",
        body: "お気に入りの音声を指定した場所へ保存しました。",
      });
    } catch (error) {
      onNotice({ kind: "error", title: "保存できませんでした", body: errorText(error) });
    }
  }
  async function openFolder(item: Generation) {
    try {
      await call("open_audio_folder", { generationId: item.id });
    } catch (error) {
      onNotice({ kind: "error", title: "フォルダを開けません", body: errorText(error) });
    }
  }
  if (loading)
    return (
      <div className="loading-inline">
        <div className="loader-orb" />
        お気に入りを読み込んでいます…
      </div>
    );
  if (selectedVoice) {
    const group = grouped.find((entry) => entry.name === selectedVoice);
    return (
      <section className="favorites-page">
        <button className="back-link" onClick={() => setSelectedVoice(null)}>
          ← ボイス一覧へ戻る
        </button>
        <div className="page-intro">
          <span className="section-label">お気に入り音声</span>
          <h2>{selectedVoice}</h2>
          <p>{group?.items.length ?? 0}件の音声を保存しています。</p>
        </div>
        <FriendlyFavoriteList
          items={group?.items ?? []}
          onRemove={remove}
          onExport={exportFile}
          onOpen={openFolder}
        />
      </section>
    );
  }
  return (
    <section className="favorites-page">
      <div className="page-intro">
        <span className="section-label">保存した音声</span>
        <h2>お気に入り</h2>
        <p>ボイスを選択すると、そのボイスで保存した音声を表示します。</p>
      </div>
      {grouped.length ? (
        <div className="character-grid">
          {grouped.map((group) => (
            <button className="character-card" key={group.name} onClick={() => setSelectedVoice(group.name)}>
              <span className="character-avatar">{group.name.slice(0, 1)}</span>
              <div>
                <b>{group.name}</b>
                <small>{group.items.length}件の音声</small>
                <em>最終保存 {nowLabel(group.items[0].createdAt)}</em>
              </div>
              <span>→</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="surface blank-state">
          <span>★</span>
          <b>お気に入りはありません</b>
          <small>生成結果の星ボタンから音声を保存できます。</small>
        </div>
      )}
    </section>
  );
}
export function FriendlyFavoriteList({
  items,
  onRemove,
  onExport,
  onOpen,
}: {
  items: Generation[];
  onRemove: (item: Generation) => Promise<void>;
  onExport: (item: Generation) => Promise<void>;
  onOpen: (item: Generation) => Promise<void>;
}) {
  return (
    <div className="favorite-list">
      {items.map((item) => (
        <article className="surface favorite-item" key={item.id}>
          <div className="favorite-audio">
            <WavePlayer audioBase64={item.audioBase64} durationSeconds={item.durationSeconds} />
          </div>
          <div className="favorite-copy">
            <p>{item.text}</p>
            <div className="favorite-details">
              <span>ボイス: {item.voiceName}</span>
              <span>声の説明: {item.caption || "設定なし"}</span>
              <span>{item.emojis.map((tag) => tag.emoji).join(" ") || "絵文字なし"}</span>
              <span>{nowLabel(item.createdAt)}</span>
            </div>
          </div>
          <div className="favorite-actions">
            <button onClick={() => void onExport(item)}>↓ ファイルに保存</button>
            <button onClick={() => void onOpen(item)}>▣ 保存フォルダを開く</button>
            <button className="danger-text" onClick={() => void onRemove(item)}>
              お気に入りから削除
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
