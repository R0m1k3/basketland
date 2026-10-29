import { describe, expect, it } from 'vitest';
import { findCue, findOnScreen, readDuration, type Subtitle } from '../src/components/match/playback';
import { fmtTime, parseClock } from '../src/components/match/format';
import { stripScores } from '../src/components/match/spoiler';

const sub = (seq: number, video_ts: number, end_ts: number | null = null): Subtitle => ({
  seq,
  video_ts,
  end_ts,
  text: `l${seq}`,
  speaker: '',
  kind: 'action',
});

describe('findCue (ligne de VF active)', () => {
  const subs = [sub(1, 10, 14), sub(2, 20, 23), sub(3, 30, null)];
  it('avant la première ligne', () => expect(findCue(subs, 5)).toEqual({ index: -1, visible: false }));
  it('pendant une ligne', () => expect(findCue(subs, 12)).toEqual({ index: 0, visible: true }));
  it('après la fin : la ligne reste courante mais quitte l’écran', () =>
    expect(findCue(subs, 18)).toEqual({ index: 0, visible: false }));
  it('sans fin : affichée 4 s', () => {
    expect(findCue(subs, 33).visible).toBe(true);
    expect(findCue(subs, 40).visible).toBe(false);
    expect(findCue(subs, 40).index).toBe(2);
  });
  it('liste vide', () => expect(findCue([], 3).index).toBe(-1));
});

describe('parseClock (chrono saisi)', () => {
  it.each([
    ['7:43', 463],
    ['07:43', 463],
    ['7.43', 463],
    ['743', 463],
    ['12:00', 720],
    ['42.3', 42],
    [' 0:05 ', 5],
  ])('%s → %s s', (input, expected) => expect(parseClock(input)).toBe(expected));
  it.each(['', 'abc', '7:75', '25:00', '99'])('refuse « %s »', (input) => expect(parseClock(input)).toBeNull());
});

describe('mise en forme', () => {
  it('fmtTime', () => {
    expect(fmtTime(65)).toBe('1:05');
    expect(fmtTime(3725)).toBe('1:02:05');
    expect(fmtTime(Number.NaN)).toBe('0:00');
  });
  it('stripScores retire le score des lignes de fin de période', () => {
    expect(stripScores('Fin du 4e quart · NY 133 – 127 CHI')).toBe('Fin du 4e quart');
    expect(stripScores('Dunk de Caleb Wilson !')).toBe('Dunk de Caleb Wilson !');
  });
});

describe('findOnScreen (VF en roll-up)', () => {
  const mk = (seq: number, at: number, text = 'Dunk de Wembanyama', end: number | null = at + 1): Subtitle => ({
    seq,
    video_ts: at,
    end_ts: end,
    text,
    speaker: '',
    kind: 'action',
  });

  it('une ligne trop courte reste le temps d’être lue', () => {
    const subs = [mk(1, 10, 'Temps mort Clippers', 10.8)];
    expect(readDuration(subs[0])).toBeGreaterThanOrEqual(2.5);
    expect(findOnScreen(subs, 12)).toEqual([0]);
    expect(findOnScreen(subs, 14)).toEqual([]);
  });

  it('deux actions simultanées s’empilent au lieu de s’écraser', () => {
    const subs = [mk(1, 455, 'Walker Kessler marque en lay-up'), mk(2, 455, 'Walker Kessler marque le lancer franc 1 sur 1')];
    expect(findOnScreen(subs, 455.5)).toEqual([0, 1]);
  });

  it('au plus deux lignes, les plus récentes', () => {
    const subs = [mk(1, 100), mk(2, 100.5), mk(3, 101)];
    expect(findOnScreen(subs, 101.2)).toEqual([1, 2]);
  });

  it('une ligne longue reste plus longtemps', () => {
    const court = mk(1, 0, 'Faute');
    const long = mk(2, 0, 'Shai Gilgeous-Alexander marque un shoot à 3 points, passe décisive de Jalen Williams');
    expect(readDuration(long)).toBeGreaterThan(readDuration(court));
    expect(readDuration(long)).toBeLessThanOrEqual(7);
  });
});
