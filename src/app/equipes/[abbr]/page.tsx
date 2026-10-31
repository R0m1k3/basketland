import TeamPage from '@/components/pages/TeamPage';

/**
 * Un seul fichier pour toutes les équipes (`out/equipes/_.html` et `_.txt`) :
 * le serveur Rust le sert pour tout `/equipes/<abbr>`, la page lit
 * l'abréviation dans l'URL (jamais dans `params`, qui vaut toujours `_`).
 *
 * `Page` est un composant serveur : un export par défaut qui serait
 * directement le composant client ferait ignorer `generateStaticParams`.
 * `dynamicParams` reste à sa valeur par défaut : à l'export, seuls les
 * paramètres de `generateStaticParams` sont produits ; en développement
 * (`next dev`, sans export), tout identifiant est rendu.
 */

export function generateStaticParams() {
  return [{ abbr: '_' }];
}

export default function Page() {
  return <TeamPage />;
}
