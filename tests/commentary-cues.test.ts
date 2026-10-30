import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCues,
  filterTranscript,
  hallucinationReason,
  isRepetitionLoop,
  joinWords,
  mergeTranscripts,
  parseVerboseJson,
  punctuateWords,
  shiftTranscript,
  wordsFromTranscript,
  wrapTwoLines,
  type AsrSegment,
  type AsrWord,
} from '../src/lib/commentaryCues';
import { cuesFromChunks, planChunks } from '../src/lib/commentary';

/** Mots réguliers : `text` découpé, un mot toutes les `step` s à partir de `t0`. */
function words(text: string, t0 = 0, step = 0.3, len = 0.25): AsrWord[] {
  return text.split(' ').map((w, i) => ({ word: ` ${w}`, start: t0 + i * step, end: t0 + i * step + len }));
}

const seg = (start: number, end: number, text: string, o: Partial<AsrSegment> = {}): AsrSegment => ({
  start,
  end,
  text,
  avg_logprob: -0.2,
  no_speech_prob: 0.05,
  compression_ratio: 1.4,
  ...o,
});

describe('parseVerboseJson', () => {
  it('lit segments et mots de niveau supérieur (forme TranscriptionVerbose d’OpenAI / speaches)', () => {
    const t = parseVerboseJson({
      task: 'transcribe',
      language: 'english',
      duration: 12.5,
      text: ' LeBron for three. Got it!',
      segments: [{ id: 0, seek: 0, start: 0.5, end: 2.8, text: ' LeBron for three. Got it!', tokens: [1, 2], temperature: 0, avg_logprob: -0.21, compression_ratio: 1.1, no_speech_prob: 0.01 }],
      words: [
        { word: ' LeBron', start: 0.5, end: 0.9 },
        { word: ' for', start: 0.9, end: 1.1 },
      ],
    });
    expect(t.segments).toEqual([{ id: 0, start: 0.5, end: 2.8, text: ' LeBron for three. Got it!', avg_logprob: -0.21, compression_ratio: 1.1, no_speech_prob: 0.01 }]);
    expect(t.words).toHaveLength(2);
  });

  it('tolère l’absence de words, des entrées malformées et des mots imbriqués dans les segments', () => {
    const t = parseVerboseJson({
      segments: [null, { start: 'x', end: 1, text: 'a' }, { start: 1, end: 2, text: ' ok', words: [{ word: ' ok', start: 1, end: 1.4 }, { word: 3 }] }],
    });
    expect(t.words).toEqual([]);
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0].words).toEqual([{ word: ' ok', start: 1, end: 1.4 }]);
    expect(parseVerboseJson(null)).toEqual({ segments: [], words: [] });
  });
});

describe('sortie réelle de faster-whisper', () => {
  // Produite en CPU (tiny.en, word_timestamps=True) sur 11 s d'anglais encodé
  // comme le fait l'extraction (Opus 24 kb/s, mono 16 kHz), puis mise au
  // format TranscriptionVerbose que renvoie speaches.
  const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'faster-whisper-jfk.json'), 'utf8')) as unknown;

  it('a la forme attendue (mots à espace initial, ponctuation collée) et donne des sous-titres propres', () => {
    const t = parseVerboseJson(raw);
    expect(t.segments.length).toBeGreaterThan(0);
    expect(t.words.length).toBeGreaterThan(10);
    expect(t.words[0].word.startsWith(' ')).toBe(true);
    expect(filterTranscript(t).dropped).toEqual([]);
    const cues = buildCues(wordsFromTranscript(t));
    expect(cues.map((c) => c.text).join(' ')).toBe(normalizeSpaces((raw as { text: string }).text));
    for (const c of cues) {
      expect(c.text.length).toBeLessThanOrEqual(84);
      expect(c.end - c.start).toBeLessThanOrEqual(6.0001);
    }
  });
});

