/**
 * Transcription des commentateurs → sous-titres lisibles (module PUR, sans E/S).
 *
 * Entrée : la réponse `verbose_json` de Whisper (serveur speaches, API
 * compatible OpenAI), tronçon par tronçon :
 *   { text, segments: [{ start, end, text, avg_logprob, no_speech_prob,
 *     compression_ratio, … }], words?: [{ word, start, end }] }
 * Les mots horodatés sont facultatifs (absents si le serveur ne les donne
 * pas) : on retombe alors sur les segments, découpés au prorata des
 * caractères.
 *
 * Étapes :
 *  1. `filterTranscript` — retire les hallucinations classiques de Whisper
 *     (segments « parlés » pendant la musique, la foule ou un silence) ;
 *  2. `shiftTranscript` / `mergeTranscripts` — remet chaque tronçon à sa
 *     place dans la vidéo (les tronçons se chevauchent de quelques secondes :
 *     un mot n'est gardé que dans le tronçon qui contient son milieu) ;
 *  3. `buildCues` — regroupe les mots en sous-titres : ≤ 84 caractères en
 *     anglais (deux lignes de 42, le français étant ~20 % plus long),
 *     1,2 à 6 s, coupure de préférence sur la ponctuation ou une pause, jamais
 *     de chevauchement.
 */

export interface AsrWord {
  word: string;
  start: number;
  end: number;
}

export interface AsrSegment {
  id?: number;
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
  /** Certains serveurs imbriquent les mots dans les segments. */
  words?: AsrWord[];
}

export interface Transcript {
  segments: AsrSegment[];
  /** Mots horodatés (niveau supérieur) ; vide si le serveur n'en donne pas. */
  words: AsrWord[];
}

export interface Cue {
  seq: number;
  start: number;
  end: number;
  text: string;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ------------------------------------------------------------------ lecture tolérante de verbose_json

function parseWords(raw: unknown): AsrWord[] {
  if (!Array.isArray(raw)) return [];
  const out: AsrWord[] = [];
  for (const w of raw) {
    if (!w || typeof w !== 'object') continue;
    const { word, start, end } = w as Record<string, unknown>;
    if (typeof word !== 'string' || !finite(start) || !finite(end)) continue;
    out.push({ word, start, end: Math.max(start, end) });
  }
  return out;
}

/**
 * Lit une réponse `verbose_json` sans rien supposer au-delà du strict
 * nécessaire : segments sans horodatage écartés, `words` absent toléré, mots
 * imbriqués dans les segments acceptés.
 */
export function parseVerboseJson(raw: unknown): Transcript {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const segments: AsrSegment[] = [];
  for (const s of Array.isArray(o.segments) ? o.segments : []) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    if (!finite(r.start) || !finite(r.end) || typeof r.text !== 'string') continue;
    const seg: AsrSegment = { start: r.start, end: Math.max(r.start, r.end), text: r.text };
    if (finite(r.id)) seg.id = r.id;
    if (finite(r.avg_logprob)) seg.avg_logprob = r.avg_logprob;
    if (finite(r.no_speech_prob)) seg.no_speech_prob = r.no_speech_prob;
    if (finite(r.compression_ratio)) seg.compression_ratio = r.compression_ratio;
    const nested = parseWords(r.words);
    if (nested.length) seg.words = nested;
    segments.push(seg);
  }
  return { segments, words: parseWords(o.words) };
}

// ------------------------------------------------------------------ hallucinations

/**
 * Formules que Whisper « entend » dans la musique ou le silence : génériques
 * de vidéos YouTube et de sous-titrage amateur sur lesquels il a été
 * entraîné. Jamais prononcées par un commentateur NBA : supprimées partout.
 */
const ALWAYS_BOGUS = [
  /^(sub)?titles? (by|from)\b/,
  /\bamara\.org\b/,
  /^(transcribed|transcription|captioned|captioning|translated|subtitled) by\b/,
  /^(thanks|thank you) (so much )?for watching\b/,
  /^please (like and )?subscribe\b/,
  /\bsubscribe to (my|our|the) channel\b/,
  /^see you (in the )?next (time|video)\b/,
];

