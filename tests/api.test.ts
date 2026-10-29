import { describe, it, expect } from 'vitest';
import { allowedOrigins, isOriginAllowed, requestOrigin } from '../src/lib/api';

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost:3000/api/matches/1/sync', {
    method: 'POST',
    headers,
  });
}

describe('allowedOrigins', () => {
  it('renvoie une liste vide si la variable est absente', () => {
    delete process.env.SYNC_WRITE_ORIGINS;
    expect(allowedOrigins()).toEqual([]);
  });

  it('découpe et nettoie la liste', () => {
    process.env.SYNC_WRITE_ORIGINS = ' http://192.168.1.16:3000 , 192.168.1.20 ,';
    expect(allowedOrigins()).toEqual(['http://192.168.1.16:3000', '192.168.1.20']);
    delete process.env.SYNC_WRITE_ORIGINS;
  });
});

describe('requestOrigin', () => {
  it('lit l\'en-tête Origin et ne garde que l\'hôte', () => {
    expect(requestOrigin(req({ origin: 'http://192.168.1.16:3000' }))).toBe('192.168.1.16:3000');
  });

  it('retombe sur X-Forwarded-For', () => {
    expect(requestOrigin(req({ 'x-forwarded-for': '192.168.1.50, 10.0.0.1' }))).toBe('192.168.1.50');
  });

  it('retombe sur le Referer', () => {
    expect(requestOrigin(req({ referer: 'http://nas.local:3000/matchs/1' }))).toBe('nas.local:3000');
  });

  it('renvoie null sans aucun en-tête', () => {
    expect(requestOrigin(req({}))).toBeNull();
  });
});

describe('isOriginAllowed', () => {
  it('accepte tout si la liste est vide', () => {
    expect(isOriginAllowed(req({ origin: 'http://nimportequoi:1234' }), [])).toBe(true);
  });

  it('accepte une origine listée', () => {
    const r = req({ origin: 'http://192.168.1.16:3000' });
    expect(isOriginAllowed(r, ['192.168.1.16:3000'])).toBe(true);
  });

  it('accepte une IP listée pour une origine avec port', () => {
    const r = req({ origin: 'http://192.168.1.16:3000' });
    expect(isOriginAllowed(r, ['192.168.1.16'])).toBe(true);
  });

  it('refuse une origine non listée', () => {
    const r = req({ origin: 'http://192.168.1.99:3000' });
    expect(isOriginAllowed(r, ['192.168.1.16'])).toBe(false);
  });

  it('refuse une requête sans origine identifiable', () => {
    expect(isOriginAllowed(req({}), ['192.168.1.16'])).toBe(false);
  });
});
