import NextNotFound from 'next/dist/client/components/builtin/not-found';

/**
 * Page introuvable : l'interface par défaut de Next (« 404 | This page could
 * not be found. »), telle que l'affichait `notFound()` dans les pages
 * serveur. Sert au fichier `404.html` de l'export et, par `PageData`, aux
 * pages dont la route de données répond 404 (match ou équipe inconnus).
 */
export default function NotFound() {
  return <NextNotFound />;
}
