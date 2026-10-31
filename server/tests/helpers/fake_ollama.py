#!/usr/bin/env python3
"""Faux binaire `ollama serve` (copie de tests/helpers/fakeOllama.mjs) :
/api/version, /api/show (modèle absent), /api/pull en flux."""
import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

host, port = (os.environ.get("OLLAMA_HOST") or "127.0.0.1:11434").split(":")
state = {"pulled": False}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def reply(self, status, chunks):
        self.send_response(status)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for c in chunks:
            data = c.encode()
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()
        self.wfile.write(b"0\r\n\r\n")

    def do_GET(self):
        self.handle_any()

    def do_POST(self):
        self.handle_any()

    def handle_any(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode() if n else ""
        if self.path == "/api/version":
            return self.reply(200, [json.dumps({"version": "0.0.0-test", "home": os.environ.get("HOME"),
                                                "parallel": os.environ.get("OLLAMA_NUM_PARALLEL"),
                                                "models": os.environ.get("OLLAMA_MODELS"),
                                                "context": os.environ.get("OLLAMA_CONTEXT_LENGTH"),
                                                "keep": os.environ.get("OLLAMA_KEEP_ALIVE")})])
        if self.path == "/api/show":
            return self.reply(200 if state["pulled"] else 404, ["{}" if state["pulled"] else '{"error":"model not found"}'])
        if self.path == "/api/pull":
            model = json.loads(body)["model"]
            if model == "inconnu":
                return self.reply(200, [json.dumps({"error": "pull model manifest: file does not exist"}) + "\n"])
            state["pulled"] = True
            return self.reply(200, [
                json.dumps({"status": "pulling manifest"}) + "\n",
                json.dumps({"status": "pulling", "completed": 2e6, "total": 4e6}) + "\n",
                json.dumps({"status": "pulling", "completed": 4e6, "total": 4e6}) + "\n",
                json.dumps({"status": "success"}) + "\n",
            ])
        self.reply(404, [])


signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
print("library=cpu", file=sys.stderr, flush=True)
ThreadingHTTPServer((host, int(port)), H).serve_forever()
