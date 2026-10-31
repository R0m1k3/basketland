#!/usr/bin/env python3
"""
Voix françaises du doublage, embarquées dans le conteneur BasketLand
(Qwen3-TTS, clonage des voix figées de assets/voices).

Processus de travail piloté par Node (src/lib/voiceAi.ts) via stdin/stdout,
une requête JSON par ligne :
  ← {"event": "ready", "device": "cuda", "model": "…", "voices": ["A", "B4", "B1"]}
  → {"id": 1, "op": "synth", "text": "…", "voice": "A", "out": "/abs/x.wav", "language": "French"}
  ← {"id": 1, "ok": true, "duration": 2.31, "sample_rate": 24000}
  → {"id": 2, "op": "embed", "file": "/abs/audio.ogg", "segments": [[12.0, 14.5], …]}
  ← {"id": 2, "ok": true, "embeddings": [[…192 nombres…] | null, …], "f0": [hz | null, …],
     "female": [p | null, …]}
  ← {"id": n, "ok": false, "error": "…"}   (le processus continue)

`--download-only` : télécharge les modèles (Qwen3-TTS, empreintes vocales,
classifieur homme/femme) dans le cache sans rien charger sur le GPU, puis
s'arrête. Node le lance dès qu'un doublage est demandé, indépendamment de la
carte graphique (voiceAi.ts, `prepareVoiceModels`) :
  ← {"event": "progress", "done": 1200000000, "total": 2500000000}   (toutes les 5 s, octets)
  ← {"event": "downloaded"}   (ou {"event": "error", "error": "…"})

`female` (facultatif côté Node) : probabilité que le segment soit une voix
de femme (classifieur scripts/voice_gender.py, chargé à la première analyse
comme le modèle d'empreintes) ; null si le segment dure moins d'1 s ou si
le classifieur n'a pas pu être chargé (l'analyse continue sans lui).

Au démarrage : chargement du modèle (téléchargé au premier usage dans le
cache Hugging Face, `--download-root`) puis une « empreinte de clonage » par
voix trouvée dans `--voices-dir` (reference.wav + reference.txt). Node
arrête le processus à la fin du doublage, ce qui libère la mémoire du GPU.

Garde-fous de la synthèse : Qwen3-TTS peut ne jamais produire sa fin de
phrase (une génération a tourné plus de 4 min lors des essais). Chaque
synthèse est donc plafonnée en longueur (`max_new_tokens`, proportionnel au
texte) et en temps ; une prise ratée (plafond atteint, délai dépassé, durée
absurde, audio invalide) est refaite une fois avec un nouveau tirage, puis
signalée en erreur.

stdout ne porte QUE le protocole ; les journaux vont sur stderr.
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import warnings

# Le protocole garde le vrai stdout ; tout le reste (print des bibliothèques,
# y compris du code natif qui écrit sur le descripteur 1) part sur stderr.
_PROTO = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr

DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
EMBED_MODEL = "speechbrain/spkrec-ecapa-voxceleb"
EMBED_SR = 16000
EMBED_MIN_SEC = 0.4
# Genre de la voix : rien en dessous d'1 s (estimation trop peu fiable).
GENDER_MIN_SEC = 1.0
# Ordre d'affichage des voix connues ; les autres suivent par ordre alphabétique.
VOICE_ORDER = ["A", "B4", "B1", "F"]
CODEC_HZ = 12  # trames du codec par seconde d'audio

_lock = threading.Lock()


def log(msg: str) -> None:
    print(f"[voix] {msg}", file=sys.stderr, flush=True)


def send(obj: dict) -> None:
    with _lock:
        _PROTO.write(json.dumps(obj, ensure_ascii=False) + "\n")
        _PROTO.flush()


# ------------------------------------------------------------------ modèle


def dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                st = os.lstat(os.path.join(root, f))
            except OSError:
                continue
            if not os.path.islink(os.path.join(root, f)):
                total += st.st_size
    return total


# Posé dans le dossier du modèle (snapshot du cache) une fois un téléchargement
# allé au bout : un dossier sans cette marque peut être un téléchargement
# interrompu (fichiers de configuration présents, poids absents).
COMPLETE_MARK = ".basketland-complet"
WEIGHTS_EXT = (".safetensors", ".bin", ".ckpt", ".pt", ".pth", ".h5", ".msgpack")


def has_weights(path: str) -> bool:
    try:
        return any(f.endswith(WEIGHTS_EXT) and os.path.isfile(os.path.join(path, f)) for f in os.listdir(path))
    except OSError:
        return False


def mark_complete(path: str) -> None:
    try:
        with open(os.path.join(path, COMPLETE_MARK), "w", encoding="utf-8") as f:
            f.write("ok\n")
    except OSError as e:
        log(f"marque de téléchargement complet impossible ({e})")


def fetch_model(name: str, on_progress=None) -> str:
    """
    Chemin local du modèle ; téléchargement au premier usage, progression dans
    les journaux (et toutes les 5 s à `on_progress(fait, total)`, en octets).

    Le cache seul ne suffit pas : `snapshot_download(local_files_only=True)`
    rend aussi le dossier d'un téléchargement interrompu, sans les poids. Sans
    la marque `COMPLETE_MARK`, le téléchargement est repris (ce qui est déjà
    là n'est pas retéléchargé) ; hors ligne, le cache sert s'il a des poids.
    """
    if os.path.isdir(name):
        return name
    from huggingface_hub import constants, snapshot_download

    local = None
    try:
        local = snapshot_download(name, local_files_only=True)
        if os.path.exists(os.path.join(local, COMPLETE_MARK)):
            return local
    except Exception:
        pass
    try:
        path = download_snapshot(name, constants.HF_HUB_CACHE, snapshot_download, on_progress, resume=local is not None)
    except Exception as e:
        if local and has_weights(local):
            log(f"modèle {name} : vérification impossible ({e}), version du cache utilisée")
            return local
        raise
    mark_complete(path)
    return path


def download_snapshot(name: str, cache: str, snapshot_download, on_progress, resume: bool) -> str:
    total = 0
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(name, files_metadata=True)
        total = sum((s.size or 0) for s in info.siblings or [])
    except Exception:
        pass
    size = f", {total / 1e9:.1f} Go".replace(".", ",") if total else ""
    if resume:
        log(f"modèle {name} incomplet ou pas encore vérifié dans le cache : reprise du téléchargement{size}…")
    else:
        log(f"téléchargement du modèle {name} (premier usage{size})…")
    folder = os.path.join(cache, "models--" + name.replace("/", "--"))
    stop = threading.Event()

    def watch() -> None:
        last = 0
        while not stop.wait(5):
            done = dir_size(folder)
            if on_progress:
                on_progress(done, total)
            if total:
                tenth = min(9, int(done * 10 / total))
                if tenth > last:
                    last = tenth
                    log(f"téléchargement de {name} : {tenth * 10} % ({done / 1e6:.0f} / {total / 1e6:.0f} Mo)")

    threading.Thread(target=watch, daemon=True).start()
    try:
        path = snapshot_download(name)
    finally:
        stop.set()
    log(f"modèle {name} téléchargé")
    return path


# Messages sans intérêt affichés à l'import de qwen-tts : flash-attn absent
# (l'attention standard de PyTorch est utilisée) et binaire sox absent (il ne
# sert qu'au tokenizer 25 Hz, pas au modèle 12 Hz).
NOISE = re.compile(
    r"flash-attn is not installed|^\s*\*+\s*$|sox: not found|SoX could not be found|"
    r"If you do (not|\(or think that you should\)) have SoX|sox\.sourceforge\.net|^\s*path variables\.\s*$"
)


def import_quietly(module: str):
    """Importe `module` en filtrant ce que ses dépendances écrivent sur stderr."""
    import importlib
    import tempfile

    sys.stderr.flush()
    saved = os.dup(2)
    with tempfile.TemporaryFile(mode="w+b") as tmp:
        os.dup2(tmp.fileno(), 2)
        try:
            return importlib.import_module(module)
        finally:
            sys.stderr.flush()
            os.dup2(saved, 2)
            os.close(saved)
            tmp.seek(0)
            for line in tmp.read().decode("utf-8", "replace").splitlines():
                if line.strip() and not NOISE.search(line):
                    print(line, file=sys.stderr, flush=True)


def pick_device(want: str):
    import torch

    if want in ("auto", "cuda"):
        try:
            if torch.cuda.is_available():
                # bfloat16 à partir d'Ampere (RTX 30xx) ; float16 sur les cartes plus anciennes.
                major, _minor = torch.cuda.get_device_capability(0)
                return "cuda", (torch.bfloat16 if major >= 8 else torch.float16)
            if want == "cuda":
                log("aucun GPU CUDA visible : repli sur le processeur")
        except Exception as e:  # bibliothèques CUDA absentes ou pilote trop ancien
            log(f"GPU inutilisable ({e}) : repli sur le processeur")
    return "cpu", torch.float32


def list_voice_dirs(voices_dir: str) -> list:
    try:
        names = [n for n in os.listdir(voices_dir) if os.path.isdir(os.path.join(voices_dir, n))]
    except OSError:
        return []
    rank = {v: i for i, v in enumerate(VOICE_ORDER)}
    return sorted(names, key=lambda n: (rank.get(n, len(rank)), n))


class Engine:
    def __init__(self, args):
        import torch

        self.torch = torch
        self.device, self.dtype = pick_device(args.device)
        self.download_root = args.download_root
        self.model_name = args.model
        path = fetch_model(args.model)
        Qwen3TTSModel = import_quietly("qwen_tts").Qwen3TTSModel

        t0 = time.monotonic()
        self.model = Qwen3TTSModel.from_pretrained(path, device_map="cuda:0" if self.device == "cuda" else "cpu", dtype=self.dtype)
        log(f"modèle chargé en {time.monotonic() - t0:.0f} s ({self.device}, {str(self.dtype).replace('torch.', '')})")
        self.max_time = None
        self.talker_sec = 0.0
        self._install_deadline()
        self.prompts = {}
        for vid in list_voice_dirs(args.voices_dir):
            d = os.path.join(args.voices_dir, vid)
            wav, txt = os.path.join(d, "reference.wav"), os.path.join(d, "reference.txt")
            if not (os.path.isfile(wav) and os.path.isfile(txt)):
                continue
            try:
                with open(txt, encoding="utf-8") as f:
                    ref_text = f.read().strip()
                self.prompts[vid] = self.model.create_voice_clone_prompt(ref_audio=wav, ref_text=ref_text)
            except Exception as e:  # une voix abîmée n'empêche pas les autres
                traceback.print_exc()
                log(f"voix {vid} ignorée : {e}")
        if not self.prompts:
            raise RuntimeError(f"aucune voix utilisable dans {args.voices_dir} (reference.wav + reference.txt)")
        self.encoder = None
        self.gender = None  # classifieur homme/femme : None = pas encore chargé, False = indisponible
        try:
            self.fixed_timeout = max(0.0, float(os.environ.get("TTS_SYNTH_TIMEOUT_SEC") or 0))
        except ValueError:
            log("TTS_SYNTH_TIMEOUT_SEC invalide : délai automatique")
            self.fixed_timeout = 0.0

    def _install_deadline(self) -> None:
        """
        Délai par synthèse : `generate_voice_clone` ne transmet pas `max_time`
        au `generate` de Transformers, on l'ajoute à l'appel du « talker »
        (critère d'arrêt MaxTimeCriteria). Sans cela, seul le plafond de
        longueur s'applique.
        """
        talker = getattr(getattr(self.model, "model", None), "talker", None)
        if talker is None or not hasattr(talker, "generate"):
            log("délai par synthèse indisponible (version de qwen-tts inattendue) : seul le plafond de longueur s'applique")
            return
        orig = talker.generate

        def generate(*a, **kw):
            if self.max_time:
                kw["max_time"] = self.max_time
            t0 = time.monotonic()
            try:
                return orig(*a, **kw)
            finally:
                self.talker_sec = time.monotonic() - t0

        talker.generate = generate

    # -------------------------------------------------------------- synthèse

    @staticmethod
    def limits(text: str):
        """Plafond de trames et durée maximale plausible (parole lente + marge)."""
        max_sec = min(90.0, 2.5 + len(text) / 6.0)
        return int(math.ceil(max_sec * CODEC_HZ)), max_sec

    def timeout_for(self, max_sec: float) -> float:
        if self.fixed_timeout > 0:
            return self.fixed_timeout
        # GPU : bien plus rapide que le temps réel (RTF estimé 0,15-0,4).
        # Processeur : ~8 fois plus lent que le temps réel quand il est libre,
        # bien pire s'il est partagé ; le plafond de longueur borne déjà la
        # génération, le délai ne doit couper qu'un blocage.
        return 20.0 + 3.0 * max_sec if self.device == "cuda" else 60.0 + 60.0 * max_sec

    def synth(self, req: dict) -> dict:
        import numpy as np

        torch = self.torch
        text = " ".join(str(req.get("text") or "").split())
        if not text:
            raise ValueError("texte vide")
        voice = req.get("voice")
        prompt = self.prompts.get(voice)
        if prompt is None:
            raise ValueError(f"voix inconnue : {voice} (disponibles : {', '.join(self.prompts)})")
        out = req.get("out")
        if not out:
            raise ValueError("fichier de sortie manquant")
        language = req.get("language") or "French"
        seed = req.get("seed")
        cap, max_sec = self.limits(text)
        timeout = self.timeout_for(max_sec)
        letters = sum(c.isalnum() for c in text)
        problem = ""
        for attempt in (1, 2):
            if seed is not None:
                torch.manual_seed(int(seed) + attempt - 1)
            self.max_time, self.talker_sec = timeout, 0.0
            try:
                wavs, sr = self.model.generate_voice_clone(
                    text=text, language=language, voice_clone_prompt=prompt, max_new_tokens=cap
                )
                wav = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
            except Exception:
                # Coupée par le délai avant la première trame, la génération
                # échoue en aval (liste de trames vide) : c'est un dépassement.
                if self.talker_sec < timeout:
                    raise
                wav, sr = np.zeros(0, np.float32), 24000
            finally:
                self.max_time = None
            dur = len(wav) / sr
            if self.talker_sec >= timeout:
                problem = f"délai de {timeout:.0f} s dépassé"
            elif dur * CODEC_HZ >= cap - 1:
                problem = f"plafond de {cap} trames atteint (génération sans fin)"
            elif not np.isfinite(wav).all():
                problem = "audio invalide (NaN)"
            elif dur < letters / 30.0 or dur < 0.05:
                problem = f"durée absurde ({dur:.2f} s pour {len(text)} caractères)"
            else:
                problem = ""
                break
            log(f"prise {attempt} rejetée ({problem}) : « {text[:60]} »")
        if problem:
            raise RuntimeError(f"synthèse ratée après 2 essais : {problem}")
        write_wav(out, wav, sr)
        return {"duration": round(dur, 3), "sample_rate": int(sr)}

    # -------------------------------------------------------------- empreintes

    def get_encoder(self):
        if self.encoder is None:
            from speechbrain.inference.speaker import EncoderClassifier

            savedir = os.path.join(self.download_root or os.getcwd(), "speechbrain", EMBED_MODEL.split("/")[-1])
            log(f"chargement du modèle d'empreintes vocales {EMBED_MODEL}…")
            self.encoder = EncoderClassifier.from_hparams(source=EMBED_MODEL, savedir=savedir, run_opts={"device": self.device})
            self.encoder.eval()
        return self.encoder

    def get_gender(self):
        """Classifieur homme/femme, chargé au premier besoin ; None s'il est indisponible (un essai par session)."""
        if self.gender is None:
            try:
                sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                from voice_gender import GENDER_MODEL, GenderClassifier

                log(f"chargement du classifieur de voix homme/femme {GENDER_MODEL}…")
                self.gender = GenderClassifier(self.device, log=log)
            except Exception as e:  # pas de réseau au premier usage, etc. : l'analyse continue sans lui
                why = " ".join(str(e).split())[:300] or e.__class__.__name__
                log(f"classifieur homme/femme indisponible ({why}) : pas de voix féminine automatique pendant cette session")
                self.gender = False
        return self.gender or None

    def embed(self, req: dict) -> dict:
        import numpy as np

        torch = self.torch
        path = req.get("file")
        if not path or not os.path.isfile(path):
            raise ValueError(f"fichier audio introuvable : {path}")
        segs = []
        for s in req.get("segments") or []:
            if not isinstance(s, (list, tuple)) or len(s) != 2:
                raise ValueError(f"segment invalide : {s!r}")
            a, b = float(s[0]), float(s[1])
            segs.append((max(0.0, a), max(0.0, b)))
        # Décodage par fenêtres de segments voisins (≤ 10 min) : la mémoire reste
        # bornée même si les segments couvrent tout un match.
        windows = []  # [début, fin, indices des segments]
        for i in sorted(range(len(segs)), key=lambda k: segs[k][0]):
            a, b = segs[i]
            w = windows[-1] if windows else None
            if w and a - w[1] < 30.0 and max(b, w[1]) - w[0] <= 600.0:
                w[1] = max(w[1], b)
                w[2].append(i)
            else:
                windows.append([a, b, [i]])
        embeddings = [None] * len(segs)
        f0s = [None] * len(segs)
        females = [None] * len(segs)
        enc = None
        for lo, hi, idx in windows:
            audio = decode_audio(path, lo, hi) if hi > lo else np.zeros(0, np.float32)
            for i in idx:
                a, b = segs[i]
                x = audio[int(round((a - lo) * EMBED_SR)) : max(0, int(round((b - lo) * EMBED_SR)))]
                if len(x) >= EMBED_MIN_SEC * EMBED_SR:
                    if enc is None:
                        enc = self.get_encoder()
                    with torch.inference_mode():
                        v = enc.encode_batch(torch.from_numpy(np.ascontiguousarray(x)).unsqueeze(0)).reshape(-1).float().cpu().numpy()
                    n = float(np.linalg.norm(v))
                    if n > 0 and np.isfinite(v).all():
                        embeddings[i] = [round(float(t), 6) for t in v / n]
                f0s[i] = median_f0(x)
                if len(x) >= GENDER_MIN_SEC * EMBED_SR:
                    gender = self.get_gender()
                    if gender is not None:
                        p = gender.p_female(x)
                        females[i] = round(p, 4) if math.isfinite(p) else None
        return {"embeddings": embeddings, "f0": f0s, "female": females}


# ------------------------------------------------------------------ audio


def write_wav(path: str, wav, sr: int) -> None:
    """WAV mono PCM 16 bits, écrit à côté puis renommé : jamais de fichier à moitié écrit."""
    import numpy as np
    import soundfile as sf

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = f"{path}.part"
    sf.write(tmp, np.clip(wav, -1.0, 1.0), int(sr), subtype="PCM_16", format="WAV")
    os.replace(tmp, path)


def decode_audio(path: str, start: float, end: float):
    """Extrait [start, end] en mono 16 kHz float32 (ffmpeg, sinon soundfile)."""
    import numpy as np

    ffmpeg = os.environ.get("FFMPEG_PATH") or "ffmpeg"
    cmd = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", path,
        "-vn", "-ac", "1", "-ar", str(EMBED_SR), "-f", "f32le", "-",
    ]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=900)
    except FileNotFoundError:
        import soundfile as sf
        import torch
        import torchaudio

        with sf.SoundFile(path) as f:
            sr = f.samplerate
            f.seek(min(int(start * sr), f.frames))
            x = f.read(int((end - start) * sr), dtype="float32", always_2d=True).mean(axis=1)
        if sr != EMBED_SR:
            x = torchaudio.functional.resample(torch.from_numpy(x), sr, EMBED_SR).numpy()
        return np.ascontiguousarray(x, dtype=np.float32)
    if p.returncode != 0:
        err = p.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(f"ffmpeg : {err[-1] if err else f'code {p.returncode}'}")
    return np.frombuffer(p.stdout, dtype=np.float32).copy()


