#!/usr/bin/env python3
"""
Transcription embarquée par NVIDIA Parakeet TDT (moteur « NVIDIA » de la page
Paramètres), alternative à Whisper (scripts/whisper_worker.py), bien plus
rapide sur GPU : modèle transducteur (FastConformer-TDT) de 0,6 milliard de
paramètres, anglais, exécuté par ONNX Runtime (bibliothèque onnx-asr), sans
NeMo ni PyTorch.

Même protocole que le processus Whisper, piloté par le serveur
(server/src/media/local_ai.rs) via stdin/stdout, une requête JSON par ligne :
  → {"id": 1, "file": "/data/…/chunk-000.ogg", "language": "en", "prompt": "…", "hotwords": "…"}
  ← {"id": 1, "ok": true, "result": { verbose_json façon API OpenAI }}
`prompt` et `hotwords` sont ignorés (Parakeet ne prend pas d'amorce : les
noms des joueurs sont corrigés après coup par le serveur). Le modèle n'est
chargé qu'une fois pour tout le match.

Découpage en passages de parole par le VAD Silero (20 s au plus chacun,
traités par lots), horodatage des mots tiré de celui des jetons.
Pas d'`avg_logprob` ni de `no_speech_prob` : ces indices servent aux filtres
anti-hallucination propres à Whisper, sans objet pour un transducteur.

stdout ne porte QUE le protocole ; les journaux vont sur stderr.
"""
import argparse
import json
import os
import subprocess
import sys
import traceback

SAMPLE_RATE = 16_000


def log(msg: str) -> None:
    print(f"[parakeet] {msg}", file=sys.stderr, flush=True)


# Canal du protocole : une copie de stdout, prise avant que stdout ne soit
# renvoyé sur stderr (ONNX Runtime écrit ses erreurs de fournisseur sur stdout,
# ce qui casserait le protocole).
_PROTO = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr


def send(obj: dict) -> None:
    _PROTO.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _PROTO.flush()


def cuda_devices() -> int:
    """Cartes NVIDIA utilisables (cudaGetDeviceCount de cudart) ; 0 sans pilote."""
    import ctypes

    try:
        cudart = ctypes.CDLL("libcudart.so.12")
        n = ctypes.c_int(0)
        return n.value if cudart.cudaGetDeviceCount(ctypes.byref(n)) == 0 else 0
    except OSError:
        return 0


def providers_for(device: str):
    """Fournisseurs ONNX Runtime : GPU NVIDIA si possible, sinon processeur."""
    import onnxruntime as rt

    if device in ("auto", "cuda"):
        # cuBLAS et cuDNN viennent des paquets pip nvidia-* (environnement
        # /opt/whisper, relié) : chargés avant la création des sessions.
        try:
            rt.preload_dlls(directory="")
        except Exception as e:  # ancienne version, ou bibliothèques absentes
            log(f"préchargement des bibliothèques CUDA impossible ({e})")
        if "CUDAExecutionProvider" in rt.get_available_providers() and cuda_devices() > 0:
            return ["CUDAExecutionProvider", "CPUExecutionProvider"], "cuda"
        if device == "cuda":
            log("aucun GPU CUDA visible : repli sur le processeur")
    return ["CPUExecutionProvider"], "cpu"


def load(model_name: str, device: str):
    import onnx_asr

    providers, dev = providers_for(device)
    # Sur processeur, int8 (deux à trois fois plus rapide) ; sur GPU, le
    # modèle d'origine (int8 n'y gagne rien et dégrade un peu la précision).
    # `PARAKEET_QUANTIZATION` : `auto` (défaut), `int8` ou `fp32`.
    quantization = (os.environ.get("PARAKEET_QUANTIZATION") or "auto").strip().lower()
    if quantization == "auto":
        q = "int8" if dev == "cpu" else ""
    else:
        q = "" if quantization == "fp32" else quantization
    model = onnx_asr.load_model(model_name, quantization=q or None, providers=providers)
    vad = onnx_asr.load_vad("silero", providers=["CPUExecutionProvider"])
    try:
        batch = max(1, min(64, int(os.environ.get("PARAKEET_BATCH_SIZE") or "8")))
    except ValueError:
        batch = 8
    engine = model.with_vad(vad, batch_size=batch, max_speech_duration_s=20).with_timestamps()
    return engine, dev, q or "fp32"


def read_pcm(file: str):
    """Audio du tronçon (Opus/Ogg…) en PCM 16 kHz mono float32, par ffmpeg."""
    import numpy as np

    ffmpeg = os.environ.get("FFMPEG_PATH") or "ffmpeg"
    out = subprocess.run(
        [ffmpeg, "-v", "error", "-nostdin", "-i", file, "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"],
        capture_output=True,
        check=False,
    )
    if out.returncode != 0:
        raise RuntimeError(f"décodage audio impossible : {out.stderr.decode(errors='replace').strip()[-300:]}")
    return np.frombuffer(out.stdout, dtype=np.float32)


def words_of(seg) -> list:
    """Mots d'un passage : un jeton qui commence par une espace ouvre un mot
    (SentencePiece) ; fin d'un mot = début du jeton qui ouvre le suivant, ou fin du passage."""
    tokens = list(seg.tokens or [])
    stamps = list(seg.timestamps or [])
    words = []
    for tok, ts in zip(tokens, stamps):
        t = seg.start + float(ts)
        if not words or tok.startswith(" "):
            words.append({"word": tok if tok.startswith(" ") else " " + tok, "start": t, "end": t})
        else:
            words[-1]["word"] += tok
    for i, w in enumerate(words):
        nxt = words[i + 1]["start"] if i + 1 < len(words) else seg.end
        w["end"] = round(max(w["start"], min(nxt, seg.end)), 3)
        w["start"] = round(w["start"], 3)
    return [w for w in words if w["word"].strip()]


def to_verbose(segments, duration: float) -> dict:
    segs, words, texts = [], [], []
    for i, s in enumerate(segments):
        text = (s.text or "").strip()
        if not text:
            continue
        segs.append({"id": i, "start": round(s.start, 3), "end": round(s.end, 3), "text": " " + text})
        texts.append(text)
        words.extend(words_of(s))
    return {
        "task": "transcribe",
        "language": "en",
        "duration": duration,
        "text": " ".join(texts),
        "segments": segs,
        "words": words,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--compute-type", default="auto")
    ap.add_argument("--download-root", default="")
    args, _ = ap.parse_known_args()
    # Modèles téléchargés depuis Hugging Face (HF_HOME, posé par le serveur).
    try:
        engine, device, precision = load(args.model, args.device)
    except Exception as e:
        send({"event": "error", "error": f"chargement du modèle {args.model} impossible : {e}"})
        traceback.print_exc()
        return 1
    send({"event": "ready", "device": device, "model": args.model})
    log(f"modèle {args.model} prêt sur {device} ({precision})")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            pcm = read_pcm(req["file"])
            segments = list(engine.recognize(pcm, sample_rate=SAMPLE_RATE))
            send({"id": req_id, "ok": True, "result": to_verbose(segments, len(pcm) / SAMPLE_RATE)})
        except Exception as e:
            traceback.print_exc()
            send({"id": req_id, "ok": False, "error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
