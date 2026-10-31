/**
 * État des files médias (traduction, doublage, analyse) pour les pages
 * encore rendues par Node.
 *
 * Les files tournent dans le serveur Rust (étape 6b de docs/migration-rust.md) :
 * Node ne traduit, ne double ni n'analyse plus rien, il n'a donc plus cet état
 * en mémoire. Ses pages le lisent chez Rust, `POST <BL_RUST_URL>/api/internal/media-state`
 * (jeton d'ingestion ; `BL_RUST_URL` posé par server/src/node.rs), en
 * appelant `loadMediaState()` avant de se calculer ; les fonctions
 * synchrones (`runningMatchId`, utilisé par `toViews`) rendent le dernier
 * état lu. Sans `BL_RUST_URL` (Node lancé seul : tests, développement),
 * l'état est celui des files de ce processus.
 */
import { currentActivity, type Activity } from './activity';
import { commentaryDisabledReason, commentaryRunningMatchId } from './commentary';
import { dubDisabledReason } from './dub';
import { ingestToken } from './ingest';

export interface MediaState {
  running_match_id: number | null;
  activity: Activity;
  commentary_disabled_reason: string | null;
  dub_disabled_reason: string | null;
}

const EMPTY: MediaState = {
  running_match_id: null,
  activity: { tasks: [], queued: [], watching: false },
  commentary_disabled_reason: null,
  dub_disabled_reason: null,
};

const g = globalThis as unknown as { __mediaState?: MediaState };

function rustUrl(): string | null {
  return process.env.BL_RUST_URL || null;
}

/**
 * Lit l'état des files ; `dub` : aussi `dubDisabledReason()` (charge le moteur
 * de voix : page Paramètres d'un administrateur seule). Serveur Rust
 * injoignable : dernier état lu (sans raison de désactivation du doublage), ou
 * un état vide.
 */
export async function loadMediaState(o: { dub?: boolean } = {}): Promise<MediaState> {
  const base = rustUrl();
  if (!base) {
    return {
      running_match_id: commentaryRunningMatchId(),
      activity: currentActivity(),
      commentary_disabled_reason: commentaryDisabledReason(),
      dub_disabled_reason: o.dub ? await dubDisabledReason() : null,
    };
  }
  try {
    const res = await fetch(new URL('/api/internal/media-state', base), {
      method: 'POST',
      headers: { authorization: `Bearer ${ingestToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ dub: !!o.dub }),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = (await res.json()) as MediaState;
    g.__mediaState = s;
    return s;
  } catch (e) {
    console.error('[pages] état des files du serveur Rust illisible :', (e as Error).message);
    return { ...(g.__mediaState ?? EMPTY), dub_disabled_reason: null };
  }
}

/** `commentaryRunningMatchId` : d'après le dernier état lu par `loadMediaState` quand les files tournent dans Rust. */
export function runningMatchId(): number | null {
  return rustUrl() ? (g.__mediaState?.running_match_id ?? null) : commentaryRunningMatchId();
}
