'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import TeamLogo from '@/components/ui/TeamLogo';
import PlayByPlay, { type PlayItem } from '@/components/match/PlayByPlay';
import { useNoSpoil } from '@/components/match/spoiler';
import { teamInfo } from '@/lib/teams';

interface PlayerStat {
  id: string;
  name: string;
  position: string;
  jersey: string;
  starter: boolean;
  stats: Record<string, string>;
}

interface TeamStats {
  abbr: string;
  name: string;
  score: number | null;
  stats: Record<string, string>;
  players: PlayerStat[];
}

interface Leader {
  team_abbr: string;
  category: string;
  label: string;
  player: string;
  value: string | number;
}

interface StatsPayload {
  available: boolean;
  status?: string;
  reason?: string;
  columns?: string[];
  teams?: TeamStats[];
  leaders?: Leader[];
}

type Tab = 'resume' | 'box' | 'actions';

interface Props {
  matchId: number;
  /** Match terminé : les stats complètes sont disponibles côté ESPN. */
  final: boolean;
  awayAbbr: string;
  homeAbbr: string;
  plays: PlayItem[];
  hasVideo: boolean;
}

/**
 * Statistiques du match en trois onglets : Résumé (leaders + duel
 * d'équipes), Box score, Actions (play-by-play). En mode sans spoiler,
 * le résumé et le box score restent voilés jusqu'à demande explicite.
 */