def median_f0(x):
    """F0 médiane (Hz) des trames voisées (pYIN), None si pas assez de voix."""
    import numpy as np

    if len(x) < 0.25 * EMBED_SR:
        return None
    try:
        import librosa

        f0, voiced, _prob = librosa.pyin(
            x, fmin=65.0, fmax=400.0, sr=EMBED_SR, frame_length=1024, hop_length=320
        )
    except Exception as e:
        log(f"F0 impossible : {e}")
        return None
    f = f0[voiced & np.isfinite(f0)]
    if len(f) < 3:
        return None
    return round(float(np.median(f)), 1)


# ------------------------------------------------------------------ téléchargement seul


def download_only(args) -> int:
    """Modèles mis en cache sans rien charger (ni GPU, ni voix) ; progression sur le protocole."""
    try:
        fetch_model(args.model, lambda done, total: send({"event": "progress", "done": done, "total": total}))
        from huggingface_hub import hf_hub_download

        # Petits modèles de l'analyse des voix (≈ 150 Mo), chargés plus tard par la
        # session : le cache d'abord (aucun appel réseau quand tout est déjà là).
        fetch_model(EMBED_MODEL)
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from voice_gender import GENDER_MODEL, GENDER_REVISION

        try:
            hf_hub_download(GENDER_MODEL, "model.safetensors", revision=GENDER_REVISION, local_files_only=True)
        except Exception:
            hf_hub_download(GENDER_MODEL, "model.safetensors", revision=GENDER_REVISION)
    except Exception as e:
        traceback.print_exc()
        send({"event": "error", "error": f"téléchargement des modèles de voix impossible : {e}"})
        return 1
    send({"event": "downloaded"})
    return 0


