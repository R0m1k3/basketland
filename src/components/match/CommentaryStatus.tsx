'use client';

/** État de la traduction des commentateurs, tel que renvoyé par GET /subtitles. */
export interface CommentaryState {
  status: 'disabled' | 'none' | 'queued' | 'running' | 'ready' | 'failed';
  phase?: 'extraction' | 'preparation' | 'transcription' | 'traduction';
  progress?: { done: number; total: number };
  position?: number;
  reason?: string;
}

const PHASE_LABEL: Record<NonNullable<CommentaryState['phase']>, string> = {
  extraction: 'Extraction de l’audio',
  preparation: 'Chargement des modèles (le premier lancement les télécharge)',
  transcription: 'Transcription des commentateurs',
  traduction: 'Traduction en français',
};

function pct(p?: { done: number; total: number }, phase?: CommentaryState['phase']): string {
  if (!p || !p.total) return '';
  // Téléchargement d'un modèle : progression en Mo.
  if (phase === 'preparation') return ` · ${p.done} / ${p.total} Mo`;
  return ` · ${Math.min(100, Math.round((p.done / p.total) * 100))} %`;
}

/**
 * Bandeau d'état sous le lecteur : ce que fait la chaîne
 * audio → transcription → traduction, en une ligne.
 */
export default function CommentaryStatus({
  state,
  hasReplay,
  onRetry,
}: {
  state: CommentaryState | null;
  hasReplay: boolean;
  onRetry: () => void;
}) {
  if (!hasReplay || !state) return null;
  const { status } = state;

  let tone = 'text-paper-dim';
  let dot = 'bg-paper-faint';
  let title: string;
  let detail: string | null = null;
  let spinning = false;

  if (status === 'ready') {
    tone = 'text-win';
    dot = 'bg-win';
    title = 'Commentaires traduits en français';
    detail = 'Les sous-titres suivent la voix des commentateurs.';
  } else if (status === 'running') {
    tone = 'text-flame-hot';
    spinning = true;
    title = `${state.phase ? PHASE_LABEL[state.phase] : 'Traduction des commentaires'}${pct(state.progress, state.phase)}`;
    detail = 'Le replay se regarde déjà ; les sous-titres apparaîtront à la fin.';
  } else if (status === 'queued') {
    tone = 'text-flame-hot';
    dot = 'bg-flame';
    title = state.position && state.position > 1 ? `Traduction en file d’attente (${state.position}e)` : 'Traduction en file d’attente';
    detail = 'Un match est traduit à la fois.';
  } else if (status === 'failed') {
    tone = 'text-loss';
    dot = 'bg-loss';
    title = 'Traduction impossible pour l’instant';
    detail = state.reason ?? null;
  } else if (status === 'disabled') {
    title = 'Traduction des commentaires non configurée';
    detail = state.reason ?? 'Voir le README, section « Traduction des commentaires ».';
  } else {
    title = 'Traduction des commentaires en préparation';
  }

  return (
    <div className="panel-soft flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" role="status" aria-live="polite">
      <span className="flex min-w-0 flex-1 items-start gap-3">
        {spinning ? (
          <span className="mt-1 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-flame border-t-transparent" aria-hidden="true" />
        ) : (
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        )}
        <span className="min-w-0">
          <span className={`block text-sm font-semibold ${tone}`}>{title}</span>
          {detail && <span className="block text-xs text-paper-mute">{detail}</span>}
        </span>
      </span>
      {status === 'failed' && (
        <button type="button" onClick={onRetry} className="btn !py-1.5 text-xs">
          Réessayer
        </button>
      )}
    </div>
  );
}
