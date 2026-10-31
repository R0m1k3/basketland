#!/usr/bin/env python3
"""Faux moteur de voix (même protocole que scripts/voice_worker.py).

Copie de tests/helpers/fakeVoiceWorker.mjs ; les requêtes reçues sont en
plus recopiées dans $FAKE_LOG (lignes brutes) et l'environnement utile dans
<dossier des voix>/../worker.env.
"""
import json
import os
import sys
import time

args = sys.argv[1:]


def arg(name):
    return args[args.index(name) + 1] if name in args else None


model = arg("--model")
voices_dir = arg("--voices-dir")
log = os.environ.get("FAKE_LOG")


def send(o):
    sys.stdout.write(json.dumps(o, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if "--download-only" in args:
    hf = os.environ.get("HF_HOME")
    print(f"[voix] téléchargement du modèle {model} (HF_HOME {hf})", file=sys.stderr, flush=True)
    print("trace Python à ne pas journaliser", file=sys.stderr, flush=True)
    if model == "casse":
        send({"event": "error", "error": "téléchargement des modèles de voix impossible : réseau coupé"})
        sys.exit(1)
    send({"event": "progress", "done": 1_000_000_000, "total": 2_500_000_000})
    go = os.path.join(hf, "go")
    while not os.path.exists(go):
        time.sleep(0.02)
    send({"event": "downloaded"})
    sys.exit(0)

base = os.path.dirname(voices_dir)
with open(os.path.join(base, "worker.pid"), "w") as f:
    f.write(str(os.getpid()))
with open(os.path.join(base, "worker.env"), "w") as f:
    json.dump({"argv": args, "HF_HOME": os.environ.get("HF_HOME"), "OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS"),
               "MKL_NUM_THREADS": os.environ.get("MKL_NUM_THREADS")}, f)
print(f"chargement de {model} (download-root {arg('--download-root')}, HF_HOME {os.environ.get('HF_HOME')})", file=sys.stderr, flush=True)

if model == "casse":
    send({"event": "error", "error": "modèle introuvable"})
    sys.exit(1)
if model == "muet":
    while True:
        time.sleep(1)

order = ["A", "B4", "B1", "F"]
if "--embed-only" in args:
    voices = []
else:
    voices = sorted((v for v in os.listdir(voices_dir) if os.path.exists(os.path.join(voices_dir, v, "reference.wav"))),
                    key=lambda v: order.index(v) if v in order else -1)
if model == "lent-mais-vivant":
    for n in range(1, 7):
        time.sleep(0.1)
        print(f"[voix] téléchargement : {n * 10} %", file=sys.stderr, flush=True)
sys.stdout.write("ligne parasite qui n’est pas du JSON\n")
send({"event": "ready", "device": "cpu", "model": model, "voices": voices})

for line in sys.stdin:
    if log:
        with open(log, "a") as f:
            f.write(line)
    req = json.loads(line)
    if req["op"] == "synth":
        if req["text"] == "lent":
            continue
        if req["voice"] not in voices:
            send({"id": req["id"], "ok": False, "error": f"voix inconnue : {req['voice']}"})
            continue
        if "erreur" in req["text"]:
            send({"id": req["id"], "ok": False, "error": "synthèse ratée après 2 essais : plafond de 60 trames atteint"})
            continue
        with open(req["out"], "w") as f:
            f.write(f"RIFF {req['voice']} {req['language']} {req['text']}")
        send({"id": req["id"], "ok": True, "duration": round(len(req["text"]) / 15, 3), "sample_rate": 24000})
        continue
    if req["op"] == "embed":
        if not os.path.exists(req["file"]):
            send({"id": req["id"], "ok": False, "error": f"fichier audio introuvable : {req['file']}"})
            continue
        segs = req["segments"]
        emb = [[1 if i == 0 else 0 for i in range(192)] if b - a >= 0.4 else None for a, b in segs]
        f0 = [118.5 if b - a >= 0.25 else None for a, b in segs]
        if model == "ancien":
            send({"id": req["id"], "ok": True, "embeddings": emb, "f0": f0})
            continue
        female = [0.97 if b - a >= 4 else 0.03 if b - a >= 1 else None for a, b in segs]
        send({"id": req["id"], "ok": True, "embeddings": emb, "f0": f0, "female": female})
        continue
    send({"id": req["id"], "ok": False, "error": f"opération inconnue : {req['op']}"})
