/**
 * Réécriture des playlists HLS ok.ru.
 *
 * Contraintes réelles du flux :
 *  - l'URL m3u8 est signée et expire (`expires=`) → ré-résolue à la demande ;
 *  - la playlist maître contient des chemins ABSOLUS vers un host de segments
 *    différent de celui du m3u8 ;
 *  - la playlist média contient des chemins RELATIFS (`MEDIUM00000.ts`) ;
 *  - les segments exigent l'en-tête `Referer: https://ok.ru/`.
 */

/**
 * Hôtes autorisés pour les segments (anti-SSRF).
 */
const ALLOWED_MEDIA_HOST_RE = /\.(vkuser\.net|okcdn\.ru|mycdn\.me|ok\.ru|vk\.com|userapi\.com|vkuseraudio\.net|vkuservideo\.net)$/i;

/** Un segment doit être un nom de fichier .ts (souvent MEDIA/MEDIUM + index). */
const SEGMENT_NAME_RE = /^[A-Za-z0-9_-]+\.ts$/;

/**
 * Vérifie qu'une URL de segment pointe vers un hôte de média autorisé.
 * Empêche un usage SSRF via le paramètre `s`.
 *
 * Le schéma est exigé à `https` : `http:` permettrait de viser un service
 * interne en clair, et surtout de contourner les contrôles du proxy
 * applicatif (HSTS, redirections).
 */
export function isAllowedSegmentUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_MEDIA_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Une playlist HLS valide commence par #EXTM3U et contient des segments.
 */
export function isValidPlaylist(text: string): boolean {
  if (!text || !text.includes('#EXTM3U')) return false;
  // Une playlist média doit référencer au moins un segment.
  const hasSegment = /^[A-Za-z0-9_-]+\.ts\s*$/m.test(text);
  const hasVariant = text.includes('#EXT-X-STREAM-INF');
  return hasSegment || hasVariant;
}

/**
 * Résout l'URL absolue d'un segment.
 *
 * `segment` doit être un NOM DE FICHIER (`MEDIUM00000.ts`). Toute URL absolue
 * est refusée : c'était la faille SSRF (un appelant pouvait faire lire par le
 * proxy une ressource arbitraire d'un hôte autorisé, voire via une
 * redirection ouverte). Le dossier de la variante fournit la base.
 *
 * Un chemin contenant un `/` est refusé également : on ne veut ni traversée
 * de répertoire ni segment dans un sous-dossier non prévu.
 */
export function resolveSegmentUrl(segment: string, variantUrl: string): string {
  if (segment.startsWith('http://') || segment.startsWith('https://')) {
    throw new Error('URL de segment absolue refusée');
  }
  if (segment.includes('/')) {
    throw new Error(`chemin de segment invalide: ${segment}`);
  }
  if (!SEGMENT_NAME_RE.test(segment)) {
    throw new Error(`nom de segment invalide: ${segment}`);
  }
  const base = variantUrl.slice(0, variantUrl.lastIndexOf('/') + 1);
  return `${base}${segment}`;
}

/**
 * Réécrit la playlist maître : chaque variante pointe vers le proxy.
 *
 * La clé transmise est le QUALITY de la variante (`sd`, `hd`, `full`…), et non
 * un index positionnel : c'est ce que `pickVariant` attend côté serveur.
 * Les URL signées ne transitent jamais par le client (elles expirent).
 */
export function rewriteMasterPlaylist(masterText: string, masterUrl: string, okId: string): string {
  const lines = masterText.split(/\r?\n/);
  // La source contient déjà un #EXTM3U : on ne l'ajoute que s'il est absent,
  // sinon la playlist servie par le proxy en aurait deux (invalide pour hls.js).
  const out: string[] = masterText.trimStart().startsWith('#EXTM3U') ? [] : ['#EXTM3U'];
  let fallbackIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      out.push(line);
      const next = lines[i + 1];
      if (next !== undefined && !next.trim().startsWith('#')) {
        const quality = line.match(/QUALITY=([^,]+)/)?.[1];
        const key = (quality ?? `v${fallbackIndex}`).replace(/[^a-zA-Z0-9_-]/g, '');
        out.push(`/api/video/${okId}/playlist.m3u8?v=${encodeURIComponent(key)}`);
        fallbackIndex++;
        i++;
      }
      continue;
    }
    if (line.startsWith('#')) {
      out.push(line);
    }
  }
  return out.join('\n') + '\n';
}

/**
 * Réécrit la playlist média : chaque segment pointe vers le proxy.
 *
 * @param playlistText contenu de la playlist
 * @param baseUrl      URL de la variante (pour résoudre les segments relatifs)
 * @param okId         identifiant ok.ru
 * @param variantKey   index de variante (pour retrouver le bon dossier de segments)
 */
export function rewriteMediaPlaylist(
  playlistText: string,
  baseUrl: string,
  okId: string,
  variantKey: string,
): string {
  const base = baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1);
  const out: string[] = [];

  for (const raw of playlistText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      out.push(line);
      continue;
    }
    const name = line.split('/').pop() ?? line;
    if (!SEGMENT_NAME_RE.test(name)) continue;
    const absolute = `${base}${name}`;
    out.push(`/api/video/${okId}/segment.ts?v=${encodeURIComponent(variantKey)}&s=${encodeURIComponent(name)}`);
  }
  return out.join('\n') + '\n';
}
