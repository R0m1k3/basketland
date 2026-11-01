/**
 * Réponses de `GET /api/pages/…` (serveur Rust, `server/src/pages.rs`) :
 * exactement ce que calculaient les pages serveur. Les `Map` de Node
 * (`dayCounts`, `seasonRecords`) y sont des objets ; `undefined` y est `null`.
 */
import type { Activity } from '@/lib/activity';
import type { PublicUser, UserRole } from '@/lib/db';
import type { StandingRow } from '@/lib/espn';
import type { Linescore } from '@/lib/linescore';
import type { MatchDto } from '@/lib/present';
import type { DayCount, GameView, TeamRecord } from '@/lib/queries';
import type { MinimaxSettingsView, OpenAiSettingsView, VfMode } from '@/lib/settings';
import type { TeamInfo } from '@/lib/teams';
import type { SpoilerMode } from '@/components/ui/spoiler-keys';
import type { PlayItem } from '@/components/match/PlayByPlay';
import type { PlayLite, PlayPosition } from '@/components/MatchClient';

export type Standings = { conference: string; rows: StandingRow[] }[];

/** `GET /api/pages/session?next=` (publique) : layout, `/login`, `/setup`. */
export interface SessionPage {
  has_users: boolean;
  user: { id: number; username: string; role: UserRole } | null;
  next: string;
}

/** `GET /api/pages/home`. */
export interface HomePage {
  spoilers: SpoilerMode;
  today: string;
  season: number | null;
  live: GameView[];
  replays: GameView[];
  hero_night: string | null;
  night: string | null;
  night_title: string | null;
  night_games: GameView[];
  next_up_id: number | null;
  days: { key: string; games: GameView[] }[];
  standings: Standings | null;
  auto_translate: boolean;
  activity: Activity;
  vf_count: { ready: number; running: number; partial: number; todo: number };
  idle_text: string;
  night_window_label: string | null;
}

/** `GET /api/pages/matchs?d=&team=`. */
export interface CalendarPage {
  spoilers: SpoilerMode;
  today: string;
  team: string | null;
  selected: string;
  day: {
    counts: Record<string, DayCount>;
    games: GameView[];
    records: Record<string, TeamRecord>;
    prev: string | null;
    next: string | null;
    replays: number;
    upcoming: number;
    live: number;
    all_night: boolean;
  } | null;
  team_view: { upcoming: GameView[]; played: GameView[]; record: TeamRecord } | null;
}

/** `GET /api/pages/matchs/{id}` (404 : match introuvable). */
export interface MatchPage {
  title: string;
  description: string;
  spoilers: SpoilerMode;
  match: MatchDto;
  linescore: Linescore | null;
  plays: PlayItem[];
  lite: PlayLite[];
  has_video: boolean;
  positions: PlayPosition[];
  auto_translate: boolean;
  vf_mode: VfMode;
  is_admin: boolean;
}

/** `GET /api/pages/equipes`. */
export interface TeamsPage {
  season: number | null;
  today: string;
  conferences: {
    conference: TeamInfo['conference'];
    divisions: {
      division: string;
      teams: { team: TeamInfo; record: TeamRecord | null; next: GameView | null; seed: number | null }[];
    }[];
  }[];
}

/** `GET /api/pages/equipes/{abbr}` (404 : équipe introuvable). */
export interface TeamPage {
  title: string;
  spoilers: SpoilerMode;
  abbr: string;
  team: TeamInfo;
  today: string;
  upcoming_count: number;
  next_game: GameView | null;
  upcoming_rest: GameView[];
  finished_count: number;
  form: GameView[];
  recent: GameView[];
  replays_count: number;
  replays: GameView[];
  summary: {
    season: number | null;
    total: TeamRecord;
    home: TeamRecord;
    road: TeamRecord;
    streak: string;
    streak_win: boolean | null;
  };
  seed: number | null;
  pct: number | null;
}

/** `GET /api/pages/classement`. */
export interface StandingsPage {
  conferences: Standings;
}

/** Moteur de transcription embarqué (Paramètres). */
export type TranscribeEngine = 'whisper' | 'nvidia';

/** `GET /api/pages/parametres`. */
export interface SettingsPage {
  user: { id: number; username: string; role: UserRole };
  admin: boolean;
  admin_data: {
    users: PublicUser[];
    auto_translate: boolean;
    vf_mode: VfMode;
    transcribe_engine: TranscribeEngine;
    /** Pourquoi ce choix n'est pas appliqué (TRANSCRIBE_URL, TRANSCRIBE_MODEL…), sinon null. */
    transcribe_engine_override: string | null;
    /** « Noms à respecter » (un par ligne). */
    extra_names: string;
    /** Modèle MiniMax de reprise des lignes mal traduites ; null : aucun. */
    translate_repair_model: string | null;
    /** Connexions simultanées vers ok.ru pour l'audio d'un tronçon (1 à 32). */
    fetch_parallel: number;
    voice_disabled_reason: string | null;
    minimax: MinimaxSettingsView;
    openai: OpenAiSettingsView;
    openai_model_placeholder: string;
  } | null;
  version: { commit: string | null; builtAt: string | null };
  version_text: string;
}
