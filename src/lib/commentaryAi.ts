/**
 * Clients des deux services LOCAUX de la traduction des commentaires.
 *
 * - Transcription : serveur speaches (faster-whisper sur la carte NVIDIA du
 *   NAS), API compatible OpenAI —
 *   POST {TRANSCRIBE_URL}/audio/transcriptions (multipart : file, model,
 *   language=en, response_format=verbose_json, timestamp_granularities[]=
 *   segment et word). Réponse : `TranscriptionVerbose` d'OpenAI
 *   ({ text, duration, language, segments, words? }).
 * - Traduction : Ollama, API compatible OpenAI —
 *   POST {TRANSLATE_URL}/chat/completions. Le modèle (TRANSLATE_MODEL) et le
 *   prompt système (`TRANSLATE_SYSTEM_PROMPT`, ou un fichier désigné par
 *   TRANSLATE_PROMPT_FILE) se changent sans toucher au reste.
 *
 * Deux natures d'échec, traitées différemment par la file :
 *  - `ServiceError` : serveur injoignable, HTTP 5xx, modèle absent… — le
 *    travail s'arrête et sera repris plus tard (la transcription déjà faite
 *    est gardée sur disque) ;
 *  - réponse du LLM inexploitable (JSON cassé, ligne manquante) : nouvel
 *    essai du lot, puis ligne par ligne, puis l'anglais en dernier recours.
 *    Une ligne rebelle ne bloque jamais tout le match.
 */
import fs from 'node:fs';
import { parseVerboseJson, type Transcript } from './commentaryCues';
import { embeddedOllamaAvailable, embeddedOllamaUrl, embeddedWhisperAvailable } from './localAi';

// ------------------------------------------------------------------ configuration

export const DEFAULT_TRANSCRIBE_MODEL = 'Systran/faster-distil-whisper-large-v3';
/**
 * MiLMMT-46-4B v1.0 (Xiaomi) : modèle SPÉCIALISÉ en traduction, entraîné sur
 * Gemma 3 4B (46 langues dont l'anglais et le français). Servi par Ollama à
 * partir du GGUF ; Q8_0 (~4 Go) laisse toute la marge sur une carte 12 Go.
 */
export const DEFAULT_TRANSLATE_MODEL = 'hf.co/mradermacher/MiLMMT-46-4B-v1.0-GGUF:Q8_0';

/**
 * Deux façons de piloter le modèle de traduction :
 * - 'mt'   : modèle de traduction pur (MiLMMT) — complétion BRUTE, une phrase
 *            à la fois, avec le gabarit officiel du modèle ;
 * - 'chat' : LLM généraliste (Mistral, Gemma, Qwen…) — lots de lignes en JSON
 *            avec un prompt système.
 * Par défaut : 'mt' si le nom du modèle contient « milmmt », sinon 'chat'.
 */
export type TranslateEngine = 'mt' | 'chat';

/** 'embedded' : service embarqué dans le conteneur (localAi.ts) ; 'remote' : serveur externe. */
export type ServiceMode = 'embedded' | 'remote';

export interface CommentaryConfig {
  transcribeMode: ServiceMode;
  translateMode: ServiceMode;
  transcribeUrl: string;
  transcribeModel: string;
  translateUrl: string;
  translateModel: string;
  translateEngine: TranslateEngine;
  /** Sous-titres par requête de traduction. */
  batch: number;
  /** Durée d'un tronçon audio (s). */
  chunkSec: number;
  /** Raison de l'inactivité de la fonctionnalité, ou null si elle est active. */
  disabledReason: string | null;
}

const trimUrl = (s: string | undefined) => (s ?? '').trim().replace(/\/+$/, '');

function intEnv(name: string, def: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== '' ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
}

export function engineFor(model: string, forced?: string): TranslateEngine {
  const f = forced?.trim().toLowerCase();
  if (f === 'mt' || f === 'chat') return f;
  return /milmmt/i.test(model) ? 'mt' : 'chat';
}