/**
 * Formules courtes plausibles dans un commentaire (« Thank you. », « Yeah. »)
 * mais typiques d'une hallucination quand elles sont ISOLÉES : rien autour,
 * ou un segment jugé peu probablement parlé.
 */
const SHORT_SUSPECT = /^(thank you( very much)?|thanks|you|bye( bye)?|okay|oh|so|yeah|hmm+|uh+|um+|music|applause|silence)$/;

/** Texte normalisé : minuscules, sans ponctuation ni espaces superflus. */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[♪♫*[\](){}"“”«»]/g, ' ')
    .replace(/[^\p{L}\p{N}'.\s]/gu, ' ')
    .replace(/\.(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Boucle de répétition : la même suite de 1 à 6 mots répétée à la suite
 * (≥ 5 fois pour un mot seul, ≥ 4 fois au-delà). Les commentateurs disent
 * « Let's go, let's go! », pas quatre fois de suite la même phrase.
 */
export function isRepetitionLoop(text: string): boolean {
  const t = normText(text).split(' ').filter(Boolean);
  for (let n = 1; n <= 6; n++) {
    const need = n === 1 ? 5 : 4;
    if (t.length < n * need) continue;
    for (let i = 0; i + n * need <= t.length; i++) {
      let reps = 1;
      for (let j = i + n; j + n <= t.length; j += n) {
        let same = true;
        for (let k = 0; k < n; k++) if (t[j + k] !== t[i + k]) same = false;
        if (!same) break;
        reps++;
      }
      if (reps >= need) return true;
    }
  }
  return false;
}

export interface HallucinationOptions {
  /** Prompt initial envoyé à Whisper : une recopie de ce texte est une hallucination. */
  prompt?: string;
}

export interface DroppedSegment {
  start: number;
  end: number;
  text: string;
  reason: string;
}

/**
 * Raison de rejeter un segment, ou null s'il est gardé.
 * Seuils : ceux de Whisper lui-même (no_speech 0,6 ET logprob < -1 ;
 * compression > 2,4).
 */
export function hallucinationReason(seg: AsrSegment, ctx: { isolated: boolean; prompt?: string }): string | null {
  const text = normText(seg.text);
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return 'vide ou musique';
  if ((seg.no_speech_prob ?? 0) > 0.6 && (seg.avg_logprob ?? 0) < -1) return 'pas de parole';
  if ((seg.compression_ratio ?? 0) > 2.4) return 'texte trop répétitif';
  if (ALWAYS_BOGUS.some((re) => re.test(text))) return 'formule parasite';
  if (isRepetitionLoop(seg.text)) return 'boucle de répétition';
  if (SHORT_SUSPECT.test(text) && (ctx.isolated || (seg.no_speech_prob ?? 0) > 0.3 || (seg.avg_logprob ?? 0) < -0.8)) {
    return 'formule isolée';
  }
  if (ctx.prompt && text.length >= 20 && normText(ctx.prompt).includes(text)) return 'recopie du prompt';
  return null;
}

/** Un segment est isolé si rien n'est dit dans les 2 s qui l'entourent. */
const ISOLATION_GAP = 2;

/**
 * Retire les segments hallucinés, puis les mots qui leur appartiennent.
 * Les répétitions d'un segment identique au précédent sont retirées dès la
 * troisième (Whisper « bégaie » quand il décroche).
 */
export function filterTranscript(t: Transcript, opts: HallucinationOptions = {}): { transcript: Transcript; dropped: DroppedSegment[] } {
  const segs = [...t.segments].sort((a, b) => a.start - b.start);
  const kept: AsrSegment[] = [];
  const dropped: DroppedSegment[] = [];
  let lastText = '';
  let sameRun = 0;
  segs.forEach((seg, i) => {
    const prev = segs[i - 1];
    const next = segs[i + 1];
    const isolated = (!prev || seg.start - prev.end >= ISOLATION_GAP) && (!next || next.start - seg.end >= ISOLATION_GAP);
    let reason = hallucinationReason(seg, { isolated, prompt: opts.prompt });
    const norm = normText(seg.text);
    sameRun = norm && norm === lastText ? sameRun + 1 : 0;
    lastText = norm;
    if (!reason && sameRun >= 2) reason = 'segment répété';
    if (reason) dropped.push({ start: seg.start, end: seg.end, text: seg.text.trim(), reason });
    else kept.push(seg);
  });
  const mid = (w: AsrWord) => (w.start + w.end) / 2;
  const inside = (x: number, s: { start: number; end: number }) => x >= s.start - 0.05 && x <= s.end + 0.05;
  // Un mot est retiré s'il tombe dans un segment rejeté et dans aucun segment gardé.
  const words = t.words.filter((w) => !(dropped.some((d) => inside(mid(w), d)) && !kept.some((k) => inside(mid(w), k))));
  return { transcript: { segments: kept, words }, dropped };
}

// ------------------------------------------------------------------ tronçons

/**
 * Remet un tronçon à sa place dans la vidéo : décale tous les horodatages de
 * `offset` (début réel de l'extraction), puis ne garde que les éléments dont
 * le MILIEU tombe dans [keepFrom, keepTo[. Les tronçons étant extraits avec
 * quelques secondes de recouvrement, un mot coupé à la frontière est entier
 * dans l'un des deux, et n'est gardé qu'une fois.
 */
export function shiftTranscript(t: Transcript, offset: number, keepFrom = Number.NEGATIVE_INFINITY, keepTo = Number.POSITIVE_INFINITY): Transcript {
  const r2 = (x: number) => Math.round(x * 1000) / 1000;
  const sw = (w: AsrWord): AsrWord => ({ word: w.word, start: r2(w.start + offset), end: r2(w.end + offset) });
  const keep = (x: { start: number; end: number }) => {
    const m = (x.start + x.end) / 2;
    return m >= keepFrom && m < keepTo;
  };
  return {
    segments: t.segments
      .map((s) => ({ ...s, start: r2(s.start + offset), end: r2(s.end + offset), ...(s.words ? { words: s.words.map(sw).filter(keep) } : {}) }))
      .filter(keep),
    words: t.words.map(sw).filter(keep),
  };
}

/** Concatène des tronçons déjà décalés, dans l'ordre chronologique. */
export function mergeTranscripts(list: Transcript[]): Transcript {
  return {
    segments: list.flatMap((t) => t.segments).sort((a, b) => a.start - b.start),
    words: list.flatMap((t) => t.words).sort((a, b) => a.start - b.start),
  };
}

// ------------------------------------------------------------------ mots

const PUNCT_RE = /[.,!?;:…]/;
const stripPunct = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Remet la ponctuation sur des mots qui n'en ont pas. L'API d'OpenAI rend des
 * mots SANS ponctuation (faster-whisper la garde) ; or elle sert à couper
 * les sous-titres et à la traduction. On aligne alors les mots sur le texte
 * des segments, qui lui est ponctué.
 */
export function punctuateWords(words: AsrWord[], segments: AsrSegment[]): AsrWord[] {
  if (!words.length || words.some((w) => PUNCT_RE.test(w.word))) return words;
  const out = words.map((w) => ({ ...w }));
  let wi = 0;
  for (const seg of segments) {
    const tokens = seg.text.trim().split(/\s+/).filter(Boolean);
    // Mots du segment : ceux dont le milieu tombe dedans, à partir du curseur.
    while (wi < out.length && (out[wi].start + out[wi].end) / 2 < seg.start - 0.05) wi++;
    let ti = 0;
    while (wi < out.length && ti < tokens.length && (out[wi].start + out[wi].end) / 2 <= seg.end + 0.05) {
      const a = stripPunct(out[wi].word);
      if (a === stripPunct(tokens[ti])) {
        out[wi].word = (/^\s/.test(out[wi].word) ? ' ' : '') + tokens[ti];
        wi++;
        ti++;
        continue;
      }
      // Petit décalage (mot fusionné ou scindé différemment) : on cherche
      // le mot quelques jetons plus loin, sinon on avance d'un mot.
      const ahead = tokens.slice(ti + 1, ti + 4).findIndex((tk) => stripPunct(tk) === a);
      if (ahead >= 0) ti += ahead + 1;
      else wi++;
    }
  }
  return out;
}

/**
 * Mots horodatés d'un transcript : les mots de niveau supérieur, sinon ceux
 * imbriqués dans les segments, sinon des mots SYNTHÉTIQUES (texte du
 * segment découpé, horodatage réparti au prorata des caractères).
 */
export function wordsFromTranscript(t: Transcript): AsrWord[] {
  let words = t.words.length ? t.words : t.segments.flatMap((s) => s.words ?? []);
  if (words.length) return punctuateWords([...words].sort((a, b) => a.start - b.start), t.segments);
  words = [];
  for (const s of t.segments) {
    const tokens = s.text.trim().split(/\s+/).filter(Boolean);
    const total = tokens.reduce((n, tk) => n + tk.length + 1, 0);
    let pos = 0;
    const dur = Math.max(0, s.end - s.start);
    for (const tk of tokens) {
      const a = s.start + (dur * pos) / total;
      pos += tk.length + 1;
      words.push({ word: tk, start: Math.round(a * 1000) / 1000, end: Math.round((s.start + (dur * pos) / total) * 1000) / 1000 });
    }
  }
  return words;
}

// ------------------------------------------------------------------ sous-titres

export interface CueOptions {
  /** Caractères max d'un sous-titre (2 lignes de 42). */
  maxChars?: number;
  minDuration?: number;
  maxDuration?: number;
  /** Pause au-delà de laquelle on coupe volontiers (s). */
  pauseSplit?: number;
  /** Pause au-delà de laquelle on coupe toujours (s). */
  hardGap?: number;
  /** Temps de lecture ajouté après le dernier mot, si la place le permet (s). */
  readingTail?: number;
}

const DEFAULTS: Required<CueOptions> = { maxChars: 84, minDuration: 1.2, maxDuration: 6, pauseSplit: 0.5, hardGap: 1.5, readingTail: 0.5 };

/** Assemble des mots Whisper (« ␣Hello, », « ␣world ») en texte propre. */
export function joinWords(words: AsrWord[]): string {
  let s = '';
  for (const w of words) {
    const raw = w.word.replace(/\s+/g, ' ');
    const t = raw.trim();
    if (!t) continue;
    // Ponctuation isolée, contraction (« 's », « n't ») : collée au mot précédent.
    const glue = s && (/^[.,!?;:…%)]/.test(t) || /^'(s|re|ve|ll|d|m)\b/i.test(t) || /^n't\b/i.test(t));
    s += s && !glue ? ` ${t}` : t;
  }
  return s.replace(/\s+/g, ' ').trim();
}

const endsSentence = (w: AsrWord) => /[.!?…]["”»)]?$/.test(w.word.trim());
const endsClause = (w: AsrWord) => /[,;:—–-]["”»)]?$/.test(w.word.trim());
const bare = (w: AsrWord) => w.word.trim().toLowerCase();
/** Mots qui ouvrent une proposition : on coupe volontiers AVANT eux. */
const OPENERS = new Set(['and', 'but', 'so', 'because', 'while', 'when', 'who', 'which', 'that', 'or', 'if', 'then', 'as']);
/** Mots qui ne terminent jamais une ligne (« … on its » / « feet »). */
const WEAK_END = new Set(['a', 'an', 'the', 'its', 'his', 'her', 'their', 'our', 'your', 'my', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'from', 'with', 'into', 'and', 'but', 'or', 'is', 'was', 'are', 'he', 'she', 'they', 'we', 'it', 'this']);

/**
 * Meilleur point de coupure dans un groupe trop long : après une fin de
 * phrase, puis une virgule ou une pause, puis avant une conjonction — à
 * condition que la première partie ne soit pas minuscule. À défaut, avant le
 * mot suivant, en reculant d'un ou deux mots pour ne pas finir la ligne sur
 * un article ou une préposition. Rend l'indice du premier mot de la seconde
 * partie (`group.length` = tout le groupe).
 */
function bestSplit(group: AsrWord[], o: Required<CueOptions>): number {
  let best = -1;
  let bestScore = 0;
  for (let k = 1; k < group.length; k++) {
    const head = joinWords(group.slice(0, k));
    if (head.length < o.maxChars * 0.3) continue;
    const prev = group[k - 1];
    const gap = group[k].start - prev.end;
    let score = endsSentence(prev) ? 3 : endsClause(prev) ? 2 : 0;
    if (gap > o.pauseSplit) score += 2 + gap;
    if (!score && OPENERS.has(bare(group[k])) && head.length >= o.maxChars * 0.45) score = 1;
    // À score égal, on préfère couper tard (première partie mieux remplie).
    if (score >= 1 && score + k / 1000 > bestScore) {
      bestScore = score + k / 1000;
      best = k;
    }
  }
  if (best > 0) return best;
  let k = group.length;
  while (k > group.length - 2 && k > 1 && WEAK_END.has(bare(group[k - 1]))) k--;
  return k;
}

/**
 * Regroupe les mots en sous-titres. Les cues ne se chevauchent jamais : la
 * fin d'un sous-titre est bornée par le début du suivant (40 ms d'écart).
 */
export function buildCues(input: AsrWord[], opts: CueOptions = {}): Cue[] {
  const o = { ...DEFAULTS, ...opts };
  const words = input
    .filter((w) => w.word.trim() && finite(w.start) && finite(w.end))
    .map((w) => ({ ...w, end: Math.max(w.start, w.end) }))
    .sort((a, b) => a.start - b.start);
  const groups: AsrWord[][] = [];
  let cur: AsrWord[] = [];
  const flush = (g: AsrWord[]) => {
    if (g.length) groups.push(g);
  };
  const tooLong = (g: AsrWord[], w: AsrWord) => joinWords([...g, w]).length > o.maxChars || w.end - g[0].start > o.maxDuration;
  for (const w of words) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const gap = w.start - prev.end;
      const dur = prev.end - cur[0].start;
      if (gap >= o.hardGap) {
        flush(cur);
        cur = [];
      } else if (tooLong(cur, w)) {
        const k = bestSplit(cur, o);
        flush(cur.slice(0, k));
        cur = cur.slice(k);
        if (cur.length && tooLong(cur, w)) {
          flush(cur);
          cur = [];
        }
      } else if (dur >= o.minDuration && (endsSentence(prev) || gap > o.pauseSplit) && joinWords(cur).length >= 12) {
        // Fin de phrase ou pause, et le sous-titre a déjà de quoi être lu.
        flush(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  flush(cur);

  const cues: Cue[] = [];
  const r2 = (x: number) => Math.round(x * 100) / 100;
  for (const g of groups) {
    const text = joinWords(g);
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    cues.push({ seq: 0, start: g[0].start, end: g[g.length - 1].end, text });
  }
  cues.forEach((c, i) => {
    const next = cues[i + 1];
    let end = Math.max(c.end + o.readingTail, c.start + o.minDuration);
    end = Math.min(end, c.start + o.maxDuration);
    if (next) end = Math.min(end, next.start - 0.04);
    // Mot suivant collé : on garde au moins la fin du dernier mot, sans chevaucher.
    if (end <= c.start) end = next ? Math.max(c.start + 0.01, Math.min(c.end, next.start)) : c.start + o.minDuration;
    c.seq = i + 1;
    c.start = r2(c.start);
    c.end = r2(Math.max(end, c.start + 0.01));
    if (next && c.end > r2(next.start)) c.end = r2(next.start);
  });
  return cues;
}

/**
 * Coupe un texte en deux lignes équilibrées (≤ `maxLine` si possible), de
 * préférence après une ponctuation. Pour l'export WebVTT.
 */
export function wrapTwoLines(text: string, maxLine = 42): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLine) return t;
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 1; i < t.length - 1; i++) {
    if (t[i] !== ' ') continue;
    const a = i;
    const b = t.length - i - 1;
    let score = Math.abs(a - b);
    if (Math.max(a, b) > maxLine) score += 1000;
    if (/[,.;:!?]/.test(t[i - 1])) score -= 8;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best < 0 ? t : `${t.slice(0, best)}\n${t.slice(best + 1)}`;
}