const normalizeSpaces = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('filtre des hallucinations', () => {
  it('rejette no_speech élevé ET logprob bas, mais pas l’un sans l’autre', () => {
    expect(hallucinationReason(seg(0, 2, 'What a pass', { no_speech_prob: 0.8, avg_logprob: -1.3 }), { isolated: false })).toBe('pas de parole');
    expect(hallucinationReason(seg(0, 2, 'What a pass', { no_speech_prob: 0.8, avg_logprob: -0.4 }), { isolated: false })).toBeNull();
    expect(hallucinationReason(seg(0, 2, 'What a pass', { no_speech_prob: 0.1, avg_logprob: -1.3 }), { isolated: false })).toBeNull();
  });

  it('rejette un taux de compression > 2,4 et les boucles de répétition', () => {
    expect(hallucinationReason(seg(0, 2, 'and the and the', { compression_ratio: 2.6 }), { isolated: false })).toBe('texte trop répétitif');
    expect(isRepetitionLoop("Let's go. Let's go. Let's go. Let's go.")).toBe(true);
    expect(isRepetitionLoop('the the the the the')).toBe(true);
    expect(isRepetitionLoop("Let's go, let's go! What a game.")).toBe(false);
    expect(isRepetitionLoop('He scores, he scores again, and again')).toBe(false);
  });

  it('rejette les génériques parasites partout, et « Thank you. » seulement isolé', () => {
    expect(hallucinationReason(seg(0, 3, ' Subtitles by the Amara.org community'), { isolated: false })).toBe('formule parasite');
    expect(hallucinationReason(seg(0, 3, ' Thanks for watching!'), { isolated: false })).toBe('formule parasite');
    expect(hallucinationReason(seg(0, 1, ' Thank you.'), { isolated: true })).toBe('formule isolée');
    expect(hallucinationReason(seg(0, 1, ' Thank you.'), { isolated: false })).toBeNull();
    expect(hallucinationReason(seg(0, 1, ' ♪ ♪'), { isolated: false })).toBe('vide ou musique');
  });

  it('rejette une recopie du prompt initial', () => {
    const prompt = 'NBA basketball game commentary: Portland Trail Blazers at Los Angeles Lakers. LeBron James, Deni Avdija.';
    expect(hallucinationReason(seg(0, 3, ' Portland Trail Blazers at Los Angeles Lakers.'), { isolated: false, prompt })).toBe('recopie du prompt');
    expect(hallucinationReason(seg(0, 3, ' LeBron James drives baseline.'), { isolated: false, prompt })).toBeNull();
  });

  it('retire les segments rejetés ET leurs mots, garde le reste', () => {
    const t = {
      segments: [seg(0, 2, ' Curry pulls up.'), seg(10, 11, ' Thank you.'), seg(20, 22, ' Bang! Splash.')],
      words: [...words('Curry pulls up.', 0), ...words('Thank you.', 10), ...words('Bang! Splash.', 20)],
    };
    const { transcript, dropped } = filterTranscript(t);
    expect(dropped.map((d) => d.text)).toEqual(['Thank you.']);
    expect(transcript.segments.map((s) => s.text.trim())).toEqual(['Curry pulls up.', 'Bang! Splash.']);
    expect(joinWords(transcript.words)).toBe('Curry pulls up. Bang! Splash.');
  });

  it('formule courte suspecte répétée (« Thank you. » en boucle) : retirée dès la deuxième', () => {
    const t = { segments: [seg(0, 2, ' Curry pulls up.'), seg(2.5, 3, ' Thank you.'), seg(3.5, 4, ' Thank you.'), seg(4.5, 5, " I don't see you."), seg(5.5, 6, " I don't see you.")], words: [] };
    expect(filterTranscript(t).transcript.segments.map((x) => x.text.trim())).toEqual(['Curry pulls up.', 'Thank you.', "I don't see you."]);
  });

  it('retire un segment identique répété à partir du troisième', () => {
    const t = { segments: [seg(0, 1, ' Here we go.'), seg(1.2, 2, ' Here we go.'), seg(2.2, 3, ' Here we go.'), seg(3.2, 4, ' Here we go.')], words: [] };
    expect(filterTranscript(t).transcript.segments).toHaveLength(2);
  });
});

