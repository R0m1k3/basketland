/**
 * Scan OCR du scoreboard autour d'une position video_ts.
 *
 * But : vérifier que la VF annonce un panier à l'instant où le score
 * change réellement à l'écran. On échantillonne toutes les secondes sur
 * une fenêtre et on lit le scoreboard (équipes + score) par OCR.
 */
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';

const API = 'http://localhost:3000';
const OK = process.argv[2] || '16638381853356';
const CENTER = Number(process.argv[3] || 1005.8);
const SPAN = Number(process.argv[4] || 14);

async function fetchBuf(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length > 1000) return b;
    } catch (e) {
      if (i === tries - 1) throw e;
    }
  }
  throw new Error('echec lecture');
}

const pl = await (await fetch(`${API}/api/video/${OK}/playlist.m3u8?v=sd`)).text();
const lines = pl.split('\n').map((l) => l.trim()).filter(Boolean);
const durs = [];
const segs = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('#EXTINF:')) {
    durs.push(Number(lines[i].split(':')[1].split(',')[0]));
    segs.push(lines[i + 1]);
  }
}
const cum = [0];
for (const d of durs) cum.push(cum[cum.length - 1] + d);

function segFor(vt) {
  for (let i = 0; i < cum.length - 1; i++) if (cum[i] <= vt && vt < cum[i + 1]) return i;
  return segs.length - 1;
}

const worker = await createWorker('eng');
await worker.setParameters({ tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ' });

const from = Math.max(0, CENTER - SPAN / 2);
const to = CENTER + SPAN / 2;
console.log(`  scan de ${from.toFixed(1)}s a ${to.toFixed(1)}s`);

for (let t = from; t <= to; t += 2) {
  const i = segFor(t);
  const off = t - cum[i];
  const name = new URL(segs[i], 'http://x').searchParams.get('s');
  let buf;
  try {
    buf = await fetchBuf(`${API}/api/video/${OK}/segment.ts?v=sd&s=${name}`);
  } catch (e) {
    console.log(`  ${t.toFixed(1).padStart(7)}s  LECTURE KO`);
    continue;
  }
  // Recadrage du scoreboard : bas-centre, comme mesur�� dans ocr.ts
  const meta = await sharp(buf).metadata();
  const left = Math.round(meta.width * 0.25);
  const width = Math.round(meta.width * 0.5);
  const top = Math.round(meta.height * 0.82);
  const height = Math.round(meta.height * 0.16);
  const crop = await sharp(buf)
    .extract({ left, top, width, height })
    .resize({ width: 1200 })
    .grayscale()
    .threshold(140)
    .png()
    .toBuffer();
  const { data } = await worker.recognize(crop);
  const txt = (data.text || '').replace(/\s+/g, ' ').trim();
  console.log(`  ${t.toFixed(1).padStart(7)}s  ${txt.slice(0, 70)}`);
}
await worker.terminate();
