#!/usr/bin/env node
// Faux binaire `ollama serve` : /api/version, /api/show (modèle absent), /api/pull en flux.
import http from 'node:http';
const [host, port] = (process.env.OLLAMA_HOST || '127.0.0.1:11434').split(':');
let pulled = false;
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.0.0-test', home: process.env.HOME }));
      if (req.url === '/api/show') {
        res.statusCode = pulled ? 200 : 404;
        return res.end(pulled ? '{}' : '{"error":"model not found"}');
      }
      if (req.url === '/api/pull') {
        const { model } = JSON.parse(body);
        if (model === 'inconnu') return res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\n');
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        res.write(JSON.stringify({ status: 'pulling', completed: 2e6, total: 4e6 }) + '\n');
        res.write(JSON.stringify({ status: 'pulling', completed: 4e6, total: 4e6 }) + '\n');
        pulled = true;
        return res.end(JSON.stringify({ status: 'success' }) + '\n');
      }
      res.statusCode = 404;
      res.end();
    });
  })
  .listen(Number(port), host);
process.on('SIGTERM', () => process.exit(0));
