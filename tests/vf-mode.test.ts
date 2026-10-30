import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ffmpeg n'est pas forcément installé sur la machine de test (CI) : les files
// ne dépendent que de sa disponibilité DÉCLARÉE.
vi.mock('../src/lib/audio', async (orig) => ({ ...(await orig<typeof import('../src/lib/audio')>()), ffmpegAvailable: () => true }));

import * as db from '../src/lib/db';
import { createSession } from '../src/lib/auth';
import { currentActivity } from '../src/lib/activity';
import { GET as settingsGet, POST as settingsPost } from '../src/app/api/admin/settings/route';
import { POST as postDub } from '../src/app/api/matches/[id]/dub/route';
import { autoDubEnabled, autoTranslateEnabled, isVfMode, setAutoTranslate, setVfMode, SETTING_KEYS, vfMode } from '../src/lib/settings';
import { __commentaryIdle, __setCommentaryRunnerForTests, commentaryQueuePosition, commentaryRunningMatchId, enqueueCommentary, touchViewer } from '../src/lib/commentary';
import {
  __dubIdle,
  __setDubEngineForTests,
  __setDubRunnerForTests,
  dubManifest,
  dubQueuePosition,
  enqueueDub,
  enqueueRecentDubs,
  getDubRecord,
  prioritizeDubOnView,
  requestDub,
  type DubControl,
} from '../src/lib/dub';
import { freshDb, insertMatch } from './helpers/db';

/**
 * Réglage « Version française » (sous-titres / doublage) et doublage
 * MANUEL match par match : doublage de fond selon le mode, demande
 * explicite « Doubler ce match » (traduction d'abord, fiche fermée,
 * réglages ignorés), relance réservée aux administrateurs.
 */

const M = 404000001;
const M2 = 404000002;
const BASE = 'http://nas.local:3012';

let dataDir: string;
let TRACK: db.CommentaryTrackMeta;

const trackOf = (matchId: number): db.CommentaryTrackMeta => ({ ...TRACK, ok_id: db.getMatch(matchId)!.video_ok_id! });

/** Publie le tronçon `idx` des sous-titres traduits (2 tronçons au total : le 2e rend la piste complète). */
function publish(matchId: number, idx: number): void {
  db.publishCommentaryChunk(matchId, trackOf(matchId), { idx, keepFrom: idx * 120, keepTo: idx === 1 ? Number.POSITIVE_INFINITY : 120 }, [
    { seq: db.chunkSeqBase(idx) + 1, start_ts: idx * 120 + 5, end_ts: idx * 120 + 8, text_en: 'Bang!', text_fr: 'Dedans !', untranslated: 0, emphasis: 0 },
  ]);
}

interface Run {
  matchId: number;
  chunks: number[];
  explicit: boolean;
}

/**
 * Doublage simulé : chaque tronçon traduit pas encore doublé est publié
 * (comme runDub, sans moteur de voix ni ffmpeg) ; complet quand la piste
 * traduite l'est. `during` : appelé pendant le travail.
 */
function fakeDub(during?: (matchId: number, ctl: DubControl) => Promise<void> | void): Run[] {
  const runs: Run[] = [];
  __setDubRunnerForTests(async (job, _progress, _signal, ctl) => {
    await during?.(job.matchId, ctl);
    const track = db.getCommentaryTrack(job.matchId)!;
    db.openDubTrack(job.matchId, track.ok_id, db.commentaryKey(track));
    const todo = db.getCommentaryChunks(job.matchId).filter((c) => !db.getDubChunk(job.matchId, c.idx));
    for (const c of todo) {
      db.publishDubChunk(job.matchId, { idx: c.idx, start: c.keep_from, end: c.keep_to, file: `chunk-${c.idx}.m4a`, speech: [], cuesSig: 'x' }, { voices: ['A'], speakers: {} });
    }
    db.setDubComplete(job.matchId, db.getCommentaryTrack(job.matchId)!.complete === 1);
    runs.push({ matchId: job.matchId, chunks: todo.map((c) => c.idx), explicit: !!job.explicit });
    return { ok: true, reason: `${todo.length} tronçon(s) doublé(s)` };
  });
  return runs;
}

