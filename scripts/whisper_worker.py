#!/usr/bin/env python3
"""
Transcription Whisper embarquée dans le conteneur BasketLand (faster-whisper).

Processus de travail piloté par Node (src/lib/localAi.ts) via stdin/stdout,
une requête JSON par ligne :
  → {"id": 1, "file": "/data/…/chunk-000.ogg", "language": "en", "prompt": "…"}
  ← {"id": 1, "ok": true, "result": { verbose_json façon API OpenAI }}
Avec `"voices": true`, le résultat porte aussi `voices` : l'empreinte de la
voix de chaque prise de parole (voir `voice_turns`), pour reconnaître les
commentateurs et donner une couleur à chacun.
Le modèle n'est chargé qu'une fois pour tout le match ; Node arrête le
processus à la fin de la transcription, ce qui libère la mémoire du GPU pour
la traduction.

stdout ne porte QUE le protocole ; les journaux vont sur stderr.
"""
import argparse
import json
import os
import sys
import traceback


def log(msg: str) -> None:
    print(f"[whisper] {msg}", file=sys.stderr, flush=True)


def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_model(name: str, device: str, compute_type: str, download_root: str):
    from faster_whisper import WhisperModel

    def make(dev: str, ct: str):
        return WhisperModel(name, device=dev, compute_type=ct, download_root=download_root or None)

    if device in ("auto", "cuda"):
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                # float16 : pleine précision du modèle (~1,6 Go de VRAM pour
                # turbo, ~3 Go pour large-v3) ; int8_float16 (WHISPER_COMPUTE_TYPE)
                # économise la moitié de la mémoire, au prix d'un peu de justesse.
                return make("cuda", "float16" if compute_type == "auto" else compute_type), "cuda"
            if device == "cuda":
                log("aucun GPU CUDA visible : repli sur le processeur")
        except Exception as e:  # bibliothèques CUDA absentes ou pilote trop ancien
            log(f"GPU inutilisable ({e}) : repli sur le processeur")
    return make("cpu", "int8" if compute_type == "auto" else compute_type), "cpu"


def env_float(name: str, default: float, lo: float, hi: float) -> float:
    try:
        return max(lo, min(hi, float(os.environ.get(name) or default)))
    except ValueError:
        log(f"{name} invalide : {default} utilisé")
        return default


def vad_parameters() -> dict:
    """
    Détection de la parole (Silero VAD) réglée pour un commentaire sportif :
    la voix est couverte par le public et la musique, le seuil par défaut
    (0,5) écarte des passages entiers comme « pas de parole ».
    `WHISPER_VAD_THRESHOLD` (0,35) : probabilité de parole minimale ;
    `WHISPER_VAD_MIN_SILENCE_MS` (1000) : silence qui sépare deux passages ;
    `WHISPER_VAD_PAD_MS` (400) : marge gardée autour de chaque passage.
    """
    return {
        "threshold": env_float("WHISPER_VAD_THRESHOLD", 0.35, 0.05, 0.95),
        "min_silence_duration_ms": int(env_float("WHISPER_VAD_MIN_SILENCE_MS", 1000, 100, 10000)),
        "speech_pad_ms": int(env_float("WHISPER_VAD_PAD_MS", 400, 0, 2000)),
    }


def batch_size_for(device: str) -> int:
    """
    Taille des lots du mode « batched » de faster-whisper
    (`WHISPER_BATCH_SIZE`, 0 par défaut : mode séquentiel).

    Les passages de parole repérés par le VAD sont transcrits par lots au lieu
    d'un par un : bien plus rapide sur GPU, même modèle. MAIS faster-whisper
    1.2.1 désactive alors `hallucination_silence_threshold` (forcé à None dans
    BatchedInferencePipeline.transcribe) et ne retente pas d'autres
    températures : la protection contre les phrases inventées pendant les
    pauses (« Thank you »…) disparaît. Donc à activer en connaissance de cause
    (p. ex. 8 sur GPU) ; `auto` : 8 sur carte NVIDIA, 0 sur processeur.
    """
    raw = (os.environ.get("WHISPER_BATCH_SIZE") or "0").strip().lower()
    if raw == "auto":
        return 8 if device == "cuda" else 0
    try:
        return max(0, min(64, int(raw)))
    except ValueError:
        log(f"WHISPER_BATCH_SIZE invalide ({raw}) : mode séquentiel")
        return 0


