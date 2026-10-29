import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Pas d'attente de 2 s entre deux pages basketball-video dans les tests.
vi.hoisted(() => {
  process.env.BV_RATE_MS = '0';
});

import { clearListingCache, embedKind, findReplay, parseOkIframes } from '../src/lib/bv';
import { embedHtml, signedMaster, signedMp4 } from './helpers/okFake';

/**
 * findReplay : tous les serveurs de la page sont essayés, et un embed sans
 * HLS mais avec un MP4 progressif est retenu (kind 'mp4').
 *
 * Cas réel (28/10/2026, LAL@LAC, OKC@DAL, HOU@MIL) : l'iframe ok.ru du
 * Server #1 existait, mais ok.ru n'avait produit que la qualité « mobile »
 * en MP4 ; l'ancien code concluait « flux indisponible ».
 */

const SLUG = 'los-angeles-lakers-vs-la-clippers-nba-full-game-replay-october-28-2026';
const ENTRY = `https://basketball-video.com/${SLUG}`;
const LISTING = `<a href="/${SLUG}">Watch</a>`;

function matchPage(servers: string[]): string {
  return servers
    .map(
      (href, i) =>
        `<p><b>Server #${i + 1} (${['OK', 'DM', 'FM'][i] ?? 'X'})</b></p>\n<p><a class="su-button" href="${href}">Watch</a></p>\n<p>---</p>`,
    )
    .join('\n');
}

function targetPage(ids: string[]): string {
  return ids.map((id) => `<iframe class="yt-embed" src="//ok.ru/videoembed/${id}"></iframe><p>---</p>`).join('\n');
}

const MATCH = { home_name: 'LA Clippers', away_name: 'Los Angeles Lakers', date_utc: '2026-10-29T02:30:00Z', season: 2026 };
const EXP = Date.now() + 86400_000;

const EMBEDS = {
  mp4Only: embedHtml({ duration: 6016, videos: [{ name: 'mobile', url: signedMp4('mobile', EXP) }] }),
  hls: embedHtml({ duration: 8033, hls: signedMaster(EXP), videos: [{ name: 'sd', url: signedMp4('sd', EXP) }] }),
  teaser: embedHtml({ duration: 120, hls: signedMaster(EXP) }),
  nothing: embedHtml({ duration: 6016 }),
  disallowedOnly: embedHtml({ duration: 6016, videos: [{ name: 'hd', url: signedMp4('hd', EXP), disallowed: true }] }),
};

let pages: Record<string, string>;
let embeds: Record<string, string>;
let fetched: string[];

beforeEach(() => {
  clearListingCache();
  fetched = [];
  pages = { 'https://basketball-video.com/2026-27': LISTING };
  embeds = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(url);
      const ok = url.match(/ok\.ru\/videoembed\/(\d+)/);
      if (ok) return embeds[ok[1]] ? new Response(embeds[ok[1]]) : new Response('gone', { status: 404 });
      const html = pages[url];
      return html !== undefined ? new Response(html) : new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearListingCache();
});

