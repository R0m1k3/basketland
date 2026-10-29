import { describe, it, expect } from 'vitest';
import {
  isValidPlaylist,
  isAllowedSegmentUrl,
  resolveSegmentUrl,
  rewriteMasterPlaylist,
  rewriteMediaPlaylist,
} from '../src/lib/hls';
import { parseOkEmbed, isValidOkId, parseMasterVariants, signedUrlExpiry } from '../src/lib/okru';

/** Playlist maître ok.ru réelle (relevée sur ok.ru/16656495217324). */
const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2003279,AVERAGE-BANDWIDTH=1611076,QUALITY=sd,FRAME-RATE=30,RESOLUTION=852x480
/expires/1793345530878/srcIp/82.65.11.128/pr/10/srcAg/CHROME/ch/-536166974/type/2/sig/SqtQ-OC-xHs/ct/8/id/19025075243692/video/
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=605970,QUALITY=lowest,RESOLUTION=426x240
/expires/1793345530878/srcIp/82.65.11.128/pr/10/type/0/sig/J-pRTPnPCh0/id/19025075243692/video/
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=8811888,QUALITY=full,RESOLUTION=1920x1080
/expires/1793345530878/srcIp/82.65.11.128/pr/10/type/3/sig/vhkP6aUPwBo/id/19025075243692/video/
`;

/** Playlist média ok.ru réelle. */
const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-ALLOW-CACHE:YES
#EXT-X-TARGETDURATION:7
#EXTINF:6.073367,
MEDIUM00000.ts
#EXTINF:6.006367,
MEDIUM00001.ts
#EXTINF:6.006367,
MEDIUM00002.ts
`;

