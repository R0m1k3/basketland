/** Appels JSON des formulaires d'authentification et de paramètres (côté navigateur). */

export type PostResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * POST JSON sur une route de l'application. Le message d'erreur renvoyé par
 * le serveur (déjà en français) est remonté tel quel.
 */
export async function postJson<T = Record<string, unknown>>(url: string, body: unknown): Promise<PostResult<T>> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, error: data.error || `Erreur ${res.status}` };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Serveur injoignable. Vérifiez votre connexion.' };
  }
}

/** Déconnexion puis retour à la page de connexion (rechargement complet). */
export async function logout(): Promise<void> {
  await postJson('/api/auth/logout', {});
  window.location.assign('/login');
}
