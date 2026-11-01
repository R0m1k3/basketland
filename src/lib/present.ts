/** Mise en forme des matchs pour l'API et l'UI (heures Europe/Paris). */
import { teamLogo } from './espn';
import { labelForDateKey, PARIS_TZ, parisDateKey, parisIso, parisTime } from './time';
import type { MatchRow } from './types';

/** Match de la NBA Cup : phase du tournoi. */
export interface CupInfo {
  round: 'group' | 'quarter' | 'semi' | 'final';
  /** « Phase de groupes », « Quart de finale », « Demi-finale », « Finale ». */
  label: string;
}

/** Diffusion en France : beIN SPORTS (guide des programmes) ou Prime Video. */
export interface TvFr {
  /** « beIN SPORTS 1 », « beIN SPORTS MAX 4 », « Prime Video ». */
  name: string;
  kind: 'bein' | 'prime';
  /** Direct (sinon différé). */
  live: boolean;
}

export interface MatchDto {
  id: number;
  espn_id: string;
  league: string;
  season: number;
  season_type: string;
  date_utc: string;
  date_paris: string;
  day_paris: string;
  time_paris: string;
  timezone: string;
  status: string;
  status_detail: string;
  period: number;
  clock_display: string;
  home: { abbr: string; name: string; score: number | null; logo: string };
  away: { abbr: string; name: string; score: number | null; logo: string };
  venue: string;
  broadcast: string;
  stats_available: boolean;
  video: {
    available: boolean;
    ok_id: string | null;
    duration: number | null;
    /** 'hls' (playlist proxifiée) ou 'mp4' (MP4 progressif relayé, en attendant le HLS). */
    kind: 'hls' | 'mp4' | null;
    /** URL à donner au lecteur, selon `kind` ; null sans replay. */
    src: string | null;
    /** = `src` quand kind = 'hls', sinon null (compatibilité). */
    master: string | null;
    checked_at: string | null;
  };
  /** Présent seulement pour un match de la NBA Cup (serveur Rust). */
  cup?: CupInfo;
  /** Présent seulement si le match est diffusé en France (serveur Rust). */
  tv_fr?: TvFr[];
}

export function toDto(m: MatchRow & { video_kind?: string | null }): MatchDto {
  const available = !!m.video_available && !!m.video_ok_id;
  // Ligne antérieure à la colonne video_kind (NULL) mais disponible : c'était du HLS.
  const kind: 'hls' | 'mp4' | null = available ? (m.video_kind === 'mp4' ? 'mp4' : 'hls') : null;
  const src =
    kind === 'hls' ? `/api/video/${m.video_ok_id}/master.m3u8` : kind === 'mp4' ? `/api/video/${m.video_ok_id}/file.mp4` : null;
  return {
    id: m.id,
    espn_id: m.espn_id,
    league: m.league,
    season: m.season,
    season_type: m.season_type,
    date_utc: m.date_utc,
    date_paris: parisIso(m.date_utc),
    day_paris: parisDateKey(m.date_utc),
    time_paris: parisTime(m.date_utc),
    timezone: PARIS_TZ,
    status: m.status,
    status_detail: m.status_detail ?? '',
    period: m.period ?? 0,
    clock_display: m.clock_display ?? '',
    home: { abbr: m.home_abbr, name: m.home_name, score: m.home_score, logo: teamLogo(m.home_abbr, m.league) },
    away: { abbr: m.away_abbr, name: m.away_name, score: m.away_score, logo: teamLogo(m.away_abbr, m.league) },
    venue: m.venue ?? '',
    broadcast: m.broadcast ?? '',
    stats_available: m.status === 'final',
    video: {
      available,
      ok_id: m.video_ok_id,
      duration: m.video_duration,
      kind,
      src,
      master: kind === 'hls' ? src : null,
      checked_at: m.video_checked_at,
    },
  };
}

export interface DayGroup<T> {
  date: string;
  label: string;
  matches: T[];
}

/** Groupe une liste triée par date selon le jour à Paris. */
export function groupByParisDay<T extends { date_utc: string }>(items: T[]): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const it of items) {
    const key = parisDateKey(it.date_utc);
    let g = groups[groups.length - 1];
    if (!g || g.date !== key) {
      g = groups.find((x) => x.date === key) as DayGroup<T>;
      if (!g) {
        g = { date: key, label: labelForDateKey(key), matches: [] };
        groups.push(g);
      }
    }
    g.matches.push(it);
  }
  return groups;
}
