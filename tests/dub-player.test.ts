import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DubPlayer,
  chunkAt,
  dubHint,
  duckGainAt,
  duckPoints,
  isDubAvailable,
  mergeSpeech,
  nextChunk,
  parseManifest,
  type AudioContextLike,
  type DubChunk,
  type DubManifest,
  type FetchLike,
  type Interval,
} from '../src/components/match/dubPlayer';

// ---------------------------------------------------------------- faux

/** AudioParam : enregistre l'automatisation et sait l'évaluer à un instant donné. */
class FakeParam {
  private initial: number;
  timeline: { type: 'set' | 'ramp'; v: number; t: number }[] = [];
  constructor(
    private ctx: FakeCtx,
    v: number,
  ) {
    this.initial = v;
  }
  get value() {
    return this.valueAt(this.ctx.currentTime);
  }
  set value(v: number) {
    this.initial = v;
    this.timeline = [];
  }
  setValueAtTime(v: number, t: number) {
    this.timeline.push({ type: 'set', v, t });
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.timeline.push({ type: 'ramp', v, t });
  }
  setTargetAtTime(v: number, t: number) {
    // Approximation suffisante ici : valeur atteinte à l'instant t.
    this.timeline.push({ type: 'set', v, t });
  }
  cancelScheduledValues(t: number) {
    this.timeline = this.timeline.filter((e) => e.t < t);
  }
  valueAt(time: number): number {
    let prevV = this.initial;
    let prevT = -Infinity;
    for (const e of this.timeline) {
      if (e.t <= time) {
        prevV = e.v;
        prevT = e.t;
        continue;
      }
      if (e.type === 'ramp') return prevV + ((e.v - prevV) * (time - prevT)) / (e.t - prevT);
      return prevV;
    }
    return prevV;
  }
}

class FakeNode {
  out: unknown = null;
  connect(n: unknown) {
    this.out = n;
    return n;
  }
  disconnect() {
    this.out = null;
  }
}

class FakeGain extends FakeNode {
  gain: FakeParam;
  constructor(ctx: FakeCtx) {
    super();
    this.gain = new FakeParam(ctx, 1);
  }
}

class FakeSource extends FakeNode {
  buffer: { duration: number } | null = null;
  playbackRate: FakeParam;
  onended: (() => void) | null = null;
  startArgs: [number, number] | null = null;
  stopAt: number | null = null;
  constructor(private ctx: FakeCtx) {
    super();
    this.playbackRate = new FakeParam(ctx, 1);
  }
  start(when = 0, offset = 0) {
    this.startArgs = [when, offset];
  }
  stop(when?: number) {
    this.stopAt = when ?? this.ctx.currentTime;
  }
  get stopped() {
    return this.stopAt !== null && this.stopAt <= this.ctx.currentTime + 0.05;
  }
}

class FakeCtx {
  currentTime = 0;
  state: string;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  routed: FakeGain | null = null;
  mediaSources = 0;
  failRoute = false;
  /** false : resume() n'aboutit pas (pas de geste). */
  resumable = true;
  closed = false;
  private stateListeners = new Set<() => void>();
  constructor(state: string) {
    this.state = state;
  }
  createGain() {
    const g = new FakeGain(this);
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s = new FakeSource(this);
    this.sources.push(s);
    return s;
  }
  createMediaElementSource() {
    if (this.failRoute) throw new Error('InvalidStateError');
    this.mediaSources++;
    const ctx = this;
    const node = new FakeNode();
    const connect = node.connect.bind(node);
    node.connect = (n: unknown) => {
      ctx.routed = n as FakeGain;
      return connect(n);
    };
    return node;
  }
  decodeAudioData(data: ArrayBuffer) {
    return Promise.resolve({ duration: new Float64Array(data)[0] });
  }
  resume() {
    if (this.resumable && this.state !== 'running') {
      this.state = 'running';
      for (const cb of this.stateListeners) cb();
    }
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  }
  addEventListener(_t: 'statechange', cb: () => void) {
    this.stateListeners.add(cb);
  }
  removeEventListener(_t: 'statechange', cb: () => void) {
    this.stateListeners.delete(cb);
  }
  /** Sources démarrées et pas encore coupées. */
  get live() {
    return this.sources.filter((s) => s.startArgs && !s.stopped);
  }
}

