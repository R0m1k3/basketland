/**
 * Briques du mode « scores masqués » (rendu serveur, pilotées en CSS).
 *
 * - le conteneur d'un match porte `data-scope={id}` ;
 * - `.spoil-show` disparaît quand les scores sont masqués ;
 * - `.spoil-only` n'apparaît que dans ce cas ;
 * - `RevealButton` révèle le score d'un seul match (géré par SpoilerToggle).
 */
export function RevealButton({ id, label = 'Score masqué', className = '' }: { id: number | string; label?: string; className?: string }) {
  return (
    <button
      type="button"
      data-reveal={String(id)}
      className={`spoil-only score-mask relative z-10 ${className}`}
      aria-label={`${label} — afficher le score`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-flame" aria-hidden="true" />
      {label}
      <span className="text-paper underline decoration-flame/60 underline-offset-2">Afficher</span>
    </button>
  );
}

/** Un score : la valeur, ou un tiret quand il n'est pas connu. */
export function ScoreValue({ value, className = '' }: { value: number | null; className?: string }) {
  return <span className={`num tabular-nums ${className}`}>{value ?? '–'}</span>;
}
