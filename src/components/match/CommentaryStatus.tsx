'use client';

import { fmtTime } from '@/components/match/format';

/** État de la traduction des commentateurs, tel que renvoyé par GET /subtitles. */
export interface CommentaryState {
  status: 'disabled' | 'none' | 'queued' | 'running' | 'ready' | 'failed';
  phase?: 'extraction' | 'preparation' | 'transcription' | 'traduction';
  progress?: { done: number; total: number };
  position?: number;
  reason?: string;
  /** Piste en cours : fin des sous-titres prêts d'un seul tenant depuis la position de lecture. */
  available_until?: number;
  /** Plages de vidéo déjà traduites (piste partielle). */
  covered?: [number, number][];
}

const PHASE_LABEL: Record<NonNullable<CommentaryState['phase']>, string> = {
  extraction: 'Lecture de l’audio',
  preparation: 'Chargement des modèles (le premier lancement les télécharge)',
  transcription: 'Transcription des commentateurs',
  traduction: 'Traduction en français',
};

/** Téléchargement d'un modèle (premier lancement) : progression en Mo. */
function download(p?: { done: number; total: number }, phase?: CommentaryState['phase']): string {
  return phase === 'preparation' && p && p.total ? ` · ${p.done} / ${p.total} Mo` : '';
}

/** Avance des sous-titres sur la lecture, en clair. */
function lead(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s d’avance`;
  return `${Math.floor(sec / 60)} min d’avance`;
}

/** Plage traduite qui contient la position de lecture. */
function rangeAt(covered: [number, number][] | undefined, t: number): [number, number] | undefined {
  return covered?.find(([a, b]) => t >= a - 0.5 && t < b);
}

/**
 * Bandeau d'état sous le lecteur : ce que fait la chaîne
 * audio → transcription → traduction, en une ligne.
 */
export default function CommentaryStatus({
  state,
  hasReplay,
  onRetry,
  position = 0,
}: {
  state: CommentaryState | null;
  hasReplay: boolean;
  onRetry: () => void;
  /** Position de lecture (s), lue à chaque mise à jour du statut. */
  position?: number;
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
    const here = rangeAt(state.covered, position);
    const until = here?.[1] ?? state.available_until;
    const ahead = until && until > position ? until - position : 0;
    const share = state.progress && state.progress.total && state.phase !== 'preparation' ? Math.round((state.progress.done / state.progress.total) * 100) : null;
    if (ahead > 0) {
      // Ce qui compte pour le spectateur : l'avance sur la lecture, pas la part du match.
      title = `Sous-titres en direct · ${lead(ahead)}`;
      detail = `Prêts jusqu’à ${fmtTime(until as number)} ; la traduction continue devant la lecture${share !== null ? ` (${share} % du match traduit)` : ''}.`;
    } else {
      title = `${state.phase ? PHASE_LABEL[state.phase] : 'Traduction des commentaires'}${download(state.progress, state.phase)}`;
      detail =
        state.phase === 'preparation'
          ? 'Démarrage : chargement des modèles de transcription et de traduction (10 à 30 s).'
          : 'Les sous-titres de ce passage arrivent dans quelques secondes (traduction minute par minute, à partir d’ici).';
    }
  } else if (status === 'queued') {
    tone = 'text-flame-hot';
    dot = 'bg-flame';
    if (state.position && state.position > 1) {
      title = `Traduction en file d’attente (${state.position}e)`;
      detail = 'Un match est traduit à la fois.';
    } else {
      title = 'Traduction : démarrage imminent';
      detail = 'Ce match passe avant tous les autres (un travail de fond éventuel est mis en pause).';
    }
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