class FakeVideo {
  currentTime = 0;
  paused = true;
  ended = false;
  seeking = false;
  playbackRate = 1;
  muted = false;
  readyState = 4;
  currentSrc = 'blob:http://localhost/abc';
  crossOrigin: string | null = null;
  isConnected = true;
  private _volume = 1;
  private l = new Map<string, Set<() => void>>();
  get volume() {
    return this._volume;
  }
  set volume(v: number) {
    this._volume = v;
    queueMicrotask(() => this.emit('volumechange'));
  }
  addEventListener(t: string, cb: () => void) {
    if (!this.l.has(t)) this.l.set(t, new Set());
    this.l.get(t)!.add(cb);
  }
  removeEventListener(t: string, cb: () => void) {
    this.l.get(t)?.delete(cb);
  }
  listenerCount() {
    let n = 0;
    for (const s of this.l.values()) n += s.size;
    return n;
  }
  emit(t: string) {
    for (const cb of [...(this.l.get(t) ?? [])]) cb();
  }
  play() {
    this.paused = false;
    this.emit('play');
    this.emit('playing');
  }
  pause() {
    this.paused = true;
    this.emit('pause');
  }
  seek(t: number) {
    this.seeking = true;
    this.emit('seeking');
    this.currentTime = t;
    this.seeking = false;
    this.emit('seeked');
  }
}

const URL_BASE = '/api/matches/12/dub';
const chunk = (idx: number, start: number, end: number, speech: Interval[] = []): DubChunk => ({
  idx,
  start,
  end,
  url: `${URL_BASE}/${idx}?v=1`,
  speech,
});
const manifestOf = (status: DubManifest['status'], chunks: DubChunk[]) => ({ status, chunks, voices: { A: 'Commentateur' } });

/** Laisse passer les promesses en attente (fetch → décodage → programmation). */
const flush = () => new Promise<void>((r) => setImmediate(r));

interface SetupOpts {
  manifest?: object;
  ctxState?: string;
  failRoute?: boolean;
  /** Durée audio (s) par URL de tranche ; par défaut end − start. */
  durations?: Record<string, number>;
  video?: FakeVideo;
}

function setup(opts: SetupOpts = {}) {
  const video = opts.video ?? new FakeVideo();
  const ctx = new FakeCtx(opts.ctxState ?? 'running');
  ctx.failRoute = !!opts.failRoute;
  let manifest: object = opts.manifest ?? manifestOf('ready', [chunk(0, 0, 120), chunk(1, 120, 240)]);
  let created = 0;
  const requests: string[] = [];
  const fetchFn = vi.fn(async (url: string) => {
    requests.push(url);
    if (url === URL_BASE || url.startsWith(`${URL_BASE}?`)) {
      const body = manifest;
      return { ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(8) };
    }
    const m = manifest as { chunks?: DubChunk[] };
    const c = m.chunks?.find((x) => x.url === url);
    const d = opts.durations?.[url] ?? (c ? c.end - c.start : undefined);
    if (d === undefined || d < 0) return { ok: false, status: d === undefined ? 404 : 500, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new Float64Array([d]).buffer };
  });
  const player = new DubPlayer({
    video,
    manifestUrl: URL_BASE,
    createAudioContext: () => {
      created++;
      return ctx as unknown as AudioContextLike;
    },
    fetch: fetchFn as unknown as FetchLike,
  });
  /** Fait avancer le temps de `sec` secondes, par pas d'1 s (horloge audio, vidéo, minuteries). */
  const advance = async (sec: number, videoRate = 1) => {
    for (let i = 0; i < sec; i++) {
      ctx.currentTime += 1;
      if (!video.paused) video.currentTime += videoRate * video.playbackRate;
      await vi.advanceTimersByTimeAsync(1000);
      await flush();
    }
  };
  return {
    video,
    ctx,
    player,
    fetchFn,
    requests,
    advance,
    created: () => created,
    setManifest: (m: object) => (manifest = m),
    chunkRequests: () => requests.filter((u) => u.startsWith(`${URL_BASE}/`)),
  };
}

