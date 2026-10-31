import { describe, it, expect, vi, afterEach } from 'vitest';
import { POST } from '../src/api-routes/diag/stall/route';

/** Signalement des gels de lecture : une ligne de journal, rien de stocké. */
const req = (body: string, origin = 'http://nas.local') =>
  new Request('http://nas.local/api/diag/stall', { method: 'POST', headers: { host: 'nas.local', origin, 'content-type': 'text/plain' }, body });

afterEach(() => vi.restoreAllMocks());

describe('POST /api/diag/stall', () => {
  it('journalise un gel avec qualité, débit et tampon', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await POST(req(JSON.stringify({ ms: 3200, t: 754, height: 720, bitrate: 2_800_000, estimate: 1_900_000, ahead: 0 })));
    expect(r.status).toBe(204);
    expect(log).toHaveBeenCalledWith('[lecteur] gel de 3.2 s à 12:34 · 720p (2.8 Mb/s) · débit mesuré 1.9 Mb/s · tampon 0 s');
  });

  it('refuse une origine tierce et un corps invalide', async () => {
    expect((await POST(req('{"ms":2000}', 'https://evil.example'))).status).toBe(403);
    expect((await POST(req('pas du json'))).status).toBe(400);
    expect((await POST(req('{"t":3}'))).status).toBe(400);
  });
});
