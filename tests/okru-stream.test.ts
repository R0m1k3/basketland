import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  bestMp4,
  clearOkStreamCache,
  parseOkEmbed,
  parseOkVideos,
  resolveOkStream,
  STREAM_EXPIRY_MARGIN_MS,
} from '../src/lib/okru';
import { embedHtml, MASTER, OK_ID, signedMaster, signedMp4 } from './helpers/okFake';

/**
 * Résolution des flux ok.ru : MP4 progressif quand le HLS n'existe pas
 * encore, et cache du flux signé (plus de re-résolution toutes les 45 s).
 */

describe('parseOkEmbed — champ videos (MP4 progressifs)', () => {
  it('lit les 6 qualités de l\'embed réel (vidéo entièrement traitée)', () => {
    const html = fs.readFileSync(path.join(__dirname, 'fixtures/ok-embed.html'), 'utf8');
    const info = parseOkEmbed(html, '16656495217324');
    expect(info.hlsManifestUrl).toMatch(/video\.m3u8/);
    expect(info.mp4.map((m) => m.name)).toEqual(['mobile', 'lowest', 'low', 'sd', 'hd', 'full']);
    expect(info.mp4[0].url).toMatch(/^https:\/\/ok6-29\.vkuser\.net\/\?expires=1793348942232&/);
    // Les &amp; de l'attribut HTML sont décodés.
    expect(info.mp4[0].url).not.toContain('&amp;');
  });

  it('vidéo en cours de traitement : pas de HLS, MP4 « mobile » seul', () => {
    const exp = Date.now() + 86400_000;
    const info = parseOkEmbed(embedHtml({ videos: [{ name: 'mobile', url: signedMp4('mobile', exp) }] }), OK_ID);
    expect(info.hlsManifestUrl).toBeNull();
    expect(info.duration).toBe(6016);
    expect(info.mp4).toEqual([{ name: 'mobile', url: signedMp4('mobile', exp) }]);
  });

  it('metadata sérialisée en chaîne JSON', () => {
    const info = parseOkEmbed(
      embedHtml({ metadataAsString: true, videos: [{ name: 'sd', url: signedMp4('sd', 1) }] }),
      OK_ID,
    );
    expect(info.mp4.map((m) => m.name)).toEqual(['sd']);
  });

  it('ignore les qualités disallowed, les URL non https et les entrées malformées', () => {
    expect(
      parseOkVideos([
        { name: 'mobile', url: 'https://a.okcdn.ru/?x=1', disallowed: false },
        { name: 'hd', url: 'https://a.okcdn.ru/?x=2', disallowed: true },
        { name: 'sd', url: 'http://a.okcdn.ru/?x=3' },
        { name: 'low' },
        null,
        'full',
      ]),
    ).toEqual([{ name: 'mobile', url: 'https://a.okcdn.ru/?x=1' }]);
    expect(parseOkVideos(undefined)).toEqual([]);
  });
});

describe('bestMp4', () => {
  it('ordre full > hd > sd > low > lowest > mobile, qualités inconnues en dernier', () => {
    const src = ['mobile', 'weird', 'low', 'hd', 'lowest', 'sd'].map((name) => ({ name, url: `https://x/${name}` }));
    expect(bestMp4(src)?.name).toBe('hd');
    expect(bestMp4([{ name: 'weird', url: 'u' }, { name: 'mobile', url: 'm' }])?.name).toBe('mobile');
    expect(bestMp4([])).toBeUndefined();
  });
});

