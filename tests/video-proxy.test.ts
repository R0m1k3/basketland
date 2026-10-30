import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, setDbForTests } from '../src/lib/db';
import { clearOkStreamCache } from '../src/lib/okru';
import { nextSegmentName, segmentNames } from '../src/lib/hls';
import {
  averageSegmentSec,
  ByteLru,
  clearProxyCaches,
  DEFAULT_SEGMENT_CACHE_MB,
  downloadSettings,
  prefetchIdle,
  prefetchSettings,
  prefetchWindow,
  PREFETCH_MAX_SEGMENTS,
  proxiedMaster,
  proxiedMedia,
  proxiedMp4,
  proxiedSegment,
  ProxyError,
  segmentCacheStats,
} from '../src/lib/videoProxy';
import { embedHtml, mediaPlaylist, OK_ID, signedMaster, signedMp4 } from './helpers/okFake';

/**
 * Proxy vidéo : cache des segments (segments à venir protégés) +
 * préchargement profond qui suit la qualité lue, reprise des
 * téléchargements bloqués, cache des playlists média, relais MP4 avec
 * Range. ok.ru est simulé (fetch mocké) : depuis l'environnement de test,
 * les flux réels répondent 403.
 */

describe('nextSegmentName', () => {
  it('incrémente l\'index en conservant la largeur', () => {
    expect(nextSegmentName('MEDIUM00041.ts')).toBe('MEDIUM00042.ts');
    expect(nextSegmentName('MEDIUM00041.ts', 4)).toBe('MEDIUM00045.ts');
    expect(nextSegmentName('MEDIUM00099.ts')).toBe('MEDIUM00100.ts');
    expect(nextSegmentName('MEDIUM99999.ts')).toBe('MEDIUM100000.ts');
    expect(nextSegmentName('seg_1a7.ts')).toBe('seg_1a8.ts');
  });

  it('null sans index numérique final', () => {
    expect(nextSegmentName('MEDIUM.ts')).toBeNull();
    expect(nextSegmentName('MEDIUM00001.mp4')).toBeNull();
  });

  it('suit exactement la playlist média réelle d\'ok.ru (fixture)', () => {
    const names = segmentNames(fs.readFileSync(path.join(__dirname, 'fixtures/ok-media.m3u8'), 'utf8'));
    expect(names[0]).toBe('MEDIUM00000.ts');
    expect(names.length).toBeGreaterThan(3);
    for (let i = 0; i + 1 < names.length; i++) expect(nextSegmentName(names[i])).toBe(names[i + 1]);
  });
});

describe('ByteLru', () => {
  it('évince par octets, la moins récemment lue d\'abord', () => {
    const lru = new ByteLru<string>(100);
    lru.set('a', 'A', 40);
    lru.set('b', 'B', 40);
    expect(lru.get('a')).toBe('A'); // a devient la plus récente
    lru.set('c', 'C', 40); // 120 > 100 : b est évincée
    expect(lru.has('b')).toBe(false);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('c')).toBe(true);
    expect(lru.bytes).toBe(80);
  });

  it('évince plusieurs entrées si nécessaire, refuse une entrée plus grosse que le budget', () => {
    const lru = new ByteLru<string>(100);
    lru.set('a', 'A', 30);
    lru.set('b', 'B', 30);
    lru.set('c', 'C', 30);
    lru.set('d', 'D', 90);
    expect(lru.size).toBe(1);
    expect(lru.bytes).toBe(90);
    expect(lru.set('huge', 'H', 101)).toBe(false);
    expect(lru.has('huge')).toBe(false);
    expect(lru.bytes).toBe(90);
  });

  it('remplacer une clé met à jour le total ; has() ne change pas l\'ordre', () => {
    const lru = new ByteLru<string>(100);
    lru.set('a', 'A', 50);
    lru.set('b', 'B', 10);
    lru.set('a', 'A2', 20);
    expect(lru.bytes).toBe(30);
    lru.has('b');
    lru.set('c', 'C', 75); // évince b (le plus ancien : a a été réinséré après)
    expect(lru.has('b')).toBe(false);
    expect(lru.get('a')).toBe('A2');
  });

  it('avec un rang : le rang le plus bas part le premier, la moins récemment lue à rang égal', () => {
    // a : à venir proche (gardé), c : à venir lointain, b/d/e : déjà lus.
    const rank: Record<string, number> = { a: 2.9, c: 2.1, b: 0, d: 0, e: 0 };
    const lru = new ByteLru<string>(100, (k) => rank[k] ?? 0);
    lru.set('a', 'A', 30);
    lru.set('b', 'B', 30);
    lru.set('c', 'C', 30);
    expect(lru.get('b')).toBe('B'); // lu récemment… mais déjà lu : rang 0
    expect(lru.set('d', 'D', 30)).toBe(true); // 120 > 100 : b part, pas a (le plus ancien)
    expect([lru.has('a'), lru.has('b'), lru.has('c'), lru.has('d')]).toEqual([true, false, true, true]);
    lru.set('e', 'E', 30); // d et e au rang 0 : d (le plus ancien) part
    expect(lru.has('d')).toBe(false);
    rank.e = 3; // e devient le prochain segment à lire
    lru.set('f', 'F', 30); // f au rang 0 : le seul candidat, il n'est pas gardé
    expect(lru.has('f')).toBe(false);
    rank.f = 2.5;
    lru.set('f', 'F', 30); // plus aucun rang 0 : le plus bas (c, lointain) part
    expect([lru.has('a'), lru.has('c'), lru.has('e'), lru.has('f')]).toEqual([true, false, true, true]);
  });
});

