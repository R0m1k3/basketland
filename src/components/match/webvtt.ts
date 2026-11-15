import { minReadTime, readDuration, type Subtitle } from '@/components/match/playback';
import { stripScores } from '@/components/match/spoiler';

/** VF au format WebVTT, pour le lecteur natif de l'appli TV (mêmes durées que la surimpression). */
export function toWebVtt(subs: Subtitle[], delay: number, pos: 'bas' | 'haut', noSpoil: boolean): string {
  const ts = (t: number) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const sec = Math.floor((ms % 60_000) / 1000);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms % 1000, 3)}`;
  };
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const out = ['WEBVTT', ''];
  subs.forEach((s, i) => {
    const start = Math.max(0, s.video_ts + delay);
    const next = subs[i + 1];
    const nextStart = next ? next.video_ts + delay : Infinity;
    const end = Math.max(start + 0.5, Math.min(start + readDuration(s), Math.max(nextStart, start + minReadTime(s))));
    const text = esc((noSpoil ? stripScores(s.text) : s.text).replace(/\n{2,}/g, '\n').trim());
    if (!text) return;
    out.push(`${ts(start)} --> ${ts(end)}${pos === 'haut' ? ' line:0' : ''}`, text, '');
  });
  return out.join('\n');
}
