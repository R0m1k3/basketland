import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// ffmpeg n'est pas forcément installé sur la machine de test (CI) : la file ne
// dépend que de sa disponibilité DÉCLARÉE.
vi.mock('../src/lib/audio', async (orig) => ({ ...(await orig<typeof import('../src/lib/audio')>()), ffmpegAvailable: () => true }));
import * as db from '../src/lib/db';
import { createSession } from '../src/lib/auth';
import { GET as settingsGet, POST as settingsPost } from '../src/app/api/admin/settings/route';
import { autoTranslateEnabled, setAutoTranslate, SETTING_KEYS } from '../src/lib/settings';
import { inNightWindow, inScheduleWindow } from '../src/lib/nightWindow';
import {
  __commentaryIdle,
  __setCommentaryRunnerForTests,
  commentaryQueuePosition,
  commentaryRunningMatchId,
  enqueueCommentary,
  getCommentaryRecord,
} from '../src/lib/commentary';
import { freshDb, insertMatch } from './helpers/db';

const BASE = 'http://nas.local:3012';

function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, host: 'nas.local:3012', ...headers },
    body: JSON.stringify(body),
  });
}
const cookieOf = (username: string, role: 'admin' | 'user') => ({ cookie: `bl_session=${createSession(db.insertUser(username, 'x', role)).token}` });

beforeEach(() => {
  freshDb();
  delete process.env.SYNC_WRITE_ORIGINS;
});

describe('réglage « Traduction automatique »', () => {
  it('activé par défaut (clé absente) ; seule la valeur « 0 » le désactive', () => {
    expect(db.settingGet(SETTING_KEYS.autoTranslate)).toBeNull();
    expect(autoTranslateEnabled()).toBe(true);
    setAutoTranslate(false);
    expect(db.settingGet('auto_translate')).toBe('0');
    expect(autoTranslateEnabled()).toBe(false);
    setAutoTranslate(true);
    expect(db.settingGet('auto_translate')).toBe('1');
    expect(autoTranslateEnabled()).toBe(true);
    db.settingSet('auto_translate', 'oui');
    expect(autoTranslateEnabled()).toBe(true);
  });

  it('route admin : lecture, bascule, valeur invalide refusée sans rien changer, utilisateur refusé', async () => {
    const admin = cookieOf('admin', 'admin');
    const read = await settingsGet(new Request(`${BASE}/api/admin/settings`, { headers: admin }));
    expect(await read.json()).toMatchObject({ autoTranslate: true });

    const off = await settingsPost(post('/api/admin/settings', { autoTranslate: false }, admin));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ ok: true, autoTranslate: false, openai: { keySet: false } });
    expect(autoTranslateEnabled()).toBe(false);

    // Tout est validé avant d'écrire : le modèle, valide, n'est pas enregistré non plus.
    const bad = await settingsPost(post('/api/admin/settings', { autoTranslate: 'non', openaiModel: 'gpt-5.4-mini' }, admin));
    expect(bad.status).toBe(400);
    expect(autoTranslateEnabled()).toBe(false);
    expect(db.settingGet('openai_model')).toBeNull();

    const user = await settingsPost(post('/api/admin/settings', { autoTranslate: true }, cookieOf('bob', 'user')));
    expect(user.status).toBe(403);
    expect(autoTranslateEnabled()).toBe(false);

    // Champ absent : inchangé.
    await settingsPost(post('/api/admin/settings', { openaiModel: '' }, admin));
    expect(autoTranslateEnabled()).toBe(false);
    expect((await (await settingsPost(post('/api/admin/settings', { autoTranslate: true }, admin))).json()).autoTranslate).toBe(true);
  });

  it('désactivé : la fenêtre des tâches de fond est fermée, quelle que soit l’heure', () => {
    const noon = new Date('2026-10-30T12:00:00Z');
    expect(inScheduleWindow(noon)).toBe(true);
    expect(inNightWindow(noon)).toBe(true);
    setAutoTranslate(false);
    expect(inScheduleWindow(noon)).toBe(true);
    expect(inNightWindow(noon)).toBe(false);
  });
});

describe('désactivation : les traductions de fond déjà en file sont abandonnées', () => {
  const finish = new Map<number, () => void>();
  beforeEach(() => {
    process.env.TRANSCRIBE_URL = 'http://gpu.local:8000/v1';
    process.env.TRANSLATE_URL = 'http://gpu.local:11434/v1';
    finish.clear();
    __setCommentaryRunnerForTests((job) => new Promise((resolve) => finish.set(job.matchId, () => resolve({ ok: true, reason: 'ok' }))));
  });
  afterEach(() => {
    __setCommentaryRunnerForTests(null);
    delete process.env.TRANSCRIBE_URL;
    delete process.env.TRANSLATE_URL;
  });

  it('le travail en cours se termine, la suite de la file de fond saute ; un clic explicite passe toujours', async () => {
    for (const id of [1, 2, 3]) insertMatch(id);
    enqueueCommentary(1); // fond
    enqueueCommentary(2); // fond
    expect(commentaryRunningMatchId()).toBe(1);
    expect(commentaryQueuePosition(2)).toBe(1);

    setAutoTranslate(false);
    finish.get(1)!();
    await __commentaryIdle();
    expect(commentaryRunningMatchId()).toBeNull();
    expect(commentaryQueuePosition(2)).toBeNull(); // abandonné sans avoir démarré
    expect(finish.has(2)).toBe(false);

    enqueueCommentary(3, { priority: true }); // « Traduire ce match »
    expect(commentaryRunningMatchId()).toBe(3);
    finish.get(3)!();
    await __commentaryIdle();
    expect(getCommentaryRecord(3)?.ok).toBe(true);
    expect(getCommentaryRecord(2)).toBeUndefined();
  });
});
