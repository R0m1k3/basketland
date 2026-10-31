import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

vi.mock('../src/lib/audio', async (orig) => ({ ...(await orig<typeof import('../src/lib/audio')>()), ffmpegAvailable: () => true }));

import * as db from '../src/lib/db';
import { DEFAULT_TRANSLATE_MODEL } from '../src/lib/commentaryAi';
import { GET as getSubtitles } from '../src/api-routes/matches/[id]/subtitles/route';
import { GET as getVtt } from '../src/api-routes/matches/[id]/subtitles.vtt/route';
import { GET as getCommentary, POST as postCommentary } from '../src/api-routes/matches/[id]/commentary/route';
import { __commentaryIdle, __setCommentaryRunnerForTests, commentaryQueuePosition, enqueueCommentary, type CommentaryRecord } from '../src/lib/commentary';
import { createSession } from '../src/lib/auth';
import { setAutoTranslate } from '../src/lib/settings';
import { fixturePlays, freshDb, insertMatch } from './helpers/db';
import { regenerateSubtitles } from '../src/lib/ingest';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

const ID = 401909880;
const OTHER = 401909881;
const ctx = (id = ID) => ({ params: Promise.resolve({ id: String(id) }) });
const url = (p: string, id = ID) => `http://nas.local:3012/api/matches/${id}/${p}`;

