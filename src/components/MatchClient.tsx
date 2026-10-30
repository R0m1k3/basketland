'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import VideoPlayer, { type Marker } from '@/components/VideoPlayer';
import CommentaryStatus, { type CommentaryState } from '@/components/match/CommentaryStatus';
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
}

const POLL_MS = 12_000;

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
export default function MatchClient({ matchId, video, awayAbbr, homeAbbr, plays, positions }: Props) {
  const playback = useMemo(() => new Playback(), []);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [commentary, setCommentary] = useState<CommentaryState | null>(null);
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

  const command = useCallback(
    (action: 'start' | 'retry') =>
      fetch(`/api/matches/${matchId}/commentary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
        .then((r) => (r.ok ? (r.json() as Promise<{ commentary?: CommentaryState }>) : null))
        .then((d) => d?.commentary && setCommentary(d.commentary))
        .catch(() => undefined),
    [matchId],
  );

  // Chargement initial ; une fiche ouverte passe en tête de file.
  useEffect(() => {
    void loadSubtitles().then((c) => {
      if (video.src && c && (c.status === 'none' || c.status === 'queued')) void command('start');
    });
    // L'analyse du bandeau (positions des actions pour « Revoir l'action »)
    // tourne aussi en tâche de fond ; on la priorise de la même façon.
    if (video.src) {
      fetch(`/api/matches/${matchId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze' }),
      }).catch(() => undefined);
    }
  }, [matchId, video.src, loadSubtitles, command]);

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

  const retry = useCallback(() => void command('retry'), [command]);

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
            kind={video.kind}
            src={video.src}
            subtitles={subtitles}
            markers={markers}
            awayAbbr={awayAbbr}
            homeAbbr={homeAbbr}
            durationHint={video.duration}
          />
        </div>
        <CommentaryStatus state={commentary} hasReplay={!!video.src} onRetry={retry} position={playback.currentTime} />
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
