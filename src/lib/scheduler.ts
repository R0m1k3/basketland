/**
 * Cron interne (setInterval) démarré par `instrumentation.ts` côté serveur Node.
 * Fréquences (spec) : calendrier 15 min, stats après match (5 min), vidéos 20 min
 * (revérification selon l'âge du match, voir replayCadence.ts),
 * VF après stats, analyse vidéo (synchro auto) 10 min, traduction des commentaires
 * 10 min. Désactivable avec DISABLE_CRON=1.
 *
 * Traduction et analyse de fond : seulement si la « Traduction automatique »
 * est activée (/parametres, activée par défaut) et dans la fenêtre autorisée
 * (COMMENTARY_NIGHT_WINDOW) — voir `queueRecentWork`. Doublage de fond : en
 * plus, « Version française » en mode « doublage » — voir `queueRecentDubs`.
 */
import { countMatches } from './db';
import { currentSeason } from './time';
import { syncSchedule, syncSeason, syncStats, syncSubtitles, syncVideos } from './ingest';
import { enqueueRecentAnalyses } from './analysis';
import { enqueueRecentCommentaries, inNightWindow } from './commentary';
import { enqueueRecentDubs } from './dub';
import { VIDEO_JOB_INTERVAL_MS } from './replayCadence';
import { autoDubEnabled, autoTranslateEnabled } from './settings';

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
 * Met en file le doublage de fond des replays récents traduits : seulement
 * si la « Traduction automatique » est activée, en mode « doublage »
 * (réglage « Version française ») et dans la fenêtre autorisée. En mode
 * « sous-titres », rien : un match n'est doublé que sur un clic « Doubler ce
 * match ». Renvoie le nombre de matchs mis en file.
 */
export async function queueRecentDubs(): Promise<number> {
  if (!autoDubEnabled() || !inNightWindow()) return 0;
  return enqueueRecentDubs();
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
      const { commentaries: c, analyses: a } = queueRecentWork({ commentaries: true, analyses: true });
      if (c || a) console.log(`[cron] nouveaux replays : ${c} traduction(s), ${a} analyse(s) mise(s) en file`);
    },
    3 * MIN,
  );
  every(60 * MIN, () => syncSubtitles(), 10 * MIN);
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
    // Doublage des matchs traduits (même règle, et mode « doublage »), quand le GPU est libre.
    const d = await queueRecentDubs();
    if (d) console.log(`[cron] doublage : ${d} match(s) mis en file`);
  }, 6 * MIN);
}
