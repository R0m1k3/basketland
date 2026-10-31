/**
 * Cron interne (setInterval) démarré par `instrumentation.ts` côté serveur Node.
 * Fréquences (spec) : calendrier 15 min, stats après match (5 min), vidéos 20 min
 * (revérification selon l'âge du match, voir replayCadence.ts),
 * VF après stats, analyse vidéo (synchro auto) 10 min, traduction des commentaires
 * 10 min. Désactivable avec DISABLE_CRON=1.
 *
 * Traduction et analyse de fond : seulement si la « Traduction automatique »
 * est activée (/parametres, activée par défaut) et dans la fenêtre autorisée
 * (COMMENTARY_NIGHT_WINDOW) — voir `queueRecentWork`. Pas de doublage de
 * fond : un match n'est doublé que sur « Doubler ce match » (dub.ts).
 *
 * Jobs repris par le serveur Rust (`BL_RUST_JOBS`, posé par server/src/node.rs) :
 * Node ne les lance plus, voir `rustJobs`.
 */
import { countMatches } from './db';
import { currentSeason } from './time';
import { syncSchedule, syncSeason, syncStats, syncSubtitles, syncVideos } from './ingest';
import { enqueueRecentAnalyses } from './analysis';
import { enqueueRecentCommentaries, inNightWindow } from './commentary';
import { VIDEO_JOB_INTERVAL_MS } from './replayCadence';
import { autoTranslateEnabled } from './settings';

const g = globalThis as unknown as { __basketlandCron?: boolean };

/**
 * Met en file les tâches de fond des replays récents : traduction des
 * commentaires et/ou analyse vidéo. Rien quand la « Traduction automatique »
 * est désactivée (un match n'est alors traduit que sur un clic « Traduire ce
 * match ») ni hors de la fenêtre autorisée. Renvoie le nombre de matchs mis
 * en file. (`inNightWindow` tient déjà compte du réglage ; le test explicite
 * garde la règle lisible ici.)
 */
export function queueRecentWork(what: { commentaries?: boolean; analyses?: boolean }): { commentaries: number; analyses: number } {
  if (!autoTranslateEnabled() || !inNightWindow()) return { commentaries: 0, analyses: 0 };
  return {
    commentaries: what.commentaries ? enqueueRecentCommentaries() : 0,
    analyses: what.analyses ? enqueueRecentAnalyses() : 0,
  };
}

/**
 * Jobs lancés par le cron du serveur Rust, que Node ne doit plus lancer :
 * `BL_RUST_JOBS=sync-schedule,sync-stats,sync-subtitles,sync-season`
 * (`sync-season` : chargement de la saison au premier démarrage). Les autres
 * (vidéos, analyses, traductions) restent à Node.
 */
export function rustJobs(): Set<string> {
  return new Set(
    (process.env.BL_RUST_JOBS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function every(ms: number, fn: () => Promise<unknown>, initialDelayMs: number) {
  const tick = () => fn().catch((e) => console.error('[cron]', e));
  setTimeout(() => {
    void tick();
    setInterval(tick, ms).unref?.();
  }, initialDelayMs).unref?.();
}

export function startScheduler(): void {
  if (g.__basketlandCron || process.env.DISABLE_CRON === '1') return;
  g.__basketlandCron = true;
  const MIN = 60_000;
  const rust = rustJobs();
  console.log(`[cron] démarrage des jobs internes${rust.size ? ` (repris par Rust : ${[...rust].join(', ')})` : ''}`);

  // Premier démarrage : base vide → on charge l'année civile en cours (saison complète).
  if (!rust.has('sync-season')) {
    setTimeout(async () => {
      try {
        if (countMatches({}) < 50) await syncSeason(currentSeason());
      } catch (e) {
        console.error('[cron] init', e);
      }
    }, 2_000).unref?.();
  }

  if (!rust.has('sync-schedule')) every(15 * MIN, () => syncSchedule(), 5_000);
  if (!rust.has('sync-stats')) every(5 * MIN, () => syncStats(), 60_000);
  // Recherche des replays ; un replay qui vient d'apparaître est mis en file
  // de traduction et d'analyse tout de suite (pas d'attente du job suivant).
  every(
    VIDEO_JOB_INTERVAL_MS,
    async () => {
      await syncVideos();
      const { commentaries: c, analyses: a } = queueRecentWork({ commentaries: true, analyses: true });
      if (c || a) console.log(`[cron] nouveaux replays : ${c} traduction(s), ${a} analyse(s) mise(s) en file`);
    },
    3 * MIN,
  );
  if (!rust.has('sync-subtitles')) every(60 * MIN, () => syncSubtitles(), 10 * MIN);
  // Tâches de fond lourdes (analyse vidéo OCR, pré-traduction des
  // commentaires) : seulement si la traduction automatique est activée, et
  // dans la fenêtre autorisée (COMMENTARY_NIGHT_WINDOW : en continu par
  // défaut, ou p. ex. 2 h-6 h, heure de Paris). Sinon, un match n'est
  // analysé et traduit que quand quelqu'un le demande. Un travail de fond
  // encore en cours à la fin de la fenêtre se met en pause.
  every(10 * MIN, async () => {
    const n = queueRecentWork({ analyses: true }).analyses;
    if (n) console.log(`[cron] ${n} analyse(s) vidéo mise(s) en file`);
  }, 4 * MIN);
  every(10 * MIN, async () => {
    const n = queueRecentWork({ commentaries: true }).commentaries;
    if (n) console.log(`[cron] pré-traduction : ${n} match(s) mis en file`);
  }, 6 * MIN);
}