describe('findReplay', () => {
  it('Server #1 en MP4 seul : disponible, kind mp4 (plus de « flux indisponible »)', async () => {
    pages[ENTRY] = matchPage(['https://s1.example/a', 'https://s2.example/b']);
    pages['https://s1.example/a'] = targetPage(['111111']);
    embeds['111111'] = EMBEDS.mp4Only;
    const r = await findReplay(MATCH);
    expect(r).toMatchObject({ slug: SLUG, okId: '111111', duration: 6016, available: true, kind: 'mp4' });
    // Paresseux : le Server #2 n'est pas téléchargé.
    expect(fetched).not.toContain('https://s2.example/b');
  });

  it('HLS : kind hls', async () => {
    pages[ENTRY] = matchPage(['https://s1.example/a']);
    pages['https://s1.example/a'] = targetPage(['222222']);
    embeds['222222'] = EMBEDS.hls;
    expect(await findReplay(MATCH)).toMatchObject({ okId: '222222', available: true, kind: 'hls', duration: 8033 });
  });

  it('Server #1 illisible, #2 mort, #3 lisible : retient le #3', async () => {
    pages[ENTRY] = matchPage(['https://s1.example/a', 'https://s2.example/dead', 'https://s3.example/c']);
    pages['https://s1.example/a'] = targetPage(['111111']);
    embeds['111111'] = EMBEDS.nothing;
    pages['https://s3.example/c'] = targetPage(['333333']);
    embeds['333333'] = EMBEDS.mp4Only;
    const r = await findReplay(MATCH);
    expect(r).toMatchObject({ okId: '333333', available: true, kind: 'mp4' });
  });

  it('les premiers iframes de chaque serveur passent avant les iframes secondaires', async () => {
    pages[ENTRY] = matchPage(['https://s1.example/a', 'https://s2.example/b']);
    // Page cible partagée : le 2e iframe est un AUTRE match, lisible.
    pages['https://s1.example/a'] = targetPage(['111111', '999999']);
    embeds['111111'] = EMBEDS.teaser;
    embeds['999999'] = EMBEDS.hls;
    pages['https://s2.example/b'] = targetPage(['222222']);
    embeds['222222'] = EMBEDS.mp4Only;
    const r = await findReplay(MATCH);
    expect(r).toMatchObject({ okId: '222222', kind: 'mp4' });
    expect(fetched.some((u) => u.includes('999999'))).toBe(false);
  });

  it('iframes secondaires en dernier recours', async () => {
    pages[ENTRY] = matchPage(['https://s1.example/a']);
    pages['https://s1.example/a'] = targetPage(['111111', '444444']);
    embeds['111111'] = EMBEDS.disallowedOnly;
    embeds['444444'] = EMBEDS.hls;
    expect(await findReplay(MATCH)).toMatchObject({ okId: '444444', kind: 'hls', available: true });
  });

  it('rien de lisible : indisponible, rapporte le premier candidat et sa raison', async () => {
    pages[ENTRY] = matchPage(['https://s1.example/a', 'https://s2.example/b']);
    pages['https://s1.example/a'] = targetPage(['111111']);
    embeds['111111'] = EMBEDS.teaser;
    pages['https://s2.example/b'] = targetPage(['222222']);
    embeds['222222'] = EMBEDS.nothing;
    const r = await findReplay(MATCH);
    expect(r).toMatchObject({ okId: '111111', duration: 120, available: false, kind: null, reason: 'vidéo trop courte (teaser)' });
  });

  it('embed en erreur HTTP : on passe au serveur suivant', async () => {
    pages[ENTRY] = matchPage(['https://s1.example/a', 'https://s2.example/b']);
    pages['https://s1.example/a'] = targetPage(['111111']); // embed absent → 404
    pages['https://s2.example/b'] = targetPage(['222222']);
    embeds['222222'] = EMBEDS.hls;
    expect(await findReplay(MATCH)).toMatchObject({ okId: '222222', kind: 'hls' });
  });

  it('aucun iframe : raison explicite', async () => {
    pages[ENTRY] = matchPage(['https://s1.example/a']);
    pages['https://s1.example/a'] = '<p>rien</p>';
    expect(await findReplay(MATCH)).toMatchObject({ okId: null, available: false, kind: null, reason: 'iframe ok.ru introuvable' });
  });

  it('page sans bloc Server mais avec iframe direct', async () => {
    pages[ENTRY] = targetPage(['555555']);
    embeds['555555'] = EMBEDS.mp4Only;
    expect(await findReplay(MATCH)).toMatchObject({ okId: '555555', kind: 'mp4' });
  });

  it('replay non listé', async () => {
    pages['https://basketball-video.com/2026-27'] = '<p>vide</p>';
    expect(await findReplay(MATCH)).toMatchObject({ available: false, kind: null, reason: 'replay non listé' });
  });
});

describe('parseOkIframes / embedKind', () => {
  it('tous les iframes ok.ru, dans l\'ordre, sans doublon', () => {
    const html =
      targetPage(['1111111', '2222222', '1111111']) + '<iframe src="https://bysesukior.com/e/x"></iframe>' +
      '<iframe src="https://ok.ru/videoembed/3333333?autoplay=1"></iframe>';
    expect(parseOkIframes(html)).toEqual(['1111111', '2222222', '3333333']);
  });

  it('HLS prioritaire, sinon MP4, sinon rien', () => {
    expect(embedKind({ hlsManifestUrl: 'https://x/video.m3u8', mp4: [{ name: 'sd', url: 'u' }] })).toBe('hls');
    expect(embedKind({ hlsManifestUrl: null, mp4: [{ name: 'mobile', url: 'u' }] })).toBe('mp4');
    expect(embedKind({ hlsManifestUrl: null, mp4: [] })).toBeNull();
  });
});