/** Une porte : la promesse se résout à l'appel de `open()`. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (username: string, role: 'admin' | 'user') => ({ cookie: `bl_session=${createSession(db.insertUser(username, 'x', role)).token}` });

function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, host: 'nas.local:3012', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const dubPost = (body: unknown, headers: Record<string, string> = {}, id = M) =>
  postDub(post(`/api/matches/${id}/dub`, body, headers), { params: Promise.resolve({ id: String(id) }) });

beforeEach(() => {
  freshDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-vf-mode-'));
  process.env.DATA_DIR = dataDir;
  process.env.COMMENTARY_NIGHT_WINDOW = 'always';
  process.env.TRANSCRIBE_URL = 'http://gpu.local:8000/v1';
  process.env.TRANSLATE_URL = 'http://gpu.local:11434/v1';
  process.env.DUB_REPUMP_MS = '10';
  process.env.COMMENTARY_REPUMP_MS = '10';
  delete process.env.SYNC_WRITE_ORIGINS;
  insertMatch(M, { duration: 240 });
  insertMatch(M2, { duration: 240 });
  TRACK = { ok_id: '', transcribe_model: 'large-v3-turbo', translate_model: 'translategemma:12b', chunk_sec: 120, chunks_total: 2 };
  // Moteur de voix « configuré » (jamais ouvert : l'exécuteur est simulé).
  __setDubEngineForTests({ config: () => ({}), open: async () => Promise.reject(new Error('pas de moteur en test')) });
  __setCommentaryRunnerForTests(() => new Promise(() => {}));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  __setDubRunnerForTests(null);
  __setCommentaryRunnerForTests(null);
  __setDubEngineForTests(null);
  for (const k of ['DATA_DIR', 'DUB_DISABLED', 'DUB_REPUMP_MS', 'COMMENTARY_REPUMP_MS', 'COMMENTARY_VIEWER_IDLE_MS', 'TRANSCRIBE_URL', 'TRANSLATE_URL']) delete process.env[k];
  process.env.COMMENTARY_NIGHT_WINDOW = 'always';
  vi.useRealTimers();
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ réglage

describe('réglage « Version française »', () => {
  it('sous-titres par défaut (clé absente ou valeur inconnue) ; doublage automatique = traduction automatique ET doublage', () => {
    expect(db.settingGet(SETTING_KEYS.vfMode)).toBeNull();
    expect(vfMode()).toBe('sous-titres');
    expect(autoDubEnabled()).toBe(false);
    setVfMode('doublage');
    expect(db.settingGet('vf_mode')).toBe('doublage');
    expect(vfMode()).toBe('doublage');
    expect(autoDubEnabled()).toBe(true);
    setAutoTranslate(false);
    expect(autoDubEnabled()).toBe(false);
    db.settingSet('vf_mode', 'voix');
    expect(vfMode()).toBe('sous-titres');
    expect(isVfMode('doublage')).toBe(true);
    expect(isVfMode('sous-titres')).toBe(true);
    expect(isVfMode('Doublage')).toBe(false);
    expect(isVfMode(null)).toBe(false);
  });

  it('route admin : lecture, choix, valeur invalide refusée sans rien changer, utilisateur refusé', async () => {
    const admin = cookieOf('admin', 'admin');
    expect(await (await settingsGet(new Request(`${BASE}/api/admin/settings`, { headers: admin }))).json()).toMatchObject({ autoTranslate: true, vfMode: 'sous-titres' });

    const ok = await settingsPost(post('/api/admin/settings', { vfMode: 'doublage' }, admin));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, vfMode: 'doublage', autoTranslate: true });
    expect(vfMode()).toBe('doublage');

    // Tout est validé avant d'écrire : la traduction automatique, valide, ne change pas non plus.
    for (const bad of ['voix', '', null, true, 1]) {
      const r = await settingsPost(post('/api/admin/settings', { vfMode: bad, autoTranslate: false }, admin));
      expect(r.status).toBe(400);
      expect((await r.json()).error).toContain('vfMode invalide');
    }
    expect(vfMode()).toBe('doublage');
    expect(autoTranslateEnabled()).toBe(true);

    const user = await settingsPost(post('/api/admin/settings', { vfMode: 'sous-titres' }, cookieOf('bob', 'user')));
    expect(user.status).toBe(403);
    expect(vfMode()).toBe('doublage');

    // Champ absent : inchangé.
    await settingsPost(post('/api/admin/settings', { autoTranslate: false }, admin));
    expect(vfMode()).toBe('doublage');
    expect((await (await settingsPost(post('/api/admin/settings', { vfMode: 'sous-titres' }, admin))).json()).vfMode).toBe('sous-titres');
  });
});

// ------------------------------------------------------------------ doublage automatique

describe('doublage automatique selon le mode', () => {
  it('sous-titres (défaut) : ni doublage de fond, ni lancement à l’ouverture ; doublage : les deux', async () => {
    publish(M, 0);
    publish(M, 1);
    const runs = fakeDub();
    expect(await enqueueRecentDubs()).toBe(0);
    expect(enqueueDub(M)).toMatchObject({ queued: false }); // mise en file de fond directe : abandonnée
    touchViewer(M, 10);
    prioritizeDubOnView(M); // le match est regardé, VF doublée choisie dans le lecteur
    expect(dubQueuePosition(M)).toBeNull();
    await __dubIdle();
    expect(runs).toEqual([]);
    expect(dubManifest(M).status).toBe('none');

    setVfMode('doublage');
    prioritizeDubOnView(M);
    await __dubIdle();
    expect(runs).toEqual([{ matchId: M, chunks: [0, 1], explicit: false }]);
    expect(dubManifest(M).status).toBe('ready');
    publish(M2, 0);
    expect(await enqueueRecentDubs()).toBe(1);
    expect(dubQueuePosition(M2)).toBe(1); // doublage de fond : attend la fin de la lecture de M
    expect(runs.map((r) => r.matchId)).toEqual([M]);
  });

  it('sous-titres : la traduction en cours n’annonce pas de doublage (« le doublage suivra » seulement en mode doublage)', () => {
    enqueueCommentary(M, { priority: true }); // exécuteur qui ne rend jamais la main
    expect(commentaryRunningMatchId()).toBe(M);
    expect(dubManifest(M).status).toBe('none');
    setVfMode('doublage');
    expect(dubManifest(M)).toMatchObject({ status: 'waiting', reason: 'traduction des commentaires en cours : le doublage suivra' });
  });

  it('passage en mode sous-titres : les doublages de fond en file sont abandonnés, celui en cours cède la place', async () => {
    setVfMode('doublage');
    publish(M, 0);
    publish(M2, 0);
    const g = gate();
    let ctl: DubControl | null = null;
    const runs = fakeDub(async (id, c) => {
      if (id !== M) return;
      ctl = c;
      await g.wait;
    });
    expect(enqueueDub(M).started).toBe(true);
    expect(enqueueDub(M2)).toMatchObject({ queued: true, position: 1 });
    expect(ctl!.yieldReason()).toBeNull();

    setVfMode('sous-titres');
    expect(ctl!.yieldReason()).toBe('window'); // au prochain tronçon, le travail de fond s'arrête
    g.open();
    await __dubIdle();
    expect(runs.map((r) => r.matchId)).toEqual([M]);
    expect(dubQueuePosition(M2)).toBeNull();
    expect(db.getDubChunks(M2)).toEqual([]);
  });
});

// ------------------------------------------------------------------ demande explicite

describe('« Doubler ce match » : demande explicite', () => {
  it('traduction d’abord puis doublage, fiche fermée, traduction automatique coupée, hors fenêtre, mode sous-titres', async () => {
    setAutoTranslate(false);
    process.env.COMMENTARY_NIGHT_WINDOW = 'off';
    const first = gate();
    const second = gate();
    __setCommentaryRunnerForTests(async (job) => {
      db.openCommentaryTrack(job.matchId, trackOf(job.matchId));
      await first.wait;
      publish(job.matchId, 0);
      await second.wait;
      publish(job.matchId, 1);
      return { ok: true, reason: 'traduit' };
    });
    const runs = fakeDub();

    const r = requestDub(M); // personne ne regarde la fiche de M
    expect(r).toMatchObject({ queued: true, started: false, message: 'Doublage demandé : la traduction des commentaires passe d’abord' });
    expect(r.translation).toBe('Traduction des commentaires lancée');
    expect(commentaryRunningMatchId()).toBe(M);
    expect(dubQueuePosition(M)).toBe(1);
    expect(dubManifest(M)).toMatchObject({ status: 'waiting', reason: 'traduction des commentaires en cours : le doublage suivra' });
    expect(currentActivity().queued).toContainEqual(expect.objectContaining({ kind: 'doublage', match: expect.objectContaining({ id: M }) }));

    // Pas de sous-titres pendant un moment : le doublage reste en file (plusieurs passages de la file).
    await sleep(60);
    expect(dubQueuePosition(M)).toBe(1);
    first.open();
    await vi.waitFor(() => expect(db.getCommentaryChunks(M)).toHaveLength(1));
    await sleep(60);
    expect(runs).toEqual([]); // la traduction tourne : le GPU est pris
    expect(dubManifest(M)).toMatchObject({ status: 'waiting', reason: expect.stringContaining('GPU') });

    second.open();
    await __commentaryIdle();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await __dubIdle();
    expect(runs).toEqual([{ matchId: M, chunks: [0, 1], explicit: true }]);
    expect(dubManifest(M).status).toBe('ready');
    expect(getDubRecord(M)?.ok).toBe(true);
  });

  it('revient en file tant que la traduction publie des tronçons, jusqu’au doublage complet', async () => {
    process.env.COMMENTARY_NIGHT_WINDOW = 'off';
    db.openCommentaryTrack(M, trackOf(M));
    publish(M, 0); // piste partielle, traduction arrêtée
    const translating = gate();
    __setCommentaryRunnerForTests(async (job) => {
      await translating.wait;
      publish(job.matchId, 1);
      return { ok: true, reason: 'traduit' };
    });
    // Pendant le 1er doublage, la traduction du match reprend (et prend le GPU).
    const runs = fakeDub((id) => {
      if (!commentaryRunningMatchId()) enqueueCommentary(id, { priority: true, explicit: true });
    });

    enqueueDub(M, { priority: true, explicit: true });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toEqual({ matchId: M, chunks: [0], explicit: true });
    await vi.waitFor(() => expect(dubQueuePosition(M)).toBe(1)); // remis en file : la suite arrive
    expect(dubManifest(M).status).toBe('waiting');

    translating.open();
    await __commentaryIdle();
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    await __dubIdle();
    expect(runs[1]).toEqual({ matchId: M, chunks: [1], explicit: true });
    expect(dubQueuePosition(M)).toBeNull();
    expect(dubManifest(M).status).toBe('ready');
  });

  it('cède la place à la lecture d’un AUTRE match, reprend après', async () => {
    process.env.COMMENTARY_VIEWER_IDLE_MS = '60000';
    publish(M, 0);
    publish(M, 1);
    const runs = fakeDub();
    touchViewer(M2, 10); // quelqu'un regarde un autre match
    expect(requestDub(M)).toMatchObject({ queued: true, started: false });
    await sleep(40);
    expect(runs).toEqual([]);
    expect(dubManifest(M).status).toBe('waiting');
    vi.setSystemTime(Date.now() + 10 * 60_000); // la lecture s'arrête
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await __dubIdle();
    vi.useRealTimers();
    expect(runs[0]).toMatchObject({ matchId: M, explicit: true });
  });

  it('match déjà doublé : rien à refaire ; doublage désactivé : refus clair ; pas de replay : la raison', async () => {
    publish(M, 0);
    publish(M, 1);
    const runs = fakeDub();
    requestDub(M);
    await __dubIdle();
    expect(runs).toHaveLength(1);
    expect(requestDub(M)).toMatchObject({ queued: false, message: 'Ce match est déjà doublé' });

    db.setVideo(M2, { slug: null, okId: null, duration: null, available: false });
    expect(requestDub(M2)).toMatchObject({ queued: false, message: 'Traduction impossible : pas de replay disponible' });

    process.env.DUB_DISABLED = '1';
    expect(requestDub(M, { reset: true })).toMatchObject({ queued: false, message: expect.stringContaining('Doublage inactif') });
    expect(db.getDubChunks(M)).toHaveLength(2); // rien d'effacé
  });
});

// ------------------------------------------------------------------ API

describe('API POST /api/matches/[id]/dub', () => {
  it('garde-fous : origine, Content-Type JSON, action', async () => {
    expect((await dubPost({ action: 'start' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await dubPost({ action: 'start' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await dubPost({ action: 'nope' })).status).toBe(400);
    expect((await dubPost('{oops')).status).toBe(400);
    expect((await dubPost({ action: 'start' }, {}, 999)).status).toBe(404);
    expect(dubQueuePosition(M)).toBeNull();
  });

  it('start (tout utilisateur) : traduction puis doublage en file, 202', async () => {
    fakeDub();
    const r = await dubPost({ action: 'start' }, cookieOf('bob', 'user'));
    expect(r.status).toBe(202);
    const d = await r.json();
    expect(d).toMatchObject({
      dub: { status: 'waiting', reason: 'traduction des commentaires en cours : le doublage suivra', chunks: [] },
      commentary: { status: 'running' },
      message: 'Doublage demandé : la traduction des commentaires passe d’abord',
    });
    expect(commentaryRunningMatchId()).toBe(M);
    expect(dubQueuePosition(M)).toBe(1);
    expect(commentaryQueuePosition(M)).toBeNull();
  });

  it('retry : administrateurs seulement — efface le doublage et le refait ; refusé pendant le doublage', async () => {
    publish(M, 0);
    publish(M, 1);
    let runs = fakeDub();
    expect((await dubPost({ action: 'start' }, cookieOf('bob', 'user'))).status).toBe(202);
    await __dubIdle();
    expect(runs).toHaveLength(1);
    expect(db.getDubChunks(M)).toHaveLength(2);
    fs.mkdirSync(path.join(dataDir, 'dub', String(M)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'dub', String(M), 'chunk-0.m4a'), 'm4a');

    // Déjà doublé : « start » ne refait rien.
    const again = await dubPost({ action: 'start' });
    expect(again.status).toBe(200);
    expect((await again.json()).message).toBe('Ce match est déjà doublé');

    expect((await dubPost({ action: 'retry' })).status).toBe(401);
    expect((await dubPost({ action: 'retry' }, cookieOf('carl', 'user'))).status).toBe(403);
    expect(db.getDubChunks(M)).toHaveLength(2); // intact

    const g = gate();
    runs = fakeDub(() => g.wait);
    const admin = cookieOf('admin', 'admin');
    const retry = await dubPost({ action: 'retry' }, admin);
    expect(retry.status).toBe(202);
    expect((await retry.json()).dub.status).toBe('running');
    expect(fs.existsSync(path.join(dataDir, 'dub', String(M)))).toBe(false); // fichiers effacés
    expect(db.getDubChunks(M)).toEqual([]);

    const busy = await dubPost({ action: 'retry' }, admin);
    expect(busy.status).toBe(409);
    expect((await busy.json()).message).toBe('Doublage en cours : relance possible une fois terminé');

    g.open();
    await __dubIdle();
    expect(runs).toEqual([{ matchId: M, chunks: [0, 1], explicit: true }]);
    expect(dubManifest(M).status).toBe('ready');
  });

  it('doublage désactivé : réponse 200 avec la raison, rien en file', async () => {
    process.env.DUB_DISABLED = '1';
    const r = await dubPost({ action: 'start' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ dub: { status: 'disabled' }, message: expect.stringContaining('Doublage inactif') });
    expect(commentaryRunningMatchId()).toBeNull();
  });
});
