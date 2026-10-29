/** Mise en forme des matchs pour l'API et l'UI (heures Europe/Paris). */
import { teamLogo } from './espn';
import { labelForDateKey, PARIS_TZ, parisDateKey, parisIso, parisTime } from './time';
import type { MatchRow } from './types';

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
    /** Type de flux : playlist HLS ou MP4 progressif (contrat lecteur). */
    kind: 'hls' | 'mp4' | null;
    /** URL à donner au lecteur (selon `kind`). */
    src: string | null;
    master: string | null;
    checked_at: string | null;
  };
}

export function toDto(m: MatchRow): MatchDto {
  const available = !!m.video_available && !!m.video_ok_id;
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
      kind: available ? 'hls' : null,
      src: available ? `/api/video/${m.video_ok_id}/master.m3u8` : null,
      master: available ? `/api/video/${m.video_ok_id}/master.m3u8` : null,
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