describe('tronçons', () => {
  it('planChunks : tronçons de 10 min chevauchants, reliquat court rattaché, dernier lu jusqu’au bout', () => {
    const p = planChunks(1810, 600, 3);
    expect(p).toHaveLength(3);
    expect(p[0]).toEqual({ index: 0, start: 0, length: 603, keepFrom: 0, keepTo: 600 });
    expect(p[1]).toEqual({ index: 1, start: 597, length: 606, keepFrom: 600, keepTo: 1200 });
    expect(p[2].keepTo).toBe(Number.POSITIVE_INFINITY);
    expect(p[2].start + p[2].length).toBeGreaterThan(1810);
    expect(planChunks(1250, 600)).toHaveLength(3);
    expect(planChunks(100, 600)).toHaveLength(1);
  });

  it('décale les horodatages d’un tronçon et ne garde chaque mot qu’une fois à la frontière', () => {
    // Tronçon 1 extrait à 597 s : le mot « boundary » (milieu à 600,1 s réel) est
    // dans les deux tronçons ; seul le tronçon qui contient son milieu le garde.
    const a = { segments: [seg(590, 601, ' end of chunk boundary')], words: [{ word: ' chunk', start: 598, end: 599.5 }, { word: ' boundary', start: 599.8, end: 600.4 }] };
    const b = { segments: [seg(2, 5, ' boundary next')], words: [{ word: ' boundary', start: 2.8, end: 3.4 }, { word: ' next', start: 3.5, end: 4 }] };
    const pa = shiftTranscript(a, 0, 0, 600);
    const pb = shiftTranscript(b, 597, 600, 1200);
    expect(pa.words.map((w) => w.word)).toEqual([' chunk']);
    expect(pb.words).toEqual([
      { word: ' boundary', start: 599.8, end: 600.4 },
      { word: ' next', start: 600.5, end: 601 },
    ]);
    const merged = mergeTranscripts([pb, pa]);
    expect(joinWords(merged.words)).toBe('chunk boundary next');
  });

  it('cuesFromChunks : filtre, place et découpe plusieurs tronçons', () => {
    const plans = planChunks(1200, 600, 3);
    const c0 = { segments: [seg(10, 12, ' Tatum at the line.')], words: words('Tatum at the line.', 10) };
    const c1 = { segments: [seg(13, 15, ' Two shots coming.'), seg(40, 41, ' Thank you.')], words: [...words('Two shots coming.', 13), ...words('Thank you.', 40)] };
    const cues = cuesFromChunks([
      { plan: plans[0], transcript: c0 },
      { plan: plans[1], transcript: c1 },
    ]);
    expect(cues.map((c) => [c.start, c.text])).toEqual([
      [10, 'Tatum at the line.'],
      [610, 'Two shots coming.'],
    ]);
  });
});

