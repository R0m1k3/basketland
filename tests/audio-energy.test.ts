import { describe, expect, it } from 'vitest';
import { addWordEnergy, audioEnvelope, envelopeFromPcm, withEnergy } from '../src/lib/audioEnergy';
import { parseVerboseJson, shiftTranscript } from '../src/lib/commentaryCues';

/** PCM 16 bits mono : une suite de [durée (s), amplitude 0-1] en sinus 440 Hz. */
function pcm(parts: [number, number][], sr = 8000): Uint8Array {
  const total = parts.reduce((n, [d]) => n + Math.round(d * sr), 0);
  const buf = new Uint8Array(total * 2);
  const view = new DataView(buf.buffer);
  let i = 0;
  for (const [d, amp] of parts) {
    for (let k = 0; k < Math.round(d * sr); k++, i++) view.setInt16(i * 2, Math.round(amp * 32767 * Math.sin((2 * Math.PI * 440 * i) / sr)), true);
  }
  return buf;
}

describe('intensité de la voix', () => {
  it('enveloppe : une trame de 50 ms par tranche, plus forte quand le son est plus fort', () => {
    const env = envelopeFromPcm(pcm([[1, 0.05], [1, 0.4]]));
    expect(env.frameSec).toBeCloseTo(0.05);
    expect(env.power.length).toBe(40);
    expect(env.power[30]).toBeGreaterThan(env.power[5] * 50);
  });

  it('énergie de chaque mot relative au niveau habituel du tronçon (médiane)', () => {
    const env = envelopeFromPcm(pcm([[2, 0.05], [1, 0.4]]));
    const words = addWordEnergy(
      [
        { word: ' calm', start: 0.2, end: 0.6 },
        { word: ' still', start: 1.2, end: 1.6 },
        { word: ' BANG!', start: 2.2, end: 2.7 },
      ],
      env,
    );
    expect(words[0].energy).toBeCloseTo(0, 0);
    // 0,4 / 0,05 en amplitude = +18 dB.
    expect(words[2].energy).toBeGreaterThan(16);
    expect(words[2].energy).toBeLessThan(20);
  });

  it('les mots hors de l’audio restent sans énergie ; transcript annoté, mots imbriqués compris', () => {
    const env = envelopeFromPcm(pcm([[1, 0.1]]));
    const t = withEnergy(
      { segments: [{ start: 0, end: 1, text: ' a b', words: [{ word: ' a', start: 0.1, end: 0.3 }] }], words: [{ word: ' far', start: 5, end: 5.2 }, { word: ' a', start: 0.1, end: 0.3 }] },
      env,
    );
    expect(t.words[0].energy).toBeUndefined();
    expect(t.words[1].energy).toBe(0);
    expect(t.segments[0].words?.[0].energy).toBe(0);
  });

  it('l’énergie survit à la lecture du cache et au recalage des tronçons', () => {
    const t = parseVerboseJson({ segments: [{ start: 0, end: 1, text: ' Wow' }], words: [{ word: ' Wow', start: 0.1, end: 0.4, energy: 7.5 }] });
    expect(t.words[0].energy).toBe(7.5);
    expect(shiftTranscript(t, 600).words[0]).toEqual({ word: ' Wow', start: 600.1, end: 600.4, energy: 7.5 });
  });

  it('décodage impossible : null, jamais d’erreur', async () => {
    await expect(audioEnvelope('/nonexistent/chunk.ogg')).resolves.toBeNull();
  });
});