/** Lecteur actif, contexte débloqué, en lecture à `t`. */
async function playingAt(t: number, opts: SetupOpts = {}) {
  const s = setup(opts);
  s.video.currentTime = t;
  s.player.setEnabled(true);
  s.player.unlock();
  await flush();
  await flush();
  s.video.play();
  await flush();
  return s;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- fonctions pures

describe('manifeste et tranches', () => {
  it('parseManifest valide et trie les tranches', () => {
    const m = parseManifest({
      status: 'partial',
      chunks: [
        { idx: 1, start: 120, end: 240, url: '/b', speech: [[130, 131], [5, 'x'], [9, 8]] },
        { idx: 0, start: 0, end: 120, url: '/a' },
        { idx: 2, start: 'x', end: 360, url: '/c' },
        { idx: 3, start: 400, end: 380, url: '/d' },
      ],
      voices: { A: 'Commentateur', B: 3 },
    });
    expect(m.status).toBe('partial');
    expect(m.chunks.map((c) => c.url)).toEqual(['/a', '/b']);
    expect(m.chunks[1].speech).toEqual([[130, 131]]);
    expect(m.chunks[0].speech).toEqual([]);
    expect(m.voices).toEqual({ A: 'Commentateur' });
  });

  it('statut inconnu ou réponse vide → none', () => {
    expect(parseManifest(null).status).toBe('none');
    expect(parseManifest({ status: 'bof' }).status).toBe('none');
  });

  it('isDubAvailable', () => {
    expect(isDubAvailable('none')).toBe(false);
    expect(isDubAvailable('disabled')).toBe(false);
    expect(isDubAvailable(null)).toBe(false);
    for (const s of ['waiting', 'running', 'partial', 'ready', 'failed'] as const) expect(isDubAvailable(s)).toBe(true);
  });

  it('chunkAt / nextChunk : début inclus, fin exclue, trous', () => {
    const cs = [chunk(0, 0, 120), chunk(2, 240, 360)];
    expect(chunkAt(cs, 0)?.idx).toBe(0);
    expect(chunkAt(cs, 119.9)?.idx).toBe(0);
    expect(chunkAt(cs, 120)).toBeNull();
    expect(chunkAt(cs, 300)?.idx).toBe(2);
    expect(chunkAt(cs, 400)).toBeNull();
    expect(chunkAt([], 3)).toBeNull();
    expect(nextChunk(cs, 0)?.idx).toBe(2);
    expect(nextChunk(cs, 150)?.idx).toBe(2);
    expect(nextChunk(cs, 240)).toBeNull();
  });

  it('dubHint : en préparation, bientôt disponible, indisponible', () => {
    const m = (status: DubManifest['status'], chunks: DubChunk[] = []): DubManifest => ({ status, chunks, voices: {} });
    expect(dubHint(m('waiting'), 10)).toBe('en préparation…');
    expect(dubHint(m('running'), 10)).toBe('en préparation…');
    expect(dubHint(m('running', [chunk(0, 0, 120)]), 10)).toBeNull();
    expect(dubHint(m('running', [chunk(0, 0, 120)]), 200)).toBe('bientôt disponible ici');
    expect(dubHint(m('partial', [chunk(0, 0, 120)]), 200)).toBe('bientôt disponible ici');
    expect(dubHint(m('failed', [chunk(0, 0, 120)]), 200)).toBe('indisponible ici');
    expect(dubHint(m('ready', [chunk(0, 0, 120)]), 200)).toBeNull();
    expect(dubHint(m('none'), 10)).toBeNull();
    expect(dubHint(m('disabled'), 10)).toBeNull();
    expect(dubHint(null, 10)).toBeNull();
    // Vitesse ≠ ×1 : indication prioritaire, même là où une tranche existe.
    expect(dubHint(m('ready', [chunk(0, 0, 120)]), 10, 1.5)).toBe('VF doublée à vitesse normale seulement');
    expect(dubHint(m('waiting'), 10, 2)).toBe('VF doublée à vitesse normale seulement');
    expect(dubHint(m('none'), 10, 2)).toBeNull();
  });
});

describe('baisse de la VO (calcul)', () => {
  it('fusionne les phrases rapprochées (pas de pompage)', () => {
    expect(mergeSpeech([[6.1, 8.0], [3.2, 5.9], [20, 22]])).toEqual([[3.2, 8.0], [20, 22]]);
    expect(mergeSpeech([[1, 2], [2.6, 3]])).toEqual([[1, 2], [2.6, 3]]);
  });

  it('gain : rampe de 150 ms avant, 20 % pendant, rampe de 150 ms après', () => {
    const merged = mergeSpeech([[3.2, 5.9], [6.1, 8.0]]);
    expect(duckGainAt(2, merged)).toBe(1);
    expect(duckGainAt(3.05, merged)).toBeCloseTo(1);
    expect(duckGainAt(3.125, merged)).toBeCloseTo(0.6);
    expect(duckGainAt(3.2, merged)).toBeCloseTo(0.2);
    expect(duckGainAt(6.0, merged)).toBeCloseTo(0.2); // entre deux phrases fusionnées
    expect(duckGainAt(8.075, merged)).toBeCloseTo(0.6);
    expect(duckGainAt(8.15, merged)).toBeCloseTo(1);
    expect(duckGainAt(30, merged)).toBe(1);
    expect(duckGainAt(5, merged, 0.5)).toBeCloseTo(0.5);
  });

  it('points de passage', () => {
    expect(duckPoints([[10, 12]])).toEqual([
      { t: 9.85, gain: 1 },
      { t: 10, gain: 0.2 },
      { t: 12, gain: 0.2 },
      { t: 12.15, gain: 1 },
    ]);
  });
});

// ---------------------------------------------------------------- lecteur

describe('DubPlayer : programmation', () => {
  it('démarre la tranche au bon décalage par rapport à la vidéo', async () => {
    const { ctx } = await playingAt(30);
    const head = ctx.live.find((s) => s.buffer?.duration === 120 && s.startArgs![1] > 0)!;
    expect(head).toBeDefined();
    expect(head.startArgs![0]).toBeCloseTo(0.05); // maintenant + LEAD
    expect(head.startArgs![1]).toBeCloseTo(30.05); // 30 s dans la tranche + LEAD
    expect(head.playbackRate.value).toBe(1);
  });

  it('décalage dans une tranche qui ne commence pas à 0', async () => {
    const { ctx } = await playingAt(150);
    const head = ctx.live.find((s) => s.startArgs![0] < 1)!;
    expect(head.startArgs![1]).toBeCloseTo(30.05);
  });

  it('enchaîne la tranche suivante sans blanc, pile à la frontière', async () => {
    const { ctx } = await playingAt(100);
    expect(ctx.live).toHaveLength(2);
    const [head, next] = ctx.sources.filter((s) => s.startArgs);
    expect(head.startArgs![1]).toBeCloseTo(100.05);
    // Frontière à 120 s vidéo = 20 s plus tard sur l'horloge audio.
    expect(next.startArgs![0]).toBeCloseTo(20);
    expect(next.startArgs![1]).toBe(0);
    expect(head.stopAt).toBeNull(); // son audio finit pile à la frontière
  });

  it('audio qui déborde de sa tranche : coupé quand la suivante commence', async () => {
    const { ctx } = await playingAt(100, { durations: { [`${URL_BASE}/0?v=1`]: 121 } });
    const [head, next] = ctx.sources.filter((s) => s.startArgs);
    expect(next.startArgs![0]).toBeCloseTo(20);
    expect(head.stopAt).toBeCloseTo(20);
  });

  it('à la fin naturelle d’une tranche, programme la suivante', async () => {
    const s = await playingAt(100, { manifest: manifestOf('ready', [chunk(0, 0, 120), chunk(1, 120, 240), chunk(2, 240, 360)]) });
    expect(s.ctx.live).toHaveLength(2);
    await s.advance(21); // on passe 120 s
    const head = s.ctx.sources.find((x) => x.startArgs![0] < 1)!;
    head.onended?.();
    await flush();
    const third = s.ctx.sources.find((x) => x.buffer && x.startArgs && Math.abs(x.startArgs[0] - 140) < 0.01);
    expect(third).toBeDefined(); // 240 s vidéo ↔ 140 s audio
  });

  it('saut dans la vidéo : arrêt puis reprise au nouveau décalage', async () => {
    const s = await playingAt(30);
    const before = s.ctx.sources.filter((x) => x.startArgs);
    s.video.seek(200);
    await flush();
    for (const x of before) expect(x.stopAt).not.toBeNull();
    const head = s.ctx.live.find((x) => x.startArgs![1] > 0)!;
    expect(head.startArgs![1]).toBeCloseTo(80.05);
    // Le manifeste repart avec la nouvelle position.
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.requests).toContain(`${URL_BASE}?t=200`);
  });

  it('pause : silence ; lecture : reprise à la bonne position', async () => {
    const s = await playingAt(30);
    s.video.pause();
    expect(s.ctx.live).toHaveLength(0);
    s.ctx.currentTime = 10;
    s.video.currentTime = 31;
    s.video.play();
    const head = s.ctx.live.find((x) => x.startArgs![1] > 0)!;
    expect(head.startArgs![0]).toBeCloseTo(10.05);
    expect(head.startArgs![1]).toBeCloseTo(31.05);
  });

  it('vitesse ≠ ×1 : VF muette, VO à plein sans baisse, indication dans le menu', async () => {
    const s = await playingAt(4, { manifest: manifestOf('ready', [chunk(0, 0, 120, [[3, 10]]), chunk(1, 120, 240)]) });
    const gain = s.ctx.routed!.gain;
    expect(gain.valueAt(s.ctx.currentTime + 0.1)).toBeCloseTo(0.2);
    s.video.playbackRate = 1.5;
    s.video.emit('ratechange');
    expect(s.ctx.live).toHaveLength(0);
    expect(gain.valueAt(s.ctx.currentTime + 0.2)).toBe(1);
    expect(s.player.getSnapshot()).toMatchObject({ enabled: true, active: false, hint: 'VF doublée à vitesse normale seulement' });
    // Rien ne repart pendant la lecture accélérée (contrôle de dérive compris).
    await s.advance(3);
    expect(s.ctx.live).toHaveLength(0);
    expect(gain.valueAt(s.ctx.currentTime + 0.2)).toBe(1);
  });

  it('retour à ×1 : resynchronisation et reprise au bon décalage', async () => {
    const s = await playingAt(4, { manifest: manifestOf('ready', [chunk(0, 0, 120, [[3, 10], [30, 40]]), chunk(1, 120, 240)]) });
    s.video.playbackRate = 2;
    s.video.emit('ratechange');
    await s.advance(5); // 10 s de vidéo à ×2
    expect(s.ctx.live).toHaveLength(0);
    s.video.playbackRate = 1;
    s.video.emit('ratechange');
    const t = s.video.currentTime;
    const head = s.ctx.live.find((x) => x.startArgs![1] > 0)!;
    expect(head.playbackRate.value).toBe(1);
    expect(head.startArgs![0]).toBeCloseTo(s.ctx.currentTime + 0.05);
    expect(head.startArgs![1]).toBeCloseTo(t + 0.05);
    expect(s.player.getSnapshot()).toMatchObject({ active: true, hint: null });
    // La baisse de la VO reprend, calée sur la nouvelle correspondance.
    expect(s.ctx.routed!.gain.valueAt(s.ctx.currentTime + (35 - t))).toBeCloseTo(0.2);
  });

  it('repli sans routage, vitesse ≠ ×1 : video.volume rendu au volume choisi', async () => {
    const video = new FakeVideo();
    video.volume = 0.8;
    await flush();
    const s = await playingAt(4, { video, failRoute: true, manifest: manifestOf('ready', [chunk(0, 0, 120, [[3, 10]])]) });
    await flush();
    expect(video.volume).toBeCloseTo(0.16);
    video.playbackRate = 2;
    video.emit('ratechange');
    await vi.advanceTimersByTimeAsync(60);
    expect(video.volume).toBeCloseTo(0.8);
    expect(s.ctx.live).toHaveLength(0);
  });

  it('attente de tampon : silence jusqu’à « playing »', async () => {
    const s = await playingAt(30);
    s.video.emit('waiting');
    expect(s.ctx.live).toHaveLength(0);
    await s.advance(2, 0); // vidéo figée
    expect(s.ctx.live).toHaveLength(0);
    s.video.emit('playing');
    expect(s.ctx.live.length).toBeGreaterThan(0);
  });

  it('« stalled » avec du tampon devant ne coupe pas la voix', async () => {
    const s = await playingAt(30);
    s.video.emit('stalled');
    expect(s.ctx.live.length).toBeGreaterThan(0);
  });

  it('image figée sans événement : silence, puis reprise quand elle repart', async () => {
    const s = await playingAt(30);
    await s.advance(1);
    await s.advance(1, 0);
    expect(s.ctx.live).toHaveLength(0);
    await s.advance(1);
    expect(s.ctx.live.length).toBeGreaterThan(0);
  });

  it('dérive > 150 ms : reprogrammation ; dérive faible : rien', async () => {
    const s = await playingAt(30);
    const n0 = s.ctx.sources.length;
    await s.advance(1, 1.1); // 100 ms d'écart
    expect(s.ctx.sources.length).toBe(n0);
    await s.advance(1, 1.3); // 400 ms d'écart cumulés
    expect(s.ctx.sources.length).toBeGreaterThan(n0);
    const head = s.ctx.live.find((x) => x.startArgs![1] > 0)!;
    expect(head.startArgs![1]).toBeCloseTo(s.video.currentTime + 0.05);
  });

  it('tranche manquante : VO seule, indication, tranche suivante programmée', async () => {
    const s = await playingAt(150, { manifest: manifestOf('partial', [chunk(0, 0, 120, [[100, 110]]), chunk(2, 240, 360, [[250, 255]])]) });
    expect(s.ctx.live).toHaveLength(1);
    const next = s.ctx.live[0];
    expect(next.startArgs![1]).toBe(0);
    expect(next.startArgs![0]).toBeCloseTo(0.05 + (240 - 150.05));
    expect(s.player.getSnapshot()).toMatchObject({ available: true, enabled: true, active: false, hint: 'bientôt disponible ici' });
    // VO à plein dans le trou, baissée seulement là où la VF parle.
    const gain = s.ctx.routed!.gain;
    expect(gain.valueAt(1)).toBe(1);
    expect(gain.valueAt(0.05 + (252 - 150.05))).toBeCloseTo(0.2);
  });

  it('tranche plus courte que prévu : VO après la fin de son audio', async () => {
    const s = await playingAt(100, { durations: { [`${URL_BASE}/0?v=1`]: 90 } });
    expect(s.ctx.live.every((x) => x.startArgs![1] === 0)).toBe(true); // seule la suivante est programmée
  });

  it('tranche en erreur : VO à cet endroit, nouvel essai 20 s plus tard', async () => {
    const s = await playingAt(30, { durations: { [`${URL_BASE}/0?v=1`]: -1 } });
    const tries = () => s.chunkRequests().filter((u) => u.endsWith('/0?v=1')).length;
    expect(s.ctx.live).toHaveLength(1);
    expect(s.ctx.live[0].startArgs![1]).toBe(0); // seule la tranche suivante est programmée
    expect(tries()).toBe(1);
    await s.advance(10);
    expect(tries()).toBe(1);
    await s.advance(11);
    expect(tries()).toBe(2);
  });
});

