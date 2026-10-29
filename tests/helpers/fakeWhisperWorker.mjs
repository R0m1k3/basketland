// Faux processus Whisper (même protocole que scripts/whisper_worker.py).
import readline from 'node:readline';
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
if (model === 'casse') {
  process.stdout.write(JSON.stringify({ event: 'error', error: 'modèle introuvable' }) + '\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ event: 'ready', device: 'cpu', model }) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.file.endsWith('erreur.ogg')) {
    process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: 'fichier illisible' }) + '\n');
    return;
  }
  const result = {
    text: 'Curry pulls up. Bang!',
    segments: [{ id: 0, start: 0, end: 2, text: ' Curry pulls up. Bang!', avg_logprob: -0.2, no_speech_prob: 0.01, compression_ratio: 1.1 }],
    words: [
      { word: ' Curry', start: 0, end: 0.4 },
      { word: ' pulls', start: 0.4, end: 0.8 },
      { word: ' up.', start: 0.8, end: 1.2 },
      { word: ' Bang!', start: 1.4, end: 2 },
    ],
  };
  process.stdout.write(JSON.stringify({ id: req.id, ok: true, result, prompt: req.prompt }) + '\n');
});
