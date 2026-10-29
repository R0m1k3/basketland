/**
 * Démarre le serveur Next.js en mode standalone pour le développement local.
 *
 * `next build` ne copie NI `.next/static` NI `public` dans `.next/standalone` :
 * le Dockerfile le fait explicitement, mais un `npm start` local sans cette
 * étape servait les pages sans leur CSS ni leur JavaScript (404 sur
 * `/_next/static/...`) — donc sans lecteur vidéo ni calibration.
 *
 * Ce script reproduit ce que fait le Dockerfile, puis lance le serveur.
 */
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const standalone = join(root, '.next', 'standalone');

if (!existsSync(standalone)) {
  console.error('Build absent : lancez `npm run build` avant `npm start`.');
  process.exit(1);
}

const staticSrc = join(root, '.next', 'static');
const staticDst = join(standalone, '.next', 'static');
if (existsSync(staticSrc)) {
  await mkdir(dirname(staticDst), { recursive: true });
  await cp(staticSrc, staticDst, { recursive: true });
}

const publicSrc = join(root, 'public');
if (existsSync(publicSrc)) {
  await cp(publicSrc, join(standalone, 'public'), { recursive: true });
}

// Le serveur standalone écoute sur le nom d'hôte de la machine sans
// `HOSTNAME=0.0.0.0` : il ne répond alors pas sur 127.0.0.1, mais
// seulement sur l'IP de l'interface.
//
// On ne se contente PAS d'une valeur par défaut : `HOSTNAME` est souvent
// DÉJÀ défini dans l'environnement (nom de la machine ou IP d'interface),
// et le `||` ne s'appliquerait alors jamais. D'où `START_HOSTNAME`, qui
// est le seul moyen de choisir explicitement une autre interface.
process.env.HOSTNAME = process.env.START_HOSTNAME || '0.0.0.0';

await import(join(standalone, 'server.js'));