describe('DubPlayer : baisse de la VO', () => {
  it('suit les intervalles de parole sur l’horloge audio', async () => {
    const s = await playingAt(0, { manifest: manifestOf('ready', [chunk(0, 0, 120, [[3.2, 5.9], [6.1, 8.0], [20, 22]])]) });
    const g = s.ctx.routed!.gain;
    // À 1× en partant de 0, temps audio = temps vidéo.
    expect(g.valueAt(1)).toBe(1);
    expect(g.valueAt(3.125)).toBeCloseTo(0.6);
    expect(g.valueAt(5)).toBeCloseTo(0.2);
    expect(g.valueAt(6)).toBeCloseTo(0.2);
    expect(g.valueAt(8.075)).toBeCloseTo(0.6);
    expect(g.valueAt(10)).toBeCloseTo(1);
    expect(g.valueAt(21)).toBeCloseTo(0.2);
    expect(g.valueAt(30)).toBeCloseTo(1);
  });

  it('pause : la VO remonte à plein', async () => {
    const s = await playingAt(4, { manifest: manifestOf('ready', [chunk(0, 0, 120, [[3, 10]])]) });
    const g = s.ctx.routed!.gain;
    expect(g.valueAt(0.05)).toBeCloseTo(0.2);
    s.video.pause();
    expect(g.valueAt(s.ctx.currentTime + 0.2)).toBe(1);
  });

  it('volume de la VF = volume de la vidéo, coupé en muet', async () => {
    const s = await playingAt(30);
    const dubGain = s.ctx.gains[0];
    expect(dubGain.gain.value).toBe(1);
    s.video.volume = 0.5;
    await flush();
    expect(dubGain.gain.valueAt(s.ctx.currentTime + 1)).toBe(0.5);
    s.video.muted = true;
    s.video.emit('volumechange');
    expect(dubGain.gain.valueAt(s.ctx.currentTime + 1)).toBe(0);
  });

  it('repli sans routage : baisse par video.volume, restauré à la désactivation', async () => {
    const video = new FakeVideo();
    video.volume = 0.8;
    await flush();
    const s = await playingAt(4, { video, failRoute: true, manifest: manifestOf('ready', [chunk(0, 0, 120, [[3, 10]])]) });
    await flush();
    expect(video.volume).toBeCloseTo(0.16); // 20 % de 0,8
    // L'utilisateur change le volume pendant la baisse : c'est la nouvelle référence.
    video.volume = 0.5;
    await flush();
    await vi.advanceTimersByTimeAsync(60);
    expect(video.volume).toBeCloseTo(0.1);
    s.player.setEnabled(false);
    expect(video.volume).toBeCloseTo(0.5);
    expect(s.ctx.mediaSources).toBe(0);
  });

  it('source d’une autre origine : pas de routage (elle sortirait muette)', async () => {
    const video = new FakeVideo();
    video.currentSrc = 'https://cdn.example.com/video.mp4';
    vi.stubGlobal('location', { href: 'http://localhost:3012/matchs/12', origin: 'http://localhost:3012' });
    try {
      const s = await playingAt(4, { video, manifest: manifestOf('ready', [chunk(0, 0, 120, [[3, 10]])]) });
      expect(s.ctx.mediaSources).toBe(0);
      expect(video.volume).toBeCloseTo(0.2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('DubPlayer : routage de la VO', () => {
  it('HLS lu nativement (Safari sans MSE) : pas de routage', async () => {
    const video = new FakeVideo();
    video.currentSrc = '/api/video/77/master.m3u8';
    const s = await playingAt(30, { video });
    expect(s.ctx.mediaSources).toBe(0);
    expect(s.ctx.live.length).toBeGreaterThan(0); // la VF joue quand même
  });

  it('flux MSE (blob:) : routage', async () => {
    const s = await playingAt(30);
    expect(s.ctx.mediaSources).toBe(1);
  });
});

describe('DubPlayer : cycle de vie', () => {
  it('pas de contexte audio sans geste ; routage seulement contexte actif', async () => {
    const s = setup({ ctxState: 'suspended' });
    s.ctx.resumable = false;
    s.player.setEnabled(true);
    await flush();
    expect(s.created()).toBe(0); // activation sans geste (préférence mémorisée)
    s.video.play(); // « play » = geste de l'utilisateur
    expect(s.created()).toBe(1);
    await flush();
    expect(s.ctx.mediaSources).toBe(0); // contexte suspendu : la VO n'est pas détournée
    expect(s.ctx.live).toHaveLength(0);
    s.ctx.resumable = true;
    s.player.unlock();
    await flush();
    await flush();
    expect(s.ctx.mediaSources).toBe(1);
    expect(s.ctx.live.length).toBeGreaterThan(0);
  });

  it('VF doublée non choisie : ni contexte, ni chargement, manifeste sans ?t=', async () => {
    const s = setup();
    s.video.currentTime = 50;
    await flush();
    s.video.play();
    await flush();
    expect(s.created()).toBe(0);
    expect(s.chunkRequests()).toEqual([]);
    expect(s.requests).toEqual([URL_BASE]);
    expect(s.player.getSnapshot()).toMatchObject({ status: 'ready', available: true, enabled: false, active: false });
  });

  it('désactivation : sources coupées, VO à plein, mémoire libérée', async () => {
    const s = await playingAt(4, { manifest: manifestOf('ready', [chunk(0, 0, 120, [[3, 10]]), chunk(1, 120, 240)]) });
    expect(s.player.decodedChunks()).toHaveLength(2);
    s.player.setEnabled(false);
    expect(s.ctx.live).toHaveLength(0);
    expect(s.ctx.routed!.gain.valueAt(s.ctx.currentTime + 1)).toBe(1);
    expect(s.player.decodedChunks()).toHaveLength(0);
    expect(s.ctx.state).toBe('running'); // la VO routée traverse toujours le contexte
  });

  it('destruction : écouteurs retirés, contexte fermé si la vidéo a quitté la page', async () => {
    const s = await playingAt(30);
    s.video.isConnected = false;
    s.player.destroy();
    expect(s.video.listenerCount()).toBe(0);
    expect(s.ctx.closed).toBe(true);
  });

  it('un lecteur recréé sur la même vidéo réutilise contexte et routage', async () => {
    const s = await playingAt(30);
    s.player.destroy(); // vidéo toujours dans la page : contexte gardé
    expect(s.ctx.closed).toBe(false);
    const again = new DubPlayer({
      video: s.video,
      manifestUrl: URL_BASE,
      createAudioContext: () => {
        throw new Error('ne doit pas être rappelé');
      },
      fetch: s.fetchFn as unknown as FetchLike,
    });
    again.setEnabled(true);
    again.unlock();
    await flush();
    await flush();
    expect(s.ctx.mediaSources).toBe(1);
    expect(s.ctx.live.length).toBeGreaterThan(0);
    again.destroy();
  });

  it('manifeste rafraîchi toutes les 30 s avec ?t= : les nouvelles tranches sont jouées', async () => {
    const s = await playingAt(30, { manifest: manifestOf('running', []) });
    expect(s.player.getSnapshot().hint).toBe('en préparation…');
    expect(s.ctx.live).toHaveLength(0);
    s.setManifest(manifestOf('running', [chunk(0, 0, 120)]));
    await s.advance(30);
    expect(s.requests.filter((u) => u.startsWith(`${URL_BASE}?t=`))).toHaveLength(2);
    expect(s.requests).toContain(`${URL_BASE}?t=60`);
    await flush();
    expect(s.ctx.live.length).toBeGreaterThan(0);
    expect(s.player.getSnapshot()).toMatchObject({ active: true, hint: null });
  });

  it('VF doublée non choisie : guet de la disponibilité toutes les 60 s, arrêté une fois prête', async () => {
    const s = setup({ manifest: manifestOf('none', []) });
    await flush();
    expect(s.player.getSnapshot().available).toBe(false);
    s.setManifest(manifestOf('ready', [chunk(0, 0, 120)]));
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(s.player.getSnapshot().available).toBe(true);
    expect(s.requests).toEqual([URL_BASE, URL_BASE]);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(s.requests).toHaveLength(2);
  });

  it('au plus 3 tranches décodées en mémoire', async () => {
    const chunks = [0, 1, 2, 3, 4, 5].map((i) => chunk(i, i * 120, (i + 1) * 120));
    const s = await playingAt(10, { manifest: manifestOf('ready', chunks) });
    for (const t of [130, 250, 370, 490, 610, 10]) {
      s.video.seek(t);
      await flush();
      await flush();
      expect(s.player.decodedChunks().length).toBeLessThanOrEqual(3);
    }
    // La tranche à la position et la suivante sont bien là.
    expect(s.player.decodedChunks()).toEqual(expect.arrayContaining([chunks[0].url, chunks[1].url]));
  });
});
