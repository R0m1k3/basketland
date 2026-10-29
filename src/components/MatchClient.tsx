'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import VideoPlayer, { type Subtitle } from '@/components/VideoPlayer';

interface Props {
  matchId: number;
  masterUrl: string | null;
  initialOffset: number;
}

interface Anchor {
  period: number;
  clock_sec: number;
  video_ts: number;
  method: string;
}

interface SyncState {
  settings?: { global_offset?: number; quarter_offsets?: Record<string, number> };
  anchors?: Anchor[];
  analysis?: { status?: string; reason?: string };
}

const fmt = (s: number) => {
  const m = Math.floor(Math.max(0, s) / 60);
  const sec = Math.floor(Math.max(0, s) % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

/**
 * Conteneur client du lecteur : charge les sous-titres, gère le décalage
 * persistant, la calibration (analyse automatique, ancres manuelles) et le
 * bouton « Statistiques ».
 */
export default function MatchClient({ matchId, masterUrl, initialOffset }: Props) {
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [offset, setOffset] = useState(initialOffset);
  const [quarterOffsets, setQuarterOffsets] = useState<Record<string, number>>({});
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [analysis, setAnalysis] = useState<string>('');
  const [showCalibration, setShowCalibration] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [message, setMessage] = useState('');

  const loadSync = useCallback(() => {
    fetch(`/api/matches/${matchId}/sync`)
      .then((r) => r.json())
      .then((d: SyncState) => {
        setAnchors(d.anchors ?? []);
        if (d.settings?.quarter_offsets) setQuarterOffsets(d.settings.quarter_offsets);
        if (d.analysis?.status) setAnalysis(d.analysis.status);
      })
      .catch(() => undefined);
  }, [matchId]);

  /**
   * Recharge les sous-titres : le serveur les régénère (positions video_ts
   * recalculées) après chaque écriture de calibration. Sans ce rechargement,
   * le lecteur garde les anciennes positions et le calibrage paraît sans
   * effet jusqu'au rechargement de la page.
   */
  // Ref de l'offset courant : permet à `reloadSubtitles` de comparer sans
  // être reconstruite à chaque changement d'offset (sinon le polling se
  // redémarre à chaque clic sur les boutons ±).
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  // Compteur de requête : deux réponses arrivant dans le désordre (deux
  // clics rapides sur ±) doivent être ignorées si elles ne sont pas la
  // dernière. Comparer l'offset courant à celui du serveur ne suffisait
  // pas : la garde était satisfaite au moment de la réponse, donc la
  // réponse désuète écrasait quand même l'état local.
  const reqSeq = useRef(0);

  const reloadSubtitles = useCallback(() => {
    const myId = ++reqSeq.current;
    fetch(`/api/matches/${matchId}/subtitles`)
      .then((r) => r.json())
      .then((d: { subtitles?: Subtitle[]; settings?: { global_offset?: number } }) => {
        // Une réponse plus récente a déjà été traitée : on jette celle-ci.
        if (myId !== reqSeq.current) return;
        setSubtitles(d.subtitles ?? []);
        setOffset((cur) => d.settings?.global_offset ?? cur);
      })
      .catch(() => undefined);
  }, [matchId]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/matches/${matchId}/subtitles`)
      .then((r) => r.json())
      .then((d: { subtitles?: Subtitle[]; settings?: { global_offset?: number } }) => {
        if (cancelled) return;
        setSubtitles(d.subtitles ?? []);
        if (typeof d.settings?.global_offset === 'number') setOffset(d.settings.global_offset);
      })
      .catch(() => undefined);
    loadSync();
    return () => {
      cancelled = true;
    };
  }, [matchId, loadSync]);

  /**
   * L'analyse automatique tourne en tâche de fond (5 à 8 min de CPU pour un
   * scan complet). On interroge son état périodiquement et on recharge la VF
   * dès qu'elle se termine.
   */
  useEffect(() => {
    if (analysis !== 'running') return;
    const timer = setInterval(() => {
      fetch(`/api/matches/${matchId}/sync`)
        .then((r) => r.json())
        .then((d: SyncState) => {
          const st = d.analysis?.status;
          if (st && st !== 'running') {
            setAnalysis(st);
            reloadSubtitles();
            loadSync();
          }
        })
        .catch(() => undefined);
    }, 15_000);
    return () => clearInterval(timer);
  }, [analysis, matchId, loadSync, reloadSubtitles]);

  /**
   * Écriture de calibration : POST vers /sync.
   *
   * Vérifie `res.ok` et remonte le message d'erreur du serveur. Sans cela,
   * un refus (403 origine, 415 Content-Type) passait silencieusement et
   * l'interface affichait quand même une réussite.
   */
  const writeSync = useCallback(
    async (body: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> => {
      try {
        const res = await fetch(`/api/matches/${matchId}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        if (!res.ok) return { ok: false, message: d.error ?? `Échec de l'écriture (${res.status}).` };
        return { ok: true, message: d.message };
      } catch {
        return { ok: false, message: 'Échec de l’écriture (réseau).' };
      }
    },
    [matchId],
  );

  /** Persiste le décalage côté serveur puis recharge les sous-titres. */
  const changeOffset = useCallback(
    (next: number) => {
      setOffset(next);
      void writeSync({ global_offset: next }).then((r) => {
        if (!r.ok && r.message) setMessage(r.message);
        reloadSubtitles();
      });
    },
    [writeSync, reloadSubtitles],
  );

  /** Ajuste le décalage d'un seul quart. */
  const changeQuarterOffset = useCallback(
    (period: number, delta: number) => {
      const next = { ...quarterOffsets, [String(period)]: (quarterOffsets[String(period)] ?? 0) + delta };
      setQuarterOffsets(next);
      void writeSync({ quarter_offsets: next }).then((r) => {
        if (!r.ok && r.message) setMessage(r.message);
        reloadSubtitles();
      });
    },
    [writeSync, quarterOffsets, reloadSubtitles],
  );

  /** Lance l'analyse automatique (OCR du chrono à l'écran + énergie audio). */
  const runAnalysis = useCallback(async () => {
    setMessage('Analyse en cours…');
    try {
      const res = await fetch(`/api/matches/${matchId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze' }),
      });
      const d = await res.json();
      setMessage(d.message ?? (d.started ? 'Analyse lancée.' : 'Analyse impossible.'));
      loadSync();
    } catch {
      setMessage('Analyse impossible.');
    }
  }, [matchId, loadSync]);

  /** Pose une ancre : l'action sélectionnée se passe à la position courante. */
  const setAnchor = useCallback(
    async (seq: number) => {
      const r = await writeSync({ action: 'anchor', seq, video_ts: currentTime });
      if (!r.ok) {
        setMessage(r.message ?? 'Impossible de poser l’ancre.');
        return;
      }
      setMessage(r.message ?? 'Ancre posée.');
      loadSync();
      // Le serveur a recalculé les positions : on recharge la VF.
      reloadSubtitles();
    },
    [matchId, currentTime, loadSync, reloadSubtitles, writeSync],
  );

  const removeAnchor = useCallback(
    async (period: number, clockSec: number) => {
      const r = await writeSync({ action: 'delete-anchor', period, clock_sec: clockSec });
      if (!r.ok && r.message) setMessage(r.message);
      loadSync();
      reloadSubtitles();
    },
    [loadSync, reloadSubtitles, writeSync],
  );

  const periods = [1, 2, 3, 4, 5];

  return (
    <>
      <VideoPlayer
        masterUrl={masterUrl}
        subtitles={subtitles}
        offset={offset}
        onOffsetChange={changeOffset}
        onTimeChange={setCurrentTime}
      />

      {subtitles.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          Sous-titres français générés à partir du play-by-play, calés sur le commentaire original
          de la diffusion. Ajustez le décalage si nécessaire — la valeur est conservée.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        {/*
          Le panneau de statistiques est rendu par la page, qui ne l'affiche
          que si le match est terminé (`isFinal`). Ce bouton ne faisait que
          changer son propre libellé (`showStats` n'était jamais lu) : il
          était donc visible et actif sur un match en cours, sans effet.
          Il est retiré au profit du seul panneau conditionné.
        */}
        {masterUrl && (
          <button
            type="button"
            onClick={() => setShowCalibration((v) => !v)}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:border-slate-500"
          >
            {showCalibration ? 'Masquer la calibration' : 'Calibrer la synchronisation'}
          </button>
        )}
      </div>

      {showCalibration && (
        <section className="mt-4 space-y-4 rounded-xl border border-slate-800 bg-[#111621] p-4">
          <h3 className="text-sm font-semibold text-white">Calibration de la VF</h3>

          <p className="text-xs text-slate-400">
            Le replay coupe une trentaine de minutes de contenu : le décalage n’est donc pas
            uniforme. Deux leviers — l’analyse automatique et l’ancrage manuel — permettent de
            recaler la VF précisément.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={runAnalysis}
              className="rounded-lg bg-court-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-court-600"
            >
              Calibrer automatiquement
            </button>
            {analysis && (
              <span className="text-xs text-slate-400">
                Analyse : {analysis}
                {message ? ` — ${message}` : ''}
              </span>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Décalage par quart
            </h4>
            <div className="flex flex-wrap gap-3">
              {periods.map((p) => (
                <div key={p} className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-500">Q{p}</span>
                  <button
                    type="button"
                    onClick={() => changeQuarterOffset(p, -0.5)}
                    className="rounded border border-slate-700 px-1.5 py-0.5 hover:border-slate-500"
                  >
                    −
                  </button>
                  <span className="w-14 text-center tabular-nums text-slate-200">
                    {(quarterOffsets[String(p)] ?? 0).toFixed(1)} s
                  </span>
                  <button
                    type="button"
                    onClick={() => changeQuarterOffset(p, 0.5)}
                    className="rounded border border-slate-700 px-1.5 py-0.5 hover:border-slate-500"
                  >
                    +
                  </button>
                </div>
              ))}
            </div>
          </div>

          {anchors.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Ancres ({anchors.length})
              </h4>
              <ul className="space-y-1 text-xs">
                {anchors.map((a) => (
                  <li key={`${a.period}-${a.clock_sec}`} className="flex items-center gap-2">
                    <span className="text-slate-300">
                      Q{a.period} {fmt(a.clock_sec)}
                    </span>
                    <span className="tabular-nums text-slate-500">→ {fmt(a.video_ts)} vidéo</span>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                      {a.method}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAnchor(a.period, a.clock_sec)}
                      className="text-slate-500 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {subtitles.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Ancrer manuellement — cliquez sur la ligne qui passe maintenant (
                {fmt(currentTime)})
              </h4>
              <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-slate-800 p-2">
                {subtitles.map((s) => (
                  <button
                    key={s.seq}
                    type="button"
                    onClick={() => setAnchor(s.seq)}
                    className="block w-full rounded px-2 py-1 text-left text-xs text-slate-300 hover:bg-slate-800"
                  >
                    <span className="mr-2 tabular-nums text-slate-500">{fmt(s.video_ts)}</span>
                    {s.text}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </>
  );
}
