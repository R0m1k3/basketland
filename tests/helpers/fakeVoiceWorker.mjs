// Faux moteur de voix (même protocole que scripts/voice_worker.py).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const model = arg('--model');
const voicesDir = arg('--voices-dir');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// Téléchargement seul : progression (octets) puis fin, sans GPU ni voix.
if (args.includes('--download-only')) {
  process.stderr.write(`[voix] téléchargement du modèle ${model} (HF_HOME ${process.env.HF_HOME})\n`);
  if (model === 'casse') {
    send({ event: 'error', error: 'téléchargement des modèles de voix impossible : réseau coupé' });
    process.exit(1);
  }
  send({ event: 'progress', done: 1_000_000_000, total: 2_500_000_000 });
  // Le test lit la progression, puis libère la fin en créant ce fichier.
  const go = path.join(process.env.HF_HOME, 'go');
  const t = setInterval(() => {
    if (!fs.existsSync(go)) return;
    clearInterval(t);
    send({ event: 'downloaded' });
    process.exit(0);
  }, 20);
} else {

// Le test retrouve le processus (arrêt effectif après une interruption).
fs.writeFileSync(path.join(path.dirname(voicesDir), 'worker.pid'), String(process.pid));
process.stderr.write(`chargement de ${model} (download-root ${arg('--download-root')}, HF_HOME ${process.env.HF_HOME})\n`);

if (model === 'casse') {
  send({ event: 'error', error: 'modèle introuvable' });
  process.exit(1);
}
if (model === 'muet') {
  // Ne devient jamais prêt et ne dit rien (délai de chargement).
  setInterval(() => undefined, 1000);
} else {
  const order = ['A', 'B4', 'B1', 'F'];
  // Analyse des voix seule (synthèse MiniMax) : aucune voix de synthèse.
  const voices = args.includes('--embed-only')
    ? []
    : fs
    .readdirSync(voicesDir)
    .filter((v) => fs.existsSync(path.join(voicesDir, v, 'reference.wav')))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  // Une ligne de journal par seconde pendant un « téléchargement » : le délai de chargement est relancé.
  const slow = model === 'lent-mais-vivant';
  let n = 0;
  const go = () => {
    process.stdout.write('ligne parasite qui n’est pas du JSON\n');
    send({ event: 'ready', device: 'cpu', model, voices });
  };
  if (slow) {
    const t = setInterval(() => {
      process.stderr.write(`[voix] téléchargement : ${++n * 10} %\n`);
      if (n === 6) {
        clearInterval(t);
        go();
      }
    }, 100);
  } else go();

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const req = JSON.parse(line);
    if (req.op === 'synth') {
      if (req.text === 'lent') return; // ne répond jamais (interruption)
      if (!voices.includes(req.voice)) return send({ id: req.id, ok: false, error: `voix inconnue : ${req.voice}` });
      if (req.text.includes('erreur')) return send({ id: req.id, ok: false, error: 'synthèse ratée après 2 essais : plafond de 60 trames atteint' });
      fs.writeFileSync(req.out, `RIFF ${req.voice} ${req.language} ${req.text}`);
      return send({ id: req.id, ok: true, duration: Math.round((req.text.length / 15) * 1000) / 1000, sample_rate: 24000 });
    }
    if (req.op === 'embed') {
      if (!fs.existsSync(req.file)) return send({ id: req.id, ok: false, error: `fichier audio introuvable : ${req.file}` });
      const embeddings = req.segments.map(([a, b]) => (b - a >= 0.4 ? Array.from({ length: 192 }, (_, i) => (i === 0 ? 1 : 0)) : null));
      const f0 = req.segments.map(([a, b]) => (b - a >= 0.25 ? 118.5 : null));
      // Ancien moteur : pas de champ `female`. Sinon P(femme) dès 1 s (0,97 au-delà de 4 s, une « locutrice »).
      if (model === 'ancien') return send({ id: req.id, ok: true, embeddings, f0 });
      const female = req.segments.map(([a, b]) => (b - a >= 4 ? 0.97 : b - a >= 1 ? 0.03 : null));
      return send({ id: req.id, ok: true, embeddings, f0, female });
    }
    send({ id: req.id, ok: false, error: `opération inconnue : ${req.op}` });
  });
}
}