describe('buildCues', () => {
  it('respecte 84 caractères, 6 s, et ne fait jamais chevaucher deux sous-titres', () => {
    const text =
      'He crosses over, steps back, and drills the three from the corner. That is his fifth of the night and the Lakers are rolling now, they have outscored Portland by twelve in this quarter alone and the crowd is on its feet';
    const cues = buildCues(words(text, 100, 0.28));
    expect(cues.length).toBeGreaterThan(2);
    for (const [i, c] of cues.entries()) {
      expect(c.text.length).toBeLessThanOrEqual(84);
      expect(c.end - c.start).toBeLessThanOrEqual(6.0001);
      expect(c.end).toBeGreaterThan(c.start);
      if (cues[i + 1]) expect(c.end).toBeLessThanOrEqual(cues[i + 1].start);
      expect(c.seq).toBe(i + 1);
    }
    // Rien n'est perdu.
    expect(cues.map((c) => c.text).join(' ')).toBe(text);
  });

  it('coupe de préférence après la ponctuation', () => {
    const cues = buildCues(words('He crosses over, steps back, and drills the three from the corner. That is his fifth of the night', 0, 0.3));
    expect(cues[0].text).toBe('He crosses over, steps back, and drills the three from the corner.');
  });

  it('sans ponctuation : coupe avant une conjonction, jamais après un article', () => {
    const cues = buildCues(words('they have outscored Portland by twelve in this quarter alone and the crowd is on its feet right now', 0, 0.28));
    expect(cues[0].text).toBe('they have outscored Portland by twelve in this quarter alone');
    const noOpener = buildCues(words('Shai Gilgeous-Alexander gets to his spot over the outstretched arm of the long defender', 0, 0.28));
    expect(noOpener[0].text).not.toMatch(/\b(the|of|over)$/);
  });

  it('coupe sur une pause de plus de 0,5 s', () => {
    const w = [...words('Brown drives to the rim', 0), ...words('and he is fouled hard', 2.1)];
    const cues = buildCues(w);
    expect(cues.map((c) => c.text)).toEqual(['Brown drives to the rim', 'and he is fouled hard']);
  });

  it('impose une durée minimale de 1,2 s sans empiéter sur le suivant', () => {
    const cues = buildCues([{ word: ' Wow!', start: 5, end: 5.3 }, ...words('What a block by Wembanyama', 9)]);
    expect(cues[0]).toMatchObject({ text: 'Wow!', start: 5 });
    expect(cues[0].end).toBeGreaterThanOrEqual(6.2);
    const tight = buildCues([{ word: ' Wow!', start: 5, end: 5.3 }, { word: ' Yes!', start: 7.0, end: 7.2 }]);
    expect(tight[0].end).toBeLessThanOrEqual(tight[1].start);
  });

  it('assemble mots, ponctuation isolée et contractions', () => {
    expect(joinWords([{ word: ' He', start: 0, end: 0.1 }, { word: "'s", start: 0.1, end: 0.2 }, { word: ' open', start: 0.2, end: 0.3 }, { word: '!', start: 0.3, end: 0.3 }])).toBe(
      "He's open!",
    );
  });
});

describe('mots', () => {
  it('sans mots horodatés, découpe les segments au prorata des caractères', () => {
    const w = wordsFromTranscript({ segments: [seg(10, 12, ' Jokic finds Murray.')], words: [] });
    expect(w.map((x) => x.word)).toEqual(['Jokic', 'finds', 'Murray.']);
    expect(w[0].start).toBe(10);
    expect(w[2].end).toBe(12);
    expect(buildCues(w)[0]).toMatchObject({ text: 'Jokic finds Murray.', start: 10 });
  });

  it('remet la ponctuation des segments sur des mots qui n’en ont pas (API OpenAI)', () => {
    const segments = [seg(0, 2, ' Curry, from deep. Bang!')];
    const w = punctuateWords(
      ['Curry', 'from', 'deep', 'Bang'].map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.4 })),
      segments,
    );
    expect(joinWords(w)).toBe('Curry, from deep. Bang!');
    // Mots déjà ponctués (faster-whisper) : inchangés.
    const p = words('Curry, from deep.');
    expect(punctuateWords(p, segments)).toBe(p);
  });

  it('wrapTwoLines équilibre deux lignes de 42 caractères au plus', () => {
    expect(wrapTwoLines('Court.')).toBe('Court.');
    const w = wrapTwoLines('Il élimine son défenseur, recule et plante le tir à trois points depuis le coin.');
    const lines = w.split('\n');
    expect(lines).toHaveLength(2);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(42);
  });
});
