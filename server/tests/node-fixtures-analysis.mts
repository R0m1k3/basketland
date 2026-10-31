/**
 * Produit, avec le code Node, les réponses attendues de la route de calage
 * portée en Rust (étape 7 : src/app/api/matches/[id]/sync/route.ts →
 * server/src/sync_route.rs, file d'analyse de src/lib/analysis.ts) :
 * server/tests/fixtures/analysis.expected.json, comparé par tests/analysis_node.rs.
 *
 * Une suite de requêtes (lecture, ancres, offsets, décalages, remise à zéro,
 * erreurs de validation, analyses demandées) sur le match 401909880 et son
 * play-by-play réel, avec un exécuteur d'analyse qui ne rend jamais la main
 * (comme tests/sync-route.test.ts) : statut et corps de chaque réponse, et
 * lignes `sync_anchors` / `sync_settings` après chacune (dates de mise à jour
 * retirées).
 *
 * À relancer après une modification de ces modules, depuis la racine du dépôt :
 *   npx -y tsx server/tests/node-fixtures-analysis.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'server', 'tests', 'fixtures');
process.env.DB_PATH = ':memory:';
delete process.env.SYNC_WRITE_ORIGINS;
for (const k of ['ANALYSIS_MAX_PARALLEL', 'ANALYSIS_MIN_INTERVAL_MS', 'ANALYSIS_TIMEOUT_MS', 'COMMENTARY_NIGHT_WINDOW']) delete process.env[k];

const audio = await import(path.join(ROOT, 'src/lib/audio.ts'));
void audio;
const db = await import(path.join(ROOT, 'src/lib/db.ts'));
const helpers = await import(path.join(ROOT, 'tests/helpers/db.ts'));
const analysis = await import(path.join(ROOT, 'src/lib/analysis.ts'));
const route = await import(path.join(ROOT, 'src/app/api/matches/[id]/sync/route.ts'));
console.log = () => {};
console.error = () => {};

const ID = 401909880;
helpers.freshDb();
helpers.insertMatch(ID, { duration: 8033 });
db.replacePlays(ID, helpers.fixturePlays(ID));
helpers.insertMatch(1);
// ffmpeg est présent sur la machine qui produit le fichier : la file le vérifie.
if (!audio.ffmpegAvailable()) throw new Error('ffmpeg requis');
analysis.__setAnalysisRunnerForTests(() => new Promise(() => {}));

const ctx = { params: Promise.resolve({ id: String(ID) }) };
const strip = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== 'updated_at') o[k] = strip(x);
    return o;
  }
  return v;
};
const rows = () => ({
  anchors: db.getAnchors(ID),
  settings: strip(db.getSyncSettings(ID)),
});

const steps: unknown[] = [];
async function step(label: string, body: unknown, headers: Record<string, string> = {}, raw?: string) {
  const res =
    body === 'GET'
      ? await route.GET(new Request(`http://nas.local:3012/api/matches/${ID}/sync`), ctx)
      : await route.POST(
          new Request(`http://nas.local:3012/api/matches/${ID}/sync`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'http://nas.local:3012', host: 'nas.local:3012', ...headers },
            body: raw ?? JSON.stringify(body),
          }),
          ctx,
        );
  const text = await res.text();
  steps.push({ label, body: body === 'GET' ? null : (raw ?? JSON.stringify(body)), headers, status: res.status, response: strip(JSON.parse(text)), rows: rows() });
}

const play = helpers.fixturePlays(ID).find((p: { period: number; clock_sec: number }) => p.period === 3 && p.clock_sec < 400)!;
await step('lecture', 'GET');
await step('chrono', { action: 'clock', video_ts: 3600, period: 2, clock_sec: 84 });
await step('chrono dixièmes', { action: 'clock', video_ts: 7000, period: 4, clock_sec: 42.8 });
await step('offsets', { global_offset: 5, quarter_offsets: { '10': 1, '2': 2.25 } });
await step('chrono avec offsets', { action: 'clock', video_ts: 3700.333, period: 2, clock_sec: 50 });
await step('décalage global', { action: 'nudge', delta: 0.5 });
await step('décalage du quart', { action: 'nudge', delta: -1.25, period: 3 });
await step('décalage du quart existant', { action: 'nudge', delta: 0.1, period: 2 });
await step('ancre sur une action', { action: 'anchor', seq: play.seq, video_ts: 5000.127 });
await step('ancres brutes', { anchors: [{ period: 1.7, clock_sec: 600.9, video_ts: 100.256, wallclock: '2026-01-01T00:00:00.000Z' }, { period: 3, clock_sec: 12, video_ts: 6000 }] });
await step('offsets nuls', { global_offset: null });
await step('offsets en tableau', { quarter_offsets: [1, 2] });
await step('suppression', { action: 'delete-anchor', period: 2, clock_sec: 84 });
await step('corps vide', {});
await step('corps tableau', []);
for (const [label, body] of [
  ['delta invalide', { action: 'nudge', delta: 4000 }],
  ['période invalide', { action: 'nudge', delta: 1, period: 1.5 }],
  ['action introuvable', { action: 'anchor', seq: -5, video_ts: 10 }],
  ['ancre sans seq', { action: 'anchor', video_ts: 10 }],
  ['offset invalide', { global_offset: 99999 }],
  ['clé de quart invalide', { quarter_offsets: { abc: 1 } }],
  ['valeur de quart invalide', { quarter_offsets: { '3': 'x' } }],
  ['ancre brute invalide', { anchors: [{ period: 1, clock_sec: 1 }] }],
  ['suppression invalide', { action: 'delete-anchor', period: 2 }],
  ['prolongation absente', { action: 'clock', video_ts: 100, period: 6, clock_sec: 200 }],
  ['chrono au-delà de la vidéo', { action: 'clock', video_ts: 9000, period: 2, clock_sec: 84 }],
] as const)
  await step(label, body);
await step('JSON invalide', null, {}, '{pas du json');
await step('origine étrangère', { action: 'reset' }, { origin: 'https://evil.example' });
await step('texte brut', { action: 'reset' }, { 'content-type': 'text/plain' });
await step('analyse', { action: 'analyze' });
await step('analyse audio', { action: 'analyze-audio' });
await step('lecture pendant l’analyse', 'GET');
await step('remise à zéro', { action: 'reset' });
analysis.enqueueAnalysis(1, { priority: true });
await step('analyse en file', { action: 'analyze' });
await step('lecture en file', 'GET');

fs.writeFileSync(path.join(OUT, 'analysis.expected.json'), JSON.stringify({ id: ID, steps }));
process.stdout.write(`analysis.expected.json : ${steps.length} requêtes\n`);
process.exit(0);
