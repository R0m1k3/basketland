/**
 * Cron interne (setInterval) démarré par `instrumentation.ts` côté serveur Node.
 * Fréquences (spec) : calendrier 15 min, stats après match (5 min), vidéos 20 min
 * (revérification selon l'âge du match, voir replayCadence.ts),
 * VF après stats, analyse vidéo (synchro auto) 10 min, traduction des commentaires
 * 10 min. Désactivable avec DISABLE_CRON=1.
 */
import { countMatches } from './db';
import { currentSeason } from './time';
import { syncSchedule, syncSeason, syncStats, syncSubtitles, syncVideos } from './ingest';
import { enqueueRecentAnalyses } from './analysis';
import { enqueueRecentCommentaries, inNightWindow } from './commentary';
import { VIDEO_JOB_INTERVAL_MS } from './replayCadence';

const g = globalThis as unknown as { __basketlandCron?: boolean };

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
  console.log('[cron] démarrage des jobs internes');

  // Premier démarrage : base vide → on charge l'année civile en cours (saison complète).
  setTimeout(async () => {
    try {
      if (countMatches({}) < 50) await syncSeason(currentSeason());
    } catch (e) {
      console.error('[cron] init', e);
    }
  }, 2_000).unref?.();

  every(15 * MIN, () => syncSchedule(), 5_000);
  every(5 * MIN, () => syncStats(), 60_000);
  // Recherche des replays ; un replay qui vient d'apparaître est mis en file
  // de traduction et d'analyse tout de suite (pas d'attente du job suivant).
  every(
    VIDEO_JOB_INTERVAL_MS,
    async () => {
      await syncVideos();
      if (!inNightWindow()) return;
      const c = enqueueRecentCommentaries();
      const a = enqueueRecentAnalyses();
      if (c || a) console.log(`[cron] nouveaux replays : ${c} traduction(s), ${a} analyse(s) mise(s) en file`);
    },
    3 * MIN,
  );
  every(60 * MIN, () => syncSubtitles(), 10 * MIN);
  // Tâches de fond lourdes (analyse vidéo OCR, pré-traduction des
  // commentaires) : SEULEMENT dans la fenêtre de nuit (2 h-6 h, heure de
  // Paris, COMMENTARY_NIGHT_WINDOW). Le reste du temps, un match n'est
  // analysé et traduit que quand quelqu'un l'ouvre. Un travail de fond
  // encore en cours à la fin de la fenêtre se met en pause.
  every(10 * MIN, async () => {
    if (!inNightWindow()) return;
    const n = enqueueRecentAnalyses();
    if (n) console.log(`[cron] ${n} analyse(s) vidéo mise(s) en file (nuit)`);
  }, 4 * MIN);
  every(10 * MIN, async () => {
    if (!inNightWindow()) return;
    const n = enqueueRecentCommentaries();
    if (n) console.log(`[cron] pré-traduction de nuit : ${n} match(s) mis en file`);
  }, 6 * MIN);
}