function post(body: unknown, headers: Record<string, string> = {}, id = ID) {
  return postCommentary(
    new Request(url('commentary', id), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://nas.local:3012', host: 'nas.local:3012', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    ctx(id),
  );
}

/** Cookie de session d'un compte créé pour le test. */
function sessionCookie(username: string, role: 'admin' | 'user'): Record<string, string> {
  return { cookie: `bl_session=${createSession(db.insertUser(username, 'x', role)).token}` };
}

function storeTrack(okId = db.getMatch(ID)!.video_ok_id!) {
  db.replaceCommentary(ID, { ok_id: okId, transcribe_model: 'deepdml/faster-whisper-large-v3-turbo-ct2', translate_model: 'mistral-nemo:12b' }, [
    { seq: 1, start_ts: 12.5, end_ts: 15, text_en: 'He pulls up from deep.', text_fr: 'Il déclenche de loin.', untranslated: 0 },
    { seq: 2, start_ts: 15.2, end_ts: 17, text_en: 'Bang!', text_fr: 'Dedans !', untranslated: 0 },
  ]);
}

describe('API sous-titres = traduction des commentaires', () => {
  beforeEach(() => {
    freshDb();
    insertMatch(ID, { duration: 8033 });
    process.env.TRANSCRIBE_URL = 'http://gpu.local:8000/v1';
    process.env.TRANSLATE_URL = 'http://gpu.local:11434/v1';
    delete process.env.SYNC_WRITE_ORIGINS;
    __setCommentaryRunnerForTests(() => new Promise(() => {}));
  });
  afterEach(() => {
    __setCommentaryRunnerForTests(null);
    for (const k of ['TRANSCRIBE_URL', 'TRANSLATE_URL', 'SYNC_WRITE_ORIGINS']) delete process.env[k];
  });

  it('disabled : configuration absente, aucune mise en file', async () => {
    delete process.env.TRANSCRIBE_URL;
    delete process.env.TRANSLATE_URL;
    const d = await (await getSubtitles(new Request(url('subtitles')), ctx())).json();
    expect(d).toEqual({
      match_id: ID,
      count: 0,
      subtitles: [],
      commentary: { status: 'disabled', reason: 'serveurs de transcription et de traduction non configurés (TRANSCRIBE_URL, TRANSLATE_URL)' },
    });
  });

  it('none : pas de replay ; les sous-titres play-by-play ne sont plus servis', async () => {
    db.setVideo(ID, { slug: null, okId: null, duration: null, available: false });
    db.replacePlays(ID, fixturePlays(ID));
    expect(regenerateSubtitles(ID)).toBeGreaterThan(0); // toujours générés en interne…
    const d = await (await getSubtitles(new Request(url('subtitles')), ctx())).json();
    expect(d).toEqual({ match_id: ID, count: 0, subtitles: [], commentary: { status: 'none', reason: 'pas de replay disponible' } }); // …mais plus exposés
  });

  it('le GET ne lance rien : la fiche démarre la traduction elle-même, après le démarrage de la lecture', async () => {
    const d = await (await getSubtitles(new Request(url('subtitles?t=42')), ctx())).json();
    expect(d.commentary).toEqual({ status: 'none' });
    expect(commentaryQueuePosition(ID)).toBeNull();
  });

  it('ready : cues traduites au format du contrat, export VTT', async () => {
    storeTrack();
    const d = await (await getSubtitles(new Request(url('subtitles')), ctx())).json();
    expect(d).toEqual({
      match_id: ID,
      count: 2,
      subtitles: [
        { seq: 1, video_ts: 12.5, end_ts: 15, text: 'Il déclenche de loin.', speaker: '', kind: 'voice' },
        { seq: 2, video_ts: 15.2, end_ts: 17, text: 'Dedans !', speaker: '', kind: 'voice' },
      ],
      commentary: { status: 'ready', models: { transcribe: 'deepdml/faster-whisper-large-v3-turbo-ct2', translate: 'mistral-nemo:12b' } },
    });
    const vtt = await (await getVtt(new Request(url('subtitles.vtt')), ctx())).text();
    expect(vtt).toContain('00:00:12.500 --> 00:00:15.000\nIl déclenche de loin.');
    expect(vtt).toContain('Dedans !');
  });

  it('running : les sous-titres déjà publiés sont servis, avec available_until ; ready seulement une fois complète', async () => {
    const okId = db.getMatch(ID)!.video_ok_id!;
    const meta = { ok_id: okId, transcribe_model: 'deepdml/faster-whisper-large-v3-turbo-ct2', translate_model: DEFAULT_TRANSLATE_MODEL, chunk_sec: 60, chunks_total: 2 };
    let finish!: () => void;
    __setCommentaryRunnerForTests(async (_job, progress) => {
      db.openCommentaryTrack(ID, meta);
      db.publishCommentaryChunk(ID, meta, { idx: 0, keepFrom: 0, keepTo: 60 }, [
        { seq: 1, start_ts: 12.5, end_ts: 15, text_en: 'He pulls up from deep.', text_fr: 'Il déclenche de loin.', untranslated: 0 },
        { seq: 2, start_ts: 15.2, end_ts: 17, text_en: 'Bang!', text_fr: 'Dedans !', untranslated: 0 },
      ]);
      progress({ phase: 'transcription', done: 1, total: 2, availableUntil: 60 });
      await new Promise<void>((r) => (finish = r));
      db.publishCommentaryChunk(ID, meta, { idx: 1, keepFrom: 60, keepTo: Number.POSITIVE_INFINITY }, []);
      return { ok: true, reason: 'ok' };
    });
    enqueueCommentary(ID, { priority: true }); // « start » envoyé par la fiche
    const d = await (await getSubtitles(new Request(url('subtitles')), ctx())).json();
    expect(d).toEqual({
      match_id: ID,
      count: 2,
      subtitles: [
        { seq: 1, video_ts: 12.5, end_ts: 15, text: 'Il déclenche de loin.', speaker: '', kind: 'voice' },
        { seq: 2, video_ts: 15.2, end_ts: 17, text: 'Dedans !', speaker: '', kind: 'voice' },
      ],
      commentary: {
        status: 'running',
        phase: 'transcription',
        progress: { done: 1, total: 2 },
        available_until: 60,
        covered: [[0, 60]],
        models: { transcribe: 'deepdml/faster-whisper-large-v3-turbo-ct2', translate: DEFAULT_TRANSLATE_MODEL },
      },
    });
    expect(db.commentaryReadyIds([ID])).toEqual(new Set());
    expect(await (await getVtt(new Request(url('subtitles.vtt')), ctx())).text()).toContain('Dedans !');
    finish();
    await __commentaryIdle();
    const done = await (await getSubtitles(new Request(url('subtitles')), ctx())).json();
    expect(done.count).toBe(2);
    expect(done.commentary).toEqual({ status: 'ready', models: { transcribe: 'deepdml/faster-whisper-large-v3-turbo-ct2', translate: DEFAULT_TRANSLATE_MODEL } });
    expect(db.commentaryReadyIds([ID])).toEqual(new Set([ID]));
  });

  it('piste partielle d’une autre vidéo : ignorée', async () => {
    db.publishCommentaryChunk(ID, { ok_id: '111222333', transcribe_model: 'w', translate_model: 'l', chunk_sec: 60, chunks_total: 3 }, { idx: 0, keepFrom: 0, keepTo: 60 }, [
      { seq: 1, start_ts: 1, end_ts: 2, text_en: 'a', text_fr: 'b', untranslated: 0 },
    ]);
    const d = await (await getSubtitles(new Request(url('subtitles')), ctx())).json();
    expect(d.count).toBe(0);
    expect(d.commentary).toEqual({ status: 'none' });
  });

  it('piste d’une autre vidéo : plus servie, le match est refait', async () => {
    storeTrack('111222333');
    const d = await (await getSubtitles(new Request(url('subtitles')), ctx())).json();
    expect(d.count).toBe(0);
    expect(d.commentary.status).toBe('none'); // refaite au prochain « start » de la fiche
    expect(await (await getVtt(new Request(url('subtitles.vtt')), ctx())).text()).toBe('WEBVTT\nNOTE BasketLand VF — Portland Trail Blazers @ Los Angeles Lakers\n');
  });
});

describe('API POST /commentary', () => {
  beforeEach(() => {
    freshDb();
    insertMatch(ID, { duration: 8033 });
    insertMatch(OTHER);
    process.env.TRANSCRIBE_URL = 'http://gpu.local:8000/v1';
    process.env.TRANSLATE_URL = 'http://gpu.local:11434/v1';
    delete process.env.SYNC_WRITE_ORIGINS;
    __setCommentaryRunnerForTests(() => new Promise(() => {}));
  });
  afterEach(() => {
    __setCommentaryRunnerForTests(null);
    for (const k of ['TRANSCRIBE_URL', 'TRANSLATE_URL', 'SYNC_WRITE_ORIGINS']) delete process.env[k];
  });

  it('403 pour une origine tierce', async () => {
    const r = await post({ action: 'start' }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(commentaryQueuePosition(ID)).toBeNull();
  });

  it('415 sans Content-Type JSON (même « text/plain;charset=application/json »)', async () => {
    expect((await post({ action: 'start' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post({ action: 'start' }, { 'content-type': 'text/plain;charset=application/json' })).status).toBe(415);
  });

  it('400 pour une action inconnue ou un JSON invalide', async () => {
    expect((await post({ action: 'nope' })).status).toBe(400);
    expect((await post('{oops')).status).toBe(400);
  });

  it('start : en tête de file (202) ; retry (administrateur) relance une piste prête', async () => {
    enqueueCommentary(OTHER);
    const r = await post({ action: 'start' });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({
      commentary: { status: 'queued', position: 1, models: { transcribe: 'deepdml/faster-whisper-large-v3-turbo-ct2', translate: DEFAULT_TRANSLATE_MODEL } },
      message: 'Traduction des commentaires lancée',
    });

    __setCommentaryRunnerForTests(() => new Promise(() => {}));
    storeTrack();
    const again = await post({ action: 'start' });
    expect(again.status).toBe(200);
    expect((await again.json()).message).toBe('Pas de lancement (ready)');
    const retry = await post({ action: 'retry' }, sessionCookie('admin', 'admin'));
    expect(retry.status).toBe(202);
    expect((await retry.json()).commentary.status).toBe('running');
  });

  it('retry réservé aux administrateurs : 401 sans session, 403 pour un utilisateur, piste intacte', async () => {
    storeTrack();
    const anon = await post({ action: 'retry' });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: 'non connecté' });
    const user = await post({ action: 'retry' }, sessionCookie('bob', 'user'));
    expect(user.status).toBe(403);
    expect(await user.json()).toEqual({ error: 'réservé aux administrateurs' });
    expect(commentaryQueuePosition(ID)).toBeNull();
    expect(db.commentaryReadyIds([ID])).toEqual(new Set([ID]));
  });

  it('clic « Sous-titrer ce match » (manual) : mis en file même pendant le délai après un échec ; le lancement automatique, non', async () => {
    enqueueCommentary(OTHER); // occupe la file : le match reste visible en « queued »
    const okId = db.getMatch(ID)!.video_ok_id;
    db.kvSet(`commentary:${ID}`, { at: new Date().toISOString(), ok: false, failures: 1, kind: 'erreur', reason: 'échec simulé', okId } satisfies CommentaryRecord);

    const auto = await post({ action: 'start' });
    expect(auto.status).toBe(200);
    expect(await auto.json()).toMatchObject({ commentary: { status: 'failed', reason: 'échec simulé' }, message: 'Pas de lancement (failed)' });
    expect(commentaryQueuePosition(ID)).toBeNull();

    const manual = await post({ action: 'start', manual: true }); // simple utilisateur : pas besoin d'être administrateur
    expect(manual.status).toBe(202);
    expect(await manual.json()).toMatchObject({ commentary: { status: 'queued', position: 1 }, message: 'Traduction en file (position 1)' });
  });

  it('traduction automatique désactivée : le « start » automatique ne lance rien, le clic explicite oui', async () => {
    setAutoTranslate(false);
    const auto = await post({ action: 'start' });
    expect(auto.status).toBe(200);
    expect(await auto.json()).toEqual({
      commentary: { status: 'none' },
      autoTranslate: false,
      message: 'Traduction automatique désactivée : lancez-la avec « Sous-titrer ce match ».',
    });
    expect(commentaryQueuePosition(ID)).toBeNull();

    const manual = await post({ action: 'start', manual: true });
    expect(manual.status).toBe(202);
    expect((await manual.json()).commentary.status).toBe('running');
  });

  it('GET : statut seul', async () => {
    const d = await (await getCommentary(new Request(url('commentary')), ctx())).json();
    expect(d).toEqual({ commentary: { status: 'none' } });
  });
});

describe('commentaryReadyIds (badges « VF »)', () => {
  beforeEach(() => {
    freshDb();
    insertMatch(ID);
    insertMatch(OTHER);
  });

  it('seuls les matchs dont la piste correspond au replay actuel', () => {
    storeTrack();
    db.replaceCommentary(OTHER, { ok_id: 'ancienne-video', transcribe_model: 'w', translate_model: 'l' }, [
      { seq: 1, start_ts: 1, end_ts: 2, text_en: 'a', text_fr: 'b', untranslated: 0 },
    ]);
    expect(db.commentaryReadyIds([ID, OTHER, 42])).toEqual(new Set([ID]));
    expect(db.commentaryReadyIds([])).toEqual(new Set());
  });

  it('publication par tronçons, dans le désordre : jamais comptée avant le dernier ; tronçon republié remplacé', () => {
    const meta = { ok_id: db.getMatch(ID)!.video_ok_id!, transcribe_model: 'w', translate_model: 'l', chunk_sec: 60, chunks_total: 3 };
    const cue = (idx: number, k: number, fr = `fr${idx}.${k}`) => ({
      seq: db.chunkSeqBase(idx) + k,
      start_ts: idx * 60 + k * 10,
      end_ts: idx * 60 + k * 10 + 2,
      text_en: `en${idx}.${k}`,
      text_fr: fr,
      untranslated: fr.startsWith('en') ? 1 : 0,
    });
    expect(db.openCommentaryTrack(ID, meta)).toEqual(new Set());
    // Le spectateur a commencé au milieu : tronçon 1 d'abord.
    expect(db.publishCommentaryChunk(ID, meta, { idx: 1, keepFrom: 60, keepTo: 120 }, [cue(1, 1), cue(1, 2)])).toEqual({ done: 1, complete: false });
    expect(db.getCommentaryTrack(ID)).toMatchObject({ complete: 0, cues: 2, chunk_sec: 60, chunks_total: 3 });
    expect(db.commentaryReadyIds([ID])).toEqual(new Set());
    expect(db.commentaryProgressByIds([ID]).get(ID)).toEqual({ complete: false, done: 1, total: 3 });
    expect(db.finalMatchesNeedingCommentary('2000-01-01T00:00:00Z').map((m) => m.id)).toContain(ID);
    db.publishCommentaryChunk(ID, meta, { idx: 2, keepFrom: 120, keepTo: Number.POSITIVE_INFINITY }, [cue(2, 1, 'en2.1')]);
    expect(db.commentaryCoverage(ID)).toEqual([[60, 1e9]]);
    expect(db.commentaryCuesBefore(ID, 120, 3, 60)).toEqual(['en1.1', 'en1.2']);
    expect(db.commentaryCuesBefore(ID, 120, 3)).toEqual([]); // passage trop ancien : pas de contexte
    // Republier un tronçon remplace ses seuls sous-titres.
    db.publishCommentaryChunk(ID, meta, { idx: 1, keepFrom: 60, keepTo: 120 }, [cue(1, 1, 'un')]);
    expect(db.getCommentaryCues(ID).map((c) => c.text_fr)).toEqual(['un', 'en2.1']);
    // Reprise : les tronçons faits sont rendus.
    expect(db.openCommentaryTrack(ID, meta)).toEqual(new Set([1, 2]));
    expect(db.publishCommentaryChunk(ID, meta, { idx: 0, keepFrom: 0, keepTo: 60 }, [cue(0, 1)])).toEqual({ done: 3, complete: true });
    expect(db.getCommentaryTrack(ID)).toMatchObject({ complete: 1, cues: 3, untranslated: 1 });
    expect(db.commentaryReadyIds([ID])).toEqual(new Set([ID]));
    expect(db.commentaryProgressByIds([ID]).get(ID)).toEqual({ complete: true, done: 3, total: 3 });
    expect(db.finalMatchesNeedingCommentary('2000-01-01T00:00:00Z').map((m) => m.id)).not.toContain(ID);
    expect(db.commentaryCoverage(ID)).toEqual([[0, 1e9]]);
    // Changement de modèle de traduction : la piste faite par l'ancien est à refaire.
    expect(db.finalMatchesNeedingCommentary('2000-01-01T00:00:00Z', 30, 'l').map((m) => m.id)).not.toContain(ID);
    expect(db.finalMatchesNeedingCommentary('2000-01-01T00:00:00Z', 30, 'gemma4:e4b').map((m) => m.id)).toContain(ID);
    // Autres modèles (ou relance explicite) : on repart de zéro.
    expect(db.openCommentaryTrack(ID, { ...meta, translate_model: 'autre' })).toEqual(new Set());
    expect(db.getCommentaryCues(ID)).toEqual([]);
    expect(db.getCommentaryTrack(ID)).toBeUndefined();
  });
});

describe('migration de commentary_tracks.complete', () => {
  it('ajoutée sur une base existante, pistes antérieures marquées complètes ; idempotente', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-migrate-'));
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE commentary_tracks (
      match_id INTEGER PRIMARY KEY, ok_id TEXT NOT NULL, transcribe_model TEXT NOT NULL, translate_model TEXT NOT NULL,
      cues INTEGER NOT NULL DEFAULT 0, untranslated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
    old.exec(`INSERT INTO commentary_tracks VALUES (1, 'ok', 'w', 'l', 12, 0, '2026-01-01T00:00:00Z')`);
    old.close();
    for (let i = 0; i < 2; i++) {
      const d = db.openDatabase(file);
      expect(d.prepare('SELECT complete FROM commentary_tracks WHERE match_id = 1').get()).toEqual({ complete: 1 });
      d.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
