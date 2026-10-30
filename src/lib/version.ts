/**
 * Version de l'application en service : commit et date de construction de
 * l'image Docker (`APP_COMMIT`, `APP_BUILT_AT`, posés par la CI, voir le
 * Dockerfile). Sert à vérifier qu'un serveur tourne bien sur la dernière
 * image (bas de la page Paramètres). Construite hors de la CI : null.
 */
export interface AppVersion {
  /** Commit court (7 caractères). */
  commit: string | null;
  /** Date ISO de construction de l'image. */
  builtAt: string | null;
}

export function appVersion(): AppVersion {
  const sha = process.env.APP_COMMIT?.trim();
  const built = process.env.APP_BUILT_AT?.trim();
  return {
    commit: sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : null,
    builtAt: built && Number.isFinite(Date.parse(built)) ? new Date(built).toISOString() : null,
  };
}
