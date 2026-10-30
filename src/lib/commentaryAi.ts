/**
 * Clients des deux services LOCAUX de la traduction des commentaires.
 *
 * - Transcription : serveur speaches (faster-whisper sur la carte NVIDIA du
 *   NAS), API compatible OpenAI —
 *   POST {TRANSCRIBE_URL}/audio/transcriptions (multipart : file, model,
 *   language=en, response_format=verbose_json, timestamp_granularities[]=
 *   segment et word). Réponse : `TranscriptionVerbose` d'OpenAI
 *   ({ text, duration, language, segments, words? }).
 * - Traduction : Ollama — API native POST /api/chat pour l'Ollama embarqué
 *   (num_ctx, schéma JSON), POST {TRANSLATE_URL}/chat/completions compatible
 *   OpenAI pour un serveur externe. Le modèle (TRANSLATE_MODEL, Gemma 4 E4B
 *   par défaut) et le prompt système (`TRANSLATE_SYSTEM_PROMPT`, ou un
 *   fichier désigné par TRANSLATE_PROMPT_FILE) se changent sans toucher au reste.
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
import { getSetting, SETTING_KEYS } from './settings';
import { nameRendered, type RosterIndex } from './rosterNames';

// ------------------------------------------------------------------ configuration

/**
 * Whisper large-v3-turbo (CTranslate2) : meilleur compromis mesuré sur de
 * vrais commentaires NBA — moins d'erreurs sur les noms que distil-large-v3,
 * et large-v3 complet ne fait pas mieux pour un temps ×3,6. ~1,6 Go en fp16.
 */
export const DEFAULT_TRANSCRIBE_MODEL = 'deepdml/faster-whisper-large-v3-turbo-ct2';
/**
 * TranslateGemma 12B (Google, Ollama `translategemma:12b`, Q4_K_M, 8,1 Go) :
 * modèle de traduction, choisi par l'utilisateur. Au banc d'essai (55 phrases
 * de commentateurs NBA) : 93/110 piloté comme ici — nos consignes basket et
 * des lots JSON dans le gabarit Gemma brut (son gabarit officiel n'accepte
 * pas de consignes système) —, contre 65/110 dans son format officiel, une
 * phrase à la fois. Gemma 4 E4B (`gemma4:e4b`, 97/110, 6,6 Go) reste
 * disponible via TRANSLATE_MODEL.
 */
export const DEFAULT_TRANSLATE_MODEL = 'translategemma:12b';
/** Lignes précédentes données au modèle pour le sens (non traduites). */
export const CONTEXT_LINES = 5;

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

/** Qui traduit : Ollama (embarqué ou externe), ou l'API OpenAI si une clé est configurée. */
export type TranslateProvider = 'ollama' | 'openai';

/** Modèle OpenAI par défaut (rapide et peu coûteux ; remplaçable dans les paramètres ou par OPENAI_MODEL). */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
export const OPENAI_URL = 'https://api.openai.com/v1';

/**
 * Clé et modèle OpenAI : variables OPENAI_API_KEY / OPENAI_MODEL, ou réglages
 * enregistrés dans la page Paramètres (prioritaires). Null : pas de clé.
 */
export type OpenAiSettingsReader = () => { key: string | null; model: string | null };
/** Par défaut : réglages enregistrés dans la page Paramètres (table `settings`). */
let openAiSettingsReader: OpenAiSettingsReader = () => ({ key: getSetting(SETTING_KEYS.openaiApiKey), model: getSetting(SETTING_KEYS.openaiModel) });
/** Branche la lecture des réglages enregistrés (page Paramètres). */
export function setOpenAiSettingsReader(fn: OpenAiSettingsReader): void {
  openAiSettingsReader = fn;
}

export function openAiConfig(): { key: string; model: string } | null {
  let saved: { key: string | null; model: string | null } = { key: null, model: null };
  try {
    saved = openAiSettingsReader();
  } catch {
    /* réglages illisibles : on retombe sur les variables d'environnement */
  }
  const key = saved.key?.trim() || process.env.OPENAI_API_KEY?.trim() || '';
  if (!key) return null;
  return { key, model: saved.model?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL };
}

