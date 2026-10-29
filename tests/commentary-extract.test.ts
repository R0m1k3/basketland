/**
 * Extraction audio réelle avec ffmpeg (sautée si ffmpeg ou libopus manque) :
 * un tronçon lu au milieu d'un fichier source, mono 16 kHz Opus, de la durée
 * demandée.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractAudioChunk } from '../src/lib/commentary';

const ff = process.env.FFMPEG_PATH || 'ffmpeg';
const hasOpus = (() => {
  try {
    const r = spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 && /libopus/.test(r.stdout) && spawnSync('ffprobe', ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
})();

function probe(file: string): { duration: number; rate: number; channels: number; codec: string } {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout) as { streams: { codec_name: string; sample_rate: string; channels: number }[]; format: { duration: string } };
  return { duration: Number(j.format.duration), rate: Number(j.streams[0].sample_rate), channels: j.streams[0].channels, codec: j.streams[0].codec_name };
}

describe.skipIf(!hasOpus)('extractAudioChunk (ffmpeg réel)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-extract-'));
  const src = path.join(dir, 'source.mp4');
  spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30:sample_rate=44100', '-ac', '2', '-c:a', 'aac', '-y', src]);

  it('extrait [10 s, 18 s] en Opus mono 16 kHz', async () => {
    const out = path.join(dir, 'chunk-000.ogg');
    await extractAudioChunk(src, 10, 8, out);
    expect(fs.existsSync(`${out}.part`)).toBe(false);
    const p = probe(out);
    expect(p).toMatchObject({ codec: 'opus', channels: 1 });
    // Opus est décodé à 48 kHz : ffprobe annonce 48000 même pour une entrée 16 kHz.
    expect([16000, 48000]).toContain(p.rate);
    expect(Math.abs(p.duration - 8)).toBeLessThan(0.5);
  });

  it('dernier tronçon demandé au-delà de la fin : s’arrête à la fin du flux', async () => {
    const out = path.join(dir, 'chunk-001.ogg');
    await extractAudioChunk(src, 25, 60, out);
    expect(Math.abs(probe(out).duration - 5)).toBeLessThan(0.5);
  });

  it('source illisible : erreur, aucun fichier laissé', async () => {
    const out = path.join(dir, 'chunk-002.ogg');
    await expect(extractAudioChunk(path.join(dir, 'absent.mp4'), 0, 10, out)).rejects.toThrow(/ffmpeg audio @0s code/);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(`${out}.part`)).toBe(false);
  });
});
