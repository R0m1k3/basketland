import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

/**
 * Passe un processus de tâche lourde (ffmpeg d'extraction, Whisper, Ollama,
 * OCR) en priorité CPU basse (`nice`, `BACKGROUND_NICE`, 10 par défaut) : la
 * lecture vidéo (proxy HLS, servi par Node) garde la main quand le
 * processeur du NAS sature. Sans effet si le système le refuse.
 */
export function lowerPriority(child: ChildProcess): void {
  const n = Number(process.env.BACKGROUND_NICE);
  const nice = Number.isFinite(n) ? Math.max(0, Math.min(19, Math.trunc(n))) : 10;
  if (!child.pid || nice === 0) return;
  try {
    os.setPriority(child.pid, nice);
  } catch {
    /* plateforme ou droits : on laisse la priorité par défaut */
  }
}
