/**
 * Interface en fichiers statiques (étape 8b, voir docs/migration-rust.md) :
 * `next build` produit `out/`, servi par le serveur Rust. Chaque page est un
 * composant client qui lit ses données dans `GET /api/pages/…` ; aucun code
 * serveur Next ne tourne à l'exécution.
 *
 * Routes dynamiques (`/matchs/[id]`, `/equipes/[abbr]`) : un seul fichier par
 * route, pour le paramètre de remplacement `_` (`out/matchs/_.html` et
 * `_.txt`), que Rust sert pour tout identifiant ; la page lit le vrai dans
 * l'URL.
 *
 * En développement (`next dev` derrière Rust), pas d'export : les routes
 * dynamiques acceptent alors tout identifiant (l'export n'accepte que ceux de
 * `generateStaticParams`, et Rust n'y est pas là pour servir la page `_`).
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  output: process.env.NODE_ENV === 'development' ? undefined : 'export',
  trailingSlash: false,
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