# ------------------------------------------------------------------ boucle


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--download-root", default="")
    ap.add_argument("--voices-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "voices"))
    ap.add_argument("--download-only", action="store_true")
    args = ap.parse_args()

    if args.download_root:
        os.environ["HF_HOME"] = args.download_root
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    # « Setting `pad_token_id` to `eos_token_id` » à chaque synthèse, etc.
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
    warnings.filterwarnings("ignore", category=FutureWarning)
    warnings.filterwarnings("ignore", category=UserWarning)

    if args.download_only:
        return download_only(args)
    try:
        engine = Engine(args)
    except Exception as e:
        traceback.print_exc()
        send({"event": "error", "error": f"chargement du modèle {args.model} impossible : {e}"})
        return 1
    voices = list(engine.prompts)
    send({"event": "ready", "device": engine.device, "model": args.model, "voices": voices})
    log(f"modèle {args.model} prêt sur {engine.device} · voix {', '.join(voices)}")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            op = req.get("op")
            if op == "synth":
                res = engine.synth(req)
            elif op == "embed":
                res = engine.embed(req)
            else:
                raise ValueError(f"opération inconnue : {op}")
            send({"id": req_id, "ok": True, **res})
        except Exception as e:
            traceback.print_exc()
            if engine.device == "cuda":
                engine.torch.cuda.empty_cache()  # après un manque de mémoire GPU
            send({"id": req_id, "ok": False, "error": str(e) or e.__class__.__name__})
    return 0


if __name__ == "__main__":
    sys.exit(main())