export interface CommentaryConfig {
  transcribeMode: ServiceMode;
  translateMode: ServiceMode;
  transcribeUrl: string;
  transcribeModel: string;
  translateUrl: string;
  translateModel: string;
  translateEngine: TranslateEngine;
  translateProvider: TranslateProvider;
  /** Jeton `Bearer` du serveur de traduction (clé OpenAI, ou TRANSLATE_API_KEY). */
  translateApiKey: string;
  /** Sous-titres par requête de traduction (12-15 : au-delà, risque de lignes fusionnées ou décalées). */
  batch: number;
  /** Lots traduits en même temps (Ollama embarqué : OLLAMA_NUM_PARALLEL réglé pareil). */
  parallel: number;
  /**
   * Durée d'un tronçon audio (s, 120 par défaut) : les premiers sous-titres
   * arrivent ~20-40 s après l'ouverture du match (traduction à la demande),
   * et un match entier ne coûte que ~60 lancements de ffmpeg/Whisper.
   */
  chunkSec: number;
  /** Raison de l'inactivité de la fonctionnalité, ou null si elle est active. */
  disabledReason: string | null;
}

const trimUrl = (s: string | undefined) => (s ?? '').trim().replace(/\/+$/, '');

function intEnv(name: string, def: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== '' ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
}

/** Requêtes de traduction simultanées (`TRANSLATE_PARALLEL`, 2 par défaut). */
export function translateParallel(): number {
  return intEnv('TRANSLATE_PARALLEL', 2, 1, 8);
}

export function engineFor(model: string, forced?: string): TranslateEngine {
  const f = forced?.trim().toLowerCase();
  if (f === 'mt' || f === 'chat') return f;
  return /milmmt/i.test(model) ? 'mt' : 'chat';
}

