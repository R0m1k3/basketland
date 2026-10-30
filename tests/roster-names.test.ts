import { describe, it, expect } from 'vitest';
import { editDistance, fixRosterNames, nameRendered, nearestSurname, rosterIndex } from '../src/lib/rosterNames';
import { buildUserMessage, consistentTranslation, TRANSLATE_SYSTEM_PROMPT } from '../src/lib/commentaryAi';

/** Noms des joueurs : corrections sûres avant traduction, liste donnée au LLM. */
const roster = rosterIndex(['Zach Edey', 'Ja Morant', 'Jaren Jackson Jr.', 'Neemias Queta', 'Shaedon Sharpe', 'Deni Avdija', 'Jerami Grant', 'Desmond Bane']);

describe('effectif du match', () => {
  it('index des noms de famille (suffixes Jr. ignorés, noms trop courts exclus)', () => {
    expect([...roster.surnames.values()].sort()).toEqual(['Avdija', 'Bane', 'Edey', 'Grant', 'Jackson', 'Morant', 'Queta', 'Sharpe']);
    expect(editDistance('edie', 'edey')).toBe(2);
    expect(editDistance('morrant', 'morant')).toBe(1);
  });

  it('corrige les écarts d’une lettre (≥ 5 lettres) ou deux (≥ 8), même initiale', () => {
    expect(nearestSurname('Morrant', roster)).toBe('Morant');
    expect(nearestSurname('Sharp', roster)).toBe('Sharpe');
    expect(nearestSurname('Avdia', roster)).toBe('Avdija');
    expect(nearestSurname('Grant', roster)).toBe('Grant');
    // Trop court ou trop loin : laissé au LLM.
    expect(nearestSurname('Edie', roster)).toBeNull();
    expect(nearestSurname('Kata', roster)).toBeNull();
    // Mot anglais courant : jamais touché.
    expect(nearestSurname('Heart', rosterIndex(['Josh Hart']))).toBeNull();
  });

  it('dans une ligne : possessif conservé, le reste intact', () => {
    expect(fixRosterNames("Morrant's floater, and Sharp with the rebound.", roster)).toBe("Morant's floater, and Sharpe with the rebound.");
    expect(fixRosterNames('Nice pass by Edie to Kata.', roster)).toBe('Nice pass by Edie to Kata.');
    expect(fixRosterNames('Morrant scores.', rosterIndex([]))).toBe('Morrant scores.');
  });

  it('liste « joueurs » envoyée au LLM, avec la consigne de corriger les noms écorchés', () => {
    const m = buildUserMessage([{ i: 1, en: 'Kata with the block.' }], [], 'gemma4:e4b', roster);
    expect(m).toContain('"joueurs":["Zach Edey","Ja Morant"');
    expect(TRANSLATE_SYSTEM_PROMPT).toContain('« Kata » → « Queta »');
    expect(buildUserMessage([{ i: 1, en: 'x' }], [], 'gemma4:e4b')).not.toContain('joueurs');
  });

  it('contrôle des noms : un nom corrigé vers un joueur proche ne rend pas la ligne suspecte', () => {
    expect(nameRendered('kata', ' contre de queta', roster)).toBe(true);
    expect(consistentTranslation('Great block by Kata.', 'Superbe contre de Queta.', roster)).toBe(true);
    expect(consistentTranslation('Great block by Kata.', 'Superbe contre de Queta.')).toBe(false);
    expect(consistentTranslation('Great block by Kata.', 'Superbe passe de Morant.', roster)).toBe(false);
  });
});