export default function StatsPanel({ matchId, final, awayAbbr, homeAbbr, plays, hasVideo }: Props) {
  const [tab, setTab] = useState<Tab>(final ? 'resume' : 'actions');
  const [data, setData] = useState<StatsPayload | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const noSpoil = useNoSpoil();

  useEffect(() => {
    if (!final) return;
    let cancelled = false;
    setData(null);
    fetch(`/api/matches/${matchId}/stats`)
      .then(async (r) => {
        const d = (await r.json().catch(() => null)) as StatsPayload | null;
        return d ?? { available: false, reason: `Erreur ${r.status} lors du chargement.` };
      })
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData({ available: false, reason: 'Le serveur ne répond pas.' }));
    return () => {
      cancelled = true;
    };
  }, [matchId, final, attempt]);

  const tabs: { id: Tab; label: string; disabled?: boolean }[] = [
    { id: 'resume', label: 'Résumé', disabled: !final },
    { id: 'box', label: 'Box score', disabled: !final },
    { id: 'actions', label: 'Actions', disabled: !plays.length },
  ];

  const gated = noSpoil && !revealed && tab !== 'actions';

  return (
    <section id="stats" aria-labelledby="stats-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="kicker">Feuille de match</p>
          <h2 id="stats-title" className="title-lg">
            Statistiques
          </h2>
        </div>
        <div role="tablist" aria-label="Sections des statistiques" className="flex rounded-full border border-ink-700 bg-ink-900 p-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              disabled={t.disabled}
              onClick={() => setTab(t.id)}
              className={`rounded-full px-3.5 py-1.5 font-display text-sm font-semibold uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 disabled:cursor-not-allowed disabled:opacity-35 sm:px-4 ${
                tab === t.id ? 'bg-paper text-ink-950' : 'text-paper-mute hover:text-paper'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div id={`panel-${tab}`} role="tabpanel" className="animate-fade-up" key={tab}>
        {tab === 'actions' ? (
          <PlayByPlay plays={plays} awayAbbr={awayAbbr} homeAbbr={homeAbbr} hasVideo={hasVideo} />
        ) : !final ? (
          <Empty text="Les statistiques détaillées seront disponibles dès la fin du match." />
        ) : gated ? (
          <SpoilerGate onReveal={() => setRevealed(true)} />
        ) : !data ? (
          <StatsSkeleton />
        ) : !data.available ? (
          <Empty text={data.reason ?? 'Statistiques indisponibles pour le moment.'} onRetry={() => setAttempt((a) => a + 1)} />
        ) : tab === 'resume' ? (
          <Summary data={data} />
        ) : (
          <BoxScore data={data} />
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Résumé

const LEADER_CATS = [
  { key: 'points', label: 'Points', unit: 'pts' },
  { key: 'rebounds', label: 'Rebonds', unit: 'reb' },
  { key: 'assists', label: 'Passes décisives', unit: 'pd' },
];

function headshot(id: string) {
  return `https://a.espncdn.com/i/headshots/nba/players/full/${id}.png`;
}

function Summary({ data }: { data: StatsPayload }) {
  const teams = data.teams ?? [];
  const [away, home] = teams;
  const playerIds = useMemo(() => {
    const m = new Map<string, PlayerStat>();
    for (const t of teams) for (const p of t.players) m.set(`${t.abbr}|${p.name}`, p);
    return m;
  }, [teams]);
  if (!away || !home) return <Empty text="Statistiques d’équipe indisponibles." />;

  const leaders = data.leaders ?? [];
  const leaderFor = (team: string, cat: string) => {
    const fromApi = leaders.find((l) => l.team_abbr === team && l.category === cat);
    if (fromApi) return { player: fromApi.player, value: String(fromApi.value) };
    // Repli : calcul depuis le box score si ESPN n'a pas publié de leaders.
    const col = cat === 'points' ? 'PTS' : cat === 'rebounds' ? 'REB' : 'AST';
    const t = teams.find((x) => x.abbr === team);
    const best = [...(t?.players ?? [])].sort((a, b) => Number(b.stats[col] ?? 0) - Number(a.stats[col] ?? 0))[0];
    return best && best.stats[col] ? { player: best.name, value: best.stats[col] } : null;
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-3">
        <h3 className="kicker">Leaders du match</h3>
        {LEADER_CATS.map((c) => (
          <div key={c.key} className="panel overflow-hidden">
            <div className="flex items-center justify-between border-b border-ink-700/60 px-4 py-2">
              <span className="font-display text-sm font-bold uppercase tracking-wider text-paper-dim">{c.label}</span>
            </div>
            <div className="grid grid-cols-2 divide-x divide-ink-700/60">
              {[away, home].map((t, i) => {
                const l = leaderFor(t.abbr, c.key);
                const p = l ? playerIds.get(`${t.abbr}|${l.player}`) : undefined;
                return <LeaderCell key={t.abbr} abbr={t.abbr} leader={l} player={p} unit={c.unit} mirror={i === 1} />;
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <h3 className="kicker">Duel d’équipes</h3>
        <TeamComparison away={away} home={home} />
      </div>
    </div>
  );
}

function LeaderCell({
  abbr,
  leader,
  player,
  unit,
  mirror,
}: {
  abbr: string;
  leader: { player: string; value: string } | null;
  player?: PlayerStat;
  unit: string;
  mirror: boolean;
}) {
  const t = teamInfo(abbr);
  if (!leader) return <div className="p-4 text-sm text-paper-faint">—</div>;
  const line = player
    ? [`${player.stats.PTS ?? 0} pts`, `${player.stats.REB ?? 0} reb`, `${player.stats.AST ?? 0} pd`].join(' · ')
    : '';
  return (
    <div className={`relative flex items-center gap-2.5 p-3 sm:gap-3 sm:p-4 ${mirror ? 'flex-row-reverse text-right' : ''}`}>
      <span
        className="pointer-events-none absolute inset-0 opacity-[0.12]"
        style={{ background: `linear-gradient(${mirror ? '270deg' : '90deg'}, ${t.accent}, transparent 70%)` }}
        aria-hidden="true"
      />
      <Avatar id={player?.id} name={leader.player} accent={t.accent} />
      <div className="relative min-w-0 flex-1">
        <p className="num text-3xl font-bold leading-none sm:text-4xl" style={{ color: t.accent }}>
          {leader.value}
          <span className="ml-1 text-xs font-semibold uppercase text-paper-faint">{unit}</span>
        </p>
        <p className="mt-1 line-clamp-2 text-sm font-medium leading-tight text-paper">{leader.player}</p>
        <p className="truncate text-[11px] text-paper-faint">
          {abbr}
          {line ? ` · ${line}` : ''}
        </p>
      </div>
    </div>
  );
}

function Avatar({ id, name, accent }: { id?: string; name: string; accent: string }) {
  const [failed, setFailed] = useState(false);
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('');
  return (
    <span
      className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full border border-ink-600 bg-ink-800 sm:h-14 sm:w-14"
      style={{ boxShadow: `0 0 0 2px ${accent}33` }}
    >
      {id && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={headshot(id)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-x-0 bottom-0 h-full w-full object-cover object-top"
        />
      ) : (
        <span className="font-display text-base font-bold text-paper-mute">{initials}</span>
      )}
    </span>
  );
}

interface CompRow {
  label: string;
  away: number;
  home: number;
  display?: (v: number) => string;
  lowerIsBetter?: boolean;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function benchPoints(t: TeamStats): number {
  return t.players.filter((p) => !p.starter).reduce((acc, p) => acc + (Number(p.stats.PTS) || 0), 0);
}

function TeamComparison({ away, home }: { away: TeamStats; home: TeamStats }) {
  const rows: CompRow[] = [];
  const add = (label: string, key: string, opts: Partial<CompRow> = {}) => {
    const a = num(away.stats[key]);
    const h = num(home.stats[key]);
    if (a === null || h === null) return;
    rows.push({ label, away: a, home: h, ...opts });
  };
  const pct = (v: number) => `${v} %`;
  add('Adresse aux tirs', 'FG%', { display: pct });
  add('Adresse à 3 points', '3P%', { display: pct });
  add('Lancers francs', 'FT%', { display: pct });
  add('Rebonds', 'REB');
  add('Rebonds offensifs', 'OR');
  add('Passes décisives', 'AST');
  add('Interceptions', 'STL');
  add('Contres', 'BLK');
  add('Balles perdues', 'TO', { lowerIsBetter: true });
  add('Points dans la raquette', 'PIP');
  add('Points en contre-attaque', 'FBPs');
  rows.push({ label: 'Points du banc', away: benchPoints(away), home: benchPoints(home) });
  add('Plus gros écart en faveur', 'LL');

  const a = teamInfo(away.abbr);
  const h = teamInfo(home.abbr);
  return (
    <div className="panel p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between text-sm font-semibold">
        <span className="flex items-center gap-2">
          <TeamLogo abbr={away.abbr} size={26} /> {away.abbr}
        </span>
        <span className="flex items-center gap-2">
          {home.abbr} <TeamLogo abbr={home.abbr} size={26} />
        </span>
      </div>
      <ul className="space-y-3.5">
        {rows.map((r) => {
          const max = Math.max(r.away, r.home, 1);
          const awayBetter = r.lowerIsBetter ? r.away < r.home : r.away > r.home;
          const homeBetter = r.lowerIsBetter ? r.home < r.away : r.home > r.away;
          const fmt = r.display ?? ((v: number) => String(v));
          return (
            <li key={r.label}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                <span className={`num w-14 text-lg leading-none ${awayBetter ? 'text-paper' : 'text-paper-mute'}`}>{fmt(r.away)}</span>
                <span className="truncate text-center text-xs text-paper-mute">{r.label}</span>
                <span className={`num w-14 text-right text-lg leading-none ${homeBetter ? 'text-paper' : 'text-paper-mute'}`}>{fmt(r.home)}</span>
              </div>
              <div className="grid grid-cols-2 gap-1" aria-hidden="true">
                <div className="flex h-1.5 justify-end overflow-hidden rounded-l-full bg-ink-800">
                  <span
                    className="h-full rounded-l-full transition-[width] duration-700"
                    style={{ width: `${(r.away / max) * 100}%`, background: a.accent, opacity: awayBetter ? 1 : 0.4 }}
                  />
                </div>
                <div className="flex h-1.5 overflow-hidden rounded-r-full bg-ink-800">
                  <span
                    className="h-full rounded-r-full transition-[width] duration-700"
                    style={{ width: `${(r.home / max) * 100}%`, background: h.accent, opacity: homeBetter ? 1 : 0.4 }}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- Box score

const COLS: { key: string; label: string; title: string; total?: string }[] = [
  { key: 'MIN', label: 'MIN', title: 'Minutes jouées' },
  { key: 'PTS', label: 'PTS', title: 'Points' },
  { key: 'FG', label: 'TIRS', title: 'Tirs réussis-tentés', total: 'FG' },
  { key: '3PT', label: '3 PTS', title: 'Tirs à 3 points réussis-tentés', total: '3PT' },
  { key: 'FT', label: 'LF', title: 'Lancers francs réussis-tentés', total: 'FT' },
  { key: 'REB', label: 'REB', title: 'Rebonds', total: 'REB' },
  { key: 'AST', label: 'PD', title: 'Passes décisives', total: 'AST' },
  { key: 'STL', label: 'INT', title: 'Interceptions', total: 'STL' },
  { key: 'BLK', label: 'CTR', title: 'Contres', total: 'BLK' },
  { key: 'TO', label: 'BP', title: 'Balles perdues', total: 'TO' },
  { key: 'OREB', label: 'RO', title: 'Rebonds offensifs', total: 'OR' },
  { key: 'DREB', label: 'RD', title: 'Rebonds défensifs', total: 'DR' },
  { key: 'PF', label: 'F', title: 'Fautes personnelles', total: 'PF' },
  { key: '+/-', label: '+/-', title: 'Écart de points avec le joueur sur le terrain' },
];
const PCT_FOR: Record<string, string> = { FG: 'FG%', '3PT': '3P%', FT: 'FT%' };
const HIGHLIGHT = ['PTS', 'REB', 'AST', 'STL', 'BLK'];

function BoxScore({ data }: { data: StatsPayload }) {
  const teams = data.teams ?? [];
  const [sel, setSel] = useState(0);
  const team = teams[sel];
  const switchTo = useCallback((i: number) => setSel(i), []);
  if (!team) return <Empty text="Box score indisponible." />;

  const played = team.players.filter((p) => p.stats.MIN !== undefined && p.stats.MIN !== '');
  const starters = played.filter((p) => p.starter);
  const bench = played.filter((p) => !p.starter);
  const dnp = team.players.filter((p) => !played.includes(p));
  const best: Record<string, number> = {};
  for (const k of HIGHLIGHT) best[k] = Math.max(0, ...played.map((p) => Number(p.stats[k]) || 0));
  const accent = teamInfo(team.abbr).accent;

  return (
    <div className="space-y-3">
      <div className="flex gap-2" role="group" aria-label="Choisir l’équipe">
        {teams.map((t, i) => (
          <button
            key={t.abbr}
            type="button"
            onClick={() => switchTo(i)}
            aria-pressed={sel === i}
            className={`flex flex-1 items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame/60 sm:flex-none sm:pr-5 ${
              sel === i ? 'border-ink-500 bg-ink-800' : 'border-ink-700 bg-ink-900 opacity-60 hover:opacity-100'
            }`}
            style={sel === i ? { boxShadow: `inset 0 -2px 0 ${teamInfo(t.abbr).accent}` } : undefined}
          >
            <TeamLogo abbr={t.abbr} size={30} />
            <span className="min-w-0">
              <span className="block truncate font-display text-base font-bold uppercase leading-tight">{teamInfo(t.abbr).nick}</span>
              <span className="num block text-sm text-paper-mute">{t.score ?? ''}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="panel overflow-hidden">
        <div className="boxscore max-h-[75vh] overflow-auto">
          <table className="table-stats min-w-[760px]">
            <caption className="sr-only">Box score — {team.name}</caption>
            <thead>
              <tr>
                <th scope="col" className="boxscore-sticky !text-left">
                  Joueur
                </th>
                {COLS.map((c) => (
                  <th key={c.key} scope="col" title={c.title}>
                    <abbr title={c.title} className="no-underline">
                      {c.label}
                    </abbr>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <GroupRow label="Cinq de départ" />
              {starters.map((p) => (
                <PlayerRow key={p.id} p={p} best={best} accent={accent} />
              ))}
              {bench.length > 0 && <GroupRow label="Remplaçants" />}
              {bench.map((p) => (
                <PlayerRow key={p.id} p={p} best={best} accent={accent} />
              ))}
              {dnp.length > 0 && <GroupRow label="N’ont pas joué" />}
              {dnp.map((p) => (
                <tr key={p.id} className="text-paper-faint">
                  <th scope="row" className="boxscore-sticky !text-left font-normal">
                    <PlayerName p={p} dim />
                  </th>
                  <td colSpan={COLS.length} className="!text-left !text-paper-faint">
                    Non utilisé
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-ink-600 bg-ink-850/80">
                <th scope="row" className="boxscore-sticky !text-left font-display text-sm font-bold uppercase tracking-wider !text-paper">
                  Équipe
                </th>
                {COLS.map((c) => (
                  <td key={c.key} className="font-semibold !text-paper">
                    {c.key === 'PTS' ? team.score ?? '' : c.total ? team.stats[c.total] ?? '' : ''}
                    {PCT_FOR[c.key] && team.stats[PCT_FOR[c.key]] && (
                      <span className="block text-[10px] font-normal text-paper-faint">{team.stats[PCT_FOR[c.key]]} %</span>
                    )}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-paper-faint">
        TIRS : réussis-tentés · 3 PTS : tirs à 3 points · LF : lancers francs · REB : rebonds (RO offensifs, RD défensifs) · PD : passes décisives ·
        INT : interceptions · CTR : contres · BP : balles perdues · F : fautes · +/- : écart quand le joueur est sur le terrain.
      </p>
    </div>
  );
}

function GroupRow({ label }: { label: string }) {
  return (
    <tr className="!border-t-0 hover:!bg-transparent">
      <th scope="colgroup" colSpan={COLS.length + 1} className="boxscore-group">
        <span>{label}</span>
      </th>
    </tr>
  );
}

function PlayerName({ p, dim }: { p: PlayerStat; dim?: boolean }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className={`truncate font-medium ${dim ? '' : 'text-paper'}`}>{p.name}</span>
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-paper-faint">
        {p.jersey ? `#${p.jersey}` : ''} {p.position}
      </span>
    </span>
  );
}

function PlayerRow({ p, best, accent }: { p: PlayerStat; best: Record<string, number>; accent: string }) {
  return (
    <tr>
      <th scope="row" className="boxscore-sticky !text-left font-normal">
        <PlayerName p={p} />
      </th>
      {COLS.map((c) => {
        const v = p.stats[c.key] ?? '';
        const top = HIGHLIGHT.includes(c.key) && best[c.key] > 0 && Number(v) === best[c.key];
        const plus = c.key === '+/-' ? Number(v) : 0;
        return (
          <td
            key={c.key}
            className={`${c.key === 'PTS' ? 'font-semibold text-paper' : ''} ${plus > 0 ? '!text-win/90' : plus < 0 ? '!text-loss/80' : ''}`}
            style={top ? { color: accent, fontWeight: 700 } : undefined}
          >
            {v}
          </td>
        );
      })}
    </tr>
  );
}

// ---------------------------------------------------------------- états

function SpoilerGate({ onReveal }: { onReveal: () => void }) {
  return (
    <div className="panel relative overflow-hidden px-6 py-10 text-center">
      <div className="spoiler-veil pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="relative mx-auto max-w-md">
        <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-flame/15 text-flame">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 3l18 18" strokeLinecap="round" />
            <path d="M10.6 5.1A10.5 10.5 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.3 2.4-2.6 3.7M6.6 6.6C4.4 8 2.8 10.2 2 12c1 2.5 5 7 10 7 1.8 0 3.4-.6 4.8-1.4" />
          </svg>
        </span>
        <p className="font-display text-xl font-bold uppercase tracking-wide">Mode sans spoiler</p>
        <p className="mt-1 text-sm text-paper-mute">Les statistiques révèlent le résultat. Regardez le replay d’abord, ou affichez-les quand vous voulez.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={onReveal} className="btn-primary">
            Afficher les stats
          </button>
        </div>
      </div>
    </div>
  );
}

function Empty({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="panel-soft flex flex-col items-center gap-3 px-6 py-10 text-center text-sm text-paper-mute">
      <p>{text}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn !py-1.5 !text-xs">
          Réessayer
        </button>
      )}
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Chargement des statistiques">
      {[0, 1].map((c) => (
        <div key={c} className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="panel h-[92px] animate-pulse bg-ink-850/80" />
          ))}
        </div>
      ))}
    </div>
  );
}
