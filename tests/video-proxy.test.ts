import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, setDbForTests } from '../src/lib/db';
import { clearOkStreamCache } from '../src/lib/okru';
import { nextSegmentName, segmentNames } from '../src/lib/hls';
import {
  ByteLru,
  clearProxyCaches,
  prefetchIdle,
  PREFETCH_AHEAD,
  PREFETCH_CONCURRENCY,
  proxiedMaster,
  proxiedMedia,
  proxiedMp4,
  proxiedSegment,
  ProxyError,
} from '../src/lib/videoProxy';
import { embedHtml, mediaPlaylist, OK_ID, signedMaster, signedMp4 } from './helpers/okFake';

/**
 * Proxy vidéo : cache LRU des segments + préchargement, cache des
 * playlists média, relais MP4 avec Range. ok.ru est simulé (fetch mocké) :
 * depuis l'environnement de test, les flux réels répondent 403.
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
});

// ------------------------------------------------------------------ faux ok.ru

const SEG_COUNT = 12;
const SEG_SIZE = 1000;
const MP4_SIZE = 5000;

let exp: number;
let embed: () => string;
let calls: { url: string; range?: string }[];
let active: number;
let maxActive: number;
let segmentStatus: (name: string, n: number) => number;
let mp4Responder: ((url: string, range?: string) => Response) | null;

function segBytes(i: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(SEG_SIZE).fill(i % 256);
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
      `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,QUALITY=sd,RESOLUTION=852x480\nhttps://vd123.okcdn.ru/expires/${exp}/type/2/sig/S/video/\n`,
    );
  }
  if (/\/video\/$/.test(url)) return new Response(mediaPlaylist(SEG_COUNT), { headers: { 'content-type': 'application/x-mpegURL' } });
  const seg = url.match(/\/video\/(MEDIUM(\d+)\.ts)$/);
  if (seg) {
    const i = Number(seg[2]);
    const n = calls.filter((c) => c.url === url).length;
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
  mp4Responder = null;
  embed = () => embedHtml({ hls: signedMaster(exp), videos: [{ name: 'sd', url: signedMp4('sd', exp) }] });
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(async () => {
  await prefetchIdle();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function body(r: Response): Promise<Uint8Array> {
  return new Uint8Array(await r.arrayBuffer());
}

describe('segments : cache LRU + préchargement', () => {
  it('sert le segment puis précharge N+1..N+4 ; le suivant vient du cache', async () => {
    const r = await proxiedSegment(OK_ID, 'sd', 'MEDIUM00003.ts', null);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('video/mp2t');
    expect(r.headers.get('content-length')).toBe(String(SEG_SIZE));
    expect(await body(r)).toEqual(segBytes(3));
    await prefetchIdle();
    expect(PREFETCH_AHEAD).toBe(4);
    for (const n of [4, 5, 6, 7]) expect(segCalls(`MEDIUM0000${n}.ts`)).toBe(1);
    expect(segCalls('MEDIUM00008.ts')).toBe(0);
    // Concurrence bornée : la requête du lecteur + PREFETCH_CONCURRENCY préchargements.
    expect(maxActive).toBeLessThanOrEqual(1 + PREFETCH_CONCURRENCY);

    const r2 = await proxiedSegment(OK_ID, 'sd', 'MEDIUM00004.ts', null);
    expect(await body(r2)).toEqual(segBytes(4));
    expect(segCalls('MEDIUM00004.ts')).toBe(1); // aucun nouvel appel amont
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
