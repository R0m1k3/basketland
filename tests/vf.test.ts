import { describe, it, expect } from 'vitest';
import { translatePlay, classifyPlay, isKeyCategory, periodLabel, ordinalFr } from '../src/lib/vf';
import { buildCommentary } from '../src/lib/vf';
import type { PlayRow } from '../src/lib/types';

function play(overrides: Partial<PlayRow> = {}): PlayRow {
  return {
    match_id: 1,
    seq: 0,
    period: 1,
    clock_display: '12:00',
    clock_sec: 720,
    wallclock: '2026-10-28T03:12:54Z',
    event_type: 'Jump Shot',
    text_en: 'Brandon Miller makes 24-foot three point jump shot',
    actor: 'Brandon Miller',
    team_abbr: 'CHA',
    home_score: 0,
    away_score: 3,
    scoring: 1,
    is_key: 1,
    score_value: 3,
    ...overrides,
  };
}

describe('classifyPlay', () => {
  it('reconnaît les fins de match et de quart', () => {
    expect(classifyPlay('End of Game', 'End of Game', false)).toBe('game_end');
    expect(classifyPlay('End Period', 'End of the 4th Quarter', false)).toBe('period_end');
    expect(classifyPlay('Start Period', 'Start of 2nd Quarter', false)).toBe('period_start');
  });

  it('reconnaît un temps mort', () => {
    expect(classifyPlay('Timeout', 'Timeout', false)).toBe('timeout');
  });

  it('reconnaît un panier', () => {
    expect(classifyPlay('Jump Shot', 'Brandon Miller makes 24-foot three point jump shot', true)).toBe(
      'made_fg',
    );
    expect(classifyPlay('Jump Shot', 'Brandon Miller misses 24-foot jump shot', false)).toBe(
      'missed_fg',
    );
  });

  it('reconnaît un lancer franc', () => {
    expect(classifyPlay('Free Throw', 'Cody Martin makes free throw 2 of 2', true)).toBe('ft_made');
  });

  it('reconnaît un rebond offensif et un rebond défensif', () => {
    expect(classifyPlay('Offensive Rebound', 'Pascal Siakam offensive rebound', false)).toBe(
      'rebound_off',
    );
    expect(classifyPlay('Defensive Rebound', 'Pascal Siakam defensive rebound', false)).toBe(
      'rebound_def',
    );
  });
});

describe('isKeyCategory', () => {
  it('considère les actions marquantes comme clés', () => {
    expect(isKeyCategory('made_fg')).toBe(true);
    expect(isKeyCategory('ft_made')).toBe(true);
    expect(isKeyCategory('game_end')).toBe(true);
    expect(isKeyCategory('period_end')).toBe(true);
    expect(isKeyCategory('timeout')).toBe(true);
  });

  it('ne considère pas un rebond ordinaire comme clé', () => {
    expect(isKeyCategory('rebound_def')).toBe(false);
    expect(isKeyCategory('missed_fg')).toBe(false);
  });
});

describe('ordinalFr', () => {
  it('accorde les ordinaux', () => {
    expect(ordinalFr(1)).toBe('1er');
    expect(ordinalFr(2)).toBe('2e');
    expect(ordinalFr(3)).toBe('3e');
    expect(ordinalFr(4)).toBe('4e');
  });
});

describe('periodLabel', () => {
  it('nomme les quarts', () => {
    expect(periodLabel(1)).toContain('quart');
  });
});

describe('translatePlay', () => {
  it('traduit la fin du match', () => {
    expect(translatePlay(play({ event_type: 'End of Game', text_en: 'End of Game', scoring: 0 }))).toBe(
      'Fin du match',
    );
  });

  it('traduit la fin d\'un quart', () => {
    const fr = translatePlay(
      play({ event_type: 'End Period', text_en: 'End of the 4th Quarter', scoring: 0, period: 4 }),
    );
    expect(fr).toContain('4');
    expect(fr.toLowerCase()).toContain('fin');
  });

  it('traduit un temps mort', () => {
    const fr = translatePlay(play({ event_type: 'Timeout', text_en: 'Timeout', scoring: 0 }));
    expect(fr.toLowerCase()).toContain('temps mort');
  });

  it('traduit un panier à trois points en conservant le nom du joueur', () => {
    const fr = translatePlay(play());
    expect(fr).toContain('Brandon Miller');
    expect(fr).toContain('trois points');
    expect(fr).toContain('marque');
  });

  it('traduit un tir manqué', () => {
    const fr = translatePlay(
      play({ text_en: 'Pascal Siakam misses 30-foot three point pullup jump shot', scoring: 0 }),
    );
    expect(fr).toContain('rate');
    expect(fr).toContain('Siakam');
  });

  it('traduit un dunk', () => {
    const fr = translatePlay(play({ text_en: 'Josh Green makes dunk', scoring: 1, score_value: 2 }));
    expect(fr.toLowerCase()).toContain('dunk');
  });

  it('traduit un lancer franc', () => {
    const fr = translatePlay(
      play({ text_en: 'Cody Martin makes free throw 2 of 2', scoring: 1, score_value: 1 }),
    );
    expect(fr.toLowerCase()).toContain('lancer franc');
  });

  it('traduit un rebond', () => {
    const fr = translatePlay(
      play({ text_en: 'Pascal Siakam defensive rebound', scoring: 0, event_type: 'Defensive Rebound' }),
    );
    expect(fr.toLowerCase()).toContain('rebond');
  });

  it('renvoie toujours une chaîne non vide', () => {
    const fr = translatePlay(play({ text_en: 'Quelque chose d\'inconnu', event_type: 'Unknown' }));
    expect(typeof fr).toBe('string');
    expect(fr.length).toBeGreaterThan(0);
  });

  it('ne renvoie jamais de texte anglais résiduel obvious', () => {
    const fr = translatePlay(play());
    expect(fr).not.toMatch(/\b(makes|misses|jump shot|rebound)\b/i);
  });
});

describe('buildCommentary', () => {
  it('produit une VF lisible (entre 120 et 180 lignes pour un match complet)', () => {
    // 464 actions avec une distribution réaliste.
    const shots = [
      'Player makes three point jump shot',
      'Player makes two point jump shot',
      'Player makes two point jump shot',
      'Player misses two point jump shot',
      'Player misses three point jump shot',
      'Player defensive rebound',
      'Player offensive rebound',
      'Player personal foul',
    ];
    const plays: PlayRow[] = Array.from({ length: 464 }, (_, i) => {
      const text = shots[i % shots.length];
      const scoring = text.startsWith('Player makes');
      return play({
        seq: i,
        text_en: text.replace('Player', `Player${i}`),
        scoring: scoring ? 1 : 0,
        score_value: scoring ? (text.includes('three') ? 3 : 2) : 0,
        event_type: scoring ? 'Jump Shot' : 'Defensive Rebound',
        wallclock: new Date(Date.parse('2026-10-28T03:12:54Z') + i * 10_000).toISOString(),
      });
    });
    const lines = buildCommentary(plays);
    expect(lines.length).toBeGreaterThanOrEqual(120);
    expect(lines.length).toBeLessThanOrEqual(180);
  });

  it('chaque ligne a un texte français non vide', () => {
    const lines = buildCommentary([play()]);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.text_fr.trim().length).toBeGreaterThan(0);
    }
  });

  void buildCommentary;
});