describe('réglages du préchargement', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('par défaut : ~90 s d\'avance (15 segments ok.ru de 6 s), 3 en parallèle, cache 512 Mo', () => {
    expect(prefetchSettings()).toEqual({ aheadSec: 90, concurrency: 3 });
    expect(prefetchWindow(6)).toBe(15);
    expect(prefetchWindow(6.006)).toBe(15);
    expect(prefetchWindow(2)).toBe(PREFETCH_MAX_SEGMENTS); // plafonné
    expect(DEFAULT_SEGMENT_CACHE_MB).toBe(512);
    expect(downloadSettings()).toEqual({ stallMs: 5000, headersMs: 8000, retries: 4 });
  });

  it('réglables par l\'environnement ; valeurs invalides ignorées', () => {
    vi.stubEnv('PREFETCH_AHEAD_SEC', '60');
    vi.stubEnv('PREFETCH_CONCURRENCY', '2');
    vi.stubEnv('SEGMENT_STALL_MS', 'abc');
    expect(prefetchWindow(6)).toBe(10);
    expect(prefetchSettings().concurrency).toBe(2);
    expect(downloadSettings().stallMs).toBe(5000);
    vi.stubEnv('PREFETCH_AHEAD_SEC', '0');
    expect(prefetchWindow(6)).toBe(0);
  });

  it('durée moyenne des segments lue dans la playlist (fixture ok.ru réelle)', () => {
    const text = fs.readFileSync(path.join(__dirname, 'fixtures/ok-media.m3u8'), 'utf8');
    expect(averageSegmentSec(text)).toBeCloseTo(6.01, 1);
    expect(averageSegmentSec('#EXTM3U\n#EXT-X-TARGETDURATION:4\nA00001.ts\n')).toBe(4);
    expect(averageSegmentSec('#EXTM3U\n')).toBe(6);
  });
});

// ------------------------------------------------------------------ faux ok.ru

// 40 segments (≤ 99 : les noms ci-dessous s'écrivent `MEDIUM000${n}`), pour
// laisser la place à une fenêtre de préchargement de 15 segments.
const SEG_COUNT = 40;
const SEG_SIZE = 1000;
const MP4_SIZE = 5000;

let exp: number;
let embed: () => string;
let calls: { url: string; range?: string }[];
let active: number;
let maxActive: number;
let segmentStatus: (name: string, n: number) => number;
let playlistStatus: number;
/** Playlist média servie (défaut : SEG_COUNT segments de 6 s). */
let playlistBody: string | null;
let mp4Responder: ((url: string, range?: string) => Response) | null;
/** Réponse sur mesure pour un segment (n = rang de l'appel pour cette URL) ; null : réponse normale. */
let segmentResponder:
  | ((name: string, n: number, range: string | undefined, init: RequestInit | undefined) => Response | Promise<Response> | null)
  | null;

function segBytes(i: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(SEG_SIZE).fill(i % 256);
}

/** Octets tous différents d'une position à l'autre : un décalage de reprise se verrait. */
function patterned(seed: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: SEG_SIZE }, (_, i) => (i * 7 + seed) % 256);
}

const seg = (n: number) => `MEDIUM${String(n).padStart(5, '0')}.ts`;
const TS = { 'content-type': 'video/MP2T' };

/** Corps qui livre `bytes` puis ne donne plus rien, sans se fermer (connexion bloquée). */
function stallingBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (c) => c.enqueue(bytes) });
}

/** Corps qui livre `bytes` au compte-gouttes (connexion dégradée, mais pas bloquée). */
function tricklingBody(bytes: Uint8Array, chunk = 50, everyMs = 50): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream({
    pull: async (c) => {
      await new Promise((r) => setTimeout(r, everyMs));
      if (off >= bytes.length) return c.close();
      c.enqueue(bytes.slice(off, off + chunk));
      off += chunk;
    },
  });
}

/** Corps qui livre `bytes` puis se ferme (coupure avant la fin annoncée). */
function truncatedBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start: (c) => {
      c.enqueue(bytes);
      c.close();
    },
  });
}

