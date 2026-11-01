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
  /** Arrêtée à la demande : « Reprendre la traduction » la relance. */
  stopped?: boolean;
}

/** État du doublage, tiré du manifeste GET /api/matches/[id]/dub. */
export interface DubBannerState {
  status: 'none' | 'waiting' | 'running' | 'partial' | 'ready' | 'disabled' | 'failed';
  reason?: string;
  /** Pendant le travail : tronçons doublés sur tronçons traduits publiés. */
  progress?: { done: number; total: number };
  /** Étape en cours, ou téléchargement des voix qui avance pendant l'attente. */
  step?: string;
  /** Arrêté à la demande : « Reprendre le doublage » le relance. */
  stopped?: boolean;
  /** Tronçons déjà doublés (jouables). */
  chunks: number;
}

/** Réponse d'une commande POST /commentary ou /dub, pour le retour affiché sous le bandeau. */
export interface CommandResult {
  ok: boolean;
  /** La traduction (ou le doublage) est en file ou en cours après la commande. */
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

/** Raison renvoyée par le serveur (en minuscule), en début de phrase. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Une ligne d'état du bandeau (traduction ou doublage). */
interface Line {
  tone: string;
  dot: string;
  spinning: boolean;
  title: string;
  detail: string | null;
  /** Seconde ligne de détail (facultative). */
  note?: string | null;
}

function StatusLine({ line }: { line: Line }) {
  return (
    <span className="flex min-w-0 items-start gap-3" role="status" aria-live="polite">
      {line.spinning ? (
        <span className="mt-1 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-flame border-t-transparent" aria-hidden="true" />
      ) : (
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${line.dot}`} aria-hidden="true" />
      )}
      <span className="min-w-0">
        <span className={`block text-sm font-semibold ${line.tone}`}>{line.title}</span>
        {line.detail && <span className="block text-xs text-paper-mute">{line.detail}</span>}
        {line.note && <span className="block text-xs text-paper-mute">{line.note}</span>}
      </span>
    </span>
  );
}

/** Ligne du doublage, ou null quand il n'y a rien à en dire (pas commencé, moteur de voix inactif). */
function dubLine(dub: DubBannerState, canStart: boolean): Line | null {
  const base = { tone: 'text-paper-dim', dot: 'bg-paper-faint', spinning: false };
  switch (dub.status) {
    case 'running': {
      const p = dub.progress;
      const listen = 'Les passages déjà doublés s’écoutent tout de suite : menu ⚙ du lecteur → Voix → « VF doublée ».';
      return {
        ...base,
        tone: 'text-flame-hot',
        spinning: true,
        title: p ? `Doublage en voix françaises · ${p.done} / ${p.total} tronçon${p.total > 1 ? 's' : ''}` : 'Doublage en voix françaises : démarrage',
        detail: dub.step ? cap(dub.step) : listen,
        note: dub.step && dub.chunks > 0 ? listen : null,
      };
    }
    case 'waiting':
      return {
        ...base,
        tone: 'text-flame-hot',
        dot: 'bg-flame',
        title: 'Doublage en attente',
        detail: dub.reason ? cap(dub.reason) : null,
        note: dub.step ? `${cap(dub.step)} (continue pendant l’attente)` : null,
      };
    case 'partial':
      if (dub.stopped) {
        return {
          ...base,
          dot: 'bg-flame/50',
          title: `Doublage arrêté (${dub.chunks} tronçon${dub.chunks > 1 ? 's' : ''} doublé${dub.chunks > 1 ? 's' : ''})`,
          detail: canStart ? '« Reprendre le doublage » le relance là où il s’est arrêté.' : 'Les passages pas encore doublés restent en VO.',
        };
      }
      return {
        ...base,
        dot: 'bg-flame/50',
        title: `Doublé en partie (${dub.chunks} tronçon${dub.chunks > 1 ? 's' : ''})`,
        detail: dub.reason ? cap(dub.reason) : canStart ? '« Doubler ce match » complète le doublage.' : 'Les passages pas encore doublés restent en VO.',
      };
    case 'ready':
      return { ...base, tone: 'text-win', dot: 'bg-win', title: 'Voix françaises prêtes', detail: 'Menu ⚙ du lecteur → Voix → « VF doublée ».' };
    case 'failed':
      return { ...base, tone: 'text-loss', dot: 'bg-loss', title: 'Doublage impossible pour l’instant', detail: dub.reason ?? null };
    case 'none':
      return dub.stopped ? { ...base, title: 'Doublage arrêté', detail: canStart ? '« Reprendre le doublage » le relance.' : null } : null;
    default:
      return null;
  }
}

const RELAUNCH_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);
const RELAUNCH_CLASS = 'btn-ghost border border-ink-600/70 !px-2.5 !py-1 text-xs text-paper-mute disabled:cursor-not-allowed disabled:opacity-50';
const STOP_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </svg>
);

/** Confirmation d'une relance (administrateurs). */
function Confirm({ text, busy, onConfirm, onCancel }: { text: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-ink-700/60 pt-3">
      <p className="min-w-0 flex-1 basis-60 text-xs text-paper-dim">{text}</p>
      <span className="flex items-center gap-2">
        <button type="button" onClick={onConfirm} disabled={busy} className="btn-danger !px-3 !py-1.5 text-xs">
          Relancer
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="btn-ghost !py-1.5 text-xs">
          Annuler
        </button>
      </span>
    </div>
  );
}

/**
 * Bandeau d'état sous le lecteur : ce que fait la chaîne
 * audio → transcription → traduction, en une ligne, puis le doublage en
 * voix françaises, sur une seconde ligne dès qu'il a commencé.
 *
 * - Traduction automatique désactivée (Paramètres) : un match pas encore
 *   traduit affiche le bouton « Sous-titrer ce match ».
 * - « Doubler ce match » (tout utilisateur ; moteur de voix actif, match pas
 *   entièrement doublé ni déjà en file), dans les deux modes : seul ce
 *   bouton lance le doublage (et la traduction s'il le faut) ; une
 *   traduction ne le lance jamais. Mis en avant en mode « doublage ».
 * - « Arrêter le doublage » (tout utilisateur) pendant que le match est
 *   doublé ou en file : ce qui est doublé reste, et « Reprendre le
 *   doublage » (le bouton « Doubler ce match ») le relance.
 * - Administrateurs : « Relancer la traduction » et « Relancer le doublage »
 *   (avec confirmation) — refont la piste même terminée ; inactifs pendant
 *   que ce match est traduit (ou doublé).
 */
export default function CommentaryStatus({
  state,
  hasReplay,
  autoTranslate,
  vfMode = 'sous-titres',
  dub = null,
  onStart,
  onRelaunch,
  onDub,
  onDubRelaunch,
  onDubStop,
  onStop,
  position = 0,
}: {
  state: CommentaryState | null;
  hasReplay: boolean;
  /** Réglage serveur « Traduction automatique ». */
  autoTranslate: boolean;
  /** Réglage serveur « Version française ». */
  vfMode?: 'sous-titres' | 'doublage';
  /** État du doublage (manifeste), null tant qu'il n'est pas chargé. */
  dub?: DubBannerState | null;
  /** Lancement explicite : « Sous-titrer ce match », « Réessayer ». */
  onStart: () => Promise<CommandResult>;
  /** Relance forcée (administrateurs seulement ; absent sinon). */
  onRelaunch?: () => Promise<CommandResult>;
  /** Doublage explicite : « Doubler ce match ». */
  onDub?: () => Promise<CommandResult>;
  /** Doublage effacé puis refait (administrateurs seulement ; absent sinon). */
  onDubRelaunch?: () => Promise<CommandResult>;
  /** « Arrêter le doublage » : retiré de la file ou interrompu, sans rien effacer. */
  onDubStop?: () => Promise<CommandResult>;
  /** « Arrêter la traduction » : retirée de la file ou interrompue, ce qui est traduit reste. */
  onStop?: () => Promise<CommandResult>;
  /** Position de lecture (s), lue à chaque mise à jour du statut. */
  position?: number;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<null | 'traduction' | 'doublage'>(null);
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
    setConfirming(null);
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
  /** Traduction arrêtée à la demande : bouton « Reprendre la traduction ». */
  const stopped = status === 'none' && !!state.stopped && !state.reason;
  /** Match pas encore traduit, traduction automatique désactivée : bouton « Sous-titrer ce match ». */
  const manualStart = (!autoTranslate && status === 'none' && !state.reason) || stopped;
  /** « Arrêter la traduction » : pendant la traduction de ce match ou son attente. */
  const translationStop = !!onStop && (status === 'running' || status === 'queued');
  /** Match sans replay exploitable (ou introuvable) : ni traduction ni doublage possibles. */
  const noReplay = status === 'none' && !!state.reason;
  const dubStatus = dub?.status;
  const dubEngineOn = !!dub && dubStatus !== 'disabled';
  const dubStopped = !!dub?.stopped;
  const dubStart =
    !!onDub && dubEngineOn && status !== 'disabled' && !noReplay && (dubStatus === 'none' || dubStatus === 'partial' || dubStatus === 'failed');
  /** « Arrêter le doublage » : pendant le doublage de ce match ou son attente. */
  const dubStop = !!onDubStop && dubEngineOn && (dubStatus === 'running' || dubStatus === 'waiting');

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
    // File en pause (quota du service de traduction épuisé) : le serveur dit quand elle reprend.
    if (state.reason) {
      title = 'Traduction en pause';
      detail = state.reason;
    }
  } else if (status === 'failed') {
    tone = 'text-loss';
    dot = 'bg-loss';
    title = 'Traduction impossible pour l’instant';
    detail = state.reason ?? null;
  } else if (status === 'disabled') {
    title = 'Traduction des commentaires non configurée';
    detail = state.reason ?? 'Voir le README, section « Traduction des commentaires ».';
  } else if (stopped) {
    const partial = !!state.covered?.length;
    title = partial ? 'Traduction arrêtée en cours de route' : 'Traduction arrêtée';
    detail = partial
      ? 'Les sous-titres déjà traduits restent affichés ; « Reprendre la traduction » termine le match.'
      : 'La lecture ne la relance pas : « Reprendre la traduction » la relance.';
  } else if (manualStart) {
    const partial = !!state.covered?.length;
    title = partial ? 'Commentaires traduits en partie' : 'Commentaires pas encore traduits';
    if (dubStart) {
      detail = partial
        ? 'Complétez les sous-titres français (à partir de la position de lecture), ou doublez le match en voix françaises.'
        : 'Sous-titres français au fil de la lecture, en quelques minutes ; ou voix françaises (après les sous-titres, plus long).';
    } else {
      detail = partial
        ? 'Lancez la traduction pour compléter les sous-titres français (à partir de la position de lecture).'
        : 'Lancez la traduction : les sous-titres français arrivent au fil de la lecture, en quelques minutes.';
    }
  } else {
    title = 'Traduction des commentaires en préparation';
  }

  // Relance admin : inutile si la traduction n'est pas configurée ou si le
  // match n'a pas de replay exploitable ; visible mais inactive pendant que
  // ce match est traduit (la file ne relance pas un travail en cours).
  const canRelaunch = !!onRelaunch && status !== 'disabled' && !noReplay;
  const relaunchBlocked = status === 'running';
  // Relance du doublage (admin) : seulement s'il y a un doublage à refaire ; inactive pendant le doublage de ce match.
  const canRelaunchDub = !!onDubRelaunch && dubEngineOn && !noReplay && (!!dub?.chunks || dubStatus === 'ready' || dubStatus === 'failed' || dubStatus === 'running');
  const dubRelaunchBlocked = dubStatus === 'running';

  const translationLine: Line = { tone, dot, spinning, title, detail };
  const dubInfo = dub && dubEngineOn ? dubLine(dub, dubStart) : null;
  // Les deux boutons proposés : le mode « Version française » choisit celui qui est mis en avant.
  const dubFirst = vfMode === 'doublage';
  const showButtons =
    manualStart || translationStop || status === 'failed' || dubStart || dubStop || (canRelaunch && confirming !== 'traduction') || (canRelaunchDub && confirming !== 'doublage');

  return (
    <div className="panel-soft px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-60 space-y-2">
          <StatusLine line={translationLine} />
          {dubInfo && <StatusLine line={dubInfo} />}
        </div>
        {showButtons && (
          <span className="flex flex-wrap items-center gap-2">
            {manualStart && (
              <button
                type="button"
                onClick={() => void run(onStart, false)}
                disabled={busy}
                className={`${dubStart && dubFirst ? 'btn' : 'btn-primary'} !py-1.5 text-xs`}
                title={stopped ? 'Terminer la traduction des commentaires de ce match' : 'Traduire les commentaires en sous-titres français'}
              >
                {stopped ? 'Reprendre la traduction' : 'Sous-titrer ce match'}
              </button>
            )}
            {translationStop && onStop && (
              <button
                type="button"
                onClick={() => void run(onStop, true)}
                disabled={busy}
                className={RELAUNCH_CLASS}
                title="Arrêter la traduction de ce match (les sous-titres déjà traduits restent disponibles)"
              >
                {STOP_ICON}
                Arrêter la traduction
              </button>
            )}
            {status === 'failed' && (
              <button type="button" onClick={() => void run(onStart, false)} disabled={busy} className="btn !py-1.5 text-xs">
                Réessayer
              </button>
            )}
            {dubStart && onDub && (
              <button
                type="button"
                onClick={() => void run(onDub, false)}
                disabled={busy}
                className={`${dubFirst ? 'btn-primary' : 'btn'} !py-1.5 text-xs`}
                title="Traduire les commentaires (si besoin), puis les faire dire par des voix françaises"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="11" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </svg>
                {dubStopped ? 'Reprendre le doublage' : 'Doubler ce match'}
              </button>
            )}
            {dubStop && onDubStop && (
              <button
                type="button"
                onClick={() => void run(onDubStop, true)}
                disabled={busy}
                className={RELAUNCH_CLASS}
                title="Arrêter le doublage de ce match (les passages déjà doublés restent disponibles)"
              >
                {STOP_ICON}
                Arrêter le doublage
              </button>
            )}
            {canRelaunch && confirming !== 'traduction' && (
              <button
                type="button"
                onClick={() => setConfirming('traduction')}
                disabled={busy || relaunchBlocked}
                className={RELAUNCH_CLASS}
                title={
                  relaunchBlocked
                    ? 'Possible une fois la traduction en cours terminée'
                    : 'Administrateurs : refaire la traduction de ce match depuis le début'
                }
              >
                {RELAUNCH_ICON}
                Relancer la traduction
              </button>
            )}
            {canRelaunchDub && confirming !== 'doublage' && (
              <button
                type="button"
                onClick={() => setConfirming('doublage')}
                disabled={busy || dubRelaunchBlocked}
                className={RELAUNCH_CLASS}
                title={dubRelaunchBlocked ? 'Possible une fois le doublage en cours terminé' : 'Administrateurs : effacer le doublage de ce match et le refaire'}
              >
                {RELAUNCH_ICON}
                Relancer le doublage
              </button>
            )}
          </span>
        )}
      </div>

      {/* Confirmation de la relance (administrateurs) : elle jette la traduction existante. */}
      {canRelaunch && confirming === 'traduction' && !relaunchBlocked && onRelaunch && (
        <Confirm
          busy={busy}
          onConfirm={() => void run(onRelaunch, true)}
          onCancel={() => setConfirming(null)}
          text={
            status === 'ready'
              ? 'Relancer la traduction ? La traduction actuelle de ce match sera effacée puis refaite entièrement (plusieurs minutes de calcul).'
              : 'Relancer la traduction ? Ce match passe en tête de file, même après un échec ; ce qui est déjà traduit est repris.'
          }
        />
      )}

      {/* Confirmation de la relance du doublage (administrateurs) : elle efface le doublage existant. */}
      {canRelaunchDub && confirming === 'doublage' && !dubRelaunchBlocked && onDubRelaunch && (
        <Confirm
          busy={busy}
          onConfirm={() => void run(onDubRelaunch, true)}
          onCancel={() => setConfirming(null)}
          text="Relancer le doublage ? Les voix françaises de ce match seront effacées puis refaites entièrement (long calcul pour le serveur ; les sous-titres ne sont pas refaits)."
        />
      )}

      {feedback?.message && (
        <p className={`mt-2 text-xs ${feedback.ok ? 'text-paper-mute' : 'text-loss'}`} role={feedback.ok ? 'status' : 'alert'}>
          {feedback.message}
        </p>
      )}
    </div>
  );
}
