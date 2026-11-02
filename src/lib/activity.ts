/**
 * « En cours de traitement » : ce que fait le serveur en ce moment
 * (traduction des commentaires, analyse vidéo), pour le panneau de
 * l'accueil (GET /api/activity, rafraîchi toutes les 10 s).
 */
import { analysisActivity } from './analysis';
import { commentaryActivity } from './commentary';
import * as db from './db';
import { activeViewers } from './viewers';

export interface ActivityMatch {
  id: number;
  away: string;
  home: string;
  awayName: string;
  homeName: string;
}

export interface ActivityTask {
  kind: 'traduction' | 'analyse';
  match: ActivityMatch;
  /** Étape en clair (« Transcription des commentateurs », « Analyse : balayage »…). */
  label: string;
  /** Avancement 0-100, ou null si inconnu. */
  pct: number | null;
  /** En pause : une vidéo est regardée. */
  paused: boolean;
  /** Le match est regardé en ce moment (traduction à la demande). */
  watched: boolean;
}

export interface Activity {
  tasks: ActivityTask[];
  queued: { kind: 'traduction' | 'analyse'; match: ActivityMatch }[];
  /** Une vidéo est regardée : les tâches de fond attendent. */
  watching: boolean;
}

const PHASE: Record<string, string> = {
  extraction: 'Lecture de l’audio',
  preparation: 'Chargement des modèles',
  transcription: 'Transcription des commentateurs',
  traduction: 'Traduction en français',
};

function matchOf(id: number): ActivityMatch | null {
  const m = db.getMatch(id);
  return m ? { id, away: m.away_abbr, home: m.home_abbr, awayName: m.away_name, homeName: m.home_name } : null;
}

export function currentActivity(): Activity {
  const c = commentaryActivity();
  const a = analysisActivity();
  const watching = activeViewers().length > 0;
  const tasks: ActivityTask[] = [];
  if (c.running) {
    const match = matchOf(c.running.matchId);
    if (match) {
      const pct = c.running.phase && c.running.phase !== 'preparation' && c.running.total ? Math.round((c.running.done / c.running.total) * 100) : null;
      tasks.push({
        kind: 'traduction',
        match,
        label: c.running.phase ? PHASE[c.running.phase] : 'Démarrage',
        pct,
        paused: false,
        watched: c.running.watched,
      });
    }
  }
  for (const r of a.running) {
    const match = matchOf(r.matchId);
    if (!match) continue;
    const paused = r.phase === 'en pause pendant la lecture';
    tasks.push({
      kind: 'analyse',
      match,
      label: paused ? 'Analyse vidéo en pause' : `Analyse vidéo · ${r.phase}`,
      pct: !paused && r.total ? Math.round((r.done / r.total) * 100) : null,
      paused,
      watched: false,
    });
  }
  const queued: Activity['queued'] = [];
  for (const id of c.queued) {
    const match = matchOf(id);
    if (match) queued.push({ kind: 'traduction', match });
  }
  for (const id of a.queued) {
    const match = matchOf(id);
    if (match) queued.push({ kind: 'analyse', match });
  }
  return { tasks, queued, watching };
}