describe('rewriteMasterPlaylist', () => {
  it('pointe chaque variante vers le proxy avec la clé QUALITY', () => {
    const out = rewriteMasterPlaylist(MASTER, 'https://ok6-29.vkuser.net/video.m3u8?cmd=x', '16656495217324');
    expect(out).toContain('/api/video/16656495217324/playlist.m3u8?v=sd');
    expect(out).toContain('/api/video/16656495217324/playlist.m3u8?v=lowest');
    expect(out).toContain('/api/video/16656495217324/playlist.m3u8?v=full');
  });

  it('ne duplique pas #EXTM3U', () => {
    const out = rewriteMasterPlaylist(MASTER, 'https://ok6-29.vkuser.net/video.m3u8?cmd=x', '1');
    expect(out.match(/#EXTM3U/g)).toHaveLength(1);
  });

  it('conserve les balises EXT-X-STREAM-INF', () => {
    const out = rewriteMasterPlaylist(MASTER, 'https://ok6-29.vkuser.net/video.m3u8?cmd=x', '1');
    expect(out).toContain('QUALITY=sd');
    expect(out).toContain('RESOLUTION=852x480');
    expect(out).toContain('BANDWIDTH=2003279');
  });

  it('n\'expose jamais l\'URL signée ok.ru', () => {
    const out = rewriteMasterPlaylist(MASTER, 'https://ok6-29.vkuser.net/video.m3u8?cmd=x', '1');
    expect(out).not.toContain('vkuser.net');
    expect(out).not.toContain('sig=');
  });
});

describe('rewriteMediaPlaylist', () => {
  it('réécrit chaque segment vers le proxy', () => {
    const out = rewriteMediaPlaylist(
      MEDIA,
      'https://ok6-29.vkuser.net/expires/1/type/2/sig/ABC/id/190/video/',
      '16656495217324',
      'sd',
    );
    expect(out).toContain('/api/video/16656495217324/segment.ts?v=sd&s=MEDIUM00000.ts');
    expect(out).toContain('MEDIUM00002.ts');
  });

  it('préserve les balises EXTINF', () => {
    const out = rewriteMediaPlaylist(MEDIA, 'https://h/v/', '1', 'sd');
    expect(out).toContain('#EXTINF:6.073367,');
    expect(out).toContain('#EXT-X-TARGETDURATION:7');
  });

  it('préserve le nombre de segments', () => {
    const out = rewriteMediaPlaylist(MEDIA, 'https://h/v/', '1', 'sd');
    const count = (out.match(/segment\.ts/g) ?? []).length;
    expect(count).toBe(3);
  });
});

describe('isValidPlaylist', () => {
  it('accepte une playlist média valide', () => {
    expect(isValidPlaylist(MEDIA)).toBe(true);
  });

  it('accepte une playlist maître valide', () => {
    expect(isValidPlaylist(MASTER)).toBe(true);
  });

  it('refuse une réponse HTML', () => {
    expect(isValidPlaylist('<!DOCTYPE html><html>404</html>')).toBe(false);
  });

  it('refuse une chaîne vide', () => {
    expect(isValidPlaylist('')).toBe(false);
  });
});

describe('resolveSegmentUrl', () => {
  const variant = 'https://ok6-29.vkuser.net/expires/1/type/2/sig/ABC/id/190/video/';

  it('résout un nom de segment relatif', () => {
    expect(resolveSegmentUrl('MEDIUM00042.ts', variant)).toBe(
      'https://ok6-29.vkuser.net/expires/1/type/2/sig/ABC/id/190/video/MEDIUM00042.ts',
    );
  });

  it('REFUSE une URL absolue (surface SSRF)', () => {
    // Régression : une URL absolue allowait à l'appelant de faire lire par
    // le proxy une ressource arbitraire (éventuellement via une redirection
    // ouverte sur un hôte autorisé).
    expect(() => resolveSegmentUrl('https://ok6-29.vkuser.net/evil', variant)).toThrow();
    expect(() => resolveSegmentUrl('http://127.0.0.1/admin', variant)).toThrow();
  });

  it('refuse un nom de segment dangereux', () => {
    // Traversée de répertoire : refusée.
    expect(() => resolveSegmentUrl('../../etc/passwd', variant)).toThrow();
    expect(() => resolveSegmentUrl('../MEDIUM1.ts', variant)).toThrow();
    // Un chemin avec un slash est refusé : seuls les noms simples .ts passent.
    expect(() => resolveSegmentUrl('dir/MEDIUM1.ts', variant)).toThrow();
  });
});

describe('isAllowedSegmentUrl', () => {
  it('accepte les hôtes de média ok.ru', () => {
    expect(isAllowedSegmentUrl('https://ok6-29.vkuser.net/a/MEDIUM1.ts')).toBe(true);
    expect(isAllowedSegmentUrl('https://st.okcdn.ru/a/MEDIUM1.ts')).toBe(true);
  });

  it('refuse un hôte tiers (anti-SSRF)', () => {
    expect(isAllowedSegmentUrl('https://evil.example.com/a.ts')).toBe(false);
    expect(isAllowedSegmentUrl('http://ok6-29.vkuser.net/a.ts')).toBe(false);
    expect(isAllowedSegmentUrl('pas une url')).toBe(false);
  });
});

describe('isValidOkId', () => {
  it('accepte un id numérique valide', () => {
    expect(isValidOkId('16656495217324')).toBe(true);
  });

  it('refuse un id invalide', () => {
    expect(isValidOkId('abc')).toBe(false);
    expect(isValidOkId('')).toBe(false);
    expect(isValidOkId('../../etc')).toBe(false);
  });
});

describe('parseOkEmbed', () => {
  it('extrait durée et affiche de l\'embed', () => {
    const html = `<div data-options='{"flashvars":{"metadata":"{\\"movie\\":{\\"duration\\":\\"8033\\",\\"poster\\":\\"https://iv.okcdn.ru/i?r=X\\"}}"},"poster":"https://p"}'></div>`;
    const info = parseOkEmbed(html, '16656495217324');
    expect(info.duration).toBe(8033);
    expect(info.poster).toBe('https://iv.okcdn.ru/i?r=X');
  });

  it('extrait l\'URL m3u8 signée', () => {
    const html = `<script>{"hlsManifestUrl":"https:\\/\\/ok6-29.vkuser.net\\/video.m3u8?cmd=videoPlayerCdn&expires=1793345291075&sig=ABC"}</script>`;
    const info = parseOkEmbed(html, '1');
    expect(info.hlsManifestUrl).toContain('vkuser.net');
    expect(info.hlsManifestUrl).toContain('sig=ABC');
  });
});

describe('signedUrlExpiry', () => {
  it('lit le timestamp d\'expiration', () => {
    const exp = signedUrlExpiry('https://h/video.m3u8?expires=1793345291075');
    expect(exp).toBe(1793345291075);
  });

  it('renvoie null si absent', () => {
    expect(signedUrlExpiry('https://h/video.m3u8?x=1')).toBeNull();
  });
});

describe('parseMasterVariants', () => {
  it('extrait les variantes avec clé QUALITY', () => {
    const variants = parseMasterVariants(MASTER, 'https://ok6-29.vkuser.net/video.m3u8?cmd=x');
    expect(variants).toHaveLength(3);
    expect(variants.map((v) => v.key).sort()).toEqual(['full', 'lowest', 'sd']);
  });

  it('résout les URLs absolues', () => {
    const variants = parseMasterVariants(MASTER, 'https://ok6-29.vkuser.net/video.m3u8?cmd=x');
    expect(variants.every((v) => v.url.startsWith('https://ok6-29.vkuser.net/'))).toBe(true);
  });

  it('conserve bande passante et résolution', () => {
    const variants = parseMasterVariants(MASTER, 'https://ok6-29.vkuser.net/video.m3u8?cmd=x');
    const sd = variants.find((v) => v.key === 'sd');
    expect(sd?.bandwidth).toBe(2003279);
    expect(sd?.resolution).toBe('852x480');
  });
});
