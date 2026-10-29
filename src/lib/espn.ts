/**
 * Client ESPN (API publique sans clé) + parseurs purs (testés).
 * Base : https://site.api.espn.com/apis/site/v2/sports/basketball/<league>/
 */
import { fetchJson } from './http';
import { espnDate } from './time';
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
 * Nom du joueur principal déduit du texte ESPN.
 *
 * Repli indispensable : ESPN ne renseigne PAS `participants` pour les
 * lancers francs (mesuré sur le match Portland@Lakers : `participants=[None]`).
 * Sans ce repli, `actor` est vide sur ces actions et les séries de lancers
 * francs ne peuvent jamais être regroupées par tireur.
 *
 * Formats rencontrés :
 *   "Luka Doncic makes free throw 1 of 2"
 *   "Brandon Miller makes 24-foot three point jump shot"
 *   "Pascal Siakam defensive rebound"
 */
export function actorFromText(text: string): string {
  const clean = cleanText(text);
  // Les noms de joueurs comportent des particules en minuscules
  // (« Tristan da Silva », « de Larrea ») et des diacritiques. Sans le flag
  // `u`, `\w` ne couvre pas « é » et la particule « da » était interprétée
  // comme la fin du nom : deux tireurs différents se retrouvaient fusionnés
  // dans une même série de lancers francs.
  const NAME = "[A-ZÀ-ÖØ-Þ][\\p{L}'’.-]*";
  const PARTICLE = '(?:d[aeiu]|v[ao]n|de|del|della|di|da|dos|las|el|al)';
  const m = clean.match(
    new RegExp(
      `^(${NAME}(?: ${PARTICLE})?(?: ${NAME}){0,2})\\s+(?:makes|misses|blocks|steals|grabs|commits|enters|leaves|is called for|tosses|defensive rebound|offensive rebound|turnover|traveling)`,
      'u',
    ),
  );
  return m ? m[1] : '';
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
      actor: participants[0] ?? actorFromText(text),
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

/**
 * Calendrier sur une période, en contournant le refus de l'API pour les plages.
 *
 * ESPN **ne accepte pas** `dates=YYYYMMDD-YYYYMMDD` : la requête renvoie
 * HTTP 400 (mesuré). Les seuls formats acceptés sont `YYYYMMDD` (un jour),
 * `YYYYMM` (un mois) et `YYYY` (une année, plafonnée à 1 000 matchs).
 *
 * On découpe donc la période :
 *  - moins de 40 jours : un appel par jour (précis, et le jour ESPN est le
 *    jour US local — le conversion se fait à l'affichage) ;
 *  - 40 jours ou plus : un appel par mois (`YYYYMM`), chaque mois tenant
 *    sous le plafond de 1 000 matchs (environ 155 pour la NBA).
 *
 * Les erreurs d'un jour isolé n'interrompent pas la collecte : elles sont
 * cumulées et signalées à la fin, pour qu'un incident transitoire ne vide
 * pas le calendrier.
 */
export async function fetchScoreboardRange(
  from: Date,
  to: Date,
  league = 'nba',
  limit = 1000,
): Promise<ParsedMatch[]> {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  if (end < start) return [];
  // `spanDays` est l'écart entre les bornes (28→29 = 1 jour d'écart) ;
  // `attempts` est le nombre d'appels réellement effectués (bornes
  // incluses = spanDays + 1). Les deux ne doivent pas être confondus.
  const spanDays = Math.round((end - start) / 86400_000);

  const out: ParsedMatch[] = [];
  const errors: string[] = [];
  let attempts = 0;

  if (spanDays < 40) {
    for (let t = start; t <= end; t += 86400_000) {
      const d = new Date(t);
      attempts++;
      try {
        out.push(...(await fetchScoreboard(espnDate(d), league, limit)));
      } catch (e) {
        errors.push(`${espnDate(d)}: ${(e as Error).message}`);
      }
    }
  } else {
    // Un appel par mois : du premier jour du mois de départ au dernier
    // jour du mois d'arrivée.
    const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    const lastMonth = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1);
    while (cursor.getTime() <= lastMonth) {
      const y = cursor.getUTCFullYear();
      const m = String(cursor.getUTCMonth() + 1).padStart(2, '0');
      attempts++;
      try {
        out.push(...(await fetchScoreboard(`${y}${m}`, league, limit)));
      } catch (e) {
        errors.push(`${y}${m}: ${(e as Error).message}`);
      }
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  // Le calendrier n'est rejeté que si TOUS les appels ont échoué ET
  // qu'aucun match n'a été trouvé. Un jour en erreur sur trois ne doit pas
  // faire échouer la collecte : les jours restants restent exploitables.
  if (!out.length && attempts > 0 && errors.length === attempts) {
    throw new Error(errors.join(' | '));
  }
  return out;
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
