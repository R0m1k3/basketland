import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOffsets } from '../src/lib/sync';
import { classifyPlay } from '../src/lib/vf';

/**
 * Non-régression des findings de la revue Opus 5.5 (2e passe).
 *
 * R1 : le sens des boutons de décalage VF. Le serveur calcule
 *      `video_ts = position + offset`, et le lecteur affiche une ligne
 *      quand `video_ts <= currentTime`. Un offset POSITIF augmente donc
 *      video_ts : le sous-titre apparaît plus TARD, il RETARDE la VF.
 *      L'inversion des libellés était passée inaperçue parce qu'aucun test
 *      ne fixait ce sens.
 */
describe('sens du décalage VF (R1)', () => {
  it('un offset positif retarde la VF (apparition plus tard)', () => {
    const base = applyOffsets(1000, 1, { global_offset: 0, quarter_offsets: {} });
    const retarde = applyOffsets(1000, 1, { global_offset: 5, quarter_offsets: {} });
    expect(base).toBe(1000);
    expect(retarde).toBe(1005);
    // Le sous-titre s'affiche quand currentTime >= video_ts : un video_ts plus
    // grand => il faut attendre plus longtemps => la VF est retardée.
    expect(retarde).toBeGreaterThan(base);
  });

  it('un offset négatif avance la VF', () => {
    const avance = applyOffsets(1000, 1, { global_offset: -5, quarter_offsets: {} });
    expect(avance).toBe(995);
    expect(avance).toBeLessThan(1000);
  });

  it('les offsets par quart suivent le même sens', () => {
    const avance = applyOffsets(1000, 2, { global_offset: 0, quarter_offsets: { '2': -10 } });
    const retarde = applyOffsets(1000, 2, { global_offset: 0, quarter_offsets: { '2': 10 } });
    expect(avance).toBe(990);
    expect(retarde).toBe(1010);
  });
});

/**
 * R2 : `stats_synced_at` n'était jamais posé. La recherche directe sur
 *      "end of game" échouait car ESPN écrit `event_type = "End Game"`.
 *      Conséquence : les 15 matchs `final` les plus récents étaient
 *      retéléchargés à chaque tick du planificateur (des milliers d'appels
 *      ESPN par jour) et les matchs plus anciens n'étaient jamais traités.
 */
describe('détection de fin de match sur données ESPN réelles (R2)', () => {
  const summary = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'espn-summary-401909880.json'), 'utf-8'),
  ) as {
    plays?: Array<{ type?: { text?: string }; text?: string }>;
  };

  it('classifyPlay reconnaît le « End Game » d’ESPN', () => {
    expect(classifyPlay('End Game', '', false)).toBe('game_end');
    expect(classifyPlay('End of Game', '', false)).toBe('game_end');
  });

  it('la fixture réelle contient un « End Game » détecté comme game_end', () => {
    const plays = summary.plays ?? [];
    const endGame = plays.find((p) => (p.type?.text ?? '').toLowerCase().includes('end game'));
    expect(endGame, 'la fixture doit contenir un événement de fin de match').toBeDefined();
    expect(classifyPlay(endGame!.type?.text ?? '', endGame!.text ?? '', false)).toBe('game_end');
  });

  it('la recherche naïve qui échouait est bien ineffective', () => {
    // Ce test verrouille la cause racine : si ESPN changeait sa casse, la
    // condition naïve redeviendrait fausse et le test échouerait.
    const plays = summary.plays ?? [];
    const naive = plays.some((p) => (p.type?.text ?? '').toLowerCase().includes('end of game'));
    expect(naive).toBe(false);
  });
});