function hdr(init: RequestInit | undefined, name: string): string | undefined {
  const h = (init?.headers ?? {}) as Record<string, string>;
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : undefined;
}

function mp4Response(range?: string): Response {
  const m = range?.match(/^bytes=(\d+)-(\d*)$/);
  if (!m) {
    return new Response(new Uint8Array(MP4_SIZE), {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(MP4_SIZE), 'accept-ranges': 'bytes' },
    });
  }
  const start = Number(m[1]);
  if (start >= MP4_SIZE) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${MP4_SIZE}` } });
  const end = m[2] ? Math.min(Number(m[2]), MP4_SIZE - 1) : MP4_SIZE - 1;
  return new Response(new Uint8Array(end - start + 1), {
    status: 206,
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${MP4_SIZE}`,
    },
  });
}

async function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  const range = hdr(init, 'range');
  calls.push({ url, range });
  if (url.includes('ok.ru/videoembed/')) return new Response(embed());
  if (url.includes('video.m3u8')) {
    return new Response(
      `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,QUALITY=sd,RESOLUTION=852x480\nhttps://vd123.okcdn.ru/expires/${exp}/type/2/sig/S/video/\n` +
        `#EXT-X-STREAM-INF:BANDWIDTH=4600000,QUALITY=hd,RESOLUTION=1280x720\nhttps://vd123.okcdn.ru/expires/${exp}/type/3/sig/S/video/\n`,
    );
  }
  if (/\/video\/$/.test(url)) {
    if (playlistStatus !== 200) return new Response('x', { status: playlistStatus });
    return new Response(playlistBody ?? mediaPlaylist(SEG_COUNT), { headers: { 'content-type': 'application/x-mpegURL' } });
  }
  const seg = url.match(/\/video\/(MEDIUM(\d+)\.ts)$/);
  if (seg) {
    const i = Number(seg[2]);
    const n = calls.filter((c) => c.url === url).length;
    const custom = segmentResponder?.(seg[1], n, range, init);
    if (custom) return custom;
    const status = segmentStatus(seg[1], n);
    if (status !== 200) return new Response('x', { status });
    // Au-delà du dernier segment, ok.ru renvoie la playlist (200).
    if (i >= SEG_COUNT) return new Response(mediaPlaylist(SEG_COUNT), { headers: { 'content-type': 'application/x-mpegURL' } });
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    if (range) {
      return new Response(segBytes(i).slice(0, 10), {
        status: 206,
        headers: { 'content-type': 'video/MP2T', 'content-length': '10', 'content-range': `bytes 0-9/${SEG_SIZE}` },
      });
    }
    return new Response(segBytes(i), { headers: { 'content-type': 'video/MP2T', 'content-length': String(SEG_SIZE) } });
  }
  if (mp4Responder && /okcdn\.ru\/\?expires=/.test(url)) return mp4Responder(url, range);
  return new Response('not found', { status: 404 });
}

const segCalls = (name: string) => calls.filter((c) => c.url.endsWith(`/${name}`)).length;
/** Index des segments demandés à ok.ru pour une variante (type/2 = sd, type/3 = hd), dans l'ordre des appels. */
const segOrder = (type: number) =>
  calls.flatMap((c) => {
    const m = c.url.match(new RegExp(`/type/${type}/.*/MEDIUM(\\d+)\\.ts$`));
    return m ? [Number(m[1])] : [];
  });
const embedCalls = () => calls.filter((c) => c.url.includes('ok.ru/videoembed/')).length;

