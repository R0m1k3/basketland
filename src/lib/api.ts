import { NextResponse } from 'next/server';

export type RouteCtx<P> = { params: Promise<P> };

export function json(data: unknown, init: ResponseInit = {}) {
  return NextResponse.json(data, { ...init, headers: { 'Cache-Control': 'no-store', ...(init.headers ?? {}) } });
}

export function error(status: number, message: string) {
  return json({ error: message }, { status });
}

export function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function intParam(v: string | null, def: number, min: number, max: number): number {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