# ---------------------------------------------------------------- voix
# Qui parle ? Chaque prise de parole (mots de Whisper regroupés, coupés aux
# respirations) reçoit une EMPREINTE de voix : un vecteur de 256 nombres
# calculé par un petit modèle de reconnaissance du locuteur (WeSpeaker
# ResNet34, VoxCeleb, ONNX, ~26 Mo, sur le processeur). Deux prises de
# parole d'une même personne ont des empreintes proches (cosinus ~0,6),
# celles de deux personnes différentes non (~0,1 à 0,2). Le serveur regroupe
# ensuite ces empreintes sur tout le match (src/media/voices.rs).

VOICE_REPO = "Wespeaker/wespeaker-voxceleb-resnet34-LM"
VOICE_FILE = "voxceleb_resnet34_LM.onnx"
VOICE_REVISION = "f0c48c298fd835726c27956a5d617bad7115627e"
SR = 16000
# Prise de parole : mots séparés de moins de 0,5 s, 4 s au plus (au-delà,
# découpée : un changement de voix sans pause reste repérable).
TURN_GAP = 0.5
TURN_MAX = 4.0
# Fenêtre minimale d'une empreinte : 1 s autour d'une prise de parole courte.
EMBED_MIN = 1.0


def _mel_banks(n_mels: int = 80, n_fft: int = 512, low: float = 20.0, high: float = 8000.0):
    import numpy as np

    def mel(f):
        return 1127.0 * np.log(1.0 + f / 700.0)

    pts = np.linspace(mel(low), mel(high), n_mels + 2)
    m = mel(np.arange(n_fft // 2 + 1) * SR / n_fft)
    banks = np.zeros((n_mels, n_fft // 2 + 1), np.float64)
    for i in range(n_mels):
        lo, c, hi = pts[i], pts[i + 1], pts[i + 2]
        banks[i] = np.maximum(0.0, np.minimum((m - lo) / (c - lo), (hi - m) / (hi - c)))
    return banks


def fbank(x):
    """
    Bancs de filtres Mel (80) façon Kaldi, comme à l'entraînement du modèle :
    trames de 25 ms tous les 10 ms, pré-accentuation 0,97, fenêtre de Povey,
    logarithme, moyenne de chaque bande retirée. `None` si moins d'une trame.
    """
    import numpy as np

    n = 1 + (len(x) - 400) // 160
    if n < 1:
        return None
    idx = np.arange(400)[None, :] + 160 * np.arange(n)[:, None]
    f = x[idx].astype(np.float64) * 32768.0
    f -= f.mean(axis=1, keepdims=True)
    f = np.concatenate([f[:, :1] * 0.03, f[:, 1:] - 0.97 * f[:, :-1]], axis=1)
    f *= _WINDOW
    power = np.abs(np.fft.rfft(f, 512)) ** 2
    e = np.log(np.maximum(power @ _BANKS.T, 1.1920929e-07)).astype(np.float32)
    return e - e.mean(axis=0, keepdims=True)


_BANKS = None
_WINDOW = None


class VoiceEmbedder:
    def __init__(self):
        global _BANKS, _WINDOW
        import numpy as np
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download

        _BANKS = _mel_banks()
        _WINDOW = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(400) / 399)) ** 0.85
        path = hf_hub_download(VOICE_REPO, VOICE_FILE, revision=VOICE_REVISION)
        opts = ort.SessionOptions()
        # Tâche de fond sur le NAS : deux cœurs au plus.
        opts.intra_op_num_threads = 2
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])

    def __call__(self, x):
        import numpy as np

        feats = fbank(x)
        if feats is None:
            return None
        e = self.session.run(None, {"feats": feats[None]})[0][0]
        norm = float(np.linalg.norm(e))
        return e / norm if norm > 0 else None


_embedder = None
_embedder_failed = False


def voice_embedder():
    """Modèle chargé au premier usage ; une panne (hors ligne…) n'empêche pas la transcription."""
    global _embedder, _embedder_failed
    if _embedder is None and not _embedder_failed:
        try:
            _embedder = VoiceEmbedder()
            log("empreintes de voix prêtes")
        except Exception as e:
            _embedder_failed = True
            log(f"empreintes de voix indisponibles ({e}) : sous-titres sans couleur par commentateur")
    return _embedder


