/**
 * Client HTTP commun : User-Agent navigateur (obligatoire pour ok.ru, dont les URLs
 * signées portent `srcAg=CHROME`), timeout et retries.
 */
export const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
  ) {
    super(`HTTP ${status} pour ${url}`);
  }
}

export interface FetchOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /**
   * 'follow' (défaut) : les redirections sont suivies automatiquement.
   * 'manual' : la réponse 3xx est RENDUE à l'appelant, qui peut alors
   * vérifier la destination avant de la suivre. Indispensable pour une
   * defense anti-SSRF : en 'follow', le trafic atteint déjà l'hôte
   * redirectionné avant qu'on puisse le refuser.
   */
  redirect?: 'follow' | 'manual';
}

export async function fetchWithRetry(url: string, opts: FetchOpts = {}): Promise<Response> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9', ...opts.headers },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        redirect: opts.redirect ?? 'follow',
        cache: 'no-store',
      });
      if (res.status >= 500 && attempt < retries) {
        lastErr = new HttpError(res.status, url);
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await fetchWithRetry(url, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}

/** Limiteur de débit simple : au plus une requête toutes les `intervalMs`. */
export function createRateLimiter(intervalMs: number) {
  let next = 0;
  let chain: Promise<void> = Promise.resolve();
  return function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(async () => {
      const wait = next - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      next = Date.now() + intervalMs;
    });
    chain = p.catch(() => undefined);
    return p.then(fn);
  };
}

/** Décodage minimal des entités HTML. */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}
