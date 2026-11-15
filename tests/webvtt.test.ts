import { describe, expect, it } from 'vitest';
import { toWebVtt } from '@/components/match/webvtt';
import type { Subtitle } from '@/components/match/playback';

const sub = (seq: number, video_ts: number, text: string): Subtitle => ({ seq, video_ts, end_ts: null, text, speaker: 'A', kind: 'comment' });

describe('toWebVtt (lecteur natif TV)', () => {
  it('produit un WebVTT avec délai, position haute et échappement', () => {
    const vtt = toWebVtt([sub(1, 3661.5, 'Panier <3> & faute'), sub(2, 3670, 'Suite')], 0.5, 'haut', false);
    const lines = vtt.split('\n');
    expect(lines[0]).toBe('WEBVTT');
    expect(lines[2]).toMatch(/^01:01:02\.000 --> 01:01:\d\d\.\d{3} line:0$/);
    expect(lines[3]).toBe('Panier &lt;3&gt; &amp; faute');
    expect(vtt.match(/-->/g)).toHaveLength(2);
  });

  it('en bas : pas de réglage de ligne', () => {
    expect(toWebVtt([sub(1, 1, 'x')], 0, 'bas', false)).not.toContain('line:');
  });
});
