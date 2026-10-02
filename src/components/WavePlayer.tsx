import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { dataAudio, formatSeconds, wavPeaks } from "../utils";

const BARS = 96;

/** 波形つきの再生ボタン。波形をクリックした位置から再生する。 */
export function WavePlayer({
  audioBase64,
  durationSeconds,
}: {
  audioBase64: string | null;
  durationSeconds: number | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(durationSeconds ?? 0);
  const peaks = useMemo(() => wavPeaks(audioBase64, BARS), [audioBase64]);
  const source = dataAudio(audioBase64);

  useEffect(() => {
    if (!source) return;
    const audio = new Audio(source);
    audioRef.current = audio;
    const onTime = () => setPosition(audio.currentTime);
    const onMeta = () => Number.isFinite(audio.duration) && setDuration(audio.duration);
    const onEnd = () => {
      setPlaying(false);
      setPosition(0);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("ended", onEnd);
    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("ended", onEnd);
      audioRef.current = null;
    };
  }, [source]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().then(() => setPlaying(true));
    } else {
      audio.pause();
      setPlaying(false);
    }
  }

  function seek(event: MouseEvent<HTMLDivElement>) {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    audio.currentTime = ((event.clientX - rect.left) / rect.width) * duration;
    setPosition(audio.currentTime);
    if (audio.paused) void audio.play().then(() => setPlaying(true));
  }

  const progress = duration ? position / duration : 0;
  return (
    <div className="wave-player">
      <button
        type="button"
        className={`wave-play ${playing ? "playing" : ""}`}
        aria-label={playing ? "一時停止" : "再生"}
        onClick={toggle}
        disabled={!source}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <div
        className="wave-bars"
        role="slider"
        aria-label="再生位置"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        onClick={seek}
      >
        {(peaks.length ? peaks : Array.from({ length: BARS }, () => 0.08)).map((peak, index) => (
          <span
            key={index}
            className={index / BARS < progress ? "played" : ""}
            style={{ height: `${Math.max(8, peak * 100)}%` }}
          />
        ))}
      </div>
      <span className="wave-time">
        {playing || position > 0 ? formatSeconds(position) : formatSeconds(duration || durationSeconds)}
      </span>
    </div>
  );
}
