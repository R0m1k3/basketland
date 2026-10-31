import MatchPage from '@/components/pages/MatchPage';

/**
 * Un seul fichier pour tous les matchs (`out/matchs/_.html` et `_.txt`) : le
 * serveur Rust le sert pour tout `/matchs/<id>`, la page lit l'identifiant
 * dans l'URL (jamais dans `params`, qui vaut toujours `_`).
 *
 * `Page` est un composant serveur : un export par défaut qui serait
 * directement le composant client ferait ignorer `generateStaticParams`.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ id: '_' }];
}

export default function Page() {
  return <MatchPage />;
}
