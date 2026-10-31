/**
 * Produit, avec le code Node, les données attendues des pages (étape 8a,
 * `GET /api/pages/…`, server/src/pages.rs) : server/tests/fixtures/pages.expected.json,
 * comparé à l'octet près par tests/pages_node.rs.
 *
 * Mode fixture (par défaut) :
 * - base au schéma réel (migrations de db.ts), remplie avec le code Node :
 *   vraie nuit ESPN du 27/10/2026 (tableau des scores, stats, play-by-play du
 *   match 401909880), calendrier synthétique autour d'elle (saison passée,
 *   présaison, playoffs, All-Star, matchs en cours et à venir, replays HLS ou
 *   MP4, pistes de traduction complètes, partielles ou périmées), classement
 *   ESPN réel, comptes, sessions, réglages ;
 * - pour chaque scénario (page, instant présent figé, variables
 *   d'environnement, réglages, cookie « scores masqués », session,
 *   paramètres), ce que calcule le composant serveur de la page — mêmes
 *   fonctions de src/lib, dans le même ordre —, mis à la forme du contrat de
 *   `/api/pages/…`, et l'état des files de Node que Rust reçoit de
 *   `POST /api/internal/page-state`.
 *
 * Mode direct (`--live <base> <url du serveur Rust> <jeton de session>
 * [<url de Node>]`, `INGEST_TOKEN` posé) : calcule les mêmes données sur une
 * base existante, à l'instant réel, et compare chaque réponse de
 * `/api/pages/…` du serveur Rust (lancé sur cette base, Node à côté) octet par
 * octet. Avec l'URL de Node, l'état des files est lu chez lui
 * (`/api/internal/page-state`) comme le fait Rust.
 *
 * À relancer après une modification des pages ou de leurs modules, depuis la
 * racine du dépôt :
 *   npx -y tsx server/tests/node-fixtures-pages.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'server', 'tests', 'fixtures');
const LIVE = process.argv[2] === '--live';

// ------------------------------------------------------------------ horloge figée

const RealDate = Date;
let fakeNow: number | null = null;
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(fakeNow ?? RealDate.now());
    else super(...(args as [string]));
  }
  static now(): number {
    return fakeNow ?? RealDate.now();
  }
}
globalThis.Date = FakeDate as unknown as DateConstructor;
const setNow = (iso: string | null) => {
  fakeNow = iso === null ? null : RealDate.parse(iso);
};

// ------------------------------------------------------------------ environnement

const ENV_KEYS = ['COMMENTARY_NIGHT_WINDOW', 'APP_COMMIT', 'APP_BUILT_AT', 'COMMENTARY_DISABLED', 'DUB_DISABLED', 'TRANSCRIBE_URL', 'TRANSLATE_URL'];
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-pages-fx-'));
if (LIVE) {
  process.env.DB_PATH = process.argv[3];
} else {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DATA_DIR = DATA;
  process.env.DB_PATH = path.join(DATA, 'basketland.db');
  process.env.TRANSCRIBE_URL = 'http://gpu.local:8000/v1';
  process.env.TRANSLATE_URL = 'http://gpu.local:11434/v1';
}
// Classement : ESPN « injoignable » (cache périmé servi), aucun appel réseau en mode fixture.
if (!LIVE) {
  globalThis.fetch = (async () => {
    throw new Error('hors ligne (fixture)');
  }) as typeof fetch;
}

const db = await import(path.join(ROOT, 'src/lib/db.ts'));
const espn = await import(path.join(ROOT, 'src/lib/espn.ts'));
const q = await import(path.join(ROOT, 'src/lib/queries.ts'));
const teamsLib = await import(path.join(ROOT, 'src/lib/teams.ts'));
const linescore = await import(path.join(ROOT, 'src/lib/linescore.ts'));
const vf = await import(path.join(ROOT, 'src/lib/vf.ts'));
const present = await import(path.join(ROOT, 'src/lib/present.ts'));
const time = await import(path.join(ROOT, 'src/lib/time.ts'));
const settings = await import(path.join(ROOT, 'src/lib/settings.ts'));
const auth = await import(path.join(ROOT, 'src/lib/auth.ts'));
const authRoutes = await import(path.join(ROOT, 'src/lib/authRoutes.ts'));
const version = await import(path.join(ROOT, 'src/lib/version.ts'));
const nightWindow = await import(path.join(ROOT, 'src/lib/nightWindow.ts'));
const commentary = await import(path.join(ROOT, 'src/lib/commentary.ts'));
const activity = await import(path.join(ROOT, 'src/lib/activity.ts'));
const dub = await import(path.join(ROOT, 'src/lib/dub.ts'));

console.log = () => {};
const log = (...a: unknown[]) => process.stderr.write(a.join(' ') + '\n');

type Game = Record<string, any>;
type Session = { user: { id: number; username: string; role: string } } | null;

// ------------------------------------------------------------------ état de Node (POST /api/internal/page-state)

/**
 * Mode direct : état lu chez le vrai processus Node (comme le fait Rust), pas
 * dans ce script — les files tournent là-bas. `commentaryRunningMatchId` reste
 * celui de ce script (lu à l'intérieur de `toViews`) : comparer sans
 * traduction en cours.
 */
let liveNode: { url: string; token: string } | null = null;
let nodeOverride: Record<string, any> | null = null;