export function commentaryConfig(): CommentaryConfig {
  // Clé OpenAI configurée : la traduction passe par l'API OpenAI (Ollama n'est pas démarré).
  const openai = openAiConfig();
  const translateModel = openai ? openai.model : process.env.TRANSLATE_MODEL?.trim() || DEFAULT_TRANSLATE_MODEL;
  // Sans URL externe, les services embarqués dans l'image Docker sont utilisés.
  const remoteAsr = trimUrl(process.env.TRANSCRIBE_URL);
  const remoteMt = openai ? OPENAI_URL : trimUrl(process.env.TRANSLATE_URL);
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
    translateEngine: openai ? 'chat' : engineFor(translateModel, process.env.TRANSLATE_ENGINE),
    translateProvider: openai ? 'openai' : 'ollama',
    translateApiKey: openai ? openai.key : process.env.TRANSLATE_API_KEY?.trim() || '',
    batch: intEnv('TRANSLATE_BATCH', 14, 1, 60),
    // L'API OpenAI encaisse plus de requêtes simultanées qu'un GPU de NAS.
    parallel: openai ? intEnv('TRANSLATE_PARALLEL', 4, 1, 16) : translateParallel(),
    chunkSec: intEnv('COMMENTARY_CHUNK_SEC', 120, 30, 3600),
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
 * Prompt initial de Whisper : contexte et orthographe des noms propres.
 * DÉSACTIVÉ par défaut (`WHISPER_PROMPT=1` pour l'activer) : mesuré sur de
 * vrais commentaires, la liste des joueurs corrige quelques noms mais fait
 * produire à Whisper des segments de 30 s, inutilisables en sous-titres.
 * Tronqué : Whisper n'en lit que ~224 jetons.
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
 * Prompt système par défaut de la traduction : le « prompt v1 » du banc
 * d'essai, le meilleur mesuré (ajouter des règles déplaçait les erreurs sans
 * améliorer le score). À remplacer librement (ou via TRANSLATE_PROMPT_FILE) :
 * la seule contrainte est le format de sortie JSON décrit à la fin, que
 * `parseTranslation` sait lire.
 */
export const TRANSLATE_SYSTEM_PROMPT = `Tu traduis en sous-titres français les commentaires TV en anglais d'un match NBA. Le texte anglais vient d'une transcription automatique (Whisper) : il peut contenir des noms mal orthographiés ou des phrases coupées.

Règles :
0. Tout ce qui est dit concerne le match de basket indiqué dans « match » : interprète chaque mot dans son sens basket (« three » = tir à trois points, « board » = rebond, « dime » = passe décisive, « glass » = planche, « paint » = raquette), jamais au sens courant.
1. Écris un français parlé naturel, comme un commentateur de basket français à la télé (beIN Sports, Canal+), pas une traduction mot à mot. Les commentateurs se tutoient entre eux.
2. Noms propres : ne traduis pas les noms d'équipes (Celtics, Knicks, Warriors…). La transcription écorche souvent les noms de joueurs : si un nom ressemble (par le son ou l'orthographe) à un joueur de la liste « joueurs », écris-le avec l'orthographe exacte de la liste (« Kata » → « Queta », « Edie » → « Edey »). Sinon, garde le nom tel qu'il est écrit.
3. Vocabulaire basket français :
   - three / trey / from downtown / from deep / splash → « à trois points », « derrière l'arc », « de loin » ;
   - and-one → « panier plus la faute » (ou « and one ») ; free throws → « lancers francs » ;
   - block / swat / rejection → « contre » ; assist / dime → « passe décisive » (familier : « caviar ») ;
   - screen → « écran » ; pick-and-roll / pick-and-pop → « pick-and-roll » / « pick-and-pop » ;
   - the paint / the lane → « la raquette » ; off the glass → « avec la planche » ; rebound / board → « rebond » ;
   - turnover → « balle perdue » ; steal → « interception » ; fast break / in transition → « contre-attaque », « en transition » ;
   - layup → « lay-up » ; dunk / slam → « dunk » ; bucket → « panier » ; foul → « faute » ; timeout → « temps mort » ;
   - shot clock → « les 24 secondes » ; run → « série » (« un 10-0 ») ; step-back, iso, alley-oop, 3-and-D → garder tel quel.
   - expressions de commentateurs : « he's cooking » / « on fire » / « heating up » → « il est en feu » ; « nothing but net » / « splash » → « ficelle » ; « and-one » → « panier plus la faute » ; « bucket » / « hoop » → « panier » ; « clean look » / « wide open » → « tir ouvert » ; « drop coverage » → « défense en recul » ; « switch » → « changement (défensif) » ; « help side » → « aide » ; « boards » → « rebonds » ; « glass » → « la planche » ; « charity stripe » → « la ligne des lancers francs » ; « bench » → « le banc » ; « going the other way » → « en contre-attaque » ; « tough shot » → « tir difficile » ; « foul trouble » → « en délicatesse avec les fautes » ; « crunch time » → « money time ».
4. Chiffres en chiffres : scores, statistiques et pourcentages (« 41 % à trois points », « 12-4 »).
5. Chaque ligne est un sous-titre et peut n'être qu'un morceau de phrase qui continue à la ligne suivante : traduis-la comme un morceau, dans l'ordre, sans déplacer de mots d'une ligne à l'autre, sans fusionner ni découper de lignes.
6. Phrases courtes et lisibles. N'ajoute rien, n'omets rien, n'explique rien. Si une ligne est confuse, traduis-la au plus près sans inventer.
7. Les lignes de « context » servent seulement à comprendre le début : ne les traduis pas.

Réponds uniquement avec ce JSON, sans texte autour : {"t":[{"i":<id>,"fr":"<traduction>"}]} — exactement un objet par ligne de « lines », avec le même id.`;

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
  /** Match en cours (« Memphis Grizzlies @ Portland Trail Blazers ») : le contexte basket du lot. */
  match?: string;
  /** Effectif du match : orthographe exacte des joueurs (donnée au LLM, et tolérée par le contrôle des noms). */
  roster?: RosterIndex;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Attente avant le nouvel essai après une erreur réseau ou 5xx (3 s). */
  retryDelayMs?: number;
}

