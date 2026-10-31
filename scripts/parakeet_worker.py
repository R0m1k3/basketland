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


def _dir_bytes(path: str) -> int:
    """Taille des fichiers du dossier, liens suivis mais comptés une fois
    (cache Hugging Face : snapshots/ et blobs/ pointent vers les mêmes données)."""
    seen = set()
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            real = os.path.realpath(os.path.join(root, f))
            if real in seen:
                continue
            seen.add(real)
            try:
                total += os.path.getsize(real)
            except OSError:
                pass
    return total


def model_cache_dir(model_name: str) -> str:
    """Dossier du cache Hugging Face du modèle (HF_HOME/hub/models--…)."""
    try:
        from onnx_asr.resolver import model_repos

        repo = model_repos.get(model_name, model_name)
    except Exception:
        repo = model_name
    home = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
    return os.path.join(home, "hub", "models--" + repo.replace("/", "--"))


def watch_download(cache: str):
    """Journalise la taille téléchargée toutes les 10 s, jusqu'à `stop.set()`
    (les barres de progression de Hugging Face, faites de retours chariot,
    ne passent pas dans les journaux ligne à ligne)."""
    import threading
    import time

    stop = threading.Event()
    start = time.monotonic()

    def run():
        last = -1
        while not stop.wait(10):
            mb = _dir_bytes(cache) // 1_000_000
            if mb != last:
                log(f"téléchargement du modèle : {mb} Mo reçus ({int(time.monotonic() - start)} s)")
                last = mb

    threading.Thread(target=run, daemon=True).start()
    return stop


def quantization_for(dev: str) -> str:
    """Sur processeur, int8 (deux à trois fois plus rapide) ; sur GPU, le
    modèle d'origine (int8 n'y gagne rien et dégrade un peu la précision).
    `PARAKEET_QUANTIZATION` : `auto` (défaut), `int8` ou `fp32`. "" = fp32."""
    quantization = (os.environ.get("PARAKEET_QUANTIZATION") or "auto").strip().lower()
    if quantization == "auto":
        return "int8" if dev == "cpu" else ""
    return "" if quantization == "fp32" else quantization


def with_download_log(model_name: str, dev: str, q: str, fetch, *, prefetching: bool = False):
    """Exécute `fetch()` en journalisant le téléchargement du modèle s'il
    n'est pas encore dans le cache (taille reçue toutes les 10 s)."""
    cache = model_cache_dir(model_name)
    # Déjà téléchargé dans la précision voulue (int8 : `*.int8.onnx`).
    want = (lambda f: f.endswith(f".{q}.onnx")) if q else (lambda f: f.endswith(".onnx") and ".int8." not in f)
    cached = any(want(f) for _, _, fs in os.walk(cache) for f in fs)
    if not cached:
        log(f"téléchargement de {model_name} ({q or 'fp32'}, pour {dev}) depuis Hugging Face vers {cache}…")
    elif prefetching:
        log(f"{model_name} ({q or 'fp32'}) déjà téléchargé dans {cache}")
    else:
        log(f"chargement de {model_name} sur {dev} ({q or 'fp32'}) depuis {cache}")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    stop = None if cached else watch_download(cache)
    try:
        return fetch()
    finally:
        if stop is not None:
            stop.set()
        if not cached:
            log(f"modèle présent dans le cache ({_dir_bytes(cache) // 1_000_000} Mo)")


def prefetch(model_name: str, device: str) -> int:
    """Télécharge seulement les fichiers du modèle (et du VAD) dans la
    précision qu'utilisera la transcription, sans rien charger sur le GPU :
    lancé dès que le moteur NVIDIA est choisi, pour que la première
    traduction n'attende pas le téléchargement."""
    from onnx_asr.loader import create_asr_resolver, create_vad_resolver

    _, dev = providers_for(device)
    q = quantization_for(dev)
    with_download_log(
        model_name,
        dev,
        q,
        lambda: create_asr_resolver(model_name).resolve_model(quantization=q or None),
        prefetching=True,
    )
    create_vad_resolver("silero").resolve_model()
    log(f"modèle {model_name} prêt pour la transcription ({q or 'fp32'}, {dev})")
    return 0


def load(model_name: str, device: str):
    import onnx_asr

    providers, dev = providers_for(device)
    q = quantization_for(dev)
    model = with_download_log(
        model_name, dev, q, lambda: onnx_asr.load_model(model_name, quantization=q or None, providers=providers)
    )
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
    ap.add_argument("--prefetch", action="store_true", help="télécharger le modèle puis quitter")
    args, _ = ap.parse_known_args()
    if args.prefetch:
        try:
            return prefetch(args.model, args.device)
        except Exception as e:
            log(f"téléchargement du modèle {args.model} impossible : {e}")
            traceback.print_exc()
            return 1
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
