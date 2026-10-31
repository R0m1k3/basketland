#!/usr/bin/env python3
"""Faux processus Whisper (même protocole que scripts/whisper_worker.py).

Copie de tests/helpers/fakeWhisperWorker.mjs ; chaque requête reçue est en
plus recopiée telle quelle (ligne brute) dans $FAKE_LOG, et l'environnement
utile dans $FAKE_LOG.env, pour vérifier le protocole exact.
"""
import json
import os
import sys

args = sys.argv[1:]
model = args[args.index("--model") + 1]
log = os.environ.get("FAKE_LOG")
if log:
    with open(log + ".env", "w") as f:
        json.dump({"argv": args, "HF_HOME": os.environ.get("HF_HOME"), "PYTHONUNBUFFERED": os.environ.get("PYTHONUNBUFFERED"),
                   "LD_LIBRARY_PATH": os.environ.get("LD_LIBRARY_PATH"), "pid": os.getpid()}, f)


def send(o):
    sys.stdout.write(json.dumps(o, ensure_ascii=False) + "\n")
    sys.stdout.flush()


print("[whisper] chargement du faux modèle", file=sys.stderr, flush=True)
if model == "casse":
    send({"event": "error", "error": "modèle introuvable"})
    sys.exit(1)
if model == "meurt":
    print("trace 1\ntrace 2", file=sys.stderr, flush=True)
    sys.exit(3)
send({"event": "ready", "device": "cpu", "model": model})
for line in sys.stdin:
    if log:
        with open(log, "a") as f:
            f.write(line)
    req = json.loads(line)
    if req["file"].endswith("lent.ogg"):
        continue  # ne répond jamais (interruption)
    if req["file"].endswith("erreur.ogg"):
        send({"id": req["id"], "ok": False, "error": "fichier illisible"})
        continue
    result = {
        "text": "Curry pulls up. Bang!",
        "segments": [{"id": 0, "start": 0, "end": 2, "text": " Curry pulls up. Bang!", "avg_logprob": -0.2, "no_speech_prob": 0.01, "compression_ratio": 1.1}],
        "words": [
            {"word": " Curry", "start": 0, "end": 0.4},
            {"word": " pulls", "start": 0.4, "end": 0.8},
            {"word": " up.", "start": 0.8, "end": 1.2},
            {"word": " Bang!", "start": 1.4, "end": 2},
        ],
    }
    send({"id": req["id"], "ok": True, "result": result, "prompt": req.get("prompt")})
