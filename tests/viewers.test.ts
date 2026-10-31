import { describe, it, expect, afterEach, vi } from 'vitest';
import { __clearViewersForTests, touchViewer, viewerActive, viewerPlaying } from '../src/lib/viewers';

/** Spectateurs : lecture en cours (position qui avance) ou en pause. */

afterEach(() => {
  __clearViewersForTests();
  vi.useRealTimers();
});

describe('viewerPlaying', () => {
  it('position qui avance : en lecture ; position figée plus d’une minute : en pause (mais toujours spectateur)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T10:00:00Z'));
    touchViewer(1, 0);
    expect(viewerPlaying(1)).toBe(false); // premier signe : on ne sait pas encore
    vi.advanceTimersByTime(20_000);
    touchViewer(1, 20);
    expect(viewerPlaying(1)).toBe(true);
    vi.advanceTimersByTime(20_000);
    touchViewer(1, 20); // pause : même position
    expect(viewerPlaying(1)).toBe(true); // avancé il y a moins d'une minute
    vi.advanceTimersByTime(50_000);
    touchViewer(1, 20);
    expect(viewerPlaying(1)).toBe(false);
    expect(viewerActive(1)).toBe(true);
    touchViewer(1); // signe de vie sans position : ne compte pas comme une avancée
    expect(viewerPlaying(1)).toBe(false);
  });
});
