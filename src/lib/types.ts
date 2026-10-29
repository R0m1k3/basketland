export type League = 'nba';
export type MatchStatus = 'scheduled' | 'live' | 'final';
export type SeasonType = 'preseason' | 'regular' | 'post';

export interface MatchRow {
  id: number;
  espn_id: string;
  league: string;
  season: number;
  season_type: SeasonType | string;
  date_utc: string;
  home_abbr: string;
  home_name: string;
  away_abbr: string;
  away_name: string;
  home_score: number | null;
  away_score: number | null;
  status: MatchStatus;
  status_detail: string;
  period: number;
  clock_display: string;
  venue: string;
  broadcast: string;
  slug: string | null;
  video_ok_id: string | null;
  video_duration: number | null;
  video_available: number;
  video_checked_at: string | null;
  stats_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Match normalisé issu d'ESPN (avant écriture en base). */
export interface ParsedMatch {
  id: number;
  espn_id: string;
  league: string;
  season: number;
  season_type: SeasonType;
  date_utc: string;
  home_abbr: string;
  home_name: string;
  away_abbr: string;
  away_name: string;
  home_score: number | null;
  away_score: number | null;
  status: MatchStatus;
  status_detail: string;
  period: number;
  clock_display: string;
  venue: string;
  broadcast: string;
}

export interface PlayRow {
  match_id: number;
  seq: number;
  period: number;
  clock_display: string;
  clock_sec: number;
  wallclock: string;
  event_type: string;
  text_en: string;
  actor: string;
  team_abbr: string;
  home_score: number | null;
  away_score: number | null;
  scoring: number;
  is_key: number;
  /** Valeur du panier (0-3) — non persistée, utile à la VF. */
  score_value?: number;
  /** Noms des participants (acteur, passeur...) — non persistés. */
  participants?: string[];
}

export interface PlayerStatRow {
  match_id: number;
  team_abbr: string;
  player_id: string;
  player_name: string;
  position: string;
  jersey: string;
  starter: number;
  stats: Record<string, string>;
}

export interface TeamStatRow {
  match_id: number;
  team_abbr: string;
  stats: Record<string, string>;
}

export interface LeaderRow {
  team_abbr: string;
  category: string;
  label: string;
  player: string;
  value: string;
}

export type SubtitleKind = 'action' | 'banniere' | 'score';

export interface SubtitleRow {
  match_id: number;
  seq: number;
  video_ts: number;
  end_ts: number | null;
  text_fr: string;
  speaker: string;
  kind: SubtitleKind;
}

export type AnchorMethod = 'auto' | 'manual' | 'audio';

export interface AnchorRow {
  match_id: number;
  period: number;
  clock_sec: number;
  video_ts: number;
  method: AnchorMethod;
  /** Horodatage exact de l'action ancrée (désambiguïse les arrêts de jeu). */
  wallclock: string | null;
}

export interface SyncSettings {
  match_id: number;
  global_offset: number;
  quarter_offsets: Record<string, number>;
  updated_at: string;
}

export interface CutInterval {
  start: number;
  end: number;
  meanDb: number;
}
