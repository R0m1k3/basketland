#!/usr/bin/env python3
"""
Transcription Whisper embarquée dans le conteneur BasketLand (faster-whisper).

Processus de travail piloté par Node (src/lib/localAi.ts) via stdin/stdout,
une requête JSON par ligne :
  → {"id": 1, "file": "/data/…/chunk-000.ogg", "language": "en", "prompt": "…"}
  ← {"id": 1, "ok": true, "result": { verbose_json façon API OpenAI }}
Le modèle n'est chargé qu'une fois pour tout le match ; Node arrête le
processus à la fin de la transcription, ce qui libère la mémoire du GPU pour
la traduction.

stdout ne porte QUE le protocole ; les journaux vont sur stderr.
"""
import argparse
import json
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
                return make("cuda", "float16" if compute_type == "auto" else compute_type), "cuda"
            if device == "cuda":
                log("aucun GPU CUDA visible : repli sur le processeur")
        except Exception as e:  # bibliothèques CUDA absentes ou pilote trop ancien
            log(f"GPU inutilisable ({e}) : repli sur le processeur")
    return make("cpu", "int8" if compute_type == "auto" else compute_type), "cpu"


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
    send({"event": "ready", "device": device, "model": args.model})
    log(f"modèle {args.model} prêt sur {device}")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            segments, info = model.transcribe(
                req["file"],
                language=req.get("language") or "en",
                initial_prompt=req.get("prompt") or None,
                word_timestamps=True,
                vad_filter=True,
                beam_size=args.beam_size,
                # Évite qu'une hallucination se propage d'un segment au suivant.
                condition_on_previous_text=False,
                # Saute les silences de plus de 2 s où Whisper « invente »
                # (« Thank you », « I don't see you » pendant les pauses).
                hallucination_silence_threshold=2.0,
            )
            send({"id": req_id, "ok": True, "result": to_verbose(list(segments), info)})
        except Exception as e:
            traceback.print_exc()
            send({"id": req_id, "ok": False, "error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