export function commentaryConfig(): CommentaryConfig {
  const translateModel = process.env.TRANSLATE_MODEL?.trim() || DEFAULT_TRANSLATE_MODEL;
  // Sans URL externe, les services embarqués dans l'image Docker sont utilisés.
  const remoteAsr = trimUrl(process.env.TRANSCRIBE_URL);
  const remoteMt = trimUrl(process.env.TRANSLATE_URL);
  const transcribeMode: ServiceMode = remoteAsr ? 'remote' : 'embedded';
  const translateMode: ServiceMode = remoteMt ? 'remote' : 'embedded';
  const asrOk = !!remoteAsr || embeddedWhisperAvailable();
  const mtOk = !!remoteMt || embeddedOllamaAvailable();
  let disabledReason: string | null = null;
  if (process.env.COMMENTARY_DISABLED === '1') disabledReason = 'traduction des commentaires désactivée (COMMENTARY_DISABLED=1)';
  else if (!asrOk && !mtOk) disabledReason = 'serveurs de transcription et de traduction non configurés (TRANSCRIBE_URL, TRANSLATE_URL)';
  else if (!asrOk) disabledReason = 'serveur de transcription non configuré (TRANSCRIBE_URL)';
  else if (!mtOk) disabledReason = 'serveur de traduction non configuré (TRANSLATE_URL)';
  return {
    transcribeMode,
    translateMode,
    transcribeUrl: remoteAsr,
    transcribeModel: process.env.TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL,
    translateUrl: remoteMt || `${embeddedOllamaUrl()}/v1`,
    translateModel,
    translateEngine: engineFor(translateModel, process.env.TRANSLATE_ENGINE),
    batch: intEnv('TRANSLATE_BATCH', 20, 1, 60),
    chunkSec: intEnv('COMMENTARY_CHUNK_SEC', 600, 60, 3600),
    disabledReason,
  };
}

/** Un service local (speaches, Ollama) injoignable ou en erreur. */
export class ServiceError extends Error {
  constructor(
    message: string,
    public service: 'transcription' | 'traduction',
  ) {
    super(message);
  }
}

