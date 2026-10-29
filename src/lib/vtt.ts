/** Export WebVTT des sous-titres. */
import type { SubtitleRow } from './types';

export function vttTimestamp(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

function escapeVtt(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/-->/g, '→');
}

export function toWebVtt(subs: Pick<SubtitleRow, 'seq' | 'video_ts' | 'end_ts' | 'text_fr' | 'speaker'>[], title = ''): string {
  const out = ['WEBVTT', title ? `NOTE ${title.replace(/-->/g, '→')}` : '', ''].filter((l, i) => i !== 1 || l);
  const sorted = [...subs].sort((a, b) => a.video_ts - b.video_ts || a.seq - b.seq);
  sorted.forEach((s, i) => {
    const end = Math.max(s.end_ts ?? s.video_ts + 3, s.video_ts + 0.5);
    out.push(String(i + 1));
    out.push(`${vttTimestamp(s.video_ts)} --> ${vttTimestamp(end)}`);
    out.push(s.speaker ? `<v ${escapeVtt(s.speaker)}>${escapeVtt(s.text_fr)}` : escapeVtt(s.text_fr));
    out.push('');
  });
  return out.join('\n');
}
