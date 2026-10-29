/**
 * Client ESPN (API publique sans clé) + parseurs purs (testés).
 * Base : https://site.api.espn.com/apis/site/v2/sports/basketball/<league>/
 */
import { fetchJson } from './http';
import { classifyPlay, isKeyCategory } from './vf';
import type { LeaderRow, MatchStatus, ParsedMatch, PlayRow, PlayerStatRow, SeasonType, TeamStatRow } from './types';

export const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball';
export const ESPN_V2 = 'https://site.api.espn.com/apis/v2/sports/basketball';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export function teamLogo(abbr: string, league = 'nba'): string {
  return `https://a.espncdn.com/i/teamlogos/${league}/500/${abbr.toLowerCase()}.png`;
}

/** '11:43' → 703 ; '4.9' → 5 ; '0.0' → 0. */
export function parseClock(display: string | undefined | null): number {
  if (!display) return 0;
  const s = String(display).trim();
  const m = s.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function mapStatus(state: string | undefined, name?: string): MatchStatus {
  if (state === 'in') return 'live';
  if (state === 'post') {
    // Reporté/annulé : on ne le considère pas comme terminé.
    if (name && /POSTPONED|CANCELED|CANCELLED|SUSPENDED/.test(name)) return 'scheduled';
    return 'final';
  }
  return 'scheduled';
}

export function mapSeasonType(type: number | string | undefined, slug?: string): SeasonType {
  const t = Number(type);
  if (t === 1 || slug === 'preseason') return 'preseason';
  if (t === 3 || t === 5 || slug === 'post-season' || slug === 'play-in-season') return 'post';
  return 'regular';
}

function normalizeIsoUtc(d: string): string {
  // ESPN renvoie '2026-10-27T23:30Z' : on normalise en ISO complet.
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : d;
}

function intOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function broadcastNames(comp: Json): string {
  const names = new Set<string>();
  for (const b of comp?.broadcasts ?? []) for (const n of b?.names ?? []) names.add(String(n));
  for (const g of comp?.geoBroadcasts ?? []) if (g?.media?.shortName) names.add(String(g.media.shortName));
  if (!names.size && typeof comp?.broadcast === 'string' && comp.broadcast) names.add(comp.broadcast);
  return [...names].join(', ');
}

/** Un évènement du scoreboard (ou du header de summary) → ParsedMatch. */
export function parseEvent(ev: Json, league = 'nba'): ParsedMatch | null {
  const comp = ev?.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find((c: Json) => c.homeAway === 'home');
  const away = comp.competitors?.find((c: Json) => c.homeAway === 'away');
  if (!home || !away) return null;
  const status = ev.status ?? comp.status ?? {};
  const st = mapStatus(status?.type?.state, status?.type?.name);
  const espnSeasonYear = Number(ev.season?.year ?? comp.season?.year ?? new Date(ev.date).getUTCFullYear());
  return {
    id: Number(ev.id),
    espn_id: String(ev.id),
    league,
    // ESPN numérote la saison par son année de fin (2026-27 → 2027) ; on stocke l'année de début.
    season: espnSeasonYear - 1,
    season_type: mapSeasonType(ev.season?.type ?? comp.season?.type, ev.season?.slug),
    date_utc: normalizeIsoUtc(ev.date ?? comp.date),
    home_abbr: String(home.team?.abbreviation ?? ''),
    home_name: String(home.team?.displayName ?? home.team?.name ?? ''),
    away_abbr: String(away.team?.abbreviation ?? ''),
    away_name: String(away.team?.displayName ?? away.team?.name ?? ''),
    home_score: st === 'scheduled' ? null : intOrNull(home.score?.value ?? home.score),
    away_score: st === 'scheduled' ? null : intOrNull(away.score?.value ?? away.score),
    status: st,
    status_detail: String(status?.type?.shortDetail ?? status?.type?.detail ?? ''),
    period: Number(status?.period ?? 0),
    clock_display: String(status?.displayClock ?? ''),
    venue: String(comp.venue?.fullName ?? ''),
    broadcast: broadcastNames(comp),
  };
}

export function parseScoreboard(json: Json, league = 'nba'): ParsedMatch[] {
  const out: ParsedMatch[] = [];
  for (const ev of json?.events ?? []) {
    const m = parseEvent(ev, league);
    if (m && m.home_abbr && m.away_abbr) out.push(m);
  }
  return out;
}

export interface ParsedSummary {
  match: ParsedMatch | null;
  teams: TeamStatRow[];
  players: PlayerStatRow[];
  leaders: LeaderRow[];
  plays: PlayRow[];
}

function cleanText(s: unknown): string {
  return String(s ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+'s\b/g, "'s")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Parse le play-by-play ESPN. `teamIdToAbbr` et `athleteNames` viennent du boxscore.
 * Les numéros de séquence ESPN sont uniques et croissants ; on retombe sur l'index sinon.
 */
export function parsePlays(
  rawPlays: Json[],
  matchId: number,
  teamIdToAbbr: Record<string, string>,
  athleteNames: Record<string, string>,
): PlayRow[] {
  const out: PlayRow[] = [];
  const seen = new Set<number>();
  let lastSeq = 0;
  rawPlays.forEach((p: Json, idx: number) => {
    // ESPN renumérote ses `sequenceNumber` à la relecture : ils ne sont pas
    // croissants dans le tableau (constaté sur le match Portland@Lakers :
    // 497 → 486). Comme `seq` est la clé primaire (match_id, seq) et sert
    // au tri des sous-titres, on impose une progression STRICTE.
    const espnSeq = Number(p?.sequenceNumber);
    let seq: number;
    if (!Number.isFinite(espnSeq) || seen.has(espnSeq) || espnSeq <= lastSeq) {
      seq = lastSeq + 1;
    } else {
      seq = espnSeq;
    }
    seen.add(seq);
    lastSeq = seq;
    const eventType = cleanText(p?.type?.text);
    const text = cleanText(p?.text);
    const scoring = p?.scoringPlay ? 1 : 0;
    const participants: string[] = (p?.participants ?? [])
      .map((x: Json) => athleteNames[String(x?.athlete?.id ?? '')] ?? '')
      .filter(Boolean);
    const category = classifyPlay(eventType, text, !!scoring);
    out.push({
      match_id: matchId,
      seq,
      period: Number(p?.period?.number ?? 0),
      clock_display: String(p?.clock?.displayValue ?? ''),
      clock_sec: parseClock(p?.clock?.displayValue),
      wallclock: p?.wallclock ? normalizeIsoUtc(p.wallclock) : '',
      event_type: eventType,
      text_en: text,
      actor: participants[0] ?? '',
      team_abbr: teamIdToAbbr[String(p?.team?.id ?? '')] ?? '',
      home_score: intOrNull(p?.homeScore),
      away_score: intOrNull(p?.awayScore),
      scoring,
      is_key: isKeyCategory(category) ? 1 : 0,
      score_value: Number(p?.scoreValue ?? 0),
      participants,
    });
    void idx;
  });
  // Le wallclock est indispensable à la synchro : on comble les trous par le précédent connu.
  let last = '';
  for (const p of out) {
    if (p.wallclock) last = p.wallclock;
    else p.wallclock = last;
  }
  return out;
}

export function parseSummary(json: Json, matchId: number, league = 'nba'): ParsedSummary {
  const teamIdToAbbr: Record<string, string> = {};
  const athleteNames: Record<string, string> = {};
  const box = json?.boxscore ?? {};

  for (const t of box.teams ?? []) if (t?.team?.id) teamIdToAbbr[String(t.team.id)] = String(t.team.abbreviation);
  for (const c of json?.header?.competitions?.[0]?.competitors ?? [])
    if (c?.team?.id) teamIdToAbbr[String(c.team.id)] = String(c.team.abbreviation);

  const teams: TeamStatRow[] = (box.teams ?? []).map((t: Json) => {
    const stats: Record<string, string> = {};
    for (const s of t.statistics ?? []) stats[String(s.abbreviation ?? s.label ?? s.name)] = String(s.displayValue ?? '');
    return { match_id: matchId, team_abbr: String(t.team?.abbreviation ?? ''), stats };
  });

  const players: PlayerStatRow[] = [];
  for (const group of box.players ?? []) {
    const abbr = String(group?.team?.abbreviation ?? '');
    for (const block of group?.statistics ?? []) {
      const names: string[] = block.names ?? block.labels ?? [];
      for (const a of block.athletes ?? []) {
        const id = String(a?.athlete?.id ?? '');
        if (!id) continue;
        athleteNames[id] = String(a.athlete.displayName ?? a.athlete.shortName ?? '');
        const stats: Record<string, string> = {};
        (a.stats ?? []).forEach((v: unknown, i: number) => {
          if (names[i]) stats[names[i]] = String(v ?? '');
        });
        if (a.didNotPlay) stats.DNP = String(a.reason ?? 'DNP');
        players.push({
          match_id: matchId,
          team_abbr: abbr,
          player_id: id,
          player_name: athleteNames[id],
          position: String(a.athlete?.position?.abbreviation ?? ''),
          jersey: String(a.athlete?.jersey ?? ''),
          starter: a.starter ? 1 : 0,
          stats,
        });
      }
    }
  }

  const leaders: LeaderRow[] = [];
  for (const tl of json?.leaders ?? []) {
    const abbr = String(tl?.team?.abbreviation ?? '');
    for (const cat of tl?.leaders ?? []) {
      const top = cat?.leaders?.[0];
      if (!top) continue;
      leaders.push({
        team_abbr: abbr,
        category: String(cat.name ?? ''),
        label: String(cat.displayName ?? cat.name ?? ''),
        player: String(top.athlete?.displayName ?? ''),
        value: String(top.displayValue ?? ''),
      });
    }
  }

  const headerComp = json?.header?.competitions?.[0];
  let match: ParsedMatch | null = null;
  if (headerComp) {
    match = parseEvent(
      {
        id: json?.header?.id ?? matchId,
        date: headerComp.date,
        season: json?.header?.season,
        status: headerComp.status,
        competitions: [{ ...headerComp, venue: json?.gameInfo?.venue ?? headerComp.venue }],
      },
      league,
    );
  }

  const plays = parsePlays(json?.plays ?? [], matchId, teamIdToAbbr, athleteNames);
  return { match, teams, players, leaders, plays };
}

// ------------------------------------------------------------------ fetchers

export async function fetchScoreboard(dates: string, league = 'nba', limit = 1000): Promise<ParsedMatch[]> {
  const json = await fetchJson(`${ESPN_SITE}/${league}/scoreboard?dates=${dates}&limit=${limit}`);
  return parseScoreboard(json, league);
}

export async function fetchSummary(eventId: number | string, league = 'nba'): Promise<ParsedSummary> {
  const json = await fetchJson(`${ESPN_SITE}/${league}/summary?event=${eventId}`);
  return parseSummary(json, Number(eventId), league);
}

export interface StandingRow {
  conference: string;
  abbr: string;
  name: string;
  wins: number;
  losses: number;
  pct: string;
  gb: string;
  streak: string;
  home: string;
  road: string;
  last10: string;
  seed: number;
  diff: string;
}

export function parseStandings(json: Json): { conference: string; rows: StandingRow[] }[] {
  const out: { conference: string; rows: StandingRow[] }[] = [];
  for (const conf of json?.children ?? []) {
    const name = String(conf.name ?? '').replace('Eastern Conference', 'Conférence Est').replace('Western Conference', 'Conférence Ouest');
    const rows: StandingRow[] = (conf?.standings?.entries ?? []).map((e: Json) => {
      const s: Record<string, string> = {};
      for (const st of e.stats ?? []) s[String(st.name ?? st.type)] = String(st.displayValue ?? st.value ?? '');
      const byType: Record<string, string> = {};
      for (const st of e.stats ?? []) if (st.type) byType[String(st.type)] = String(st.displayValue ?? '');
      return {
        conference: name,
        abbr: String(e.team?.abbreviation ?? ''),
        name: String(e.team?.displayName ?? ''),
        wins: Number(s.wins ?? 0),
        losses: Number(s.losses ?? 0),
        pct: s.winPercent ?? '',
        gb: s.gamesBehind ?? '',
        streak: s.streak ?? '',
        home: s.Home ?? byType.home ?? '',
        road: s.Road ?? byType.road ?? '',
        last10: s['Last Ten Games'] ?? byType.lasttengames ?? '',
        seed: Number(s.playoffSeed ?? 0),
        diff: s.differential ?? '',
      } satisfies StandingRow;
    });
    rows.sort((a, b) => (a.seed || 99) - (b.seed || 99) || b.wins - a.wins);
    out.push({ conference: name, rows });
  }
  return out;
}

export async function fetchStandings(league = 'nba'): Promise<{ conference: string; rows: StandingRow[] }[]> {
  const json = await fetchJson(`${ESPN_V2}/${league}/standings`);
  return parseStandings(json);
}