function authHeaders(key: string | undefined): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** Message lisible d'une erreur fetch (`TypeError: fetch failed` cache la vraie cause). */
function fetchErrorText(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError') return 'délai dépassé';
  if (err?.name === 'AbortError') return 'interrompu';
  return err?.cause?.code || err?.cause?.message || err?.message || String(e);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

function timeoutSignal(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([t, outer]) : t;
}

// ------------------------------------------------------------------ transcription

export interface TranscribeOptions {
  /** Prompt initial de Whisper (noms des équipes et des joueurs). */
  prompt?: string;
  signal?: AbortSignal;
  /** Délai max d'un tronçon (`TRANSCRIBE_TIMEOUT_MS`, 20 min par défaut : speaches peut retomber sur le CPU). */
  timeoutMs?: number;
  /** Attente avant le nouvel essai après une erreur réseau ou 5xx (3 s). */
  retryDelayMs?: number;
}

/**
 * Transcrit un fichier audio (un tronçon). Une erreur réseau ou 5xx est
 * retentée une fois ; au-delà, `ServiceError`.
 */
export async function transcribeAudio(file: string, cfg: CommentaryConfig, o: TranscribeOptions = {}): Promise<Transcript> {
  const audio = await fs.promises.readFile(file);
  const url = `${cfg.transcribeUrl}/audio/transcriptions`;
  const timeoutMs = o.timeoutMs ?? intEnv('TRANSCRIBE_TIMEOUT_MS', 20 * 60_000, 10_000, 6 * 3600_000);
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (o.signal?.aborted) throw new ServiceError('transcription interrompue', 'transcription');
    const form = new FormData();
    form.append('file', new Blob([audio], { type: file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/ogg' }), file.split('/').pop() || 'audio.ogg');
    form.append('model', cfg.transcribeModel);
    form.append('language', 'en');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    form.append('timestamp_granularities[]', 'word');
    form.append('temperature', '0');
    if (o.prompt) form.append('prompt', o.prompt);
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', body: form, headers: authHeaders(process.env.TRANSCRIBE_API_KEY), signal: timeoutSignal(timeoutMs, o.signal) });
    } catch (e) {
      last = `serveur de transcription injoignable (${cfg.transcribeUrl}) : ${fetchErrorText(e)}`;
      if (o.signal?.aborted) break;
      await sleep(o.retryDelayMs ?? 3000, o.signal);
      continue;
    }
    if (res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ServiceError('réponse de transcription illisible (JSON attendu, response_format=verbose_json)', 'transcription');
      }
      if (!body || typeof body !== 'object' || (!('segments' in body) && !('words' in body) && !('text' in body))) {
        throw new ServiceError('réponse de transcription inattendue (ni segments ni texte)', 'transcription');
      }
      return parseVerboseJson(body);
    }
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    last = `serveur de transcription : HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
    // 4xx : requête refusée (modèle inconnu…) — inutile de réessayer.
    if (res.status < 500) break;
    await sleep(o.retryDelayMs ?? 3000, o.signal);
  }
  throw new ServiceError(last || 'transcription impossible', 'transcription');
}

/**
 * Prompt initial de Whisper : contexte et orthographe des noms propres
 * (Whisper écorche volontiers « Giannis Antetokounmpo »). Tronqué : Whisper
 * n'en lit que ~224 jetons.
 */
export function whisperPrompt(home: string, away: string, players: string[]): string {
  const base = `NBA basketball game commentary: ${away} at ${home}.`;
  let out = base;
  for (const p of players) {
    const next = `${out}${out === base ? ' ' : ', '}${p}`;
    if (next.length > 600) break;
    out = next;
  }
  return out === base ? out : `${out}.`;
}

// ------------------------------------------------------------------ traduction

/**
 * Prompt système par défaut de la traduction. À remplacer librement (ou via
 * TRANSLATE_PROMPT_FILE) : la seule contrainte est le format de sortie JSON
 * décrit à la fin, que `parseTranslation` sait lire.
 */
export const TRANSLATE_SYSTEM_PROMPT = `Tu traduis en français les sous-titres d'une retransmission de match NBA : ce sont les paroles des commentateurs américains, transcrites automatiquement.

Règles :
- Français parlé et naturel, dans le registre d'un commentateur sportif français : vivant, direct, phrases courtes.
- Noms propres inchangés (joueurs, entraîneurs, équipes, salles).
- Jargon NBA adapté comme le disent les commentateurs français : « three » → « à trois points », « free throw » → « lancer franc », « rebound » → « rebond », « turnover » → « perte de balle », « steal » → « interception », « block » → « contre », « assist » → « passe décisive », « fast break » → « contre-attaque », « shot clock » → « les 24 secondes », « timeout » → « temps mort », « and-one » → « panier plus la faute » ; « dunk », « alley-oop », « pick-and-roll », « step-back » restent tels quels.
- Ni ajout ni omission : traduis le sens de chaque ligne, sans commentaire ni explication. Une phrase coupée reste coupée.
- Chaque ligne est traduite à sa place : ne fusionne pas, ne déplace pas de texte d'une ligne à l'autre. Le contexte précédent sert seulement à comprendre.
- Chiffres en chiffres. Si un nom de joueur est manifestement mal transcrit et que tu reconnais le joueur, écris-le correctement.

Réponds UNIQUEMENT avec un objet JSON de la forme {"t":[{"i":<id>,"fr":"<traduction>"}]}, une entrée par ligne à traduire, avec les mêmes id.`;

/** Prompt système effectif : fichier TRANSLATE_PROMPT_FILE s'il est lisible, sinon le prompt par défaut. */
export function translateSystemPrompt(): string {
  const file = process.env.TRANSLATE_PROMPT_FILE?.trim();
  if (file) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return text;
    } catch (e) {
      console.error(`[commentaires] prompt ${file} illisible, prompt par défaut utilisé :`, (e as Error).message);
    }
  }
  return TRANSLATE_SYSTEM_PROMPT;
}

/** Qwen3 « réfléchit » à voix haute par défaut : `/no_think` le coupe. */
export const needsNoThink = (model: string) => /qwen3/i.test(model);

export interface TranslateLine {
  i: number;
  en: string;
}

export interface TranslateContext {
  /** Équipes et joueurs (orthographe de référence). */
  names?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Attente avant le nouvel essai après une erreur réseau ou 5xx (3 s). */
  retryDelayMs?: number;
}

/** Message utilisateur d'un lot : contexte (à ne pas traduire) puis lignes. */
export function buildUserMessage(lines: TranslateLine[], context: string[], model: string, names?: string): string {
  const parts: string[] = [];
  if (names) parts.push(`Noms propres du match : ${names}`);
  if (context.length) {
    parts.push(`Contexte précédent (déjà traduit, NE PAS traduire) :\n${context.map((c) => `- ${c}`).join('\n')}`);
  }
  parts.push(`Lignes à traduire :\n${JSON.stringify({ lignes: lines.map((l) => ({ i: l.i, en: l.en })) })}`);
  if (needsNoThink(model)) parts.push('/no_think');
  return parts.join('\n\n');
}

/**
 * Extrait les traductions d'une réponse de LLM, même mal emballée : bloc
 * <think>, balises ``` , texte avant ou après le JSON, tableau nu, clés
 * approchantes. Rend une table id → texte (vide si rien d'exploitable).
 */
export function parseTranslation(content: string): Map<number, string> {
  const out = new Map<number, string>();
  let s = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  let data: unknown;
  const tryParse = (txt: string) => {
    try {
      return JSON.parse(txt) as unknown;
    } catch {
      return undefined;
    }
  };
  data = tryParse(s);
  if (data === undefined) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) data = tryParse(s.slice(a, b + 1));
  }
  if (data === undefined) {
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    if (a >= 0 && b > a) data = tryParse(s.slice(a, b + 1));
  }
  let list: unknown = data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    list = o.t ?? o.translations ?? o.lignes ?? o.lines ?? Object.values(o).find(Array.isArray);
  }
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = Number(r.i ?? r.id);
    const fr = r.fr ?? r.text ?? r.translation;
    if (Number.isInteger(id) && typeof fr === 'string') out.set(id, fr.replace(/\s+/g, ' ').trim());
  }
  return out;
}