async function nodeState(withDub: boolean) {
  if (liveNode) {
    const r = await fetch(liveNode.url + '/api/internal/page-state', {
      method: 'POST',
      headers: { authorization: `Bearer ${liveNode.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ dub: withDub }),
    });
    nodeOverride = (await r.json()) as Record<string, any>;
    return nodeOverride;
  }
  return {
    running_match_id: commentary.commentaryRunningMatchId(),
    activity: activity.currentActivity(),
    commentary_disabled_reason: commentary.commentaryDisabledReason(),
    dub_disabled_reason: withDub ? await dub.dubDisabledReason() : null,
  };
}

// ------------------------------------------------------------------ pages (même code que src/app/**/page.tsx)

/** Map → objet, par clé croissante (contrat de /api/pages : une table de correspondance). */
const sortedObject = <V, R>(m: Map<string, V>, f: (v: V) => R) =>
  Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, f(v)]));
const rec = (r: { wins: number; losses: number }) => ({ wins: r.wins, losses: r.losses });

function sessionPage(session: Session, next: string | undefined) {
  return {
    has_users: session ? true : auth.hasUsers(),
    user: session ? { id: session.user.id, username: session.user.username, role: session.user.role } : null,
    next: authRoutes.safeNextPath(next),
  };
}

function idleText(auto: boolean, untranslated: boolean): string {
  const none = 'Aucun traitement en cours';
  if (nodeOverride ? nodeOverride.commentary_disabled_reason : commentary.commentaryDisabledReason()) return `${none} — traduction des commentaires non configurée.`;
  if (!auto) return `${none} — traduction à la demande : « Sous-titrer ce match » sur la fiche d’un match.`;
  if (!nightWindow.inScheduleWindow()) {
    const hours = nightWindow.nightWindowLabel();
    return hours ? `${none} — traduction automatique ${hours}.` : `${none} — un match est traduit dès qu’on le regarde.`;
  }
  return untranslated ? `${none}.` : `${none} — tous les replays disponibles sont traités.`;
}

function nightTitle(night: string, today: string): string {
  if (night === today || night === q.shiftKey(today, -1)) return 'Cette nuit';
  if (night === q.shiftKey(today, 1)) return 'Demain soir';
  return 'Prochaine nuit';
}

function homePage(spoilers: string) {
  const now = new Date();
  const today = q.todayKey(now);
  const season = q.latestSeason();
  const live = q.liveGames();
  const replays: Game[] = q.latestReplays(9);
  const hero = replays[0];
  const night = q.nextNightKey(now);
  const nightGames: Game[] = night ? q.gamesOfNight(night) : [];
  const nextUp = nightGames.find((g) => g.status === 'scheduled' && Date.parse(g.date_utc) > now.getTime());
  const lastNightDay = nightGames.reduce((m: string, g) => (g.day_paris > m ? g.day_paris : m), today);
  const days = q.upcomingDays(q.shiftKey(lastNightDay, 1), 4, now);
  const standings = q.cachedStandings();
  const autoTranslate = settings.autoTranslateEnabled();
  const act = nodeOverride ? nodeOverride.activity : activity.currentActivity();
  const vfCount = {
    ready: replays.filter((g) => g.vf.state === 'ready').length,
    running: replays.filter((g) => g.vf.state === 'running').length,
    partial: replays.filter((g) => g.vf.state === 'partial').length,
    todo: replays.filter((g) => g.vf.state === 'none').length,
  };
  return {
    spoilers,
    today,
    season: season ?? null,
    live,
    replays,
    hero_night: hero ? q.nightKeyOf(hero.date_utc) : null,
    night: night ?? null,
    night_title: night ? nightTitle(night, today) : null,
    night_games: nightGames,
    next_up_id: nextUp?.id ?? null,
    days: days.map((d: { key: string; games: Game[] }) => ({ key: d.key, games: d.games })),
    standings: standings ?? null,
    auto_translate: autoTranslate,
    activity: act,
    vf_count: vfCount,
    idle_text: idleText(autoTranslate, vfCount.todo + vfCount.partial > 0),
    night_window_label: nightWindow.nightWindowLabel(),
  };
}

function matchsPage(spoilers: string, sp: Record<string, string | undefined>) {
  const today = q.todayKey();
  const teamParam = sp.team?.toUpperCase();
  const team = teamParam && teamsLib.isNbaTeam(teamParam) ? teamParam : undefined;
  const d = sp.d;
  const selected = q.isDateKey(d) ? d! : q.defaultCalendarDay();
  let day: unknown = null;
  let teamView: unknown = null;
  if (!team) {
    const counts = q.dayCounts(q.shiftKey(selected, -7), q.shiftKey(selected, 7));
    const games: Game[] = q.gamesOfDay(selected);
    const records = q.seasonRecords();
    const prev = q.prevDayWithGames(selected);
    const next = q.nextDayWithGames(selected, true);
    const replays = games.filter((g) => g.hasReplay).length;
    const upcoming = games.filter((g) => q.isUpcoming(g)).length;
    const live = games.filter((g) => g.status === 'live').length;
    const allNight = games.length > 0 && games.every((g) => Number(g.time_paris.slice(0, 2)) < 12);
    day = {
      counts: sortedObject(counts, (c: Record<string, number>) => ({ total: c.total, final: c.final, live: c.live, replays: c.replays })),
      games,
      records: sortedObject(records, rec),
      prev: prev ?? null,
      next: next ?? null,
      replays,
      upcoming,
      live,
      all_night: allNight,
    };
  } else {
    const all: Game[] = q.teamGames(team);
    const now = new Date();
    const upcoming = all.filter((g) => q.isUpcoming(g, now));
    const played = all.filter((g) => g.status === 'final').reverse();
    const r = q.seasonRecords().get(team) ?? { wins: 0, losses: 0 };
    teamView = { upcoming, played, record: rec(r) };
  }
  return { spoilers, today, team: team ?? null, selected, day, team_view: teamView };
}

const PERIOD_CATS = new Set(['period_start', 'period_end', 'game_end']);
const EXTRA_KEY_CATS = new Set(['blocked_fg', 'foul_flagrant', 'foul_technical', 'ejection', 'review', 'challenge']);

function toPlayItems(plays: any[]) {
  let prevTotal = 0;
  return plays.map((p) => {
    const total = p.home_score !== null && p.away_score !== null ? p.home_score + p.away_score : null;
    const pts = p.scoring && total !== null ? Math.max(0, Math.min(4, total - prevTotal)) : 0;
    if (total !== null) prevTotal = total;
    const cat = vf.classifyPlay(p.event_type, p.text_en, !!p.scoring);
    let text: string;
    try {
      text = vf.translatePlay({ ...p, score_value: pts });
    } catch {
      text = p.text_en;
    }
    return {
      seq: p.seq,
      period: p.period,
      clock: p.clock_display,
      text,
      team: p.team_abbr ?? '',
      away: p.away_score,
      home: p.home_score,
      pts,
      key: !!p.is_key || pts > 0 || EXTRA_KEY_CATS.has(cat),
      type: PERIOD_CATS.has(cat) ? 'period' : 'play',
    };
  });
}

function loadMatch(raw: string) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db.getMatch(id);
  return row ? present.toDto(row) : null;
}

function matchPage(spoilers: string, session: Session, raw: string): [number, unknown] {
  const match = loadMatch(raw);
  if (!match) return [404, { error: 'match introuvable', title: 'Match introuvable' }];
  // generateMetadata
  const a = teamsLib.teamInfo(match.away.abbr).nick;
  const h = teamsLib.teamInfo(match.home.abbr).nick;
  const what = match.status === 'final' ? (match.video.available ? 'replay en VF' : 'statistiques') : 'avant-match';
  const title = `${a} – ${h} · ${what}`;
  const description = `${match.away.name} contre ${match.home.name}, ${time.parisDateLabel(match.date_utc)} à ${match.time_paris} (heure de Paris).`;
  // page
  const isFinal = match.status === 'final';
  const isLive = match.status === 'live';
  const upcoming = !isFinal && !isLive;
  const plays = upcoming ? [] : db.getPlays(match.id);
  const ls = linescore.computeLinescore(plays);
  const items = toPlayItems(plays);
  const lite = plays.map((p: any) => [p.seq, p.period, p.clock_sec, p.clock_display]);
  const hasVideo = isFinal && match.video.available && !!match.video.src;
  const positions = hasVideo ? db.getSubtitles(match.id).map((s: any) => [s.seq, s.video_ts]) : [];
  const autoTranslate = settings.autoTranslateEnabled();
  const vfMode = settings.vfMode();
  const isAdmin = session?.user.role === 'admin';
  return [
    200,
    {
      title,
      description,
      spoilers,
      match,
      linescore: ls,
      plays: items,
      lite,
      has_video: hasVideo,
      positions,
      auto_translate: autoTranslate,
      vf_mode: vfMode,
      is_admin: isAdmin,
    },
  ];
}

const DIVISIONS: Record<string, string[]> = {
  Est: ['Atlantique', 'Centrale', 'Sud-Est'],
  Ouest: ['Nord-Ouest', 'Pacifique', 'Sud-Ouest'],
};

function equipesPage() {
  const records = q.seasonRecords();
  const next = q.nextGameByTeam();
  const seeds = q.conferenceSeeds();
  const season = q.latestSeason();
  const today = q.todayKey();
  return {
    season: season ?? null,
    today,
    conferences: (['Est', 'Ouest'] as const).map((conf) => ({
      conference: conf,
      divisions: DIVISIONS[conf].map((div) => {
        const list = teamsLib.TEAMS.filter((t: any) => t.conference === conf && t.division === div).sort((a: any, b: any) => {
          const ra = records.get(a.abbr);
          const rb = records.get(b.abbr);
          const pa = ra && ra.wins + ra.losses ? ra.wins / (ra.wins + ra.losses) : 0;
          const pb = rb && rb.wins + rb.losses ? rb.wins / (rb.wins + rb.losses) : 0;
          return pb - pa || (rb?.wins ?? 0) - (ra?.wins ?? 0) || a.nick.localeCompare(b.nick);
        });
        return {
          division: div,
          teams: list.map((t: any) => ({
            team: t,
            record: records.get(t.abbr) ? rec(records.get(t.abbr)) : null,
            next: next.get(t.abbr) ?? null,
            seed: seeds.get(t.abbr) ?? null,
          })),
        };
      }),
    })),
  };
}

function seasonSummary(games: Game[], team: string) {
  const season = q.latestSeason();
  const regular = games.filter((g) => g.status === 'final' && g.season === season && g.season_type === 'regular');
  const total = { wins: 0, losses: 0 };
  const home = { wins: 0, losses: 0 };
  const road = { wins: 0, losses: 0 };
  const results: boolean[] = [];
  for (const g of regular) {
    const isHome = g.home.abbr === team;
    const mine = isHome ? g.home.score : g.away.score;
    const theirs = isHome ? g.away.score : g.home.score;
    if (mine === null || theirs === null || mine === theirs) continue;
    const won = mine > theirs;
    const bucket = isHome ? home : road;
    if (won) {
      total.wins++;
      bucket.wins++;
    } else {
      total.losses++;
      bucket.losses++;
    }
    results.push(won);
  }
  let streak = 0;
  const last = results[results.length - 1];
  for (let i = results.length - 1; i >= 0 && results[i] === last; i--) streak++;
  return { season, total, home, road, streak: streak ? `${last ? 'V' : 'D'}${streak}` : '—', streakWin: last };
}

const ABBR_RE = /^[A-Z]{2,4}$/;

function equipePage(spoilers: string, raw: string): [number, unknown] {
  const abbr = raw.toUpperCase();
  if (!ABBR_RE.test(abbr)) return [404, { error: 'équipe introuvable' }];
  const all: Game[] = q.teamGames(abbr);
  if (!all.length && !teamsLib.isNbaTeam(abbr)) return [404, { error: 'équipe introuvable' }];
  // generateMetadata
  const tm = teamsLib.teamInfo(abbr);
  const title = teamsLib.isNbaTeam(abbr) ? `${tm.city} ${tm.nick}` : abbr;
  // page
  const t = teamsLib.teamInfo(abbr);
  const now = new Date();
  const today = q.todayKey(now);
  const upcoming = all.filter((g) => q.isUpcoming(g, now));
  const finished = all.filter((g) => g.status === 'final');
  const recent = [...finished].reverse();
  const replays = recent.filter((g) => g.hasReplay);
  const summary = seasonSummary(all, abbr);
  const nextGame = upcoming[0];
  const conf = q.cachedStandings()?.find((c: any) => c.rows.some((r: any) => r.abbr === abbr));
  const rank = conf ? conf.rows.findIndex((r: any) => r.abbr === abbr) : -1;
  const seed = conf && rank >= 0 ? conf.rows[rank].seed || rank + 1 : undefined;
  const played = summary.total.wins + summary.total.losses;
  const pct = played ? Math.round((summary.total.wins / played) * 1000) / 10 : undefined;
  return [
    200,
    {
      title,
      spoilers,
      abbr,
      team: t,
      today,
      upcoming_count: upcoming.length,
      next_game: nextGame ?? null,
      upcoming_rest: upcoming.slice(1, 9),
      finished_count: finished.length,
      form: finished.filter((g) => g.season_type === 'regular').slice(-10),
      recent: recent.slice(0, 10),
      replays_count: replays.length,
      replays: replays.slice(0, 6),
      summary: {
        season: summary.season ?? null,
        total: summary.total,
        home: summary.home,
        road: summary.road,
        streak: summary.streak,
        streak_win: summary.streakWin ?? null,
      },
      seed: seed ?? null,
      pct: pct ?? null,
    },
  ];
}

async function classementPage() {
  // loadStandings de src/app/classement/page.tsx.
  const key = 'standings:nba';
  let data = db.kvGet(key, 30 * 60_000);
  if (!data) {
    try {
      data = await espn.fetchStandings('nba');
      db.kvSet(key, data);
    } catch {
      data = db.kvGet(key, Infinity);
    }
  }
  return { conferences: data ?? [] };
}

const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: time.PARIS_TZ });
function versionText(): string {
  const { commit, builtAt } = version.appVersion();
  if (!commit) return 'Numéro de version non renseigné.';
  return `Version ${commit}${builtAt ? ` · image construite le ${dateFmt.format(new Date(builtAt))}` : ''}.`;
}

async function parametresPage(session: NonNullable<Session>, dubReason: () => Promise<string | null>) {
  const { user } = session;
  const admin = user.role === 'admin';
  const adminData = admin
    ? {
        users: db.listUsers(),
        auto_translate: settings.autoTranslateEnabled(),
        vf_mode: settings.vfMode(),
        voice_disabled_reason: await dubReason(),
        minimax: settings.minimaxSettingsView(),
        openai: settings.openAiSettingsView(),
        openai_model_placeholder: settings.OPENAI_MODEL_PLACEHOLDER,
      }
    : null;
  return {
    user: { id: user.id, username: user.username, role: user.role },
    admin,
    admin_data: adminData,
    version: version.appVersion(),
    version_text: versionText(),
  };
}

// ------------------------------------------------------------------ scénario

interface Scenario {
  name: string;
  page: 'session' | 'home' | 'matchs' | 'match' | 'equipes' | 'equipe' | 'classement' | 'parametres';
  now?: string;
  env?: Record<string, string>;
  settings?: Record<string, string | null>;
  spoilers?: 'show' | 'hide';
  token?: string | null;
  params?: Record<string, string>;
  /** Avant le calcul : état des files (fixture seulement). */
  setup?: () => void;
}

async function compute(s: Scenario): Promise<{ status: number; body: unknown; node: unknown }> {
  const spoilers = s.spoilers ?? 'show';
  const session: Session = s.token ? auth.validateSession(s.token, { renew: false }) : null;
  const params = s.params ?? {};
  const needsNode = ['home', 'matchs', 'equipes', 'equipe'].includes(s.page) || (s.page === 'parametres' && session?.user.role === 'admin');
  const node = needsNode ? await nodeState(s.page === 'parametres') : { running_match_id: null, activity: null, commentary_disabled_reason: null, dub_disabled_reason: null };
  switch (s.page) {
    case 'session':
      return { status: 200, body: sessionPage(session, params.next), node };
    case 'home':
      return { status: 200, body: homePage(spoilers), node };
    case 'matchs':
      return { status: 200, body: matchsPage(spoilers, params), node };
    case 'match': {
      const [status, body] = matchPage(spoilers, session, params.id);
      return { status, body, node };
    }
    case 'equipes':
      return { status: 200, body: equipesPage(), node };
    case 'equipe': {
      const [status, body] = equipePage(spoilers, params.abbr);
      return { status, body, node };
    }
    case 'classement':
      return { status: 200, body: await classementPage(), node };
    case 'parametres':
      if (!session) return { status: 401, body: { error: 'non connecté' }, node };
      return { status: 200, body: await parametresPage(session, async () => (node as { dub_disabled_reason: string | null }).dub_disabled_reason), node };
  }
}

/** Chemin de `/api/pages/…` d'un scénario. */
function pageUrl(s: Scenario): string {
  const p = s.params ?? {};
  const qs = (o: Record<string, string>) => {
    const u = new URLSearchParams(o).toString();
    return u ? `?${u}` : '';
  };
  switch (s.page) {
    case 'match':
      return `/api/pages/matchs/${encodeURIComponent(p.id)}`;
    case 'equipe':
      return `/api/pages/equipes/${encodeURIComponent(p.abbr)}`;
    case 'home':
      return '/api/pages/home';
    default:
      return `/api/pages/${s.page}${qs(p)}`;
  }
}

// ------------------------------------------------------------------ mode direct

if (LIVE) {
  const [, , , , base, token, nodeUrl] = process.argv;
  if (nodeUrl) liveNode = { url: nodeUrl, token: process.env.INGEST_TOKEN ?? '' };
  const teamsWithGames = db.listTeams().map((t: { abbr: string }) => t.abbr);
  const one = (where: string) =>
    (db.getDb().prepare(`SELECT id FROM matches WHERE league = 'nba' AND ${where} ORDER BY date_utc DESC LIMIT 1`).get() as { id: number } | undefined)?.id;
  const ids = [
    one(`status = 'final' AND video_available = 1`),
    one(`status = 'final' AND id IN (SELECT match_id FROM plays)`),
    one(`status = 'final' AND video_available = 0 AND id NOT IN (SELECT match_id FROM plays)`),
    one(`status = 'live'`),
    one(`status = 'scheduled'`),
  ].filter((x): x is number => x !== undefined);
  const scenarios: Scenario[] = [
    { name: 'session', page: 'session', token, params: { next: '/matchs?d=2026-10-27' } },
    { name: 'home', page: 'home', token },
    { name: 'matchs', page: 'matchs', token },
    { name: 'matchs-hier', page: 'matchs', token, params: { d: q.shiftKey(q.todayKey(), -1) } },
    { name: 'matchs-equipe', page: 'matchs', token, params: { team: teamsWithGames[0] ?? 'LAL' } },
    ...ids.map((id) => ({ name: `match-${id}`, page: 'match' as const, token, params: { id: String(id) } })),
    { name: 'match-introuvable', page: 'match', token, params: { id: '999999999' } },
    { name: 'equipes', page: 'equipes', token },
    ...teamsWithGames.slice(0, 5).map((abbr: string) => ({ name: `equipe-${abbr}`, page: 'equipe' as const, token, params: { abbr } })),
    { name: 'classement', page: 'classement', token },
    { name: 'parametres', page: 'parametres', token },
  ];
  let bad = 0;
  for (const s of scenarios) {
    nodeOverride = null;
    const res = await fetch(base + pageUrl(s), { headers: { cookie: `bl_session=${token}` } });
    const got = await res.text();
    const { status, body } = await compute(s);
    const want = JSON.stringify(body);
    const ok = res.status === status && got === want;
    if (!ok) bad++;
    log(`${ok ? 'identique' : 'ÉCART    '} ${s.name} (${res.status}, ${got.length} octets)`);
    if (!ok) {
      const i = [...want].findIndex((c, k) => got[k] !== c);
      log(`  node : ${want.slice(Math.max(0, i - 80), i + 120)}\n  rust : ${got.slice(Math.max(0, i - 80), i + 120)}`);
    }
  }
  log(bad ? `${bad} écart(s)` : `${scenarios.length} pages identiques à l'octet`);
  process.exit(bad ? 1 : 0);
}

// ------------------------------------------------------------------ base de la fixture

const BASE = '2026-10-29T19:00:00.000Z'; // jeudi 29 octobre 2026, 20 h à Paris
const plusH = (iso: string, h: number) => new RealDate(RealDate.parse(iso) + h * 3600_000).toISOString();
setNow(plusH(BASE, -0.5));
db.getDb();

const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', f), 'utf8'));

// Vraie nuit ESPN du 27 octobre (4 matchs terminés, dates ESPN sans secondes) et vrai match 401909880.
const REAL = 401909880;
db.upsertMatches(espn.parseScoreboard(readJson('espn-scoreboard-20261027.json')));
const summary = espn.parseSummary(readJson('espn-summary-401909880.json'), REAL);
db.replaceStats(REAL, summary.teams, summary.players, summary.leaders);
db.replacePlays(REAL, summary.plays);
db.markStatsSynced(REAL);
db.setVideo(REAL, { slug: 'por-lal', okId: '11655461160542', duration: 7480, available: true, kind: 'hls' });
db.setVideo(401909877, { slug: null, okId: '11655461160543', duration: 7000.5, available: true, kind: 'mp4' });
db.setVideo(401909878, { slug: null, okId: null, duration: null, available: false });
// Positions vidéo des actions (sous-titres d'action), avec des instants fractionnaires.
db.replaceSubtitles(
  REAL,
  summary.plays.slice(0, 60).map((p: any, i: number) => ({ seq: p.seq, video_ts: i === 3 ? 120 : 60 + i * 12.25, end_ts: 62 + i * 12.25, text_fr: 'x', speaker: '', kind: 'action' })),
);

// Calendrier synthétique : 37 jours autour du 29/10 (heures de Paris de 0 h 30 à 4 h, parfois 18 h).
const ABBRS: string[] = teamsLib.TEAMS.map((t: any) => t.abbr);
const NAMES: Record<string, string> = Object.fromEntries(teamsLib.TEAMS.map((t: any) => [t.abbr, `${t.city} ${t.nick}`]));
let seed = 20261029;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let nextId = 401910000;
const raw = db.getDb();
const sql = (s: string, p: Record<string, unknown> = {}) => raw.prepare(s).run(p as never);

function game(o: { date: string; home: string; away: string; season?: number; type?: string; status: string; hs?: number | null; as?: number | null; period?: number; clock?: string; venue?: string; broadcast?: string }) {
  const id = nextId++;
  db.upsertMatch({
    id,
    espn_id: String(id),
    league: 'nba',
    season: o.season ?? 2026,
    season_type: o.type ?? 'regular',
    date_utc: o.date,
    home_abbr: o.home,
    home_name: NAMES[o.home] ?? o.home,
    away_abbr: o.away,
    away_name: NAMES[o.away] ?? o.away,
    home_score: o.hs ?? null,
    away_score: o.as ?? null,
    status: o.status,
    status_detail: o.status === 'final' ? 'Final' : o.status === 'live' ? `Q${o.period ?? 2} ${o.clock ?? '5:00'}` : '',
    period: o.status === 'scheduled' ? 0 : (o.period ?? 4),
    clock_display: o.status === 'live' ? (o.clock ?? '5:00') : o.status === 'final' ? '0.0' : '',
    venue: o.venue ?? `${NAMES[o.home] ?? o.home} Arena`,
    broadcast: o.broadcast ?? (rnd() < 0.5 ? 'NBA League Pass' : ''),
  });
  return id;
}

const baseMs = RealDate.parse(BASE);
const finals: number[] = [];
for (let d = -24; d <= 12; d++) {
  const key = q.shiftKey('2026-10-29', d);
  if (d === -10 || d === 5) continue; // jours de relâche
  if (key === '2026-10-27' || key === '2026-10-28') continue; // la vraie nuit ESPN
  const n = 3 + (((d % 4) + 4) % 4);
  const order = [...ABBRS].sort(() => rnd() - 0.5);
  for (let i = 0; i < n; i++) {
    const afternoon = d === -3 && i === 0;
    const hours = afternoon ? 18 : [0.5, 1, 1.5, 2, 3.5, 4][i % 6];
    const date = new RealDate(RealDate.parse(time.parisDayStartUtc(key)) + hours * 3600_000).toISOString();
    const start = RealDate.parse(date);
    const home = order[2 * i];
    const away = order[2 * i + 1];
    const past = start < baseMs - 3 * 3600_000;
    const hs = 95 + Math.floor(rnd() * 35);
    let as = 95 + Math.floor(rnd() * 35);
    if (as === hs) as += 3;
    const id = game({ date, home, away, status: past ? 'final' : 'scheduled', hs: past ? hs : null, as: past ? as : null });
    if (past) finals.push(id);
  }
}
// Matchs en cours ce soir (18 h et 19 h 30 à Paris), un « programmé » commencé depuis peu, un match nul.
const liveA = game({ date: plusH(BASE, -2), home: 'LAL', away: 'GS', status: 'live', hs: 54, as: 50, period: 2, clock: '1:12' });
const liveB = game({ date: plusH(BASE, -0.5), home: 'MIA', away: 'NY', status: 'live', hs: 12, as: 9, period: 1, clock: '6:40' });
const lateScheduled = game({ date: plusH(BASE, -1), home: 'CHI', away: 'CLE', status: 'scheduled' });
const tie = game({ date: '2026-10-20T23:30:00.000Z', home: 'DEN', away: 'UTAH', status: 'final', hs: 100, as: 100 });
// Saison passée (saison régulière et playoffs), présaison, All-Star (équipes hors NBA).
for (let i = 0; i < 12; i++) {
  game({ date: `2026-04-${String(1 + i).padStart(2, '0')}T23:30:00.000Z`, season: 2025, home: i % 2 ? 'LAL' : 'POR', away: i % 2 ? 'BOS' : 'LAL', status: 'final', hs: 100 + i, as: 104 - i });
}
for (let i = 0; i < 4; i++) game({ date: `2026-05-0${1 + i}T01:00:00.000Z`, season: 2025, type: 'post', home: 'LAL', away: 'DEN', status: 'final', hs: 110 - i * 3, as: 105 });
for (let i = 0; i < 6; i++) game({ date: `2026-10-0${2 + i}T23:00:00.000Z`, type: 'preseason', home: ABBRS[i], away: ABBRS[29 - i], status: 'final', hs: 99, as: 101 + i });
const allStar = game({ date: '2026-02-15T01:00:00.000Z', season: 2025, home: 'WEST', away: 'EAST', status: 'final', hs: 186, as: 190 });
game({ date: '2027-02-14T01:00:00.000Z', home: 'WEST', away: 'EAST', status: 'scheduled' });

// Replays (HLS, MP4 provisoire), stats joueurs, pistes de traduction dans tous les états.
const allFinals = [...finals, tie, allStar, REAL, 401909877, 401909879];
const partialIds: number[] = [];
for (const id of allFinals) {
  if (id === REAL || id === 401909877 || id === 401909878) continue;
  const r = rnd();
  if (r < 0.7) {
    db.setVideo(id, { slug: null, okId: `ok${id}`, duration: 7000 + Math.floor(rnd() * 900), available: true, kind: rnd() < 0.2 ? 'mp4' : 'hls' });
  } else if (r < 0.8) {
    db.setVideo(id, { slug: null, okId: null, duration: null, available: false });
  }
  if (rnd() < 0.6) {
    sql(`INSERT INTO player_stats (match_id, team_abbr, player_id, player_name, stats_json) VALUES ($m, 'XXX', $p, 'Joueur', '{}')`, { m: id, p: `p${id}` });
  }
}
const track = (id: number, okId: string, o: { complete: number; total: number | null; done: number; cues?: number }) => {
  sql(
    `INSERT OR REPLACE INTO commentary_tracks (match_id, ok_id, transcribe_model, translate_model, cues, untranslated, created_at, complete, chunks_total)
     VALUES ($m, $ok, 'whisper', 'qwen', $cues, 0, $now, $c, $t)`,
    { m: id, ok: okId, cues: o.cues ?? 40, now: plusH(BASE, -30), c: o.complete, t: o.total },
  );
  for (let i = 0; i < o.done; i++) sql(`INSERT INTO commentary_chunks (match_id, idx, keep_from, keep_to) VALUES ($m, $i, $f, $t)`, { m: id, i, f: i * 600, t: (i + 1) * 600 });
};
const withVideo = (raw.prepare(`SELECT id, video_ok_id FROM matches WHERE video_available = 1 ORDER BY date_utc DESC`).all() as { id: number; video_ok_id: string }[]);
withVideo.forEach((m, i) => {
  const k = i % 6;
  if (k === 0) track(m.id, m.video_ok_id, { complete: 1, total: 13, done: 13 });
  else if (k === 1) {
    track(m.id, m.video_ok_id, { complete: 0, total: 13, done: 1 + (i % 11) });
    partialIds.push(m.id);
  } else if (k === 2) track(m.id, 'ancien-replay', { complete: 1, total: 13, done: 13 });
  else if (k === 3 && i % 4 === 0) track(m.id, m.video_ok_id, { complete: 0, total: null, done: 2 });
  else if (k === 4 && i % 4 === 0) track(m.id, m.video_ok_id, { complete: 0, total: 13, done: 3, cues: 0 });
});

// Classement ESPN réel, avec un rang 0 et un rang absent (repli sur la position).
const standings = espn.parseStandings(readJson('../../server/tests/fixtures/espn-standings.json'));
standings[0].rows[3].seed = 0;
delete standings[1].rows[5].seed;
setNow(plusH(BASE, -0.25));
db.kvSet('standings:nba', standings);

// Comptes, sessions, réglages.
const admin = db.insertUser('michel', 'x', 'admin');
const user = db.insertUser('paul', 'x', 'user');
db.insertUser('zoé', 'x', 'user');
db.touchUserLogin(user);
db.insertSession(auth.hashToken('jeton-admin'), admin, '2027-01-01T00:00:00.000Z');
db.insertSession(auth.hashToken('jeton-paul'), user, '2027-01-01T00:00:00.000Z');
settings.setSetting('openai_api_key', 'sk-test-abcdefghijklmnop1234');
settings.setSetting('minimax_api_key', 'mm-cle-de-test-0123456789abcdef');
settings.setSetting('minimax_voices', JSON.stringify({ A: 'French_MaleNarrator', F: 'French_Female_News Anchor' }));

// ------------------------------------------------------------------ scénarios

const running = (id: number, queued: number[] = []) => () => {
  commentary.__setCommentaryRunnerForTests((_job: unknown, progress: (p: unknown) => void) => {
    progress({ phase: 'transcription', done: 2, total: 5 });
    return new Promise(() => {});
  });
  commentary.enqueueCommentary(id, { priority: true });
  for (const x of queued) commentary.enqueueCommentary(x);
};

const today = '2026-10-29';
const scenarios: Scenario[] = [
  { name: 'session admin, next du calendrier', page: 'session', token: 'jeton-admin', params: { next: '/matchs?d=2026-10-27' } },
  { name: 'session sans cookie, next externe', page: 'session', params: { next: '//evil.example/x' } },
  { name: 'session : next encodé', page: 'session', token: 'jeton-paul', params: { next: '/x y?a=é#' } },
  { name: 'session : next vers /login', page: 'session', token: 'jeton-inconnu', params: { next: '/login?next=/' } },
  { name: 'session : next vers l’API', page: 'session', params: { next: '/api/matches' } },
  { name: 'session : next ../', page: 'session', params: { next: '/a/../equipes/?' } },
  { name: 'session sans next', page: 'session', token: 'jeton-paul' },

  { name: 'accueil, traduction en cours', page: 'home', now: BASE, token: 'jeton-paul', setup: running(partialIds[0], [partialIds[1]]) },
  { name: 'accueil, scores masqués, fenêtre 2-6 fermée', page: 'home', now: BASE, spoilers: 'hide', env: { COMMENTARY_NIGHT_WINDOW: '2-6' } },
  { name: 'accueil, fenêtre 2-6 ouverte', page: 'home', now: plusH(BASE, 7), env: { COMMENTARY_NIGHT_WINDOW: '2-6' } },
  { name: 'accueil, fenêtre « off »', page: 'home', now: BASE, env: { COMMENTARY_NIGHT_WINDOW: 'off' } },
  { name: 'accueil, traduction automatique désactivée', page: 'home', now: BASE, settings: { auto_translate: '0' } },
  { name: 'accueil, traduction non configurée', page: 'home', now: BASE, env: { TRANSCRIBE_URL: '' } },
  { name: 'accueil, plus rien de programmé', page: 'home', now: plusH(BASE, 24 * 120) },
  { name: 'accueil, quinze jours plus tôt', page: 'home', now: plusH(BASE, -24 * 15) },
  { name: 'accueil, la nuit (match programmé en retard)', page: 'home', now: plusH(BASE, 5) },

  { name: 'calendrier, jour par défaut', page: 'matchs', now: BASE },
  { name: 'calendrier, jour par défaut : tout est joué', page: 'matchs', now: '2026-10-25T19:00:00.000Z' },
  { name: 'calendrier, la vraie nuit ESPN', page: 'matchs', now: BASE, params: { d: '2026-10-28' } },
  { name: 'calendrier, jour avec un match à 18 h', page: 'matchs', now: BASE, params: { d: q.shiftKey(today, -3) } },
  { name: 'calendrier, relâche', page: 'matchs', now: BASE, spoilers: 'hide', params: { d: q.shiftKey(today, -10) } },
  { name: 'calendrier, date impossible', page: 'matchs', now: BASE, params: { d: '2026-02-30' } },
  { name: 'calendrier, bien avant la saison', page: 'matchs', now: BASE, params: { d: '2025-01-01' } },
  { name: 'calendrier, équipe en minuscules', page: 'matchs', now: BASE, params: { team: 'lal', d: '2026-10-20' }, setup: running(partialIds[2]) },
  { name: 'calendrier, équipe hors NBA', page: 'matchs', now: BASE, params: { team: 'WEST' } },
  { name: 'calendrier, équipe vide', page: 'matchs', now: BASE, params: { team: '', d: today } },
  { name: 'calendrier, Portland', page: 'matchs', now: BASE, params: { team: 'POR' } },

  { name: 'fiche, vrai match avec replay (admin, doublage)', page: 'match', now: BASE, token: 'jeton-admin', settings: { vf_mode: 'doublage' }, params: { id: String(REAL) } },
  { name: 'fiche, replay MP4 sans play-by-play', page: 'match', now: BASE, token: 'jeton-paul', params: { id: '401909877' } },
  { name: 'fiche, terminé sans replay', page: 'match', now: BASE, token: 'jeton-paul', spoilers: 'hide', params: { id: '401909878' } },
  { name: 'fiche, en cours', page: 'match', now: BASE, token: 'jeton-paul', params: { id: String(liveA) } },
  { name: 'fiche, à venir', page: 'match', now: BASE, token: 'jeton-paul', params: { id: String(lateScheduled) } },
  { name: 'fiche, All-Star', page: 'match', now: BASE, token: 'jeton-paul', settings: { auto_translate: '0' }, params: { id: String(allStar) } },
  { name: 'fiche, identifiant 0x… (Number())', page: 'match', now: BASE, token: 'jeton-paul', params: { id: '0x' + liveB.toString(16) } },
  { name: 'fiche, identifiant invalide', page: 'match', now: BASE, token: 'jeton-paul', params: { id: 'abc' } },
  { name: 'fiche, identifiant inconnu', page: 'match', now: BASE, token: 'jeton-paul', params: { id: '999' } },
  { name: 'fiche, identifiant décimal', page: 'match', now: BASE, token: 'jeton-paul', params: { id: '1.5' } },

  { name: 'équipes', page: 'equipes', now: BASE, setup: running(partialIds[3]) },
  { name: 'équipes, fin de saison', page: 'equipes', now: plusH(BASE, 24 * 30) },

  { name: 'équipe, Lakers', page: 'equipe', now: BASE, params: { abbr: 'lal' } },
  { name: 'équipe, Portland (vraie nuit)', page: 'equipe', now: BASE, spoilers: 'hide', params: { abbr: 'POR' } },
  { name: 'équipe, rang 0 au classement', page: 'equipe', now: BASE, params: { abbr: standings[0].rows[3].abbr } },
  { name: 'équipe, rang absent', page: 'equipe', now: BASE, params: { abbr: standings[1].rows[5].abbr } },
  { name: 'équipe, Denver (match nul)', page: 'equipe', now: BASE, params: { abbr: 'DEN' } },
  { name: 'équipe hors NBA avec des matchs', page: 'equipe', now: BASE, params: { abbr: 'west' } },
  { name: 'équipe inconnue', page: 'equipe', now: BASE, params: { abbr: 'XYZ' } },
  { name: 'équipe mal écrite', page: 'equipe', now: BASE, params: { abbr: 'L1' } },
  { name: 'équipe, ß majuscule (SS)', page: 'equipe', now: BASE, params: { abbr: 'ßß' } },

  { name: 'classement, cache frais', page: 'classement', now: BASE },
  { name: 'classement, cache périmé et ESPN injoignable', page: 'classement', now: plusH(BASE, 2) },

  { name: 'paramètres, administrateur, version', page: 'parametres', now: BASE, token: 'jeton-admin', env: { APP_COMMIT: 'A1B2C3D4E5F6', APP_BUILT_AT: '2026-10-31T15:23:09Z' } },
  { name: 'paramètres, administrateur, commit sans date', page: 'parametres', now: BASE, token: 'jeton-admin', env: { APP_COMMIT: ' abcdef0123 ', APP_BUILT_AT: 'pas une date' }, settings: { auto_translate: '0', vf_mode: 'doublage' } },
  { name: 'paramètres, administrateur, doublage désactivé', page: 'parametres', now: BASE, token: 'jeton-admin', env: { DUB_DISABLED: '1' } },
  { name: 'paramètres, utilisateur, version inconnue', page: 'parametres', now: BASE, token: 'jeton-paul', env: { APP_COMMIT: 'zz' } },
  { name: 'paramètres, sans session', page: 'parametres', now: BASE },
];

// ------------------------------------------------------------------ calcul

const out: Record<string, unknown> = {};
{
  const d = db.openDatabase(path.join(DATA, 'schema.db'));
  out.schema = (d.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { sql: string }[]).map((r) => r.sql);
  d.close();
}
// Contenu de la base : INSERT au format de `quote()` (types SQLite conservés).
{
  const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { name: string }[]).map((r) => r.name);
  const inserts: string[] = [];
  for (const t of tables) {
    const cols = (raw.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.length) continue;
    const expr = cols.map((c) => `quote("${c}")`).join(` || ',' || `);
    for (const r of raw.prepare(`SELECT 'INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (' || ${expr} || ')' AS s FROM "${t}" ORDER BY rowid`).all() as { s: string }[]) inserts.push(r.s);
  }
  out.inserts = inserts;
}

const results: unknown[] = [];
for (const s of scenarios) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(s.env ?? {})) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const savedSettings: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(s.settings ?? {})) {
    savedSettings[k] = settings.getSetting(k);
    settings.setSetting(k, v);
  }
  setNow(s.now ?? BASE);
  s.setup?.();
  const { status, body, node } = await compute(s);
  commentary.__setCommentaryRunnerForTests(null);
  for (const [k, v] of Object.entries(savedSettings)) settings.setSetting(k, v);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  results.push({
    name: s.name,
    page: s.page,
    now: s.now ?? BASE,
    env: s.env ?? {},
    settings: s.settings ?? {},
    spoilers: s.spoilers ?? 'show',
    token: s.token ?? null,
    params: s.params ?? {},
    node,
    status,
    body: JSON.stringify(body),
  });
}
out.scenarios = results;
setNow(null);
fs.writeFileSync(path.join(OUT, 'pages.expected.json'), JSON.stringify(out));
fs.rmSync(DATA, { recursive: true, force: true });
log(`pages.expected.json : ${results.length} scénarios, ${(out.inserts as string[]).length} lignes en base`);
process.exit(0);