describe('resolveOkStream', () => {
  let embedCalls: number;
  let masterCalls: number;
  let embed: () => string;
  let exp: number;
  let masterStatus: number;

  beforeEach(() => {
    clearOkStreamCache();
    embedCalls = 0;
    masterCalls = 0;
    masterStatus = 200;
    exp = Date.now() + 24 * 3600_000;
    embed = () => embedHtml({ hls: signedMaster(exp), videos: [{ name: 'sd', url: signedMp4('sd', exp) }] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('ok.ru/videoembed/')) {
          embedCalls++;
          // Latence réaliste : les appels concurrents doivent se retrouver
          // pendant la résolution.
          await new Promise((r) => setTimeout(r, 5));
          return new Response(embed(), { status: 200 });
        }
        if (url.includes('video.m3u8')) {
          masterCalls++;
          return masterStatus === 200 ? new Response(MASTER, { status: 200 }) : new Response('', { status: masterStatus });
        }
        return new Response('nope', { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearOkStreamCache();
  });

  it('MP4 seul : pas d\'erreur, masterText/masterUrl vides, variants vide, mp4 renseigné', async () => {
    embed = () => embedHtml({ videos: [{ name: 'mobile', url: signedMp4('mobile', exp) }] });
    const s = await resolveOkStream(OK_ID);
    expect(s.masterText).toBe('');
    expect(s.masterUrl).toBe('');
    expect(s.variants).toEqual([]);
    expect(s.mp4).toEqual([{ name: 'mobile', url: signedMp4('mobile', exp) }]);
    expect(s.expiresAt).toBe(exp);
    expect(masterCalls).toBe(0);
  });

  it('ni HLS ni MP4 : erreur', async () => {
    embed = () => embedHtml({});
    await expect(resolveOkStream(OK_ID)).rejects.toThrow(/ni HLS ni MP4/);
  });

  it('HLS : variantes et MP4 tous deux exposés', async () => {
    const s = await resolveOkStream(OK_ID);
    expect(s.variants.map((v) => v.key)).toEqual(['sd', 'lowest']);
    expect(s.mp4.map((m) => m.name)).toEqual(['sd']);
    expect(s.expiresAt).toBe(exp);
  });

  it('appels concurrents : une seule résolution', async () => {
    const all = await Promise.all([resolveOkStream(OK_ID), resolveOkStream(OK_ID), resolveOkStream(OK_ID)]);
    expect(embedCalls).toBe(1);
    expect(all[0]).toBe(all[1]);
    expect(all[1]).toBe(all[2]);
  });

  it('plusieurs `force` simultanés (segments en 403) : une seule résolution', async () => {
    await resolveOkStream(OK_ID);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    embedCalls = 0;
    await Promise.all([
      resolveOkStream(OK_ID, { force: true }),
      resolveOkStream(OK_ID, { force: true }),
      resolveOkStream(OK_ID, { force: true }),
    ]);
    expect(embedCalls).toBe(1);
    // Un 403 tardif, juste après la résolution forcée, réutilise le flux frais.
    await resolveOkStream(OK_ID, { force: true });
    expect(embedCalls).toBe(1);
  });

  it('garde le flux en cache bien au-delà de 45 s (jusqu\'à l\'expiration de la signature)', async () => {
    const first = await resolveOkStream(OK_ID);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    const again = await resolveOkStream(OK_ID);
    expect(again).toBe(first);
    expect(embedCalls).toBe(1);
  });

  it('stale-while-revalidate : proche de l\'expiration, sert l\'ancien flux et rafraîchit en fond', async () => {
    const first = await resolveOkStream(OK_ID);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(exp - 20 * 60_000);
    const exp2 = exp + 24 * 3600_000;
    embed = () => embedHtml({ hls: signedMaster(exp2) });
    const served = await resolveOkStream(OK_ID);
    expect(served).toBe(first); // pas d'attente
    expect(embedCalls).toBe(2); // rafraîchissement lancé
    await vi.waitFor(async () => expect((await resolveOkStream(OK_ID)).expiresAt).toBe(exp2));
    expect(embedCalls).toBe(2);
  });

  it('au-delà de expiresAt - 5 min : attend une nouvelle résolution', async () => {
    const first = await resolveOkStream(OK_ID);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(exp - STREAM_EXPIRY_MARGIN_MS + 1000);
    const exp2 = exp + 24 * 3600_000;
    embed = () => embedHtml({ hls: signedMaster(exp2) });
    const s = await resolveOkStream(OK_ID);
    expect(s).not.toBe(first);
    expect(s.expiresAt).toBe(exp2);
  });

  it('HLS momentanément illisible : MP4 en attendant, HLS retenté après 30 s (pas 10 min)', async () => {
    masterStatus = 403;
    const degraded = await resolveOkStream(OK_ID);
    expect(degraded.hlsError).toBe(true);
    expect(degraded.variants).toEqual([]);
    masterStatus = 200;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5_000);
    expect(await resolveOkStream(OK_ID)).toBe(degraded);
    vi.setSystemTime(Date.now() + 30_000);
    expect(await resolveOkStream(OK_ID)).toBe(degraded); // servi pendant le rafraîchissement en fond
    await new Promise((r) => setTimeout(r, 20));
    const healed = await resolveOkStream(OK_ID);
    expect(healed.hlsError).toBe(false);
    expect(healed.variants.map((v) => v.key)).toEqual(['sd', 'lowest']);
  });

  it('un rafraîchissement en échec ne fait pas perdre un flux encore valable', async () => {
    const first = await resolveOkStream(OK_ID);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(exp - 20 * 60_000);
    embed = () => embedHtml({});
    expect(await resolveOkStream(OK_ID)).toBe(first);
    await new Promise((r) => setTimeout(r, 20));
    expect(await resolveOkStream(OK_ID)).toBe(first);
  });
});
