import { describe, it, expect } from 'vitest';
import { buildCommentary } from '../src/lib/vf';
import type { PlayRow } from '../src/lib/types';

/**
 * Non-régression de la revue Opus 5.5 (2e passe).
 *
 * R3 : la bannière « Coup d'envoi » disparaissait ou glissait sur l'action
 *      suivante quand la 1re action ne produisait pas de ligne `primary`
 *      (rebond, faute, perte de balle, tir manqué → catégorie `extras`).
 * N6 : les `seq` étaient RENUMÉROTÉS quand un doublon apparaissait. Or le
 *      `seq` sert à retrouver l'action ESPN quand l'utilisateur pose une
 *      ancre (`getPlays().find(p => p.seq === seq)`) : une ligne renumérotée
 *      pointait vers la mauvaise action.
 */

function play(seq: number, eventType: string, text: string, period = 1, clock = 720): PlayRow {
  return {
    match_id: 1,
    seq,
    period,
    clock_sec: clock,
    clock_display: `${Math.floor(clock / 60)}:${String(clock % 60).padStart(2, '0')}`,
    wallclock: '2026-10-28T19:00:00Z',
    event_type: eventType,
    text_en: text,
    actor: '',
    team_abbr: 'POR',
    home_score: 0,
    away_score: 0,
    score_value: 0,
    scoring: false,
  } as unknown as PlayRow;
}

describe('bannière de coup d’envoi (R3)', () => {
  it('est conservée quand la 1re action ne produit pas de ligne primary', () => {
    // 1re action = tir manqué (catégorie `extras`), puis un tir réussi.
    const plays = [
      play(1, 'Missed Shot', 'LeBron James misses 25-foot three point jumper'),
      play(2, 'Made Shot', 'LeBron James makes 25-foot three point jumper'),
      play(3, 'Made Shot', 'Stephen Curry makes 10-foot two point shot'),
    ];
    const lines = buildCommentary(plays, { minLines: 1, maxLines: 50 });
    const banner = lines.find((l) => l.text_fr.includes('Coup d'));
    expect(banner, 'la bannière doit être présente').toBeDefined();
    // Elle est sur la 1re action, pas sur la suivante.
    expect(banner!.seq).toBe(1);
  });

  it('est appliquée en préfixe de la 1re ligne commentée quand elle existe', () => {
    const plays = [
      play(1, 'Start of the 1st Quarter', 'Start of the 1st Quarter'),
      play(2, 'Made Shot', 'Stephen Curry makes 10-foot two point shot'),
    ];
    const lines = buildCommentary(plays, { minLines: 1, maxLines: 50 });
    expect(lines[0].text_fr).toContain('Coup d');
    expect(lines[0].seq).toBe(1);
  });

  it('ne fait pas disparaître un temps mort en 1re action', () => {
    const plays = [
      play(1, 'Timeout', 'Timeout: Team'),
      play(2, 'Made Shot', 'Stephen Curry makes 10-foot two point shot'),
    ];
    const lines = buildCommentary(plays, { minLines: 1, maxLines: 50 });
    expect(lines.some((l) => l.text_fr.includes('Coup d'))).toBe(true);
    // Le temps mort reste commenté (il ne doit pas être absorbé par la bannière).
    expect(lines.some((l) => /temps mort/i.test(l.text_fr))).toBe(true);
  });
});

describe('unicité des seq sans renumérotation (N6)', () => {
  it('les seq restent ceux des actions ESPN (aucune renumérotation)', () => {
    const plays = [
      play(10, 'Made Shot', 'LeBron James makes 25-foot three point jumper'),
      play(25, 'Made Shot', 'Stephen Curry makes 10-foot two point shot'),
      play(40, 'Made Shot', 'Kevin Durant makes 12-foot two point shot'),
    ];
    const lines = buildCommentary(plays, { minLines: 1, maxLines: 50 });
    const seqs = lines.map((l) => l.seq);
    // Les seq de sortie doivent être un sous-ensemble des seq ESPN : une
    // renumérotation les aurait décalés et l'ancrage pointerait ailleurs.
    for (const s of seqs) expect([10, 25, 40]).toContain(s);
  });

  it('aucun seq dupliqué', () => {
    const plays = Array.from({ length: 40 }, (_, i) =>
      play(i * 3 + 1, 'Made Shot', `Player${i} makes 10-foot two point shot`),
    );
    const lines = buildCommentary(plays, { minLines: 1, maxLines: 100 });
    const seqs = lines.map((l) => l.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
