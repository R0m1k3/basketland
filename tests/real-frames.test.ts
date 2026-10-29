/**
 * Localisation et lecture du bandeau sur de VRAIES images de replays ok.ru
 * (flux HD 1280x720), pour trois diffuseurs :
 *  - nybos : Prime Video — chrono noir sur case blanche, période en exposant dessous ;
 *  - memgs : chaîne locale — tout sur une ligne, texte blanc sur fond sombre ;
 *  - denokc : ESPN — chrono dans une pastille blanche, période en exposant à gauche.
 * Plus des plans sans bandeau (gros plans, vue d'ensemble) : aucune lecture attendue.
 *
 * Pour limiter le poids du dépôt, les fixtures ne gardent que le bas de l'image
 * (y ≥ 432) en JPEG ; le haut est recomposé avec un bruit différent pour chaque
 * image (une zone fixe parasite fausserait la recherche des incrustations).
 * Vérité terrain lue à l'œil : tests/fixtures/real-frames/truth.json.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createOcrWorker, scoresMatchAt, type OcrWorker, type ScorePoint } from '../src/lib/ocr';
import { locateScoreboard, readScoreboard, type ScoreboardLocation } from '../src/lib/scoreboard';
import { ffmpegOk } from './helpers/scoreboardImages';

const DIR = path.join(__dirname, 'fixtures', 'real-frames');
const truth = JSON.parse(fs.readFileSync(path.join(DIR, 'truth.json'), 'utf8')) as Record<
  string,
  Record<string, { period: number; clock: number; away: number; home: number | null; optional?: boolean } | null>
>;
const pbp = JSON.parse(fs.readFileSync(path.join(DIR, 'pbp.json'), 'utf8')) as Record<string, { plays: number[][] }>;

/** Image 1280x720 : haut bruité (graine propre à l'image) + bas réel. */
function frame(file: string, seed: number): Buffer {
  const r = spawnSync(
    process.env.FFMPEG_PATH || 'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=0x707070:s=1280x432:d=1,noise=alls=90:allf=t:all_seed=${seed}`,
      '-i', path.join(DIR, file),
      '-filter_complex', '[0:v][1:v]vstack=inputs=2,format=rgb24',
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return r.stdout;
}

const files = (match: string) =>
  fs
    .readdirSync(DIR)
    .filter((f) => f.startsWith(`${match}-`) && f.endsWith('.jpg'))
    .sort((a, b) => Number(/t(\d+)/.exec(a)![1]) - Number(/t(\d+)/.exec(b)![1]));
const keyOf = (f: string) => /-(t\d+)\.jpg$/.exec(f)![1];

function timeline(match: string): ScorePoint[] {
  return pbp[match].plays.filter((p) => p[3] !== null).map((p) => ({ period: p[1], clock_sec: p[2], home: p[3], away: p[4] }));
}

describe.skipIf(!ffmpegOk())('vraies images de diffusion', () => {
  let worker: OcrWorker;
  beforeAll(async () => {
    worker = await createOcrWorker();
  }, 60_000);
  afterAll(async () => {
    await worker?.terminate();
  });

  it('la vérité terrain est cohérente avec le play-by-play ESPN', () => {
    for (const match of ['nybos', 'memgs', 'denokc']) {
      const tl = timeline(match);
      for (const [key, t] of Object.entries(truth[match])) {
        if (!t || t.home === null || (match === 'denokc' && key === 't5300')) continue; // bandeau en retard sur ESPN
        expect(scoresMatchAt([t.away, t.home], tl, t.period, t.clock), `${match} ${key}`).toBe(true);
      }
    }
  });

  const cases: { match: string; minRate: number }[] = [
    { match: 'nybos', minRate: 0.8 },
    { match: 'memgs', minRate: 0.8 },
    { match: 'denokc', minRate: 0.8 },
  ];
  const locations: Record<string, ScoreboardLocation | null> = {};

  for (const { match, minRate } of cases) {
    it(
      `${match} : localise le bandeau et lit période + chrono (≥ ${minRate * 100} %), sans lecture fausse`,
      async () => {
        const fs_ = files(match);
        const frames = fs_.map((f, i) => frame(f, i + 1));
        const t0 = Date.now();
        const loc = await locateScoreboard(worker, frames);
        const locMs = Date.now() - t0;
        expect(loc.location, 'bandeau localisé').not.toBeNull();
        locations[match] = loc.location;
        let ok = 0;
        let visible = 0;
        let readMs = 0;
        for (let i = 0; i < frames.length; i++) {
          const t = truth[match][keyOf(fs_[i])];
          const t1 = Date.now();
          const r = await readScoreboard(worker, frames[i], loc.location);
          readMs += Date.now() - t1;
          if (!t) {
            expect(r, `${keyOf(fs_[i])} sans bandeau : aucune lecture`).toBeNull();
            continue;
          }
          if (t.optional) continue;
          visible++;
          if (r) {
            // Jamais de chrono faux : une lecture fausse décale la VF.
            expect(Math.abs(r.clock_sec - t.clock), `${keyOf(fs_[i])} chrono`).toBeLessThanOrEqual(1);
            if (r.period !== null) expect(r.period, `${keyOf(fs_[i])} période`).toBe(t.period);
          }
          if (r && r.period === t.period) ok++;
        }
        console.log(`[mesure] ${match} : ${ok}/${visible} période+chrono, localisation ${locMs} ms (${frames.length} images), lecture ${Math.round(readMs / frames.length)} ms/image`);
        expect(ok / visible).toBeGreaterThanOrEqual(minRate);
      },
      300_000,
    );
  }

  it(
    'plans sans bandeau : aucune lecture, ni en repli pleine largeur ni avec un gabarit appris',
    async () => {
      const empty = [...files('laclal'), 'nybos-16607260052140-t2100.jpg', 'denokc-16592868674220-t2900.jpg'];
      for (const [i, f] of empty.entries()) {
        const png = frame(f, 100 + i);
        // Repli pleine largeur (lent) : sur deux images seulement.
        if (i < 2) expect(await readScoreboard(worker, png, null), f).toBeNull();
        for (const loc of Object.values(locations)) if (loc) expect(await readScoreboard(worker, png, loc), f).toBeNull();
      }
    },
    300_000,
  );
});
