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

/** Un segment doit être un nom de fichier .ts (souvent MEDIA/MEDIUM + index). */
const SEGMENT_NAME_RE = /^[A-Za-z0-9_-]+\.ts$/;

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
/**
 * Entrée de variante analysée dans une playlist maîtresse.
 *
 * `key` est la clé de qualité utilisée dans l'URL du proxy
 * (`?v=<key>`) : c'est le QUALITY de la balise `#EXT-X-STREAM-INF`, ou un
 * repli positionnel (`v0`, `v1`, …) si la balise n'en porte pas.
 */
export interface MasterVariant {
  /** Ligne `#EXT-X-STREAM-INF` complète. */
  inf: string;
  /** Clé de qualité normalisée (utilisable dans une URL). */
  key: string;
  /** URI de la variante, telle qu'écrite dans la playlist. */
  uri: string;
  /** URL absolue de la variante. */
  url: string;
}

/**
 * Parse les variantes d'une playlist maîtresse HLS.
 *
 * Source UNIQUE de vérité pour l'extraction des variantes : elle est utilisée
 * à la fois pour réécrire la playlist maîtresse (proxy) et pour exposer la
 * liste des variantes (API). Avant, ces deux chemins avaient leur propre
 * logique et ils divergeaient : seule l'API sautait les lignes de
 * commentaire intercalées entre `#EXT-X-STREAM-INF` et l'URI, ce qui
 * décalait les clés de repli positionnelles.
 */
export function parseMasterVariants(masterText: string, baseUrl: string): MasterVariant[] {
  const lines = masterText.split(/\r?\n/);
  const out: MasterVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const inf = lines[i].trim();
    if (!inf.startsWith('#EXT-X-STREAM-INF')) continue;
    // L'URI peut être précédée de lignes vides ou de commentaires.
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
    if (j >= lines.length) break;
    const uri = lines[j].trim();
    const quality = inf.match(/QUALITY=([^,]+)/)?.[1];
    const key = (quality ?? `v${out.length}`).replace(/[^a-zA-Z0-9_-]/g, '');
    out.push({ inf, key, uri, url: new URL(uri, baseUrl).toString() });
    i = j;
  }
  return out;
}

/**
 * Réécrit la playlist maîtresse : chaque variante est remplacée par l'URL du
 * proxy, qui sert la playlist média correspondante.
 *
 * La clé de qualité est reprise de l'attribut `QUALITY=` de la balise
 * `#EXT-X-STREAM-INF`, et non un index positionnel : c'est ce que `pickVariant`
 * attend côté serveur. Les URL signées ne transitent jamais par le client
 * (elles expirent).
 */
export function rewriteMasterPlaylist(masterText: string, masterUrl: string, okId: string): string {
  const lines = masterText.split(/\r?\n/);
  // La source contient déjà un #EXTM3U : on ne l'ajoute que s'il est absent,
  // sinon la playlist servie par le proxy en aurait deux (invalide pour hls.js).
  const out: string[] = masterText.trimStart().startsWith('#EXTM3U') ? [] : ['#EXTM3U'];

  // Les variantes sont extraites par le parseur canonique : on les remplace
  // dans le flux d'origine, en conservant les autres balises (#EXT-X-VERSION,
  // #EXT-X-INDEPENDENT-SEGMENTS, …) à leur place.
  const variants = parseMasterVariants(masterText, masterUrl);
  const byInf = new Map(variants.map((v) => [v.inf, v]));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const v = byInf.get(line);
      if (v) {
        out.push(v.inf);
        // On saute l'URI source (et les lignes intercalées) : elle est
        // remplacée par l'URL du proxy.
        let j = i + 1;
        while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
        out.push(`/api/video/${okId}/playlist.m3u8?v=${encodeURIComponent(v.key)}`);
        i = j;
      } else {
        out.push(line);
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
      // Les balises qui portent une URI (#EXT-X-KEY, #EXT-X-MAP) pointent
      // aujourd'hui vers ok.ru en direct. On les réécrit vers le proxy pour
      // qu'une playlist chiffrée reste lisible (sinon le navigateur tenterait
      // de charger la clé en direct et CORS la refuserait). Les URI absentes
      // ou déjà relatives sont laissées telles quelles.
      out.push(rewriteUriAttribute(line, okId, variantKey));
      continue;
    }
    const name = line.split('/').pop() ?? line;
    if (!SEGMENT_NAME_RE.test(name)) continue;
    out.push(`/api/video/${okId}/segment.ts?v=${encodeURIComponent(variantKey)}&s=${encodeURIComponent(name)}`);
  }
  return out.join('\n') + '\n';
}

/**
 * Réécrit l'attribut `URI="..."` d'une balise HLS vers le proxy vidéo.
 *
 * Seules les balises MEDIA (`#EXT-X-KEY`, `#EXT-X-MAP`) portent une URI.
 *
 * Deux formes à traiter, et les deux doivent passer par le proxy :
 *  - URI absolue (`https://…/key.bin`) : le nom du fichier est extrait et
 *    réécrit vers `/asset.ts` ; sans cela, le navigateur chargeait la clé
 *    en direct depuis ok.ru, sans le `Referer` requis (403) et avec un
 *    contrôle CORS qui échoue.
 *  - URI relative (`init.mp4`) : elle serait résolue par le lecteur contre
 *    l'URL de la playlist — c'est-à-dire contre le proxy — d'où un 404.
 *    On la réécrit donc explicitement vers `/asset.ts`.
 *
 * Le dossier est celui de la variante, résolu côté serveur : la ressource
 * est bien servie à côté des segments, pas dans le dossier de la clé.
 */
function rewriteUriAttribute(
  line: string,
  okId: string,
  variantKey: string,
): string {
  if (!/^#EXT-X-(KEY|MAP)/.test(line)) return line;
  return line.replace(/URI="([^"]+)"/, (_m, uri: string) => {
    // On ne garde que le NOM du fichier : ni chemin, ni URL.
    const name = uri.split('/').pop() ?? '';
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$/.test(name)) return `URI="${uri}"`;
    return `URI="/api/video/${okId}/asset.ts?v=${encodeURIComponent(variantKey)}&a=${encodeURIComponent(name)}"`;
  });
}
