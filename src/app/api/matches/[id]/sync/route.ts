import {
  clearAnchors,
  deleteAnchor,
  getAnchors,
  getAudioProfile,
  getMatch,
  getPlays,
  getSyncSettings,
  saveSyncSettings,
  upsertAnchor,
} from '@/lib/db';
import { allowedOrigins, error, isOriginAllowed, json, parseId, type RouteCtx } from '@/lib/api';
import { analysisStatus, regenerateSubtitles, startVideoAnalysis } from '@/lib/ingest';

export const dynamic = 'force-dynamic';

function syncState(id: number) {
  const profile = getAudioProfile(id);
  const st = analysisStatus(id);
  return {
    match_id: id,
    settings: getSyncSettings(id),
    anchors: getAnchors(id),
    analysis: st,
    audio: {
      status: st.status,
      analyzed_at: profile?.analyzed_at ?? null,
      seconds: profile?.rms_db.length ?? 0,
      cuts: profile?.cuts ?? [],
    },
  };
}

export async function GET(_req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  if (!getMatch(id)) return error(404, 'match introuvable');
  return json(syncState(id));
}

interface SyncBody {
  action?: 'anchor' | 'delete-anchor' | 'offset' | 'nudge' | 'reset' | 'analyze' | 'analyze-audio';
  /** Ancre depuis une ligne de VF : seq de l'action + position vidéo courante. */
  seq?: number;
  video_ts?: number;
  period?: number;
  clock_sec?: number;
  global_offset?: number;
  quarter_offsets?: Record<string, number>;
  /** Décalage relatif (ex. ±0,5 s) ; `period` pour un quart précis. */
  delta?: number;
  anchors?: { period: number; clock_sec: number; video_ts: number; wallclock?: string | null }[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * POST /api/matches/[id]/sync
 * - { global_offset, quarter_offsets }        → réglage manuel persistant
 * - { action: 'nudge', delta, period? }       → ± décalage relatif
 * - { action: 'anchor', seq, video_ts }       → « cette action se passe maintenant »
 * - { anchors: [{ period, clock_sec, video_ts }] } → ancres manuelles brutes
 * - { action: 'delete-anchor', period, clock_sec } / { action: 'reset' }
 * - { action: 'analyze-audio' }               → détection des coupures (ffmpeg)
 */
export async function POST(req: Request, ctx: RouteCtx<{ id: string }>) {
  const id = parseId((await ctx.params).id);
  if (!id) return error(400, 'id invalide');
  const match = getMatch(id);
  if (!match) return error(404, 'match introuvable');
  let body: SyncBody;
  try {
    body = (await req.json()) as SyncBody;
  } catch {
    return error(400, 'JSON invalide');
  }

  // Les écritures de calibration modifient l'état persistant sans jeton
  // (l'UI doit pouvoir les appeler depuis le navigateur). On borne donc
  // qui peut les déclencher : `SYNC_WRITE_ORIGINS` liste les origines (ou IP)
  // autorisées ; liste vide = toute origine locale est acceptée.
  //
  // Le contrôle s'applique à TOUTE écriture, pas seulement à celles qui
  // portent un `action` : `{ global_offset }`, `{ quarter_offsets }` et
  // `{ anchors: [...] }` sont des écritures au même titre. Sans cela, un
  // site tiers pouvait décaler la VF d'une heure par requête simple
  // (CSRF : une requête `text/plain` n'est pas préflightée).
  if (!isOriginAllowed(req, allowedOrigins())) {
    return error(403, 'origine non autorisée pour cette écriture');
  }
  // Exiger un Content-Type JSON : sans cela, une requête « simple » cross
  // origin (text/plain) passe le contrôle CORS du navigateur sans
  // preflight, et `req.json()` laparse quand même.
  const ctype = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!ctype.includes('application/json')) {
    return error(415, 'Content-Type application/json requis');
  }

  const current = getSyncSettings(id);
  let message = 'ok';

  if (body.action === 'analyze-audio' || body.action === 'analyze') {
    const r = startVideoAnalysis(id, { withAudio: body.action === 'analyze-audio' });
    return json({ ...syncState(id), started: r.started, message: r.reason ?? 'analyse lancée' }, { status: r.started ? 202 : 200 });
  }

  if (body.action === 'reset') {
    clearAnchors(id, ['manual']);
    saveSyncSettings(id, 0, {});
    message = 'réglages remis à zéro';
  } else if (body.action === 'nudge') {
    if (!finite(body.delta) || Math.abs(body.delta) > 3600) return error(400, 'delta invalide');
    if (finite(body.period)) {
      const q = { ...current.quarter_offsets };
      q[String(body.period)] = Math.round(((q[String(body.period)] ?? 0) + body.delta) * 100) / 100;
      saveSyncSettings(id, current.global_offset, q);
    } else {
      saveSyncSettings(id, Math.round((current.global_offset + body.delta) * 100) / 100, current.quarter_offsets);
    }
  } else if (body.action === 'anchor') {
    if (!finite(body.seq) || !finite(body.video_ts) || body.video_ts < 0) return error(400, 'seq et video_ts requis');
    const play = getPlays(id).find((p) => p.seq === body.seq);
    if (!play) return error(404, 'action introuvable');
    // L'ancre fixe la position *finale* : on retire l'offset global/quart qui sera ré-appliqué.
    const offset = current.global_offset + (Number(current.quarter_offsets[String(play.period)]) || 0);
    upsertAnchor({
      match_id: id,
      period: play.period,
      clock_sec: play.clock_sec,
      video_ts: Math.round((body.video_ts - offset) * 100) / 100,
      method: 'manual',
      wallclock: play.wallclock,
    });
    message = `ancre posée (${play.period}e période, ${play.clock_display})`;
  } else if (body.action === 'delete-anchor') {
    if (!finite(body.period) || !finite(body.clock_sec)) return error(400, 'period et clock_sec requis');
    deleteAnchor(id, body.period, body.clock_sec);
  } else {
    if (body.global_offset !== undefined || body.quarter_offsets !== undefined) {
      const g = body.global_offset ?? current.global_offset;
      if (!finite(g) || Math.abs(g) > 4 * 3600) return error(400, 'global_offset invalide');
      const q: Record<string, number> = {};
      for (const [k, v] of Object.entries(body.quarter_offsets ?? current.quarter_offsets)) {
        if (!/^\d{1,2}$/.test(k) || !finite(v) || Math.abs(v) > 3600) return error(400, `quarter_offsets[${k}] invalide`);
        q[k] = v;
      }
      saveSyncSettings(id, g, q);
    }
    for (const a of body.anchors ?? []) {
      if (!finite(a.period) || !finite(a.clock_sec) || !finite(a.video_ts) || a.video_ts < 0) return error(400, 'ancre invalide');
      // Même convention que l'action `anchor` : les ancres stockées sont des
      // positions BRUTES, les offsets globaux et par quart sont ré-appliqués
      // ensuite lors du calcul des video_ts. Sans cette correction, une même
      // position donnait deux résultats selon l'API utilisée.
      const rawOffset = current.global_offset + (Number(current.quarter_offsets[String(Math.trunc(a.period))]) || 0);
      upsertAnchor({
        match_id: id,
        period: Math.trunc(a.period),
        clock_sec: Math.trunc(a.clock_sec),
        video_ts: Math.round((a.video_ts - rawOffset) * 100) / 100,
        method: 'manual',
        wallclock: a.wallclock ?? null,
      });
    }
  }

  const count = regenerateSubtitles(id);
  return json({ ...syncState(id), subtitles: count, message });
}