beforeAll(() => {
  const db = openDatabase(':memory:');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO matches (espn_id, season, season_type, date_utc, home_abbr, home_name, away_abbr, away_name, status,
       video_ok_id, video_available, video_kind, created_at, updated_at)
     VALUES ('401', 2026, 'regular', '2026-10-29T02:30:00Z', 'LAC', 'LA Clippers', 'LAL', 'Los Angeles Lakers', 'final',
       $ok, 1, 'mp4', $now, $now)`,
  ).run({ ok: OK_ID, now });
  setDbForTests(db);
});

afterAll(() => setDbForTests(undefined));

beforeEach(() => {
  clearOkStreamCache();
  clearProxyCaches();
  exp = Date.now() + 24 * 3600_000;
  calls = [];
  active = 0;
  maxActive = 0;
  segmentStatus = () => 200;
  playlistStatus = 200;
  playlistBody = null;
  mp4Responder = null;
  segmentResponder = null;
  embed = () => embedHtml({ hls: signedMaster(exp), videos: [{ name: 'sd', url: signedMp4('sd', exp) }] });
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(async () => {
  await prefetchIdle();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function body(r: Response): Promise<Uint8Array> {
  return new Uint8Array(await r.arrayBuffer());
}

describe('segments : cache + préchargement', () => {
  it('sert le segment puis précharge ~90 s (15 segments de 6 s) ; le suivant vient du cache', async () => {
    const r = await proxiedSegment(OK_ID, 'sd', 'MEDIUM00003.ts', null);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('video/mp2t');
    expect(r.headers.get('content-length')).toBe(String(SEG_SIZE));
    expect(await body(r)).toEqual(segBytes(3));
    await prefetchIdle();
    const w = prefetchWindow(6);
    expect(w).toBe(15);
    // La playlist (lue au passage) donne la durée des segments et borne la fenêtre.
    for (let n = 4; n <= 3 + w; n++) expect(segCalls(seg(n))).toBe(1);
    expect(segCalls(seg(4 + w))).toBe(0);
    // Concurrence bornée : la requête du lecteur + PREFETCH_CONCURRENCY préchargements.
    expect(maxActive).toBeLessThanOrEqual(1 + prefetchSettings().concurrency);

    const r2 = await proxiedSegment(OK_ID, 'sd', 'MEDIUM00004.ts', null);
    expect(await body(r2)).toEqual(segBytes(4));
    expect(segCalls('MEDIUM00004.ts')).toBe(1); // aucun nouvel appel amont
    // La fenêtre avance d'un segment avec le lecteur.
    await prefetchIdle();
    expect(segCalls(seg(4 + w))).toBe(1);
    expect(segCalls(seg(5 + w))).toBe(0);
  });

  it('précharge du plus proche au plus lointain, sans jamais redemander un segment', async () => {
    await proxiedMedia(OK_ID, 'sd');
    await proxiedSegment(OK_ID, 'sd', seg(10), null).then(body);
    await prefetchIdle();
    const order = segOrder(2);
    expect(order[0]).toBe(10); // la demande du lecteur part la première
    expect(order.slice(1)).toEqual(Array.from({ length: prefetchWindow(6) }, (_, i) => 11 + i));
  });

  it('après un saut, la nouvelle position passe devant les restes de l\'ancienne', async () => {
    await proxiedMedia(OK_ID, 'sd');
    await proxiedSegment(OK_ID, 'sd', seg(2), null).then(body); // 3, 4, 5 en vol
    const before = calls.length;
    await proxiedSegment(OK_ID, 'sd', seg(25), null).then(body); // saut
    await prefetchIdle();
    const after = calls
      .slice(before)
      .flatMap((c) => (/\/type\/2\/.*MEDIUM\d+\.ts$/.test(c.url) ? [Number(c.url.match(/MEDIUM(\d+)/)![1])] : []))
      .filter((n) => n !== 25);
    // Les trois premiers préchargements lancés après le saut sont 26, 27, 28.
    expect(after.slice(0, 3)).toEqual([26, 27, 28]);
    for (let n = 26; n < SEG_COUNT; n++) expect(segCalls(seg(n))).toBe(1);
  });

  it('changement de qualité : le préchargement suit la nouvelle variante, l\'ancienne est abandonnée', async () => {
    await proxiedMedia(OK_ID, 'hd');
    await proxiedMedia(OK_ID, 'sd');
    const rHd = await proxiedSegment(OK_ID, 'hd', seg(3), null); // hd 4, 5, 6 partent
    const rSd = await proxiedSegment(OK_ID, 'sd', seg(4), null); // l'ABR descend en sd
    expect(await body(rHd)).toEqual(segBytes(3));
    expect(await body(rSd)).toEqual(segBytes(4));
    await prefetchIdle();
    const hd = segOrder(3);
    // hd : le segment demandé + au plus les préchargements déjà en vol.
    expect(hd.length).toBeLessThanOrEqual(1 + prefetchSettings().concurrency);
    // sd : toute la fenêtre derrière la nouvelle position.
    for (let n = 5; n <= 4 + prefetchWindow(6); n++) expect(segOrder(2)).toContain(n);
  });

  it('cache plein : les segments déjà lus partent avant ceux à venir (aucun double téléchargement)', async () => {
    // 12 segments de cache, dont 60 % (7) pour l'avance : le lecteur lit 0 → 24 à la suite.
    vi.stubEnv('SEGMENT_CACHE_MB', String((12 * SEG_SIZE) / (1024 * 1024)));
    clearProxyCaches();
    expect(segmentCacheStats().maxBytes).toBe(12 * SEG_SIZE);
    await proxiedMedia(OK_ID, 'sd');
    for (let i = 0; i < 25; i++) {
      const prefetched = segCalls(seg(i)) === 1;
      expect(await body(await proxiedSegment(OK_ID, 'sd', seg(i), null))).toEqual(segBytes(i));
      // Servi depuis le cache : préchargé, et toujours là au moment d'être lu.
      if (i >= 1) expect(prefetched).toBe(true);
      expect(segCalls(seg(i))).toBe(1);
      await prefetchIdle();
      expect(segmentCacheStats().bytes).toBeLessThanOrEqual(12 * SEG_SIZE);
    }
    // L'avance est bornée par le budget du cache (7 segments), pas par la fenêtre (15).
    expect(segCalls(seg(24 + 7))).toBe(1);
    expect(segCalls(seg(24 + 8))).toBe(0);
  });

  it('dédoublonne les téléchargements en vol (deux lecteurs, un seul appel amont)', async () => {
    const [a, b] = await Promise.all([
      proxiedSegment(OK_ID, 'sd', 'MEDIUM00000.ts', null),
      proxiedSegment(OK_ID, 'sd', 'MEDIUM00000.ts', null),
    ]);
    expect(await body(a)).toEqual(segBytes(0));
    expect(await body(b)).toEqual(segBytes(0));
    expect(segCalls('MEDIUM00000.ts')).toBe(1);
  });

  it('une requête arrivée pendant le préchargement le rejoint', async () => {
    await proxiedSegment(OK_ID, 'sd', 'MEDIUM00000.ts', null).then(body);
    // MEDIUM00001 est en cours de préchargement à cet instant.
    const r = await proxiedSegment(OK_ID, 'sd', 'MEDIUM00001.ts', null);
    expect(await body(r)).toEqual(segBytes(1));
    expect(segCalls('MEDIUM00001.ts')).toBe(1);
  });

  it('le préchargement s\'arrête au dernier segment de la playlist', async () => {
    await proxiedMedia(OK_ID, 'sd');
    await proxiedSegment(OK_ID, 'sd', `MEDIUM000${SEG_COUNT - 2}.ts`, null).then(body);
    await prefetchIdle();
    expect(segCalls(`MEDIUM000${SEG_COUNT - 1}.ts`)).toBe(1);
    expect(segCalls(`MEDIUM000${SEG_COUNT}.ts`)).toBe(0);
  });

  it('sans playlist connue, une réponse « playlist » au-delà de la fin n\'est pas mise en cache comme segment', async () => {
    await proxiedSegment(OK_ID, 'sd', `MEDIUM000${SEG_COUNT - 1}.ts`, null).then(body);
    await prefetchIdle();
    await expect(proxiedSegment(OK_ID, 'sd', `MEDIUM000${SEG_COUNT}.ts`, null)).rejects.toMatchObject({ status: 404 });
  });

  it('Range : relais direct (206), sans cache', async () => {
    const r = await proxiedSegment(OK_ID, 'sd', 'MEDIUM00002.ts', 'bytes=0-9');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 0-9/${SEG_SIZE}`);
    expect(calls.find((c) => c.url.endsWith('MEDIUM00002.ts'))?.range).toBe('bytes=0-9');
  });

  it('403 (signature expirée) : une re-résolution puis succès', async () => {
    await proxiedMedia(OK_ID, 'sd');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    segmentStatus = (name, n) => (name === 'MEDIUM00005.ts' && n === 1 ? 403 : 200);
    const before = embedCalls();
    const r = await proxiedSegment(OK_ID, 'sd', 'MEDIUM00005.ts', null);
    expect(await body(r)).toEqual(segBytes(5));
    expect(embedCalls()).toBe(before + 1);
  });

  it('flux en cache sans HLS (playlist illisible au dernier passage) : re-résolution au lieu d\'un 404', async () => {
    embed = () => embedHtml({ videos: [{ name: 'sd', url: signedMp4('sd', exp) }] });
    await expect(proxiedMaster(OK_ID)).rejects.toMatchObject({ status: 404 });
    embed = () => embedHtml({ hls: signedMaster(exp), videos: [{ name: 'sd', url: signedMp4('sd', exp) }] });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 15_000);
    const r = await proxiedSegment(OK_ID, 'sd', 'MEDIUM00001.ts', null);
    expect(await body(r)).toEqual(segBytes(1));
  });

  it('refuse un nom de segment qui n\'est pas un simple fichier .ts', async () => {
    await expect(proxiedSegment(OK_ID, 'sd', '../x.ts', null)).rejects.toMatchObject({ status: 400 });
    await expect(proxiedSegment(OK_ID, 'sd', 'https://evil/x.ts', null)).rejects.toMatchObject({ status: 400 });
  });

  it('refuse une clé de variante qui n\'a pas la forme d\'un QUALITY ok.ru', async () => {
    await expect(proxiedSegment(OK_ID, 'sd|x', seg(1), null)).rejects.toMatchObject({ status: 404 });
    expect(calls.length).toBe(0);
  });

  it('playlist illisible : la fin du flux est apprise du premier segment introuvable', async () => {
    playlistStatus = 500;
    await proxiedSegment(OK_ID, 'sd', seg(SEG_COUNT - 3), null).then(body);
    await prefetchIdle();
    // Sans playlist, le préchargement avance à l'aveugle puis s'arrête à la fin :
    // au plus un appel par place de préchargement au-delà, jamais répété.
    const beyond = segOrder(2).filter((n) => n >= SEG_COUNT);
    expect(beyond.length).toBeLessThanOrEqual(prefetchSettings().concurrency);
    expect(new Set(beyond).size).toBe(beyond.length);
    for (let n = SEG_COUNT - 2; n < SEG_COUNT; n++) expect(segCalls(seg(n))).toBe(1);
  });
});

