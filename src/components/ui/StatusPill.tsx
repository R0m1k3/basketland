/** Statut d'un match : en direct (pulsation), terminé, ou heure de début. */
export default function StatusPill({
  status,
  period,
  clock,
  time,
}: {
  status: string;
  period?: number;
  clock?: string;
  /** Heure de début (Paris), affichée pour un match à venir. */
  time?: string;
}) {
  if (status === 'live') {
    return (
      <span className="chip-live">
        <span className="h-1.5 w-1.5 animate-pulse-live rounded-full bg-live" />
        {period ? `${period > 4 ? `Prol. ${period - 4}` : `Q${period}`}${clock ? ` · ${clock}` : ''}` : 'En direct'}
      </span>
    );
  }
  if (status === 'final') return <span className="chip">Terminé</span>;
  return <span className="chip-flame">{time ?? 'À venir'}</span>;
}
