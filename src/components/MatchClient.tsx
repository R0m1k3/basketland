'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import VideoPlayer, { type Marker } from '@/components/VideoPlayer';
import CommentaryStatus, { type CommandResult, type CommentaryState, type DubBannerState } from '@/components/match/CommentaryStatus';
import { Playback, PlaybackContext, SEEK_EVENT, type Subtitle } from '@/components/match/playback';
import { periodName } from '@/components/match/format';

/** Action compacte transmise par la page : [seq, période, chrono (s), chrono affiché]. */
export type PlayLite = [number, number, number, string];
/** Position vidéo estimée d'une action (calée par l'analyse du bandeau) : [seq, secondes]. */
export type PlayPosition = [number, number];

interface Props {
  matchId: number;
  video: { kind: 'hls' | 'mp4' | null; src: string | null; duration: number | null };
  awayAbbr: string;
  homeAbbr: string;
  plays: PlayLite[];
  positions: PlayPosition[];
  /**
   * Réglage « Traduction automatique » : activé, la traduction part toute
   * seule une fois la lecture lancée ; désactivé, seulement sur un clic
   * « Sous-titrer ce match » (ou « Doubler ce match »).
   */
  autoTranslate: boolean;
  /**
   * Réglage « Version française » : en mode « doublage », le lecteur part en
   * « VF doublée » tant que l'utilisateur n'a rien choisi.
   */
  vfMode: 'sous-titres' | 'doublage';
  /** Administrateur : boutons « Relancer la traduction » et « Relancer le doublage ». */
  isAdmin: boolean;
}

/** Manifeste du doublage (GET/POST /dub), réduit à ce que montre le bandeau. */
interface DubManifestLite {
  status?: DubBannerState['status'];
  reason?: string;
  progress?: { done: number; total: number };
  chunks?: unknown[];
}

function toDubBanner(d: DubManifestLite): DubBannerState | null {
  if (!d.status) return null;
  return { status: d.status, reason: d.reason, progress: d.progress, chunks: Array.isArray(d.chunks) ? d.chunks.length : 0 };
}

function sameDub(a: DubBannerState | null, b: DubBannerState | null): boolean {
  return (
    a === b ||
    (!!a && !!b && a.status === b.status && a.reason === b.reason && a.chunks === b.chunks && a.progress?.done === b.progress?.done && a.progress?.total === b.progress?.total)
  );
}

const POLL_MS = 12_000;
/** La traduction démarre quand le lecteur a autant d'avance chargée (s)… */
const START_BUFFER_SEC = 15;
/** …ou au plus tard après ce délai. */
const START_MAX_WAIT_MS = 20_000;

function sameSubtitles(a: Subtitle[], b: Subtitle[]): boolean {
  return a.length === b.length && a.every((s, i) => s.seq === b[i].seq && s.video_ts === b[i].video_ts && s.end_ts === b[i].end_ts && s.text === b[i].text);
}

/**
 * Salle de projection : lecteur + sous-titres français des commentateurs.
 *
 * L'état temporel ne vit PAS ici : l'horloge `Playback` (hors React) est
 * partagée par contexte. Ce composant ne re-rend qu'au chargement des
 * sous-titres et aux changements d'état de la traduction.
 */