describe('segments : téléchargement amont surveillé (blocage, coupure, lenteur)', () => {
  const FULL = patterned(42);

  beforeEach(() => {
    // Seuils courts pour le test (5 s en production).
    vi.stubEnv('SEGMENT_STALL_MS', '200');
  });

  const seg2Ranges = () => calls.filter((c) => c.url.endsWith(`/${seg(2)}`)).map((c) => c.range);

  it('flux bloqué en plein segment : coupé, puis repris à l\'octet atteint (Range 206), sans trou ni doublon', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    segmentResponder = (name, n) => {
      if (name !== seg(2)) return null;
      if (n === 1) return new Response(stallingBody(FULL.slice(0, 400)), { headers: { ...TS, 'content-length': String(SEG_SIZE) } });
      return new Response(FULL.slice(400), {
        status: 206,
        headers: { ...TS, 'content-length': '600', 'content-range': `bytes 400-999/${SEG_SIZE}` },
      });
    };
    const r = await proxiedSegment(OK_ID, 'sd', seg(2), null);
    expect(r.headers.get('content-length')).toBe(String(SEG_SIZE));
    expect(await body(r)).toEqual(FULL);
    expect(seg2Ranges()).toEqual([undefined, 'bytes=400-']);
    expect(log.mock.calls.some(([m]) => /\[vidéo\] flux ok\.ru aucun octet .* reprise n° 1 à 0\/1 Ko/.test(String(m)))).toBe(true);
    // Rangé complet au cache : la demande suivante ne repasse pas par ok.ru.
    expect(await body(await proxiedSegment(OK_ID, 'sd', seg(2), null))).toEqual(FULL);
    expect(seg2Ranges().length).toBe(2);
  });

  it('amont qui ignore Range à la reprise (200 complet) : les octets déjà reçus sont sautés', async () => {
    segmentResponder = (name, n) => {
      if (name !== seg(2)) return null;
      if (n === 1) return new Response(stallingBody(FULL.slice(0, 300)), { headers: { ...TS, 'content-length': String(SEG_SIZE) } });
      return new Response(FULL, { headers: { ...TS, 'content-length': String(SEG_SIZE) } });
    };
    expect(await body(await proxiedSegment(OK_ID, 'sd', seg(2), null))).toEqual(FULL);
    expect(seg2Ranges()).toEqual([undefined, 'bytes=300-']);
  });

  it('connexion coupée avant la fin annoncée : reprise au lieu d\'un segment tronqué', async () => {
    segmentResponder = (name, n, range) => {
      if (name !== seg(2)) return null;
      if (n === 1) return new Response(truncatedBody(FULL.slice(0, 700)), { headers: { ...TS, 'content-length': String(SEG_SIZE) } });
      expect(range).toBe('bytes=700-');
      return new Response(FULL.slice(700), { status: 206, headers: { ...TS, 'content-range': `bytes 700-999/${SEG_SIZE}` } });
    };
    expect(await body(await proxiedSegment(OK_ID, 'sd', seg(2), null))).toEqual(FULL);
    expect(seg2Ranges().length).toBe(2);
  });

  it('connexion dégradée (débit bien trop faible pour la durée du segment) : une seule reprise sur connexion neuve', async () => {
    // Segments de 0,2 s : au-delà de 2,5 × 0,2 s prévus, la connexion est jugée trop lente.
    playlistBody = ['#EXTM3U', '#EXT-X-TARGETDURATION:1', ...Array.from({ length: SEG_COUNT }, (_, i) => `#EXTINF:0.2,\n${seg(i)}`), '#EXT-X-ENDLIST', ''].join('\n');
    await proxiedMedia(OK_ID, 'sd');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Les deux connexions traînent (~1 Ko/s) : la seconde n'est pas relancée à son tour.
    segmentResponder = (name, n, range) => {
      if (name !== seg(2)) return null;
      if (n === 1) return new Response(tricklingBody(FULL), { headers: { ...TS, 'content-length': String(SEG_SIZE) } });
      const from = Number(range?.match(/^bytes=(\d+)-$/)?.[1]);
      return new Response(tricklingBody(FULL.slice(from)), {
        status: 206,
        headers: { ...TS, 'content-range': `bytes ${from}-999/${SEG_SIZE}` },
      });
    };
    expect(await body(await proxiedSegment(OK_ID, 'sd', seg(2), null))).toEqual(FULL);
    const ranges = seg2Ranges();
    expect(ranges.length).toBe(2);
    expect(ranges[1]).toMatch(/^bytes=\d+-$/);
    expect(log.mock.calls.some(([m]) => /\[vidéo\] flux ok\.ru trop lent \(\d+ kb\/s\) : reprise n° 1/.test(String(m)))).toBe(true);
  });

  it('en-têtes qui n\'arrivent jamais : nouvelle requête après le délai', async () => {
    segmentResponder = (name, n, _range, init) => {
      if (name !== seg(2)) return null;
      if (n === 1) {
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      }
      return new Response(FULL, { headers: { ...TS, 'content-length': String(SEG_SIZE) } });
    };
    const t0 = performance.now();
    expect(await body(await proxiedSegment(OK_ID, 'sd', seg(2), null))).toEqual(FULL);
    expect(seg2Ranges()).toEqual([undefined, undefined]);
    // ~1,6 × SEGMENT_STALL_MS (320 ms) + pause de 300 ms, bien loin des 60 s d'avant.
    expect(performance.now() - t0).toBeLessThan(3_000);
  });

  it('signature expirée au moment de la reprise : re-résolution, puis la suite arrive', async () => {
    await proxiedMedia(OK_ID, 'sd');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    segmentResponder = (name, n) => {
      if (name !== seg(2)) return null;
      if (n === 1) return new Response(stallingBody(FULL.slice(0, 500)), { headers: { ...TS, 'content-length': String(SEG_SIZE) } });
      if (n === 2) return new Response('expired', { status: 403 });
      return new Response(FULL.slice(500), { status: 206, headers: { ...TS, 'content-range': `bytes 500-999/${SEG_SIZE}` } });
    };
    const before = embedCalls();
    expect(await body(await proxiedSegment(OK_ID, 'sd', seg(2), null))).toEqual(FULL);
    expect(embedCalls()).toBe(before + 1);
    expect(seg2Ranges()).toEqual([undefined, 'bytes=500-', 'bytes=500-']);
  });

  it('blocages répétés : abandon après SEGMENT_RETRIES reprises, puis une nouvelle demande repart de zéro', async () => {
    vi.stubEnv('SEGMENT_RETRIES', '1');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let healthy = false;
    segmentResponder = (name) => {
      if (name !== seg(2)) return null;
      if (healthy) return new Response(FULL, { headers: { ...TS, 'content-length': String(SEG_SIZE) } });
      return new Response(stallingBody(FULL.slice(0, 100)), { headers: { ...TS, 'content-length': String(SEG_SIZE) } });
    };
    const r = await proxiedSegment(OK_ID, 'sd', seg(2), null);
    await expect(body(r)).rejects.toThrow();
    expect(seg2Ranges()).toEqual([undefined, 'bytes=100-']);
    await prefetchIdle();
    healthy = true;
    expect(await body(await proxiedSegment(OK_ID, 'sd', seg(2), null))).toEqual(FULL);
    expect(seg2Ranges()).toEqual([undefined, 'bytes=100-', undefined]);
  });
});

