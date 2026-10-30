/**
 * Moteur de voix (Qwen3-TTS) — EN ATTENTE : remplacé par l'implémentation
 * complète (worker Python embarqué) dans le commit suivant. En attendant, le
 * doublage se déclare inactif.
 */
export interface VoiceConfig {
  disabledReason?: string;
}

export function voiceConfig(): VoiceConfig {
  return { disabledReason: 'moteur de voix pas encore installé' };
}

export class VoiceSession {
  readonly voices: string[] = [];
  static async open(): Promise<VoiceSession> {
    throw new Error('moteur de voix pas encore installé');
  }
  async synth(): Promise<{ duration: number; sampleRate: number }> {
    throw new Error('moteur de voix pas encore installé');
  }
  async embed(): Promise<{ embeddings: (number[] | null)[]; f0: (number | null)[] }> {
    throw new Error('moteur de voix pas encore installé');
  }
  async close(): Promise<void> {}
}
