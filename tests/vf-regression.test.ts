import { describe, it, expect } from 'vitest';
import { buildCommentary } from '../src/lib/vf';
import { actorFromText } from '../src/lib/espn';
import type { PlayRow } from '../src/lib/types';

function play(seq: number, text: string, over: Partial<PlayRow> = {}): PlayRow {
  return {
    match_id: 1,
    seq,
    period: 1,
    clock_display: '12:00',
    clock_sec: 720 - seq,
    wallclock: new Date(Date.parse('2026-10-28T03:12:54Z') + seq * 20_000).toISOString(),
    event_type: 'Jump Shot',
    text_en: text,
    // `actor` est extrait du texte : ESPN ne renseigne pas `participants`
    // pour les lancers francs (participants=[None] sur le match réel).
    actor: actorFromText(text),
    team_abbr: 'BOS',
    home_score: 0,
    away_score: 0,
    scoring: 0,
    is_key: 1,
    ...over,
  };
}

describe('buildCommentary — pas de doublon de seq (contrainte UNIQUE en base)', () => {
  it('la bannière de coup d\'envoi ne duplique pas le seq de la 1re action', () => {
    // La 1re action de la 1re période n'est PAS un jump ball :
    // la bannière est poussée, puis le switch pousse une 2e ligne pour la
    // même action → deux lignes de même seq → crash UNIQUE en base.
    const plays: PlayRow[] = [
      play(1, 'Start of the 1st Quarter', { event_type: 'Start Period' }),
      play(2, 'Jayson Tatum makes 24-foot three point jump shot', { scoring: 1 }),
      play(3, 'End of Game', { event_type: 'End of Game', period: 4, clock_sec: 0 }),
    ];
    const lines = buildCommentary(plays);
    const seqs = lines.map((l) => l.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('la bannière de coup d\'envoi ne duplique pas le seq quand la 1re action est un tir', () => {
    const plays: PlayRow[] = [
      play(1, 'Jayson Tatum makes 24-foot three point jump shot', { scoring: 1 }),
      play(2, 'End of Game', { event_type: 'End of Game', period: 4, clock_sec: 0 }),
    ];
    const lines = buildCommentary(plays);
    const seqs = lines.map((l) => l.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('la bannière de coup d\'envoi ne duplique pas le seq quand la 1re action est un entre-deux', () => {
    const plays: PlayRow[] = [
      play(1, 'Jayson Tatum vs. Nikola Jokic', { event_type: 'Jump Ball' }),
      play(2, 'End of Game', { event_type: 'End of Game', period: 4, clock_sec: 0 }),
    ];
    const lines = buildCommentary(plays);
    const seqs = lines.map((l) => l.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('buildCommentary — pas de double commentaire des lancers francs', () => {
  it('une série de FT avec un remplacement intercalé n\'est pas commentée deux fois', () => {
    const plays: PlayRow[] = [
      play(1, 'Jayson Tatum makes free throw 1 of 2', {
        event_type: 'Free Throw',
        scoring: 1,
        actor: 'Jayson Tatum',
      }),
      play(2, 'Payton Pritchard enters the game', { event_type: 'Substitution' }),
      play(3, 'Jayson Tatum makes free throw 2 of 2', {
        event_type: 'Free Throw',
        scoring: 1,
        actor: 'Jayson Tatum',
      }),
      play(4, 'End of Game', { event_type: 'End of Game', period: 4, clock_sec: 0 }),
    ];
    const lines = buildCommentary(plays);
    const ftLines = lines.filter((l) => /lancer/i.test(l.text_fr));
    // Une seule ligne pour la série, pas deux (une pour « 1/2 » et une pour « 2/2 »).
    expect(ftLines.length).toBe(1);
    expect(ftLines[0].text_fr).toContain('2/2');
  });

  it('une série de FT contiguë n\'est commentée qu\'une fois', () => {
    const plays: PlayRow[] = [
      play(1, 'Jayson Tatum makes free throw 1 of 2', {
        event_type: 'Free Throw',
        scoring: 1,
        actor: 'Jayson Tatum',
      }),
      play(2, 'Jayson Tatum makes free throw 2 of 2', {
        event_type: 'Free Throw',
        scoring: 1,
        actor: 'Jayson Tatum',
      }),
      play(3, 'End of Game', { event_type: 'End of Game', period: 4, clock_sec: 0 }),
    ];
    const lines = buildCommentary(plays);
    const ftLines = lines.filter((l) => /lancer/i.test(l.text_fr));
    expect(ftLines.length).toBe(1);
  });
});