def turns_of(words) -> list:
    """Prises de parole [(début, fin)] : mots proches regroupés, 4 s au plus."""
    turns = []
    for w in words:
        if turns and w["start"] - turns[-1][1] < TURN_GAP and w["end"] - turns[-1][0] <= TURN_MAX:
            turns[-1][1] = max(turns[-1][1], w["end"])
        else:
            turns.append([w["start"], w["end"]])
    return turns


def voice_turns(audio, words) -> list:
    """`[{start, end, emb}]` : empreinte (arrondie au millième) de chaque prise de parole."""
    embed = voice_embedder()
    if embed is None:
        return []
    total = len(audio) / SR
    out = []
    for start, end in turns_of(words):
        a, b = start, end
        if b - a < EMBED_MIN:
            mid = (a + b) / 2
            a = max(0.0, min(mid - EMBED_MIN / 2, total - EMBED_MIN))
            b = min(total, a + EMBED_MIN)
        e = embed(audio[int(a * SR) : int(b * SR)])
        if e is not None:
            out.append({"start": round(start, 3), "end": round(end, 3), "emb": [round(float(v), 3) for v in e]})
    return out


def to_verbose(segments, info) -> dict:
    segs = []
    words = []
    texts = []
    for s in segments:
        segs.append(
            {
                "id": s.id,
                "start": round(s.start, 3),
                "end": round(s.end, 3),
                "text": s.text,
                "avg_logprob": s.avg_logprob,
                "no_speech_prob": s.no_speech_prob,
                "compression_ratio": s.compression_ratio,
                "temperature": s.temperature,
            }
        )
        texts.append(s.text)
        for w in s.words or []:
            words.append({"word": w.word, "start": round(w.start, 3), "end": round(w.end, 3)})
    return {
        "task": "transcribe",
        "language": info.language,
        "duration": info.duration,
        "text": "".join(texts).strip(),
        "segments": segs,
        "words": words,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--compute-type", default="auto")
    ap.add_argument("--download-root", default="")
    ap.add_argument("--beam-size", type=int, default=5)
    args = ap.parse_args()

    try:
        model, device = load_model(args.model, args.device, args.compute_type, args.download_root)
    except Exception as e:
        send({"event": "error", "error": f"chargement du modèle {args.model} impossible : {e}"})
        traceback.print_exc()
        return 1
    batch_size = batch_size_for(device)
    engine = model
    if batch_size > 0:
        from faster_whisper import BatchedInferencePipeline

        engine = BatchedInferencePipeline(model=model)
    send({"event": "ready", "device": device, "model": args.model})
    log(
        f"modèle {args.model} prêt sur {device}"
        + (f", par lots de {batch_size}" if batch_size > 0 else ", séquentiel")
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            extra = {"batch_size": batch_size} if batch_size > 0 else {}
            # Son décodé une seule fois (16 kHz mono, comme le fait
            # faster-whisper) : il sert aussi aux empreintes de voix.
            from faster_whisper.audio import decode_audio

            audio = decode_audio(req["file"], sampling_rate=SR)
            segments, info = engine.transcribe(
                audio,
                language=req.get("language") or "en",
                initial_prompt=req.get("prompt") or None,
                # Effectif du match : les noms des joueurs sont bien mieux
                # reconnus (banc d'essai : noms justes 61 % -> 79 %).
                hotwords=req.get("hotwords") or None,
                word_timestamps=True,
                vad_filter=True,
                vad_parameters=vad_parameters(),
                beam_size=args.beam_size,
                # Évite qu'une hallucination se propage d'un segment au suivant.
                condition_on_previous_text=False,
                # Saute les silences de plus de 2 s où Whisper « invente »
                # (« Thank you », « I don't see you » pendant les pauses).
                hallucination_silence_threshold=2.0,
                **extra,
            )
            result = to_verbose(list(segments), info)
            if req.get("voices"):
                try:
                    result["voices"] = voice_turns(audio, result["words"])
                except Exception as e:  # jamais au prix de la transcription
                    log(f"empreintes de voix impossibles : {e}")
                    result["voices"] = []
            send({"id": req_id, "ok": True, "result": result})
        except Exception as e:
            traceback.print_exc()
            send({"id": req_id, "ok": False, "error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