/** Message utilisateur d'un lot (format du banc d'essai) : contexte à ne pas traduire, puis lignes. */
export function buildUserMessage(lines: TranslateLine[], context: string[], model: string, roster?: RosterIndex, match?: string): string {
  const players = roster?.full.length ? { joueurs: roster.full } : {};
  const game = match ? { match } : {};
  const payload = JSON.stringify({ ...game, ...players, context, lines: lines.map((l) => ({ i: l.i, en: l.en })) });
  return `Traduis ces lignes. Réponds uniquement avec le JSON demandé.\n${payload}${needsNoThink(model) ? '\n/no_think' : ''}`;
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

/** Minuscules sans accents ni ponctuation (comparaisons tolérantes). */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Une traduction est-elle acceptable pour cette ligne ? */
export function validTranslation(en: string, fr: string | undefined): fr is string {
  if (!fr || !/[\p{L}\p{N}]/u.test(fr)) return false;
  // Trop longue : le modèle a bavardé, recopié le contexte ou fusionné des lignes.
  if (fr.length > en.length * 2.2 + 30) return false;
  if (/"(i|fr|en)"\s*:/.test(fr)) return false;
  // Recopie de l'anglais (une ligne courte — « Santos. », « Bang! » — peut rester telle quelle).
  if (en.trim().split(/\s+/).length >= 4 && fold(fr) === fold(en)) return false;
  return true;
}

/** Mots qu'un commentateur écrit avec une majuscule sans que ce soit un nom propre. */
const NOT_NAMES = new Set(['i', "i'm", "i've", "i'll", "i'd", 'ok', 'okay', 'oh', 'mr', 'mrs', 'god', 'lord', 'game', 'coach']);

/**
 * Noms propres et chiffres d'une ligne anglaise, qui doivent se retrouver
 * dans sa traduction : chaque nombre, et chaque mot à majuscule qui
 * n'ouvre pas une phrase (comparé sur ses 5 premières lettres, sans accents :
 * « Finals » ≈ « finales »).
 */
export function anchors(en: string): { numbers: string[]; names: string[] } {
  const numbers = en.match(/\d+/g) ?? [];
  const names: string[] = [];
  const tokens = en.split(/\s+/).filter(Boolean);
  tokens.forEach((tok, k) => {
    const word = tok.replace(/^[^\p{L}]+|[^\p{L}']+$/gu, '').replace(/'s$/i, '');
    if (!/^\p{Lu}/u.test(word) || word.length < 2) return;
    const prev = tokens[k - 1];
    if (!prev || /[.!?…:"“]$/.test(prev)) return; // début de phrase
    if (NOT_NAMES.has(word.toLowerCase())) return;
    names.push(fold(word).slice(0, 5));
  });
  return { numbers, names };
}

/**
 * La traduction garde-t-elle les chiffres et les noms de la ligne ? Une
 * traduction décalée (le texte de la ligne voisine sous le mauvais id, avec
 * un JSON pourtant valide) échoue presque toujours à ce test.
 */
export function consistentTranslation(en: string, fr: string, roster?: RosterIndex): boolean {
  const { numbers, names } = anchors(en);
  const frDigits = new Set(fr.match(/\d+/g) ?? []);
  if (numbers.some((n) => !frDigits.has(n))) return false;
  const f = ` ${fold(fr)}`;
  // Un nom corrigé vers un joueur proche de l'effectif compte comme rendu.
  return names.every((n) => nameRendered(n, f, roster));
}

/** Le modèle accepte-t-il un schéma JSON imposé sans décaler les lignes ? (mesuré : oui pour Gemma 4 E2B/E4B, non pour le 12B). */
export function schemaSafe(model: string): boolean {
  const forced = process.env.TRANSLATE_JSON_SCHEMA?.trim();
  if (forced === '1') return true;
  if (forced === '0') return false;
  return /gemma4:e[24]b/i.test(model);
}

const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    t: {
      type: 'array',
      items: { type: 'object', properties: { i: { type: 'integer' }, fr: { type: 'string' } }, required: ['i', 'fr'] },
    },
  },
  required: ['t'],
};

/**
 * Appel brut au LLM ; `ServiceError` si le serveur ne répond pas correctement.
 * - Ollama embarqué : API native `/api/chat`, qui seule accepte `num_ctx`
 *   (4096 : un lot de 14 lignes ≈ 1 000 jetons d'entrée + 350 de sortie) et
 *   un schéma JSON imposé ;
 * - serveur externe : `/chat/completions` compatible OpenAI.
 */
/**
 * TranslateGemma n'accepte qu'un message utilisateur (pas de consignes
 * système) : comme au banc d'essai, consignes et lot partent dans le gabarit
 * Gemma brut (`/api/generate`, `raw: true`).
 */
export const needsRawGemma = (model: string) => /translategemma/i.test(model);

export function gemmaRawPrompt(system: string, user: string): string {
  return `<start_of_turn>user\n${system}\n\n${user}<end_of_turn>\n<start_of_turn>model\n`;
}

export async function chatCompletion(system: string, user: string, cfg: CommentaryConfig, o: TranslateContext = {}, temperature = 0.2): Promise<string> {
  const native = cfg.translateMode === 'embedded';
  const raw = native && needsRawGemma(cfg.translateModel);
  const url = raw ? `${ollamaBase(cfg.translateUrl)}/api/generate` : native ? `${ollamaBase(cfg.translateUrl)}/api/chat` : `${cfg.translateUrl}/chat/completions`;
  const timeoutMs = o.timeoutMs ?? intEnv('TRANSLATE_TIMEOUT_MS', 5 * 60_000, 5_000, 3600_000);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const body = JSON.stringify(
    raw
      ? {
          model: cfg.translateModel,
          prompt: gemmaRawPrompt(system, user),
          raw: true,
          stream: false,
          keep_alive: '10m',
          options: { temperature, top_p: 0.9, num_ctx: 4096, num_predict: 1200, stop: ['<end_of_turn>'] },
        }
      : native
      ? {
          model: cfg.translateModel,
          messages,
          stream: false,
          keep_alive: '10m',
          format: schemaSafe(cfg.translateModel) ? TRANSLATION_SCHEMA : undefined,
          options: { temperature, top_p: 0.9, num_ctx: 4096, num_predict: 1200 },
        }
      : cfg.translateProvider === 'openai'
        ? // API OpenAI : les modèles GPT-5 refusent temperature/top_p (valeurs par défaut
          // seulement) ; un raisonnement bref suffit pour traduire des sous-titres.
          {
            model: cfg.translateModel,
            messages,
            stream: false,
            response_format: { type: 'json_object' },
            ...(/^(gpt-5|o\d)/i.test(cfg.translateModel) ? { reasoning_effort: 'low' } : { temperature }),
          }
        : { model: cfg.translateModel, messages, temperature, top_p: 0.9, stream: false, response_format: { type: 'json_object' } },
  );
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (o.signal?.aborted) throw new ServiceError('traduction interrompue', 'traduction');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json', ...authHeaders(cfg.translateApiKey) },
        signal: timeoutSignal(timeoutMs, o.signal),
      });
    } catch (e) {
      last = `serveur de traduction injoignable (${cfg.translateUrl}) : ${fetchErrorText(e)}`;
      if (o.signal?.aborted) break;
      await sleep(o.retryDelayMs ?? 3000, o.signal);
      continue;
    }
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        choices?: { message?: { content?: unknown } }[];
        message?: { content?: unknown };
        response?: unknown;
      } | null;
      const content = raw ? data?.response : native ? data?.message?.content : data?.choices?.[0]?.message?.content;
      // Réponse vide ou mal formée : c'est le CONTENU qui est en cause, le lot sera retenté.
      return typeof content === 'string' ? content : '';
    }
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    last =
      cfg.translateProvider === 'openai'
        ? res.status === 401
          ? 'API OpenAI : clé refusée (vérifier la clé dans les paramètres)'
          : res.status === 429
            ? 'API OpenAI : quota ou crédit épuisé (HTTP 429)'
            : `API OpenAI : HTTP ${res.status}${detail ? ` — ${detail}` : ''}`
        : res.status === 404 && /model/i.test(detail)
          ? `modèle de traduction « ${cfg.translateModel} » absent d'Ollama (ollama pull ${cfg.translateModel})`
          : `serveur de traduction : HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
    // 429 (limite de débit) : on réessaie une fois après une pause.
    if (res.status < 500 && res.status !== 429) break;
    await sleep(o.retryDelayMs ?? (res.status === 429 ? 10_000 : 3000), o.signal);
  }
  throw new ServiceError(last || 'traduction impossible', 'traduction');
}

export interface TranslatedLine {
  i: number;
  fr: string;
  /** Traduction impossible : `fr` est l'anglais d'origine. */
  untranslated: boolean;
}

/** Un essai de lot : traductions acceptables, et nombre de lignes manquantes ou suspectes. */
async function chatAttempt(
  system: string,
  lines: TranslateLine[],
  context: string[],
  cfg: CommentaryConfig,
  o: TranslateContext,
  temperature: number,
): Promise<{ got: Map<number, string>; missing: number; suspect: number }> {
  const raw = parseTranslation(await chatCompletion(system, buildUserMessage(lines, context, cfg.translateModel, o.roster, o.match), cfg, o, temperature));
  // Ligne seule renvoyée sous un autre id : c'est bien elle.
  if (lines.length === 1 && raw.size === 1 && !raw.has(lines[0].i)) {
    const [[otherId, fr]] = [...raw.entries()];
    raw.delete(otherId);
    raw.set(lines[0].i, fr);
  }
  const got = new Map<number, string>();
  let suspect = 0;
  for (const l of lines) {
    const fr = raw.get(l.i);
    if (!validTranslation(l.en, fr)) continue;
    got.set(l.i, fr);
    if (!consistentTranslation(l.en, fr, o.roster)) suspect++;
  }
  // Ids inventés : signe de lignes coupées ou décalées.
  const ids = new Set(lines.map((l) => l.i));
  const extra = [...raw.keys()].filter((i) => !ids.has(i)).length;
  return { got, missing: lines.length - got.size + extra, suspect };
}

/** Lot douteux : une ligne manque (ou un id en trop), ou trop de lignes perdent leurs noms et chiffres. */
const doubtful = (r: { missing: number; suspect: number }, n: number) => r.missing > 0 || r.suspect >= Math.max(2, Math.ceil(n / 4));
const badness = (r: { missing: number; suspect: number }) => r.missing * 2 + r.suspect;

/**
 * Traduit un lot (moteur 'chat') :
 *  1. le lot entier (température 0,2), contrôlé : ids exacts, texte non vide
 *     et différent de l'anglais, noms et chiffres conservés ;
 *  2. lot douteux → nouvel essai à température 0, le meilleur des deux est gardé ;
 *  3. toujours douteux → le lot est coupé en deux, chaque moitié reprend en 1 ;
 *  4. une ligne seule sans traduction acceptable après deux essais → l'anglais (marqué).
 * `context` : quelques lignes précédentes, données pour le sens seulement.
 */
export async function translateBatch(lines: TranslateLine[], context: string[], cfg: CommentaryConfig, o: TranslateContext = {}): Promise<TranslatedLine[]> {
  if (cfg.translateEngine === 'mt') return translateBatchMt(lines, cfg, o);
  return translateChat(translateSystemPrompt(), lines, context, cfg, o);
}

async function translateChat(system: string, lines: TranslateLine[], context: string[], cfg: CommentaryConfig, o: TranslateContext): Promise<TranslatedLine[]> {
  if (!lines.length) return [];
  let best = await chatAttempt(system, lines, context, cfg, o, 0.2);
  if (doubtful(best, lines.length)) {
    const again = await chatAttempt(system, lines, context, cfg, o, 0);
    if (badness(again) < badness(best)) best = again;
  }
  if (doubtful(best, lines.length) && lines.length > 1) {
    const mid = Math.ceil(lines.length / 2);
    const head = lines.slice(0, mid);
    const tail = lines.slice(mid);
    const a = await translateChat(system, head, context, cfg, o);
    const b = await translateChat(system, tail, [...context, ...head.map((l) => l.en)].slice(-CONTEXT_LINES), cfg, o);
    return [...a, ...b];
  }
  return lines.map((l) => {
    const fr = best.got.get(l.i);
    return fr ? { i: l.i, fr, untranslated: false } : { i: l.i, fr: l.en, untranslated: true };
  });
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
        headers: { 'Content-Type': 'application/json', ...authHeaders(cfg.translateApiKey) },
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
  await Promise.all(Array.from({ length: Math.min(cfg.parallel, groups.length) }, worker));
  return lines.map((l) => (done.has(l.i) ? { i: l.i, fr: done.get(l.i) as string, untranslated: false } : { i: l.i, fr: l.en, untranslated: true }));
}
