/** Statut d'un match : en direct (pulsation), terminé, ou heure de début. */
export default function StatusPill({
  status,
  period,
  clock,
  time,
  compact,
}: {
  status: string;
  period?: number;
  clock?: string;
  /** Heure de début (Paris), affichée pour un match à venir. */
  time?: string;
  /** Colonne étroite (listes denses) : « Direct » ou le quart temps, sur une ligne. */
  compact?: boolean;
}) {
  if (status === 'live') {
    const quarter = period ? (period > 4 ? `Prol. ${period - 4}` : `Q${period}`) : '';
    if (compact) {
      return (
        <span className="chip-live w-fit gap-1 justify-self-start whitespace-nowrap px-1.5 text-[10px] tracking-wide" title="En direct">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse-live rounded-full bg-live" />
          {quarter || 'Direct'}
        </span>
      );
    }
    return (
      <span className="chip-live whitespace-nowrap">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse-live rounded-full bg-live" />
        {quarter ? `${quarter}${clock ? ` · ${clock}` : ''}` : 'En direct'}
      </span>
    );
  }
  if (status === 'final') return <span className="chip">Terminé</span>;
  return <span className="chip-flame">{time ?? 'À venir'}</span>;
}
