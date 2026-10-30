import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

vi.mock('../src/lib/audio', async (orig) => ({ ...(await orig<typeof import('../src/lib/audio')>()), ffmpegAvailable: () => true }));

import * as db from '../src/lib/db';
import { DEFAULT_TRANSLATE_MODEL } from '../src/lib/commentaryAi';
import { GET as getSubtitles } from '../src/app/api/matches/[id]/subtitles/route';
import { GET as getVtt } from '../src/app/api/matches/[id]/subtitles.vtt/route';
import { GET as getCommentary, POST as postCommentary } from '../src/app/api/matches/[id]/commentary/route';
import { __commentaryIdle, __setCommentaryRunnerForTests, commentaryQueuePosition, enqueueCommentary } from '../src/lib/commentary';
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

  it('ouvrir la fiche met le match en tête de file', async () => {
    insertMatch(OTHER);
    enqueueCommentary(OTHER); // occupe le « GPU »
    const d = await (await getSubtitles(new Request(url('subtitles')), ctx())).json();
    expect(d.commentary).toMatchObject({ status: 'queued', position: 1 });
    expect(commentaryQueuePosition(ID)).toBe(1);
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
    const meta = { ok_id: okId, transcribe_model: 'deepdml/faster-whisper-large-v3-turbo-ct2', translate_model: DEFAULT_TRANSLATE_MODEL };
    let finish!: () => void;
    __setCommentaryRunnerForTests(async (_job, progress) => {
      db.publishCommentaryCues(ID, meta, [
        { seq: 1, start_ts: 12.5, end_ts: 15, text_en: 'He pulls up from deep.', text_fr: 'Il déclenche de loin.', untranslated: 0 },
        { seq: 2, start_ts: 15.2, end_ts: 17, text_en: 'Bang!', text_fr: 'Dedans !', untranslated: 0 },
      ]);
      progress({ phase: 'transcription', done: 4, total: 10, availableUntil: 2050 });
      await new Promise<void>((r) => (finish = r));
      db.completeCommentary(ID, meta, 2);
      return { ok: true, reason: 'ok' };
    });
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
        progress: { done: 4, total: 10 },
        available_until: 2050,
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
    db.publishCommentaryCues(ID, { ok_id: '111222333', transcribe_model: 'w', translate_model: 'l' }, [
      { seq: 1, start_ts: 1, end_ts: 2, text_en: 'a', text_fr: 'b', untranslated: 0 },
    ]);
    const d = await (await getSubtitles(new Request(url('subtitles')), ctx())).json();
    expect(d.count).toBe(0);
    expect(d.commentary).toEqual({ status: 'running', models: expect.any(Object) });
  });

  it('piste d’une autre vidéo : plus servie, le match est refait', async () => {
    storeTrack('111222333');
    const d = await (await getSubtitles(new Request(url('subtitles')), ctx())).json();
    expect(d.count).toBe(0);
    expect(d.commentary.status).toBe('running');
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

  it('start : en tête de file (202) ; retry relance une piste prête', async () => {
    enqueueCommentary(OTHER);
    const r = await post({ action: 'start' });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({
      commentary: { status: 'queued', position: 1, models: { transcribe: 'deepdml/faster-whisper-large-v3-turbo-ct2', translate: DEFAULT_TRANSLATE_MODEL } },
      message: 'Traduction en file (position 1)',
    });

    __setCommentaryRunnerForTests(() => new Promise(() => {}));
    storeTrack();
    const again = await post({ action: 'start' });
    expect(again.status).toBe(200);
    expect((await again.json()).message).toBe('Traduction des commentaires déjà prête');
    const retry = await post({ action: 'retry' });
    expect(retry.status).toBe(202);
    expect((await retry.json()).commentary.status).toBe('running');
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

  it('publication partielle : jamais comptée avant complete=1 ; plages remplacées, reliquat retiré', () => {
    const meta = { ok_id: db.getMatch(ID)!.video_ok_id!, transcribe_model: 'w', translate_model: 'l' };
    const cue = (seq: number, fr = `fr${seq}`) => ({ seq, start_ts: seq * 10, end_ts: seq * 10 + 2, text_en: `en${seq}`, text_fr: fr, untranslated: fr === `en${seq}` ? 1 : 0 });
    db.publishCommentaryCues(ID, meta, [cue(1), cue(2)]);
    expect(db.getCommentaryTrack(ID)).toMatchObject({ complete: 0, cues: 2, untranslated: 0 });
    expect(db.commentaryReadyIds([ID])).toEqual(new Set());
    expect(db.finalMatchesNeedingCommentary('2000-01-01T00:00:00Z').map((m) => m.id)).toContain(ID);
    db.publishCommentaryCues(ID, meta, [cue(3), cue(4, 'en4')]);
    expect(db.getCommentaryTrack(ID)).toMatchObject({ complete: 0, cues: 4, untranslated: 1 });
    // Une plage republiée remplace tout ce qui suit (la piste reste un préfixe continu).
    db.publishCommentaryCues(ID, meta, [cue(2, 'deux'), cue(3, 'trois')]);
    expect(db.getCommentaryCues(ID).map((c) => [c.seq, c.text_fr])).toEqual([
      [1, 'fr1'],
      [2, 'deux'],
      [3, 'trois'],
    ]);
    db.publishCommentaryCues(ID, meta, [cue(4), cue(5)]);
    db.completeCommentary(ID, meta, 4);
    expect(db.getCommentaryCues(ID).map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    expect(db.getCommentaryTrack(ID)).toMatchObject({ complete: 1, cues: 4 });
    expect(db.commentaryReadyIds([ID])).toEqual(new Set([ID]));
    expect(db.finalMatchesNeedingCommentary('2000-01-01T00:00:00Z').map((m) => m.id)).not.toContain(ID);
    expect(db.commentaryPublishedUntil(ID)).toBe(42);
    // Changement de modèle de traduction : la piste faite par l'ancien est à refaire.
    expect(db.finalMatchesNeedingCommentary('2000-01-01T00:00:00Z', 30, 'l').map((m) => m.id)).not.toContain(ID);
    expect(db.finalMatchesNeedingCommentary('2000-01-01T00:00:00Z', 30, 'gemma4:e4b').map((m) => m.id)).toContain(ID);
    // Nouvelle vidéo : l'ancienne piste est effacée à la première publication.
    db.publishCommentaryCues(ID, { ...meta, ok_id: 'nouvelle' }, [cue(7)]);
    expect(db.getCommentaryCues(ID).map((c) => c.seq)).toEqual([7]);
    expect(db.getCommentaryTrack(ID)).toMatchObject({ ok_id: 'nouvelle', complete: 0, cues: 1 });
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
