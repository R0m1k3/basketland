/**
 * Mode « scores masqués » côté serveur.
 *
 * La préférence est gardée en localStorage (source de vérité côté client) et
 * recopiée dans un cookie pour que le serveur rende directement la bonne
 * version : aucun score ne « clignote » au chargement.
 */
import { cookies } from 'next/headers';
import { SPOILER_COOKIE, type SpoilerMode } from './spoiler-keys';

export type { SpoilerMode };

export async function spoilerMode(): Promise<SpoilerMode> {
  try {
    return (await cookies()).get(SPOILER_COOKIE)?.value === 'hide' ? 'hide' : 'show';
  } catch {
    return 'show';
  }
}
