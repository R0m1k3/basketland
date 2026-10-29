import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/lib/audio', async (orig) => ({ ...(await orig<typeof import('../src/lib/audio')>()), ffmpegAvailable: () => true }));

import * as db from '../src/lib/db';
import { GET as getSubtitles } from '../src/app/api/matches/[id]/subtitles/route';
import { GET as getVtt } from '../src/app/api/matches/[id]/subtitles.vtt/route';
import { GET as getCommentary, POST as postCommentary } from '../src/app/api/matches/[id]/commentary/route';
import { __setCommentaryRunnerForTests, commentaryQueuePosition, enqueueCommentary } from '../src/lib/commentary';
import { fixturePlays, freshDb, insertMatch } from './helpers/db';
import { regenerateSubtitles } from '../src/lib/ingest';

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
  db.replaceCommentary(ID, { ok_id: okId, transcribe_model: 'Systran/faster-distil-whisper-large-v3', translate_model: 'mistral-nemo:12b' }, [
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
      commentary: { status: 'ready', models: { transcribe: 'Systran/faster-distil-whisper-large-v3', translate: 'mistral-nemo:12b' } },
    });
    const vtt = await (await getVtt(new Request(url('subtitles.vtt')), ctx())).text();
    expect(vtt).toContain('00:00:12.500 --> 00:00:15.000\nIl déclenche de loin.');
    expect(vtt).toContain('Dedans !');
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
      commentary: { status: 'queued', position: 1, models: { transcribe: 'Systran/faster-distil-whisper-large-v3', translate: 'mistral-nemo:12b' } },
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
});
