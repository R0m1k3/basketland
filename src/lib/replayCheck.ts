/**
 * Recherche de replay « à la demande » (fiche match ouverte sur un match
 * terminé sans replay) : contrat de POST /api/matches/[id]/replay.
 *
 * Garde-fous :
 * - match terminé seulement, sans replay ou avec un replay MP4 seul (qu'on
 *   espère voir passer en HLS) ;
 * - au plus une recherche toutes les 2 min par match : mémoire du processus
 *   (deux onglets, double clic) ET `video_checked_at` (le job vient de passer) ;
 * - une recherche déjà en cours sur ce match (job ou autre demande) est
 *   rejointe, jamais doublée (`searchReplay`).
 */
import * as db from './db';
import { prioritizeOnView } from './commentary';
import { searchReplay, replaySearchInProgress, type ReplaySearchResult } from './ingest';
import { toDto, type MatchDto } from './present';
import { MANUAL_CHECK_COOLDOWN_MS } from './replayCadence';
import type { MatchRow } from './types';

type VideoMatchRow = MatchRow & { video_kind?: string | null };

/** Au-delà, la réponse part (202) et la recherche continue en arrière-plan. */
export const REPLAY_CHECK_WAIT_MS = 20_000;

export interface ReplayCheckBody {
  video: MatchDto['video'];
  /** Une recherche a été faite (ou rejointe) pour cette demande. */
  checked: boolean;
  message: string;
  /** Recherche encore en cours au moment de répondre (202). */
  pending?: boolean;
  /** Secondes avant qu'une nouvelle demande soit acceptée (429). */
  retry_after?: number;
}

export interface ReplayCheckResponse {
  status: number;
  body: ReplayCheckBody;
}

/** Dernière demande acceptée, par match (ms epoch). */
const lastRequest = new Map<number, number>();

function remember(matchId: number, now: number): void {
  // Borne la mémoire : les entrées plus vieilles que le délai ne servent plus.
  if (lastRequest.size > 500) for (const [id, at] of lastRequest) if (now - at >= MANUAL_CHECK_COOLDOWN_MS) lastRequest.delete(id);
  lastRequest.set(matchId, now);
}

const videoOf = (matchId: number, fallback: VideoMatchRow): MatchDto['video'] => toDto(db.getMatch(matchId) ?? fallback).video;

/** Raison technique de `findReplay` → phrase pour la fiche. */
export function humanReplayReason(reason: string | undefined): string {
  if (!reason || reason === 'replay non listé') return 'pas encore publié sur le site des replays';
  if (reason === 'iframe ok.ru introuvable') return 'la page du replay n’a pas encore de vidéo';
  if (reason.startsWith('vidéo trop courte')) return 'seul un résumé est en ligne pour l’instant';
  if (reason === 'flux indisponible') return 'la vidéo est encore en cours de traitement';
  if (reason.startsWith('embed ok.ru illisible')) return 'la vidéo est momentanément illisible';
  return reason;
}

function resultMessage(r: ReplaySearchResult, video: MatchDto['video']): string {
  if (!r.lookup) return 'Recherche impossible pour l’instant (site des replays injoignable). Nouvel essai automatique plus tard.';
  if (video.available && r.changed)
    return video.kind === 'mp4' ? 'Replay trouvé ! Version provisoire : la haute définition suivra.' : 'Replay trouvé !';
  if (video.available) return 'Replay disponible ; la version haute définition n’est pas encore prête.';
  return `Pas encore de replay : ${humanReplayReason(r.lookup.reason)}.`;
}

export async function requestReplayCheck(
  m: VideoMatchRow,
  o: { now?: number; waitMs?: number } = {},
): Promise<ReplayCheckResponse> {
  const now = o.now ?? Date.now();
  const current = toDto(m).video;
  if (m.status !== 'final')
    return {
      status: 409,
      body: { video: current, checked: false, message: 'Match pas encore terminé : le replay sera cherché automatiquement après le coup de sifflet final.' },
    };
  if (current.available && current.kind !== 'mp4')
    return { status: 200, body: { video: current, checked: false, message: 'Replay déjà disponible.' } };

  // Une recherche déjà en cours est rejointe sans compter dans le délai.
  if (!replaySearchInProgress(m.id)) {
    const checked = m.video_checked_at ? Date.parse(m.video_checked_at) : NaN;
    const last = Math.max(lastRequest.get(m.id) ?? 0, Number.isFinite(checked) ? checked : 0);
    const wait = last + MANUAL_CHECK_COOLDOWN_MS - now;
    if (wait > 0) {
      const s = Math.ceil(wait / 1000);
      return {
        status: 429,
        body: {
          video: current,
          checked: false,
          retry_after: s,
          message: `Recherche faite il y a moins de 2 min : nouvelle tentative possible dans ${s} s.`,
        },
      };
    }
  }
  remember(m.id, now);

  const work = searchReplay(m, { fresh: true }).then((r) => {
    // Replay trouvé : traduction des commentaires en tête de file (la
    // fonction respecte la configuration et le backoff des échecs).
    if (r.changed) {
      try {
        prioritizeOnView(m.id);
      } catch (e) {
        console.error('[replay] mise en file de la traduction impossible :', (e as Error).message);
      }
    }
    return r;
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), o.waitMs ?? REPLAY_CHECK_WAIT_MS);
  });
  const r = await Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  if (!r)
    return {
      status: 202,
      body: {
        video: videoOf(m.id, m),
        checked: true,
        pending: true,
        message: 'Recherche lancée : la page se mettra à jour dès que le replay sera trouvé.',
      },
    };
  const video = videoOf(m.id, m);
  return { status: 200, body: { video, checked: true, message: resultMessage(r, video) } };
}

/** Tests : oublie les demandes mémorisées. */
export function __resetReplayChecksForTests(): void {
  lastRequest.clear();
}
