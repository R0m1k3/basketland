'use client';

/**
 * Données des pages (étape 8b) : chaque page est un fichier statique qui lit
 * ses données dans `GET /api/pages/…` (serveur Rust, voir
 * docs/migration-rust.md, « Données des pages »).
 *
 * - 401 (session expirée depuis le chargement) : retour à la connexion, avec
 *   la page actuelle en `next`, comme le faisait le middleware ;
 * - 404 : interface « introuvable » de Next (`notFound()` d'avant) ;
 * - `reload()` remplace `router.refresh()`, sans effet sur une page
 *   statique : les données sont relues, l'affichage reste en place pendant
 *   ce temps et les composants client gardent leur état.
 */
import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import NotFound from '@/app/not-found';

type Loaded<T> = { url: string; data: T };

type State<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; loaded: Loaded<T> }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

/** Erreur réseau ou serveur (502 : application Node injoignable…). */
class LoadError extends Error {}

/** Connexion requise : même cible que `decideAccess` (le paramètre `_rsc` en moins). */
export function goToLogin(): void {
  const { pathname, search } = window.location;
  const params = new URLSearchParams(search);
  params.delete('_rsc');
  const qs = params.toString();
  const target = pathname + (qs ? `?${qs}` : '');
  window.location.replace(target === '/' ? '/login' : `/login?next=${encodeURIComponent(target)}`);
}

type Outcome<T> = { kind: 'ok'; data: T } | { kind: 'not-found' } | { kind: 'login' };

async function fetchPage<T>(url: string): Promise<Outcome<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } });
  } catch {
    throw new LoadError('Serveur injoignable. Vérifiez votre connexion.');
  }
  // Corps toujours lu, même en erreur : la requête est alors bien terminée.
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (res.status === 401) return { kind: 'login' };
  if (res.status === 404) return { kind: 'not-found' };
  if (!res.ok || body === null) throw new LoadError(body?.error ?? `Erreur ${res.status}`);
  return { kind: 'ok', data: body };
}

const ReloadContext = createContext<() => void>(() => {});

/** Relit les données de la page affichée (à la place de `router.refresh()`). */
export function useReloadPage(): () => void {
  return useContext(ReloadContext);
}

/**
 * Données de `url`. Quand `url` change (autre jour, autre match), l'ancien
 * affichage reste jusqu'à l'arrivée des nouvelles données, comme une
 * navigation de Next vers une page serveur.
 */
export function usePageData<T>(url: string): { state: State<T>; reload: () => void; retry: () => void } {
  const [state, setState] = useState<State<T>>({ kind: 'loading' });
  const seq = useRef(0);
  const current = useRef(url);
  current.current = url;

  const load = useCallback(async (target: string, quiet: boolean) => {
    const n = ++seq.current;
    try {
      const r = await fetchPage<T>(target);
      if (n !== seq.current) return;
      if (r.kind === 'login') goToLogin();
      else if (r.kind === 'not-found') setState({ kind: 'not-found' });
      else setState({ kind: 'ready', loaded: { url: target, data: r.data } });
    } catch (e) {
      if (n !== seq.current) return;
      // Rechargement en arrière-plan : on garde ce qui est affiché.
      if (quiet) return;
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void load(url, false);
  }, [url, load]);

  const reload = useCallback(() => {
    void load(current.current, true);
  }, [load]);
  const retry = useCallback(() => {
    void load(current.current, false);
  }, [load]);

  return { state, reload, retry };
}

/** Pendant le premier chargement : rien, sinon la place de la page. */
function Pending() {
  return <div aria-busy="true" className="min-h-[60vh]" />;
}

function LoadFailed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="panel-soft flex flex-col items-center gap-4 px-6 py-14 text-center" role="alert">
      <p className="max-w-md text-paper-mute">Impossible de charger la page : {message}</p>
      <button type="button" className="btn" onClick={retry}>
        Réessayer
      </button>
    </div>
  );
}

/**
 * Charge `url` et rend `children(data)`. Le contenu est remonté à chaque
 * nouvelle URL (autre match, autre jour…), comme le segment d'une page
 * serveur de Next ; il reste monté lors d'un `reload()`.
 */
export function PageData<T>({ url, children }: { url: string; children: (data: T) => ReactNode }) {
  const { state, reload, retry } = usePageData<T>(url);
  if (state.kind === 'loading') return <Pending />;
  if (state.kind === 'not-found') {
    // `noindex` : posé par Next lui-même avec un vrai 404 (fichier 404.html).
    return (
      <>
        <meta name="robots" content="noindex" />
        <NotFound />
      </>
    );
  }
  if (state.kind === 'error') return <LoadFailed message={state.message} retry={retry} />;
  return (
    <ReloadContext.Provider value={reload}>
      <Fragment key={state.loaded.url}>{children(state.loaded.data)}</Fragment>
    </ReloadContext.Provider>
  );
}

/**
 * Titre (gabarit `'%s · BasketLand'` du layout) et description d'une page
 * dont les métadonnées dépendent des données (ex-`generateMetadata`). Au
 * démontage, les valeurs précédentes reviennent, sauf si la page suivante a
 * déjà posé les siennes.
 */
export function useDocumentMeta(title: string | null, description?: string | null): void {
  useEffect(() => {
    if (title === null) return;
    const prevTitle = document.title;
    const full = `${title} · BasketLand`;
    document.title = full;
    const meta = description ? document.querySelector<HTMLMetaElement>('meta[name="description"]') : null;
    const prevDesc = meta?.content;
    if (meta && description) meta.content = description;
    return () => {
      if (document.title === full) document.title = prevTitle;
      if (meta && prevDesc !== undefined && meta.content === description) meta.content = prevDesc;
    };
  }, [title, description]);
}
