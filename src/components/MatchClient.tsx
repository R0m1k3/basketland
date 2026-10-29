'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import VideoPlayer, { type Marker } from '@/components/VideoPlayer';
import Transcript, { type PlayClock } from '@/components/match/Transcript';
import SyncPanel, { SyncStatus, type SyncState, type WriteResult } from '@/components/match/SyncPanel';
import { Playback, PlaybackContext, SEEK_EVENT, type Subtitle } from '@/components/match/playback';
import { periodName } from '@/components/match/format';

/** Action compacte transmise par la page : [seq, période, chrono (s), chrono affiché]. */
export type PlayLite = [number, number, number, string];

interface Props {
  matchId: number;
  video: { kind: 'hls' | 'mp4' | null; src: string | null; duration: number | null };
  awayAbbr: string;
  homeAbbr: string;
  plays: PlayLite[];
}

const POLL_MS = 12_000;

/**
 * Salle de projection : lecteur + VF en direct + synchronisation.
 *
 * L'état temporel ne vit PAS ici : l'horloge `Playback` (hors React) est
 * partagée par contexte. Ce composant ne re-rend qu'au chargement des
 * sous-titres et aux changements d'état de la synchro.
 */
export default function MatchClient({ matchId, video, awayAbbr, homeAbbr, plays }: Props) {
  const playback = useMemo(() => new Playback(), []);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [subsLoading, setSubsLoading] = useState(true);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const playerRef = useRef<HTMLDivElement>(null);

  const clocks = useMemo(() => {
    const m = new Map<number, PlayClock>();
    for (const [seq, period, , clock] of plays) m.set(seq, { period, clock });
    return m;
  }, [plays]);

  // Sous-titres : un compteur écarte les réponses arrivées dans le désordre.
  const reqSeq = useRef(0);
  const loadSubtitles = useCallback(() => {
    const my = ++reqSeq.current;
    return fetch(`/api/matches/${matchId}/subtitles`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { subtitles?: Subtitle[] }) => {
        if (my !== reqSeq.current) return;
        const list = (d.subtitles ?? []).slice().sort((a, b) => a.video_ts - b.video_ts || a.seq - b.seq);
        setSubtitles(list);
      })
      .catch(() => undefined)
      .finally(() => {
        if (my === reqSeq.current) setSubsLoading(false);
      });
  }, [matchId]);

  const loadSync = useCallback(
    () =>
      fetch(`/api/matches/${matchId}/sync`, { cache: 'no-store' })
        .then((r) => (r.ok ? (r.json() as Promise<SyncState>) : null))
        .then((d) => {
          if (d) setSync(d);
          return d;
        })
        .catch(() => null),
    [matchId],
  );

  /** Écriture de calibration ; renvoie un message FR prêt à afficher. */
  const write = useCallback(
    async (body: Record<string, unknown>, success: string): Promise<WriteResult> => {
      try {
        const res = await fetch(`/api/matches/${matchId}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = (await res.json().catch(() => ({}))) as SyncState & { error?: string };
        if (!res.ok) return { ok: false, message: d.error ? `Refusé : ${d.error}` : `Échec de l’enregistrement (${res.status}).` };
        if (d.analysis || d.anchors) setSync(d);
        else void loadSync();
        void loadSubtitles();
        return { ok: true, message: success };
      } catch {
        return { ok: false, message: 'Échec de l’enregistrement (réseau).' };
      }
    },
    [matchId, loadSync, loadSubtitles],
  );

  // Chargement initial + lancement silencieux de la synchro automatique.
  useEffect(() => {
    void loadSubtitles();
    void loadSync().then((s) => {
      const st = s?.analysis?.status;
      if (!video.src || (st !== 'none' && st !== 'estimated')) return;
      fetch(`/api/matches/${matchId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze' }),
      })
        .then((r) => (r.ok ? (r.json() as Promise<SyncState>) : null))
        .then((d) => d?.analysis && setSync(d))
        .catch(() => undefined);
    });
  }, [matchId, video.src, loadSubtitles, loadSync]);

  // Suivi de l'analyse tant qu'elle est en file ou en cours ; VF rechargée à la fin.
  const status = sync?.analysis?.status;
  const prevStatus = useRef(status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = status;
    if ((was === 'running' || was === 'queued') && status !== 'running' && status !== 'queued') void loadSubtitles();
    if (status !== 'running' && status !== 'queued') return;
    const timer = setInterval(() => void loadSync(), POLL_MS);
    return () => clearInterval(timer);
  }, [status, loadSync, loadSubtitles]);

  // Repères de quart sur la barre de progression.
  const markers = useMemo<Marker[]>(() => {
    const seen = new Set<number>();
    const out: Marker[] = [];
    for (const s of subtitles) {
      const c = clocks.get(s.seq);
      if (!c || seen.has(c.period)) continue;
      seen.add(c.period);
      out.push({ t: s.video_ts, label: periodName(c.period) });
    }
    return out;
  }, [subtitles, clocks]);

  // « Revoir l'action » depuis le play-by-play : position estimée d'une action quelconque.
  useEffect(() => {
    const bySeq = new Map(plays.map((p) => [p[0], p]));
    const sortedSubs = subtitles.slice().sort((a, b) => a.seq - b.seq);
    const onSeek = (e: Event) => {
      const seq = (e as CustomEvent<{ seq: number }>).detail?.seq;
      if (typeof seq !== 'number' || !sortedSubs.length) return;
      let ref = sortedSubs[0];
      for (const s of sortedSubs) {
        if (s.seq <= seq) ref = s;
        else break;
      }
      const target = bySeq.get(seq);
      const refPlay = bySeq.get(ref.seq);
      let t = ref.video_ts;
      if (target && refPlay && target[1] === refPlay[1]) {
        const gap = refPlay[2] - target[2]; // le chrono décroît
        if (gap > 0 && gap < 90) t += gap;
      }
      playback.seek(Math.max(0, t - 3), true);
      playerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    window.addEventListener(SEEK_EVENT, onSeek);
    return () => window.removeEventListener(SEEK_EVENT, onSeek);
  }, [plays, subtitles, playback]);

  const togglePanel = useCallback(() => setPanelOpen((o) => !o), []);

  return (
    <PlaybackContext.Provider value={playback}>
      <section id="replay" aria-label="Replay et VF" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
        <div className="min-w-0 space-y-3">
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
          <SyncStatus sync={sync} open={panelOpen} onToggle={togglePanel} />
          {panelOpen && <SyncPanel sync={sync} write={write} />}
        </div>
        <aside className="relative h-[420px] min-w-0 lg:h-auto lg:min-h-[480px]">
          <div className="h-full lg:absolute lg:inset-0">
            <Transcript subtitles={subtitles} clocks={clocks} vttHref={`/api/matches/${matchId}/subtitles.vtt`} loading={subsLoading} />
          </div>
        </aside>
      </section>
    </PlaybackContext.Provider>
  );
}