describe('connexions persistantes vers ok.ru', () => {
  const SYM = Symbol.for('undici.globalDispatcher.1');
  const g = globalThis as unknown as Record<symbol, unknown> & { __okAgent?: unknown };
  let saved: unknown;
  beforeEach(() => {
    saved = g[SYM];
    g.__okAgent = undefined;
  });
  afterEach(() => {
    g[SYM] = saved;
    g.__okAgent = undefined;
  });

  const initFor = (name: string) =>
    (fetch as unknown as Mock).mock.calls.find(([u]) => String(u).endsWith(`/${name}`))?.[1] as
      | (RequestInit & { dispatcher?: { opts?: Record<string, unknown> } })
      | undefined;

  it('agent dédié (keep-alive 30 s) dérivé de l\'agent global d\'undici, passé aux requêtes de segments', async () => {
    class Agent {
      constructor(public opts: Record<string, unknown>) {}
    }
    g[SYM] = new Agent({});
    await proxiedSegment(OK_ID, 'sd', seg(1), null).then(body);
    const d = initFor(seg(1))?.dispatcher;
    expect(d).toBeInstanceOf(Agent);
    expect(d?.opts).toMatchObject({ keepAliveTimeout: 30_000 });
  });

  it('agent global absent, ou autre qu\'un Agent simple (proxy) : comportement par défaut', async () => {
    class EnvHttpProxyAgent {}
    g[SYM] = new EnvHttpProxyAgent();
    await proxiedSegment(OK_ID, 'sd', seg(1), null).then(body);
    expect(initFor(seg(1))?.dispatcher).toBeUndefined();
  });
});

