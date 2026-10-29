import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import { readdirSync } from 'node:fs';

const worker = await createWorker('eng');
await worker.setParameters({
  tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ',
});

const files = readdirSync('/tmp')
  .filter((f) => f.startsWith('sb_') && f.endsWith('.png'))
  .sort((a, b) => Number(a.slice(3, -4)) - Number(b.slice(3, -4)));

for (const f of files) {
  const ts = f.slice(3, -4);
  const path = `/tmp/${f}`;
  const meta = await sharp(path).metadata();
  const w = meta.width;
  const h = meta.height;
  // Recadrage du scoreboard : bas-centre (identique au réglage de ocr.ts)
  const crop = await sharp(path)
    .extract({
      left: Math.round(w * 0.25),
      top: Math.round(h * 0.82),
      width: Math.round(w * 0.5),
      height: Math.round(h * 0.16),
    })
    .resize({ width: 1400 })
    .grayscale()
    .threshold(150)
    .png()
    .toBuffer();
  const { data } = await worker.recognize(crop);
  console.log(`  ${String(ts).padStart(6)}s  ${(data.text || '').replace(/\s+/g, ' ').trim().slice(0, 60)}`);
}
await worker.terminate();
