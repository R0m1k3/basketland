/**
 * Fabrique des images de diffusion SYNTHÉTIQUES (1280x720 par défaut) avec un
 * bandeau de score à une position et une taille données, via ffmpeg drawtext.
 *
 * Les vraies images de diffusion ne sont pas accessibles depuis le conteneur de
 * test (flux ok.ru signés par IP) : ces images reproduisent les dispositions
 * relevées sur les storyboards ok.ru (bandeau bas-centre NBC/ESPN, encart
 * bas-gauche des chaînes locales, encart haut-droite type Prime Video), avec du
 * texte parasite (numéros de maillot, panneaux) pour éprouver la localisation.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/opentype/inter/Inter-Bold.otf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
];

export function testFont(): string | null {
  return FONT_CANDIDATES.find((f) => fs.existsSync(f)) ?? null;
}

export function ffmpegOk(): boolean {
  try {
    return spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

export interface TextItem {
  text: string;
  /** Position (fractions de l'image) du coin haut-gauche. */
  x: number;
  y: number;
  /** Hauteur de police en fraction de la hauteur d'image. */
  size: number;
  color?: string;
}

export interface BoxItem {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export interface SceneSpec {
  width?: number;
  height?: number;
  /** Graine du fond (fait varier les couleurs/positions des éléments parasites). */
  seed?: number;
  boxes: BoxItem[];
  texts: TextItem[];
}

/** Rend une scène en PNG (Buffer). */
export function renderScene(spec: SceneSpec): Buffer {
  const W = spec.width ?? 1280;
  const H = spec.height ?? 720;
  const font = testFont();
  if (!font) throw new Error('aucune police disponible pour drawtext');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-sb-'));
  try {
    const seed = spec.seed ?? 1;
    const hue = (seed * 47) % 360;
    // Fond : parquet (dégradé chaud) + tribune sombre + bruit, puis éléments parasites.
    const filters: string[] = [
      `color=c=0xC89A5E:s=${W}x${H}:d=1,format=yuv420p`,
      `drawbox=x=0:y=0:w=${W}:h=${Math.round(H * 0.38)}:color=0x1A1426:t=fill`,
      `drawbox=x=${Math.round(W * 0.3)}:y=${Math.round(H * 0.5)}:w=${Math.round(W * 0.4)}:h=${Math.round(H * 0.18)}:color=0x4B2E83:t=fill`,
      `hue=h=${hue}:s=0.8`,
      'noise=alls=18:allf=t',
    ];
    const distractors: TextItem[] = [
      { text: String(10 + (seed % 80)), x: 0.42 + (seed % 5) * 0.02, y: 0.55, size: 0.07, color: 'white' },
      { text: 'CRYPTO.COM ARENA', x: 0.08, y: 0.25, size: 0.035, color: '0xF2C14E' },
      { text: '3-0', x: 0.62, y: 0.3, size: 0.03, color: 'white' },
    ];
    const items = [...distractors, ...spec.texts];
    for (const b of spec.boxes) {
      filters.push(
        `drawbox=x=${Math.round(b.x * W)}:y=${Math.round(b.y * H)}:w=${Math.round(b.w * W)}:h=${Math.round(b.h * H)}:color=${b.color}:t=fill`,
      );
    }
    items.forEach((t, i) => {
      const f = path.join(dir, `t${i}.txt`);
      fs.writeFileSync(f, t.text);
      filters.push(
        `drawtext=fontfile=${font}:textfile=${f}:x=${Math.round(t.x * W)}:y=${Math.round(t.y * H)}:fontsize=${Math.max(8, Math.round(t.size * H))}:fontcolor=${t.color ?? 'white'}`,
      );
    });
    const r = spawnSync(
      process.env.FFMPEG_PATH || 'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', filters.join(','), '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr?.toString()}`);
    return r.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface BugState {
  away: string;
  home: string;
  awayScore: number;
  homeScore: number;
  period: string; // '2ND', 'Q4', '3RD'…
  clock: string; // '7:43', '42.8'
  shot?: string;
}

/** Les dispositions de bandeau testées, avec le rectangle attendu (fractions). */
export type LayoutName = 'bottom-wide' | 'bottom-left' | 'top-right' | 'bottom-light';

export const LAYOUT_RECTS: Record<LayoutName, { x: number; y: number; w: number; h: number }> = {
  'bottom-wide': { x: 0.22, y: 0.86, w: 0.56, h: 0.07 },
  'bottom-left': { x: 0.03, y: 0.8, w: 0.27, h: 0.14 },
  'top-right': { x: 0.66, y: 0.03, w: 0.31, h: 0.065 },
  'bottom-light': { x: 0.3, y: 0.78, w: 0.4, h: 0.08 },
};

/** Scène complète : fond + bandeau de score selon la disposition. */
export function scoreboardScene(layout: LayoutName, s: BugState, seed = 1): SceneSpec {
  const r = LAYOUT_RECTS[layout];
  const boxes: BoxItem[] = [];
  const texts: TextItem[] = [];
  if (layout === 'bottom-wide') {
    // Bandeau horizontal type ESPN/NBC : [AWY 54][HOM 61][2ND 7:43][14]
    boxes.push({ ...r, color: '0x101418' });
    const ty = r.y + r.h * 0.2;
    const sz = r.h * 0.6;
    texts.push({ text: `${s.away} ${s.awayScore}`, x: r.x + 0.01, y: ty, size: sz });
    texts.push({ text: `${s.home} ${s.homeScore}`, x: r.x + 0.15, y: ty, size: sz });
    texts.push({ text: s.period, x: r.x + 0.31, y: ty, size: sz });
    texts.push({ text: s.clock, x: r.x + 0.38, y: ty, size: sz });
    if (s.shot) texts.push({ text: s.shot, x: r.x + 0.5, y: ty, size: sz, color: '0xFFD200' });
  } else if (layout === 'bottom-left') {
    // Encart compact de chaîne locale : deux lignes d'équipes, période/chrono à droite.
    boxes.push({ ...r, color: '0x0B2240' });
    const sz = r.h * 0.33;
    texts.push({ text: `${s.away} ${s.awayScore}`, x: r.x + 0.01, y: r.y + r.h * 0.1, size: sz });
    texts.push({ text: `${s.home} ${s.homeScore}`, x: r.x + 0.01, y: r.y + r.h * 0.55, size: sz });
    texts.push({ text: s.period, x: r.x + 0.15, y: r.y + r.h * 0.1, size: sz });
    texts.push({ text: s.clock, x: r.x + 0.15, y: r.y + r.h * 0.55, size: sz });
  } else if (layout === 'top-right') {
    // Encart haut-droite, petit (type Prime Video) : "AWY 54  HOM 61  Q4 1:12"
    boxes.push({ ...r, color: '0x000000' });
    const ty = r.y + r.h * 0.18;
    const sz = r.h * 0.62;
    texts.push({ text: `${s.away} ${s.awayScore}`, x: r.x + 0.008, y: ty, size: sz });
    texts.push({ text: `${s.home} ${s.homeScore}`, x: r.x + 0.1, y: ty, size: sz });
    texts.push({ text: `${s.period} ${s.clock}`, x: r.x + 0.195, y: ty, size: sz });
  } else {
    // Bandeau clair : texte sombre sur fond blanc.
    boxes.push({ ...r, color: '0xF4F4F4' });
    const ty = r.y + r.h * 0.2;
    const sz = r.h * 0.58;
    texts.push({ text: `${s.awayScore}`, x: r.x + 0.02, y: ty, size: sz, color: '0x111111' });
    texts.push({ text: `${s.homeScore}`, x: r.x + 0.09, y: ty, size: sz, color: '0x111111' });
    texts.push({ text: s.clock, x: r.x + 0.18, y: ty, size: sz, color: '0x111111' });
    texts.push({ text: s.period, x: r.x + 0.29, y: ty, size: sz, color: '0x111111' });
  }
  return { seed, boxes, texts };
}