/** Une traduction est-elle acceptable pour cette ligne ? */
export function validTranslation(en: string, fr: string | undefined): fr is string {
  if (!fr || !/[\p{L}\p{N}]/u.test(fr)) return false;
  // Trop longue : le modèle a bavardé, recopié le contexte ou fusionné des lignes.
  if (fr.length > en.length * 2.2 + 30) return false;
  if (/"(i|fr|en)"\s*:/.test(fr)) return false;
  return true;
}

/** Appel brut à /chat/completions ; `ServiceError` si le serveur ne répond pas correctement. */
export async function chatCompletion(system: string, user: string, cfg: CommentaryConfig, o: TranslateContext = {}): Promise<string> {
  const url = `${cfg.translateUrl}/chat/completions`;
  const timeoutMs = o.timeoutMs ?? intEnv('TRANSLATE_TIMEOUT_MS', 5 * 60_000, 5_000, 3600_000);
  const body = JSON.stringify({
    model: cfg.translateModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    stream: false,
    response_format: { type: 'json_object' },
  });
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (o.signal?.aborted) throw new ServiceError('traduction interrompue', 'traduction');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json', ...authHeaders(process.env.TRANSLATE_API_KEY) },
        signal: timeoutSignal(timeoutMs, o.signal),
      });
    } catch (e) {
      last = `serveur de traduction injoignable (${cfg.translateUrl}) : ${fetchErrorText(e)}`;
      if (o.signal?.aborted) break;
      await sleep(o.retryDelayMs ?? 3000, o.signal);
      continue;
    }
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
      const content = data?.choices?.[0]?.message?.content;
      // Réponse vide ou mal formée : c'est le CONTENU qui est en cause, le lot sera retenté.
      return typeof content === 'string' ? content : '';
    }
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    last =
      res.status === 404 && /model/i.test(detail)
        ? `modèle de traduction « ${cfg.translateModel} » absent d'Ollama (ollama pull ${cfg.translateModel})`
        : `serveur de traduction : HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
    if (res.status < 500) break;
    await sleep(o.retryDelayMs ?? 3000, o.signal);
  }
  throw new ServiceError(last || 'traduction impossible', 'traduction');
}

export interface TranslatedLine {
  i: number;
  fr: string;
  /** Traduction impossible : `fr` est l'anglais d'origine. */
  untranslated: boolean;
}

/**
 * Traduit un lot : deux essais du lot entier, puis ligne par ligne pour ce
 * qui manque encore, puis l'anglais (marqué) en dernier recours.
 * `context` : quelques lignes précédentes, données pour le sens seulement.
 */
export async function translateBatch(lines: TranslateLine[], context: string[], cfg: CommentaryConfig, o: TranslateContext = {}): Promise<TranslatedLine[]> {
  if (cfg.translateEngine === 'mt') return translateBatchMt(lines, cfg, o);
  const system = translateSystemPrompt();
  const done = new Map<number, string>();
  const missing = () => lines.filter((l) => !done.has(l.i));
  for (let attempt = 0; attempt < 2 && missing().length; attempt++) {
    const todo = missing();
    const got = parseTranslation(await chatCompletion(system, buildUserMessage(todo, context, cfg.translateModel, o.names), cfg, o));
    for (const l of todo) {
      const fr = got.get(l.i);
      if (validTranslation(l.en, fr)) done.set(l.i, fr);
    }
  }
  // Repli ligne par ligne : le contexte inclut les lignes qui précèdent dans le lot.
  for (const l of missing()) {
    const idx = lines.indexOf(l);
    const ctx = [...context, ...lines.slice(0, idx).map((x) => x.en)].slice(-4);
    for (let attempt = 0; attempt < 2 && !done.has(l.i); attempt++) {
      const got = parseTranslation(await chatCompletion(system, buildUserMessage([l], ctx, cfg.translateModel, o.names), cfg, o));
      const fr = got.get(l.i) ?? (got.size === 1 ? [...got.values()][0] : undefined);
      if (validTranslation(l.en, fr)) done.set(l.i, fr);
    }
  }
  return lines.map((l) => (done.has(l.i) ? { i: l.i, fr: done.get(l.i) as string, untranslated: false } : { i: l.i, fr: l.en, untranslated: true }));
}

// ------------------------------------------------------------------ modèle de traduction pur (MiLMMT)

/** Gabarit officiel de MiLMMT-46 (fiche du modèle) : complétion brute, sans chat. */
export function mtPrompt(en: string): string {
  return `Translate this from English to French:\nEnglish: ${en}\nFrench:`;
}

/** Racine Ollama (`…/v1` retiré) : la complétion brute passe par l'API native. */
export function ollamaBase(url: string): string {
  return url.replace(/\/v1$/, '');
}

/**
 * Une traduction, en complétion brute (`/api/generate`, `raw: true` : aucun
 * gabarit de chat ajouté) et décodage glouton, comme le recommande la fiche
 * du modèle. Arrêt au saut de ligne : le modèle ne traduit qu'une phrase.
 */
export async function mtComplete(en: string, cfg: CommentaryConfig, o: TranslateContext = {}): Promise<string> {
  const url = `${ollamaBase(cfg.translateUrl)}/api/generate`;
  const timeoutMs = o.timeoutMs ?? intEnv('TRANSLATE_TIMEOUT_MS', 5 * 60_000, 5_000, 3600_000);
  const body = JSON.stringify({
    model: cfg.translateModel,
    prompt: mtPrompt(en),
    raw: true,
    stream: false,
    keep_alive: '10m',
    options: { temperature: 0, top_k: 1, num_predict: Math.min(512, 40 + en.length * 2), stop: ['\n'] },
  });
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (o.signal?.aborted) throw new ServiceError('traduction interrompue', 'traduction');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json', ...authHeaders(process.env.TRANSLATE_API_KEY) },
        signal: timeoutSignal(timeoutMs, o.signal),
      });
    } catch (e) {
      last = `serveur de traduction injoignable (${cfg.translateUrl}) : ${fetchErrorText(e)}`;
      if (o.signal?.aborted) break;
      await sleep(o.retryDelayMs ?? 3000, o.signal);
      continue;
    }
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { response?: unknown } | null;
      return typeof data?.response === 'string' ? data.response.replace(/\s+/g, ' ').trim() : '';
    }
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    last =
      res.status === 404 && /model/i.test(detail)
        ? `modèle de traduction « ${cfg.translateModel} » absent d'Ollama (ollama pull ${cfg.translateModel})`
        : `serveur de traduction : HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
    if (res.status < 500) break;
    await sleep(o.retryDelayMs ?? 3000, o.signal);
  }
  throw new ServiceError(last || 'traduction impossible', 'traduction');
}

/** Fin de phrase : ponctuation finale (guillemets fermants tolérés). */
const SENTENCE_END = /[.!?…]["»”')\]]*$/;

/**
 * Regroupe des sous-titres consécutifs en phrases : un modèle de traduction
 * pur traduit une phrase à la fois, et une phrase coupée en deux sous-titres
 * se traduit mal morceau par morceau (sujet d'un côté, verbe de l'autre).
 * Un groupe s'arrête sur la ponctuation finale, ou à 4 lignes / 300 caractères.
 */
export function groupSentences(lines: TranslateLine[]): TranslateLine[][] {
  const groups: TranslateLine[][] = [];
  let cur: TranslateLine[] = [];
  let len = 0;
  for (const l of lines) {
    cur.push(l);
    len += l.en.length + 1;
    if (SENTENCE_END.test(l.en.trim()) || cur.length >= 4 || len >= 300) {
      groups.push(cur);
      cur = [];
      len = 0;
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Répartit une traduction sur `weights.length` sous-titres, au prorata des
 * longueurs anglaises, en coupant entre deux mots — de préférence juste
 * après une ponctuation proche du point de coupe idéal. Rend null si le
 * texte a trop peu de mots pour être réparti proprement.
 */
export function splitProportional(fr: string, weights: number[]): string[] | null {
  const n = weights.length;
  if (n === 1) return [fr];
  const words = fr.split(/\s+/).filter(Boolean);
  if (words.length < n * 2) return null;
  const total = weights.reduce((a, b) => a + Math.max(1, b), 0);
  // Position (en caractères) de la fin de chaque mot.
  const ends: number[] = [];
  let pos = 0;
  for (const w of words) {
    pos += w.length + 1;
    ends.push(pos);
  }
  const out: string[] = [];
  let from = 0;
  let acc = 0;
  for (let k = 0; k < n - 1; k++) {
    acc += Math.max(1, weights[k]);
    const ideal = (acc / total) * pos;
    // Coupe possible après le mot j (au moins un mot par part, de chaque côté).
    const minJ = from;
    const maxJ = words.length - (n - k - 1) - 1;
    let best = minJ;
    let bestScore = Infinity;
    for (let j = minJ; j <= maxJ; j++) {
      const dist = Math.abs(ends[j] - ideal);
      const bonus = /[,;:.!?…]$/.test(words[j]) ? 12 : 0;
      const score = dist - bonus;
      if (score < bestScore) {
        bestScore = score;
        best = j;
      }
    }
    out.push(words.slice(from, best + 1).join(' '));
    from = best + 1;
  }
  out.push(words.slice(from).join(' '));
  return out;
}

/** Concurrence des requêtes de traduction (Ollama sert plusieurs requêtes à la fois). */
const MT_PARALLEL = Math.max(1, Math.min(8, Math.trunc(Number(process.env.TRANSLATE_PARALLEL) || 2)));

async function mtTranslateOne(en: string, cfg: CommentaryConfig, o: TranslateContext): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fr = await mtComplete(en, cfg, o);
    if (validTranslation(en, fr)) return fr;
  }
  return undefined;
}

/**
 * Lot de sous-titres traduit par un modèle de traduction pur : phrase par
 * phrase, puis répartition sur les sous-titres de la phrase. Si la
 * répartition est impossible, chaque sous-titre est traduit seul ; en
 * dernier recours, l'anglais est gardé (marqué).
 */
export async function translateBatchMt(lines: TranslateLine[], cfg: CommentaryConfig, o: TranslateContext = {}): Promise<TranslatedLine[]> {
  const done = new Map<number, string>();
  const groups = groupSentences(lines);
  let next = 0;
  const worker = async () => {
    while (next < groups.length) {
      const g = groups[next++];
      const en = g.map((l) => l.en.trim()).join(' ');
      const fr = await mtTranslateOne(en, cfg, o);
      const parts = fr ? splitProportional(fr, g.map((l) => l.en.length)) : null;
      if (parts) {
        g.forEach((l, k) => done.set(l.i, parts[k]));
        continue;
      }
      for (const l of g) {
        const one = await mtTranslateOne(l.en, cfg, o);
        if (one) done.set(l.i, one);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MT_PARALLEL, groups.length) }, worker));
  return lines.map((l) => (done.has(l.i) ? { i: l.i, fr: done.get(l.i) as string, untranslated: false } : { i: l.i, fr: l.en, untranslated: true }));
}
