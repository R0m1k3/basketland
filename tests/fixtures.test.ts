import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseScoreboard, parseSummary } from '../src/lib/espn';
import { parseServerBlocks, parseFirstOkIframe } from '../src/lib/bv';
import { parseOkEmbed, parseMasterVariants } from '../src/lib/okru';
import { buildCommentary } from '../src/lib/vf';
import { rewriteMasterPlaylist, rewriteMediaPlaylist, isValidPlaylist } from '../src/lib/hls';

/**
 * Tests de bout en bout sur des CAPTURES RÉELLES (tests/fixtures/).
 * Ces fichiers sont des réponsesLiterales des sources en production :
 * ils valident les formats exacts, pas des approximationstals.
 */

const FX = join(__dirname, 'fixtures');
const read = (f: string) => readFileSync(join(FX, f), 'utf8');
const readJson = (f: string) => JSON.parse(read(f)) as Record<string, unknown>;

describe('capture réelle — page de match basketball-video.com', () => {
  it('extrait les trois serveurs et leurs liens', () => {
    const blocks = parseServerBlocks(read('bv-match.html'));
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks[0].n).toBe(1);
    expect(blocks[0].href).toMatch(/^https?:\/\//);
  });

  it('la page cible contient un iframe ok.ru', () => {
    const id = parseFirstOkIframe(read('bv-target.html'));
    expect(id).toMatch(/^\d{5,25}$/);
  });

  it('la listing de saison contient des entrées de replay', () => {
    const html = read('bv-listing.html');
    expect(html).toMatch(/full-game-replay/);
  });
});

describe('capture réelle — embed ok.ru', () => {
  const info = parseOkEmbed(read('ok-embed.html'), '16656495217324');

  it('extrait une durée plausible pour un match complet', () => {
    expect(info.duration).not.toBeNull();
    expect(info.duration!).toBeGreaterThan(3600);
  });

  it('extrait l\'URL m3u8 signée', () => {
    expect(info.hlsManifestUrl).toMatch(/vkuser\.net\/video\.m3u8/);
    expect(info.hlsManifestUrl).toMatch(/expires=/);
  });
});

