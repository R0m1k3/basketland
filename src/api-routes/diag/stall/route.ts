import { isOriginAllowed, allowedOrigins } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** Au plus une ligne de journal toutes les 5 s (un gel peut se répéter en rafale). */
let lastLog = 0;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * POST /api/diag/stall — signalement d'un gel de lecture par le lecteur
 * (navigator.sendBeacon) : durée, position, qualité, débit estimé, avance
 * du tampon. Écrit une ligne dans les logs Docker ; ne stocke rien.
 */
export async function POST(req: Request) {
  if (!isOriginAllowed(req, allowedOrigins())) return new Response(null, { status: 403 });
  let d: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.length > 2000) return new Response(null, { status: 413 });
    d = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response(null, { status: 400 });
  }
  const ms = num(d.ms);
  if (ms === null) return new Response(null, { status: 400 });
  if (Date.now() - lastLog >= 5_000) {
    lastLog = Date.now();
    const t = num(d.t) ?? 0;
    const h = num(d.height);
    const br = num(d.bitrate);
    const est = num(d.estimate);
    const ahead = num(d.ahead);
    const mmss = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    console.log(
      `[lecteur] gel de ${(ms / 1000).toFixed(1)} s à ${mmss}` +
        `${h ? ` · ${h}p` : ''}${br ? ` (${(br / 1e6).toFixed(1)} Mb/s)` : ''}` +
        `${est ? ` · débit mesuré ${(est / 1e6).toFixed(1)} Mb/s` : ''}` +
        `${ahead !== null ? ` · tampon ${ahead} s` : ''}`,
    );
  }
  return new Response(null, { status: 204 });
}