export default function MatchClient({ matchId, video, awayAbbr, homeAbbr, plays, positions, autoTranslate, vfMode, isAdmin }: Props) {
  const playback = useMemo(() => new Playback(), []);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [commentary, setCommentary] = useState<CommentaryState | null>(null);
  // Réglage vu par le bandeau : le serveur peut répondre qu'il a été
  // désactivé depuis l'ouverture de la page (bouton « Sous-titrer ce match »).
  const [auto, setAuto] = useState(autoTranslate);
  useEffect(() => setAuto(autoTranslate), [autoTranslate]);
  const playerRef = useRef<HTMLDivElement>(null);

  // Un compteur écarte les réponses arrivées dans le désordre.
  const reqSeq = useRef(0);
  const loadSubtitles = useCallback(() => {
    const my = ++reqSeq.current;
    // La position de lecture accompagne chaque interrogation : le serveur
    // traduit en priorité à partir de là (et sait que quelqu'un regarde).
    const t = Math.max(0, Math.floor(playback.currentTime));
    return fetch(`/api/matches/${matchId}/subtitles?t=${t}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { subtitles?: Subtitle[]; commentary?: CommentaryState }) => {
        if (my !== reqSeq.current) return null;
        // Pendant la traduction, chaque tranche publiée s'ajoute à la liste :
        // le lecteur la reçoit par props (→ playback.setSubtitles) et l'affiche
        // sans interrompre la lecture. Liste inchangée : même référence, pas
        // de re-rendu du lecteur à chaque interrogation.
        const next = (d.subtitles ?? []).slice().sort((a, b) => a.video_ts - b.video_ts || a.seq - b.seq);
        setSubtitles((prev) => (sameSubtitles(prev, next) ? prev : next));
        setCommentary(d.commentary ?? null);
        return d.commentary ?? null;
      })
      .catch(() => null);
  }, [matchId, playback]);

  // `manual` : clic explicite (« Sous-titrer ce match », « Réessayer ») — mis en
  // file même pendant le délai d'attente après un échec. `retry` : relance
  // forcée, réservée aux administrateurs.
  const command = useCallback(
    (action: 'start' | 'retry', manual = false): Promise<CommandResult> =>
      fetch(`/api/matches/${matchId}/commentary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manual ? { action, manual: true } : { action }),
      })
        .then(async (r) => {
          const d = (await r.json().catch(() => ({}))) as { commentary?: CommentaryState; message?: string; error?: string; autoTranslate?: boolean };
          if (d.commentary) setCommentary(d.commentary);
          if (d.autoTranslate === false) setAuto(false);
          const accepted = r.ok && (d.commentary?.status === 'queued' || d.commentary?.status === 'running');
          return { ok: r.ok, accepted, message: d.message ?? d.error ?? (r.ok ? null : `Erreur ${r.status}`) };
        })
        .catch(() => ({ ok: false, accepted: false, message: 'Serveur injoignable. Vérifiez votre connexion.' })),
    [matchId],
  );

  // Chargement initial. La traduction n'est PAS lancée tout de suite : la
  // vidéo d'abord. Elle démarre dès que le lecteur a ~15 s d'avance en
  // mémoire (ou au plus tard 20 s après l'ouverture), pour que l'extraction
  // audio et le chargement des modèles ne volent pas la bande passante et le
  // processeur du démarrage de la lecture. Traduction automatique
  // désactivée : rien ne part sans un clic sur « Sous-titrer ce match ».
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    void loadSubtitles().then((c) => {
      if (cancelled || !autoTranslate || !video.src || !c || (c.status !== 'none' && c.status !== 'queued')) return;
      const t0 = Date.now();
      timer = setInterval(() => {
        if (playback.bufferedAhead() >= START_BUFFER_SEC || Date.now() - t0 >= START_MAX_WAIT_MS) {
          clearInterval(timer);
          if (!cancelled) void command('start');
        }
      }, 1000);
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [matchId, video.src, autoTranslate, loadSubtitles, command, playback]);

  // Signe de vie pendant la LECTURE (toutes les 20 s, et au lancement) :
  // tant qu'il arrive, les tâches de fond du serveur (traduction d'autres
  // matchs, analyse vidéo) s'effacent pour laisser la bande passante et le
  // processeur au lecteur.
  useEffect(() => {
    const beat = () => {
      const v = playback.element;
      if (!v || v.paused) return;
      fetch(`/api/matches/${matchId}/watching`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: Math.floor(v.currentTime) }),
        keepalive: true,
      }).catch(() => undefined);
    };
    const timer = setInterval(beat, 20_000);
    const onPlay = (e: Event) => {
      if (e.target instanceof HTMLVideoElement) beat();
    };
    document.addEventListener('play', onPlay, true);
    return () => {
      clearInterval(timer);
      document.removeEventListener('play', onPlay, true);
    };
  }, [matchId, playback]);

  // Suivi tant que la traduction est en file ou en cours.
  const status = commentary?.status;
  useEffect(() => {
    if (status !== 'running' && status !== 'queued') return;
    const timer = setInterval(() => void loadSubtitles(), POLL_MS);
    // Saut dans la vidéo : la nouvelle position part tout de suite (le
    // serveur réoriente la traduction), sans attendre l'interrogation suivante.
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const onSeeked = (e: Event) => {
      if (!(e.target instanceof HTMLVideoElement)) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => void loadSubtitles(), 800);
    };
    document.addEventListener('seeked', onSeeked, true); // « seeked » ne remonte pas : capture
    return () => {
      clearInterval(timer);
      clearTimeout(debounce);
      document.removeEventListener('seeked', onSeeked, true);
    };
  }, [status, loadSubtitles]);

  const startManually = useCallback(() => command('start', true), [command]);
  const relaunch = useCallback(() => command('retry'), [command]);

  // Doublage : manifeste lu SANS `?t=` (aucun effet de bord : seul le lecteur,
  // VF doublée choisie, signale la position), au chargement, quand l'état de
  // la traduction change, et toutes les 12 s tant qu'il est en file ou en cours.
  const [dub, setDub] = useState<DubBannerState | null>(null);
  const dubSeq = useRef(0);
  const loadDub = useCallback(() => {
    const my = ++dubSeq.current;
    return fetch(`/api/matches/${matchId}/dub`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<DubManifestLite>) : null))
      .then((d) => {
        if (!d || my !== dubSeq.current) return;
        const next = toDubBanner(d);
        setDub((prev) => (sameDub(prev, next) ? prev : next));
      })
      .catch(() => undefined);
  }, [matchId]);
  useEffect(() => {
    if (video.src) void loadDub();
  }, [status, video.src, loadDub]);
  const dubStatus = dub?.status;
  useEffect(() => {
    if (dubStatus !== 'waiting' && dubStatus !== 'running') return;
    const timer = setInterval(() => void loadDub(), POLL_MS);
    return () => clearInterval(timer);
  }, [dubStatus, loadDub]);

  // « Doubler ce match » (tout utilisateur) ; `retry` : « Relancer le doublage », administrateurs.
  const dubCommand = useCallback(
    (action: 'start' | 'retry'): Promise<CommandResult> => {
      ++dubSeq.current; // une lecture en vol ne doit pas écraser la réponse de la commande
      return fetch(`/api/matches/${matchId}/dub`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
        .then(async (r) => {
          const d = (await r.json().catch(() => ({}))) as { dub?: DubManifestLite; commentary?: CommentaryState; message?: string; error?: string };
          if (d.dub) setDub(toDubBanner(d.dub));
          if (d.commentary) setCommentary(d.commentary);
          const accepted = r.ok && (d.dub?.status === 'waiting' || d.dub?.status === 'running');
          return { ok: r.ok, accepted, message: d.message ?? d.error ?? (r.ok ? null : `Erreur ${r.status}`) };
        })
        .catch(() => ({ ok: false, accepted: false, message: 'Serveur injoignable. Vérifiez votre connexion.' }));
    },
    [matchId],
  );
  const startDub = useCallback(() => dubCommand('start'), [dubCommand]);
  const relaunchDub = useCallback(() => dubCommand('retry'), [dubCommand]);

  // Positions des actions, triées par seq.
  const pos = useMemo(() => positions.slice().sort((a, b) => a[0] - b[0]), [positions]);
  const bySeq = useMemo(() => new Map(plays.map((p) => [p[0], p])), [plays]);

  // Repères de quart sur la barre de progression.
  const markers = useMemo<Marker[]>(() => {
    const seen = new Set<number>();
    const out: Marker[] = [];
    for (const [seq, t] of pos) {
      const p = bySeq.get(seq);
      if (!p || seen.has(p[1])) continue;
      seen.add(p[1]);
      out.push({ t, label: periodName(p[1]) });
    }
    return out;
  }, [pos, bySeq]);

  // « Revoir l'action » depuis le play-by-play : position estimée d'une action quelconque.
  useEffect(() => {
    const onSeek = (e: Event) => {
      const seq = (e as CustomEvent<{ seq: number }>).detail?.seq;
      if (typeof seq !== 'number' || !pos.length) return;
      let ref = pos[0];
      for (const p of pos) {
        if (p[0] <= seq) ref = p;
        else break;
      }
      const target = bySeq.get(seq);
      const refPlay = bySeq.get(ref[0]);
      let t = ref[1];
      if (target && refPlay && target[1] === refPlay[1]) {
        const gap = refPlay[2] - target[2]; // le chrono décroît
        if (gap > 0 && gap < 90) t += gap;
      }
      playback.seek(Math.max(0, t - 3), true);
      playerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    window.addEventListener(SEEK_EVENT, onSeek);
    return () => window.removeEventListener(SEEK_EVENT, onSeek);
  }, [pos, bySeq, playback]);

  return (
    <PlaybackContext.Provider value={playback}>
      <section id="replay" aria-label="Replay" className="space-y-3">
        <div ref={playerRef} className="-mx-4 sm:mx-0">
          <VideoPlayer
            matchId={matchId}
            kind={video.kind}
            src={video.src}
            subtitles={subtitles}
            markers={markers}
            awayAbbr={awayAbbr}
            homeAbbr={homeAbbr}
            durationHint={video.duration}
            dubDefault={vfMode === 'doublage'}
          />
        </div>
        <CommentaryStatus
          state={commentary}
          hasReplay={!!video.src}
          autoTranslate={auto}
          vfMode={vfMode}
          dub={dub}
          onStart={startManually}
          onRelaunch={isAdmin ? relaunch : undefined}
          onDub={startDub}
          onDubRelaunch={isAdmin ? relaunchDub : undefined}
          position={playback.currentTime}
        />
        {commentary?.status === 'ready' && subtitles.length > 0 && (
          <p className="text-right text-xs text-paper-faint">
            <a href={`/api/matches/${matchId}/subtitles.vtt`} className="underline decoration-ink-500 underline-offset-2 hover:text-paper">
              Exporter les sous-titres (WebVTT)
            </a>
          </p>
        )}
      </section>
    </PlaybackContext.Provider>
  );
}
