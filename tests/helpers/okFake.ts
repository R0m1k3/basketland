/**
 * Faux ok.ru pour les tests : génère des pages d'embed (data-options) et
 * des URL signées, sans réseau.
 */
export const OK_ID = '16668708768428';

export function signedMp4(name: string, expiresMs: number, host = 'vd123.okcdn.ru'): string {
  const type = { mobile: 4, lowest: 0, low: 1, sd: 2, hd: 3, full: 5 }[name] ?? 9;
  return `https://${host}/?expires=${expiresMs}&srcIp=203.0.113.7&pr=10&srcAg=CHROME&type=${type}&sig=SIG&id=19042703182508`;
}

export function signedMaster(expiresMs: number): string {
  return `https://vd123.okcdn.ru/video.m3u8?cmd=videoPlayerCdn&expires=${expiresMs}&srcAg=CHROME&type=2&sig=SIG&id=19042703182508`;
}

interface EmbedOpts {
  duration?: number;
  hls?: string | null;
  videos?: { name: string; url: string; disallowed?: boolean }[];
  /** metadata sérialisée en chaîne JSON (forme rencontrée chez ok.ru) plutôt qu'en objet. */
  metadataAsString?: boolean;
}

/** Page d'embed ok.ru minimale avec `data-options` échappé HTML. */
export function embedHtml(o: EmbedOpts = {}): string {
  const md: Record<string, unknown> = {
    movie: { id: OK_ID, duration: String(o.duration ?? 6016), title: '.', status: 'OK', poster: 'https://iv.okcdn.ru/i?x=1' },
    videos: (o.videos ?? []).map((v) => ({ seekSchema: 3, disallowed: false, ...v })),
  };
  if (o.hls) md.hlsManifestUrl = o.hls;
  const opts = { flashvars: { metadata: o.metadataAsString ? JSON.stringify(md) : md } };
  const attr = JSON.stringify(opts).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<html><body><div data-module="OKVideo" data-options="${attr}"></div></body></html>`;
}

export const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2003279,QUALITY=sd,RESOLUTION=852x480
https://vd123.okcdn.ru/expires/9999999999999/type/2/sig/SIG/id/19042703182508/video/
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=605970,QUALITY=lowest,RESOLUTION=426x240
https://vd123.okcdn.ru/expires/9999999999999/type/0/sig/SIG/id/19042703182508/video/
`;

export function mediaPlaylist(n: number): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:7'];
  for (let i = 0; i < n; i++) lines.push('#EXTINF:6.0,', `MEDIUM${String(i).padStart(5, '0')}.ts`);
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}