describe('capture réelle — playlists HLS', () => {
  const master = read('ok-master.m3u8');
  const media = read('ok-media.m3u8');

  it('la playlist maître est valide et contient les variantes', () => {
    expect(isValidPlaylist(master)).toBe(true);
    const variants = parseMasterVariants(master, 'https://ok6-29.vkuser.net/video.m3u8?cmd=x');
    expect(variants.length).toBeGreaterThanOrEqual(3);
    expect(variants.map((v) => v.key)).toContain('sd');
    expect(variants.map((v) => v.key)).toContain('full');
  });

  it('la playlist média contient les segments .ts', () => {
    expect(isValidPlaylist(media)).toBe(true);
    expect(media).toMatch(/^MEDIUM\d+\.ts$/m);
  });

  it('la réécriture pointe vers le proxy sans exposer l\'URL signée', () => {
    const out = rewriteMasterPlaylist(master, 'https://ok6-29.vkuser.net/video.m3u8?cmd=x', '16656495217324');
    expect(out).toContain('/api/video/16656495217324/playlist.m3u8?v=sd');
    expect(out).not.toMatch(/vkuser\.net/);
    expect(out.match(/#EXTM3U/g)).toHaveLength(1);
  });

  it('la réécriture média conserve tous les segments', () => {
    const source = (media.match(/^MEDIUM\d+\.ts$/gm) ?? []).length;
    const out = rewriteMediaPlaylist(media, 'https://ok6-29.vkuser.net/x/video/', '16656495217324', 'sd');
    expect((out.match(/segment\.ts/g) ?? []).length).toBe(source);
  });
});

describe('capture réelle — scoreboard ESPN du 27/10/2026', () => {
  const matches = parseScoreboard(readJson('espn-scoreboard-20261027.json'));

  it('extrait les quatre matchs de la soirée', () => {
    expect(matches).toHaveLength(4);
  });

  it('chaque match a ses deux équipes et un statut', () => {
    for (const m of matches) {
      expect(m.home_abbr).toMatch(/^[A-Z]{2,4}$/);
      expect(m.away_abbr).toMatch(/^[A-Z]{2,4}$/);
      expect(['scheduled', 'live', 'final']).toContain(m.status);
      expect(m.date_utc).toMatch(/Z$/);
    }
  });

  it('les matchs terminés portent un score des deux côtés', () => {
    const finals = matches.filter((m) => m.status === 'final');
    expect(finals.length).toBeGreaterThan(0);
    for (const m of finals) {
      expect(m.home_score).not.toBeNull();
      expect(m.away_score).not.toBeNull();
    }
  });
});

describe('capture réelle — résumé ESPN du match Portland @ Lakers', () => {
  const summary = parseSummary(readJson('espn-summary-401909880.json'), 401909880);

  it('identifie le match', () => {
    expect(summary.match).not.toBeNull();
    expect(summary.match!.home_abbr).toBe('LAL');
    expect(summary.match!.away_abbr).toBe('POR');
  });

  it('contient les stats des deux équipes', () => {
    expect(summary.teams).toHaveLength(2);
    for (const t of summary.teams) {
      expect(Object.keys(t.stats).length).toBeGreaterThan(5);
    }
  });

  it('contient les lignes de tous les joueurs', () => {
    // 2 équipes × ~13 joueurs
    expect(summary.players.length).toBeGreaterThanOrEqual(20);
    const first = summary.players[0];
    expect(first.player_name.length).toBeGreaterThan(0);
    expect(first.stats.PTS).toBeDefined();
    expect(first.stats.REB).toBeDefined();
    expect(first.stats.MIN).toBeDefined();
  });

  it('chaque joueur apparaît une seule fois', () => {
    const ids = summary.players.map((p) => p.player_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('chaque joueur est rattaché à une équipe et un poste', () => {
    for (const p of summary.players) {
      expect(['POR', 'LAL']).toContain(p.team_abbr);
      expect(p.position).toBeTruthy();
    }
  });

  it('contient les leaders du match', () => {
    expect(summary.leaders.length).toBeGreaterThan(0);
  });

  it('contient les 511 actions du play-by-play', () => {
    expect(summary.plays).toHaveLength(511);
  });

  it('chaque action a un chrono, une période et un wallclock exploitables', () => {
    for (const p of summary.plays) {
      expect(p.period).toBeGreaterThanOrEqual(1);
      expect(p.clock_sec).toBeGreaterThanOrEqual(0);
      expect(p.clock_sec).toBeLessThanOrEqual(720);
      expect(p.wallclock).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('les actions ont une numérotation strictement croissante et unique', () => {
    // Régression : ESPN renumérote ses `sequenceNumber` à la relecture, ce qui
    // produisait des seq non monotones (497 → 486) et pouvait fausser le tri
    // des sous-titres. `seq` est la clé primaire (match_id, seq).
    for (let i = 1; i < summary.plays.length; i++) {
      expect(summary.plays[i].seq).toBeGreaterThan(summary.plays[i - 1].seq);
    }
    const seqs = summary.plays.map((p) => p.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('capture réelle — VF française sur le match complet', () => {
  const summary = parseSummary(readJson('espn-summary-401909880.json'), 401909880);
  const lines = buildCommentary(summary.plays, { homeAbbr: 'LAL', awayAbbr: 'POR' });

  it('produit une VF lisible (120 à 180 lignes)', () => {
    expect(lines.length).toBeGreaterThanOrEqual(120);
    expect(lines.length).toBeLessThanOrEqual(180);
  });

  it('chaque ligne est en français et non vide', () => {
    for (const l of lines) {
      expect(l.text_fr.trim().length).toBeGreaterThan(0);
    }
  });

  it('ne laisse pas de verbes anglais dans le texte', () => {
    for (const l of lines) {
      expect(l.text_fr).not.toMatch(/\b(makes|misses|jump shot|defensive rebound)\b/i);
    }
  });

  it('ouvre sur le début de match et ferme sur la fin', () => {
    const first = lines[0].text_fr.toLowerCase();
    const last = lines[lines.length - 1].text_fr.toLowerCase();
    expect(first).toMatch(/coup d'envoi|début/);
    expect(last).toMatch(/fin/);
  });

  it('annonce le score final', () => {
    const finalLine = lines[lines.length - 1].text_fr;
    expect(finalLine).toMatch(/\d+\s*[–-]\s*\d+/);
  });

  it('chaque ligne porte un horodatage wallclock', () => {
    for (const l of lines) {
      expect(l.wallclock).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
