/**
 * « Vidéo » synthétique d'un vrai match (play-by-play ESPN de la fixture) :
 * à chaque instant vidéo correspond un état de jeu (période, chrono, scores),
 * selon un montage connu — préroll v0, jeu vivant conservé, temps morts
 * conservés au taux rho (le reste « coupé »). Sert à mesurer le balayage
 * complet (localisation + passes) contre une vérité terrain exacte.
 */
import { Timeline, type BreakInfo, type TimedPlay } from '../../src/lib/sync';

export interface Truth {
  v0: number;
  rho: number;
  /** wall (epoch s) → instant vidéo. */
  vmap: (wall: number) => number;
  /** instant vidéo → wall (epoch s). */
  wallAt: (video: number) => number;
  duration: number;
}

export function makeTruth(tp: TimedPlay[], breaks: BreakInfo[], v0 = 420, rho = 0.25, postroll = 200): Truth {
  const tl = new Timeline(breaks.map((b) => b.interval));
  const w0 = tp[0].wall;
  const vmap = (w: number) => v0 + tl.live(w0, w) + rho * tl.comp(w0, w);
  const wEnd = tp[tp.length - 1].wall;
  const wallAt = (v: number) => {
    let lo = w0 - v0;
    let hi = wEnd + 4000;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if ((mid <= w0 ? v0 - (w0 - mid) : vmap(mid)) < v) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  return { v0, rho, vmap, wallAt, duration: Math.round(vmap(wEnd) + postroll) };
}

export interface GameState {
  period: number;
  clock: number;
  home: number;
  away: number;
  /** Instant dans une zone de temps mort (le diffuseur peut être en pub). */
  inBreak: boolean;
}

/** État affiché par le bandeau à l'instant wall. */
export function stateAt(
  plays: { period: number; clock_sec: number; wallclock: string; home_score: number | null; away_score: number | null }[],
  breaks: BreakInfo[],
  wall: number,
): GameState | null {
  const sorted = plays.map((p) => ({ ...p, wall: Date.parse(p.wallclock) / 1000 })).filter((p) => Number.isFinite(p.wall));
  let last: (typeof sorted)[number] | null = null;
  let next: (typeof sorted)[number] | null = null;
  let home = 0;
  let away = 0;
  for (const p of sorted) {
    if (p.wall <= wall) {
      last = p;
      if (p.home_score !== null) home = p.home_score;
      if (p.away_score !== null) away = p.away_score;
    } else {
      next = p;
      break;
    }
  }
  if (!last) return null;
  const inBreak = breaks.some((b) => wall >= b.interval.start && wall <= b.interval.end);
  let clock = last.clock_sec;
  if (next && next.period === last.period) {
    // Entre deux actions, le chrono reste arrêté puis repart juste à temps pour
    // atteindre celui de l'action suivante (même modèle que `findBreaks`).
    const restart = next.wall - (last.clock_sec - next.clock_sec);
    clock = Math.max(next.clock_sec, last.clock_sec - Math.max(0, wall - restart));
  }
  return { period: last.period, clock: Math.round(clock), home, away, inBreak };
}

export function fmtClock(sec: number): string {
  return sec < 60 ? `${sec}.0` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function fmtPeriod(p: number, style: 'ord' | 'q' = 'ord'): string {
  if (p > 4) return p === 5 ? 'OT' : `OT${p - 4}`;
  if (style === 'q') return `Q${p}`;
  return ['1ST', '2ND', '3RD', '4TH'][p - 1];
}
