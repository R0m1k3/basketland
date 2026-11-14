import { describe, expect, it } from 'vitest';
import { pick, score, type Box } from '@/lib/spatialNav';

const box = (left: number, top: number, w = 100, h = 40): Box => ({ left, top, right: left + w, bottom: top + h });

describe('navigation à la croix', () => {
  // Grille 3 × 2 de cartes.
  const grid = [box(0, 0), box(120, 0), box(240, 0), box(0, 60), box(120, 60), box(240, 60)];

  it('reste dans la colonne en descendant et dans la ligne à droite', () => {
    expect(pick(grid[1], grid, 'down')).toBe(4);
    expect(pick(grid[3], grid, 'right')).toBe(4);
    expect(pick(grid[4], grid, 'up')).toBe(1);
    expect(pick(grid[2], grid, 'left')).toBe(1);
  });

  it('aucun candidat au bord', () => {
    expect(pick(grid[0], grid, 'up')).toBe(-1);
    expect(pick(grid[0], grid, 'left')).toBe(-1);
    expect(pick(grid[5], grid, 'right')).toBe(-1);
  });

  it('préfère un élément aligné un peu plus loin à un élément décalé plus proche', () => {
    const from = box(0, 0);
    const aligned = box(0, 200);
    const offside = box(500, 60);
    expect(pick(from, [offside, aligned], 'down')).toBe(1);
  });

  it('un élément large au-dessus (onglets, en-tête) reste joignable', () => {
    const header = box(0, 0, 400, 40);
    const card = box(250, 100);
    expect(score(card, header, 'up')).not.toBeNull();
    expect(pick(card, [header], 'up')).toBe(0);
  });

  it('ignore un élément qui chevauche dans le mauvais sens', () => {
    expect(score(box(0, 0), box(0, 10), 'up')).toBeNull();
  });
});
