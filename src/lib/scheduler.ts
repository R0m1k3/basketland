/**
 * Cron interne (setInterval) démarré par `instrumentation.ts` côté serveur Node.
 * Fréquences (spec) : calendrier 15 min, stats après match (5 min), vidéos 2 h,
 * VF après stats, analyse vidéo (synchro auto) 10 min, traduction des commentaires
 * 10 min. Désactivable avec DISABLE_CRON=1.
 */
import { countMatches } from './db';
import { currentSeason } from './time';
import { syncSchedule, syncSeason, syncStats, syncSubtitles, syncVideos } from './ingest';
import { enqueueRecentAnalyses } from './analysis';
import { enqueueRecentCommentaries } from './commentary';

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
  every(120 * MIN, () => syncVideos(), 3 * MIN);
  every(60 * MIN, () => syncSubtitles(), 10 * MIN);
  // Synchro automatique : met en file (une analyse à la fois) les matchs
  // terminés récents qui ont un replay mais pas encore d'ancres OCR. Les
  // échecs sont espacés (backoff) : un match illisible n'est pas réanalysé
  // en boucle.
  every(10 * MIN, async () => {
    const n = enqueueRecentAnalyses();
    if (n) console.log(`[cron] ${n} analyse(s) vidéo mise(s) en file`);
  }, 4 * MIN);
  // Traduction des commentaires : un travail à la fois (GPU partagé), pour
  // les matchs terminés depuis ≤ 10 jours avec replay et sans piste traduite.
  // Inactif tant que TRANSCRIBE_URL / TRANSLATE_URL ne sont pas configurés.
  every(10 * MIN, async () => {
    const n = enqueueRecentCommentaries();
    if (n) console.log(`[cron] ${n} traduction(s) de commentaires mise(s) en file`);
  }, 6 * MIN);
}