describe('playlists média : cache', () => {
  it('une seule lecture amont pour des requêtes répétées ou simultanées', async () => {
    const [a, b] = await Promise.all([proxiedMedia(OK_ID, 'sd'), proxiedMedia(OK_ID, 'sd')]);
    const c = await proxiedMedia(OK_ID, 'sd');
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(a).toContain(`/api/video/${OK_ID}/segment.ts?v=sd&s=MEDIUM00000.ts`);
    expect(calls.filter((x) => /\/video\/$/.test(x.url)).length).toBe(1);
  });
});

describe('master : flux MP4 seul', () => {
  it('404 explicite quand ok.ru n\'a pas de HLS', async () => {
    embed = () => embedHtml({ videos: [{ name: 'mobile', url: signedMp4('mobile', exp) }] });
    await expect(proxiedMaster(OK_ID)).rejects.toMatchObject({ status: 404 });
  });
});

describe('MP4 progressif : relais Range', () => {
  beforeEach(() => {
    embed = () =>
      embedHtml({
        videos: [
          { name: 'mobile', url: signedMp4('mobile', exp) },
          { name: 'sd', url: signedMp4('sd', exp) },
          { name: 'hd', url: signedMp4('hd', exp), disallowed: true },
        ],
      });
    mp4Responder = (_url, range) => mp4Response(range);
  });

  it('Range → 206 avec Content-Range, Content-Length, Accept-Ranges ; meilleure qualité permise', async () => {
    const r = await proxiedMp4(OK_ID, 'bytes=100-199');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 100-199/${MP4_SIZE}`);
    expect(r.headers.get('content-length')).toBe('100');
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect((await body(r)).length).toBe(100);
    const up = calls.find((c) => c.url.includes('?expires='));
    expect(up?.url).toBe(signedMp4('sd', exp)); // hd disallowed, sd > mobile
    expect(up?.range).toBe('bytes=100-199');
  });

  it('sans Range → 200 complet', async () => {
    const r = await proxiedMp4(OK_ID, null);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe(String(MP4_SIZE));
    expect(calls.find((c) => c.url.includes('?expires='))?.range).toBeUndefined();
  });

  it('416 relayé', async () => {
    const r = await proxiedMp4(OK_ID, `bytes=${MP4_SIZE}-`);
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe(`bytes */${MP4_SIZE}`);
  });

  it('Range malformé : ignoré (pas transmis tel quel)', async () => {
    const r = await proxiedMp4(OK_ID, 'items=0-1');
    expect(r.status).toBe(200);
    expect(calls.find((c) => c.url.includes('?expires='))?.range).toBeUndefined();
  });

  it('403 → re-résolution de l\'embed puis succès', async () => {
    await proxiedMp4(OK_ID, 'bytes=0-9').then(body);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    let n = 0;
    mp4Responder = (_url, range) => (++n === 1 ? new Response('expired', { status: 403 }) : mp4Response(range));
    const before = embedCalls();
    const r = await proxiedMp4(OK_ID, 'bytes=0-9');
    expect(r.status).toBe(206);
    expect(embedCalls()).toBe(before + 1);
  });

  it('redirection vers un hôte non autorisé : refusée sans être suivie', async () => {
    mp4Responder = (url) =>
      url.includes('evil') ? mp4Response() : new Response(null, { status: 302, headers: { location: 'https://evil.example/x.mp4' } });
    await expect(proxiedMp4(OK_ID, 'bytes=0-9')).rejects.toMatchObject({ status: 502 });
    expect(calls.some((c) => c.url.includes('evil.example'))).toBe(false);
  });

  it('redirection vers un hôte ok.ru : suivie, Range conservé', async () => {
    mp4Responder = (url, range) =>
      url.includes('vd999')
        ? mp4Response(range)
        : new Response(null, { status: 302, headers: { location: signedMp4('sd', exp, 'vd999.okcdn.ru') } });
    const r = await proxiedMp4(OK_ID, 'bytes=0-9');
    expect(r.status).toBe(206);
    expect(calls.find((c) => c.url.includes('vd999'))?.range).toBe('bytes=0-9');
  });

  it('la qualité reste épinglée pendant la lecture même si une meilleure apparaît', async () => {
    await proxiedMp4(OK_ID, 'bytes=0-9').then(body);
    embed = () =>
      embedHtml({ videos: [{ name: 'sd', url: signedMp4('sd', exp) }, { name: 'full', url: signedMp4('full', exp) }] });
    clearOkStreamCache();
    calls = [];
    await proxiedMp4(OK_ID, 'bytes=10-19').then(body);
    expect(calls.find((c) => c.url.includes('?expires='))?.url).toBe(signedMp4('sd', exp));
  });

  it('okId inconnu en base : 404 sans appel amont', async () => {
    await expect(proxiedMp4('12345678901', 'bytes=0-1')).rejects.toBeInstanceOf(ProxyError);
    expect(calls.length).toBe(0);
  });
});
