'use client';

import { useEffect, useState } from 'react';
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

/** Réponse d'une commande POST /commentary, pour le retour affiché sous le bandeau. */
export interface CommandResult {
  ok: boolean;
  /** La traduction est en file ou en cours après la commande. */
  accepted: boolean;
  message: string | null;
}

const PHASE_LABEL: Record<NonNullable<CommentaryState['phase']>, string> = {
  extraction: 'Lecture de l’audio',
  preparation: 'Chargement des modèles (le premier lancement les télécharge)',
  transcription: 'Transcription des commentateurs',
  traduction: 'Traduction en français',
};

/** Durée d'affichage du message renvoyé par le serveur après une commande. */
const FEEDBACK_MS = 8_000;

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
 *
 * - Traduction automatique désactivée (Paramètres) : un match pas encore
 *   traduit affiche le bouton « Traduire ce match ».
 * - Administrateurs : « Relancer la traduction » (avec confirmation), quel
 *   que soit l'état — refait la piste même terminée ; inactif pendant que
 *   ce match est en cours de traduction.
 */
export default function CommentaryStatus({
  state,
  hasReplay,
  autoTranslate,
  onStart,
  onRelaunch,
  position = 0,
}: {
  state: CommentaryState | null;
  hasReplay: boolean;
  /** Réglage serveur « Traduction automatique ». */
  autoTranslate: boolean;
  /** Lancement explicite : « Traduire ce match », « Réessayer ». */
  onStart: () => Promise<CommandResult>;
  /** Relance forcée (administrateurs seulement ; absent sinon). */
  onRelaunch?: () => Promise<CommandResult>;
  /** Position de lecture (s), lue à chaque mise à jour du statut. */
  position?: number;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<CommandResult | null>(null);

  // Le message du serveur s'efface de lui-même : le bandeau dit déjà l'état.
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), FEEDBACK_MS);
    return () => clearTimeout(t);
  }, [feedback]);

  if (!hasReplay || !state) return null;
  const { status } = state;

  const run = async (cmd: () => Promise<CommandResult>, showFeedback: boolean) => {
    setBusy(true);
    setConfirming(false);
    const r = await cmd();
    setBusy(false);
    // Une mise en file se voit dans le bandeau : le message du serveur ne
    // s'affiche que pour la relance, ou quand rien n'est parti (erreur,
    // traduction inactive ou impossible).
    if (showFeedback || !r.accepted) setFeedback(r);
  };

  let tone = 'text-paper-dim';
  let dot = 'bg-paper-faint';
  let title: string;
  let detail: string | null = null;
  let spinning = false;
  /** Match pas encore traduit, traduction automatique désactivée : bouton « Traduire ce match ». */
  const manualStart = !autoTranslate && status === 'none' && !state.reason;

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
  } else if (manualStart) {
    const partial = !!state.covered?.length;
    title = partial ? 'Commentaires traduits en partie' : 'Commentaires pas encore traduits';
    detail = partial
      ? 'Lancez la traduction pour compléter les sous-titres français (à partir de la position de lecture).'
      : 'Lancez la traduction : les sous-titres français arrivent au fil de la lecture, en quelques minutes.';
  } else {
    title = 'Traduction des commentaires en préparation';
  }

  // Relance admin : inutile si la traduction n'est pas configurée ou si le
  // match n'a pas de replay exploitable ; visible mais inactive pendant que
  // ce match est traduit (la file ne relance pas un travail en cours).
  const canRelaunch = !!onRelaunch && status !== 'disabled' && !(status === 'none' && state.reason);
  const relaunchBlocked = status === 'running';

  return (
    <div className="panel-soft px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex min-w-0 flex-1 basis-60 items-start gap-3" role="status" aria-live="polite">
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
        {(manualStart || status === 'failed' || (canRelaunch && !confirming)) && (
          <span className="flex flex-wrap items-center gap-2">
            {manualStart && (
              <button type="button" onClick={() => void run(onStart, false)} disabled={busy} className="btn-primary !py-1.5 text-xs">
                Traduire ce match
              </button>
            )}
            {status === 'failed' && (
              <button type="button" onClick={() => void run(onStart, false)} disabled={busy} className="btn !py-1.5 text-xs">
                Réessayer
              </button>
            )}
            {canRelaunch && !confirming && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={busy || relaunchBlocked}
                className="btn-ghost border border-ink-600/70 !px-2.5 !py-1 text-xs text-paper-mute disabled:cursor-not-allowed disabled:opacity-50"
                title={
                  relaunchBlocked
                    ? 'Possible une fois la traduction en cours terminée'
                    : 'Administrateurs : refaire la traduction de ce match depuis le début'
                }
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                Relancer la traduction
              </button>
            )}
          </span>
        )}
      </div>

      {/* Confirmation de la relance (administrateurs) : elle jette la traduction existante. */}
      {canRelaunch && confirming && !relaunchBlocked && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-ink-700/60 pt-3">
          <p className="min-w-0 flex-1 basis-60 text-xs text-paper-dim">
            {status === 'ready'
              ? 'Relancer la traduction ? La traduction actuelle de ce match sera effacée puis refaite entièrement (plusieurs minutes de calcul).'
              : 'Relancer la traduction ? Ce match passe en tête de file, même après un échec ; ce qui est déjà traduit est repris.'}
          </p>
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => onRelaunch && void run(onRelaunch, true)} disabled={busy} className="btn-danger !px-3 !py-1.5 text-xs">
              Relancer
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="btn-ghost !py-1.5 text-xs">
              Annuler
            </button>
          </span>
        </div>
      )}

      {feedback?.message && (
        <p className={`mt-2 text-xs ${feedback.ok ? 'text-paper-mute' : 'text-loss'}`} role={feedback.ok ? 'status' : 'alert'}>
          {feedback.message}
        </p>
      )}
    </div>
  );
}
