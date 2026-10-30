"""
Genre de la voix (homme / femme) d'un extrait de parole, pour le doublage :
une locutrice (reporter au bord du terrain, consultante) prend la voix
féminine F (src/lib/dub.ts, `assignRoles`).

Modèle : JaesungHuh/voice-gender-classifier (Hugging Face, licence MIT,
révision figée ci-dessous, ~62 Mo, 15,5 M de paramètres) : un ECAPA-TDNN de
vérification du locuteur suivi d'une couche à deux classes, affiné sur
VoxCeleb2 (98,7 % de justesse annoncée sur VoxCeleb1). Seuls les poids
(model.safetensors) sont téléchargés, au premier usage, dans le cache
Hugging Face (HF_HOME = /data/models/hf) ; l'architecture est ci-dessous,
car le dépôt du modèle ne contient pas de code.

Architecture reprise de https://github.com/JaesungHuh/voice-gender-classifier
(model.py, licence MIT ci-dessous), lui-même adapté de
https://github.com/TaoRuijie/ECAPA-TDNN. Changements : chargement direct des
poids (safetensors, sans PyTorchModelHubMixin), filtres mel construits une
seule fois, sortie = probabilité « femme » au lieu d'une étiquette.

----------------------------------------------------------------------------
MIT License

Copyright (c) 2024 jaesunghuh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
----------------------------------------------------------------------------
"""
import math

import torch
import torch.nn as nn
import torch.nn.functional as F

GENDER_MODEL = "JaesungHuh/voice-gender-classifier"
# Révision figée : les poids ne changent pas sans mise à jour de ce fichier.
GENDER_REVISION = "db1222153bd60337e900be22add7af180452adc0"
SAMPLE_RATE = 16000
# Un extrait plus long est découpé en morceaux de 30 s au plus (mémoire bornée),
# dont les probabilités sont moyennées (pondérées par la durée).
MAX_PIECE_SEC = 30.0


class SEModule(nn.Module):
    def __init__(self, channels: int, bottleneck: int = 128) -> None:
        super().__init__()
        self.se = nn.Sequential(
            nn.AdaptiveAvgPool1d(1),
            nn.Conv1d(channels, bottleneck, kernel_size=1, padding=0),
            nn.ReLU(),
            nn.Conv1d(bottleneck, channels, kernel_size=1, padding=0),
            nn.Sigmoid(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x * self.se(x)


class Bottle2neck(nn.Module):
    def __init__(self, inplanes: int, planes: int, kernel_size: int, dilation: int, scale: int = 8) -> None:
        super().__init__()
        width = int(math.floor(planes / scale))
        self.conv1 = nn.Conv1d(inplanes, width * scale, kernel_size=1)
        self.bn1 = nn.BatchNorm1d(width * scale)
        self.nums = scale - 1
        pad = math.floor(kernel_size / 2) * dilation
        self.convs = nn.ModuleList(
            [nn.Conv1d(width, width, kernel_size=kernel_size, dilation=dilation, padding=pad) for _ in range(self.nums)]
        )
        self.bns = nn.ModuleList([nn.BatchNorm1d(width) for _ in range(self.nums)])
        self.conv3 = nn.Conv1d(width * scale, planes, kernel_size=1)
        self.bn3 = nn.BatchNorm1d(planes)
        self.relu = nn.ReLU()
        self.width = width
        self.se = SEModule(planes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        out = self.bn1(self.relu(self.conv1(x)))
        spx = torch.split(out, self.width, 1)
        parts = []
        sp = None
        for i in range(self.nums):
            sp = spx[i] if i == 0 else sp + spx[i]
            sp = self.bns[i](self.relu(self.convs[i](sp)))
            parts.append(sp)
        parts.append(spx[self.nums])
        out = self.bn3(self.relu(self.conv3(torch.cat(parts, 1))))
        return self.se(out) + residual


class ECAPAGender(nn.Module):
    """ECAPA-TDNN + 2 classes (0 = homme, 1 = femme). Noms des couches = ceux des poids publiés."""

    def __init__(self, C: int = 1024) -> None:
        super().__init__()
        self.conv1 = nn.Conv1d(80, C, kernel_size=5, stride=1, padding=2)
        self.relu = nn.ReLU()
        self.bn1 = nn.BatchNorm1d(C)
        self.layer1 = Bottle2neck(C, C, kernel_size=3, dilation=2, scale=8)
        self.layer2 = Bottle2neck(C, C, kernel_size=3, dilation=3, scale=8)
        self.layer3 = Bottle2neck(C, C, kernel_size=3, dilation=4, scale=8)
        self.layer4 = nn.Conv1d(3 * C, 1536, kernel_size=1)
        self.attention = nn.Sequential(
            nn.Conv1d(4608, 256, kernel_size=1),
            nn.ReLU(),
            nn.BatchNorm1d(256),
            nn.Tanh(),
            nn.Conv1d(256, 1536, kernel_size=1),
            nn.Softmax(dim=2),
        )
        self.bn5 = nn.BatchNorm1d(3072)
        self.fc6 = nn.Linear(3072, 192)
        self.bn6 = nn.BatchNorm1d(192)
        self.fc7 = nn.Linear(192, 2)
        # Hors state_dict (les poids publiés n'en ont pas) : liste plutôt qu'attribut-module.
        self._mel = []

    def fbank(self, x: torch.Tensor) -> torch.Tensor:
        """Log-mel 80 bandes (préaccentuation 0,97, fenêtres 25 ms / 10 ms), moyenne retirée par bande."""
        import torchaudio

        if not self._mel or self._mel[0][0] != x.device:
            mel = torchaudio.transforms.MelSpectrogram(
                sample_rate=SAMPLE_RATE, n_fft=512, win_length=400, hop_length=160,
                f_min=20, f_max=7600, window_fn=torch.hamming_window, n_mels=80,
            ).to(x.device)
            self._mel = [(x.device, mel)]
        pre = torch.tensor([-0.97, 1.0], device=x.device).view(1, 1, 2)
        x = F.conv1d(F.pad(x.unsqueeze(1), (1, 0), "reflect"), pre).squeeze(1)
        x = (self._mel[0][1](x) + 1e-6).log()
        return x - torch.mean(x, dim=-1, keepdim=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.bn1(self.relu(self.conv1(self.fbank(x))))
        x1 = self.layer1(x)
        x2 = self.layer2(x + x1)
        x3 = self.layer3(x + x1 + x2)
        x = self.relu(self.layer4(torch.cat((x1, x2, x3), dim=1)))
        t = x.size()[-1]
        global_x = torch.cat(
            (
                x,
                torch.mean(x, dim=2, keepdim=True).repeat(1, 1, t),
                torch.sqrt(torch.var(x, dim=2, keepdim=True).clamp(min=1e-4)).repeat(1, 1, t),
            ),
            dim=1,
        )
        w = self.attention(global_x)
        mu = torch.sum(x * w, dim=2)
        sg = torch.sqrt((torch.sum((x**2) * w, dim=2) - mu**2).clamp(min=1e-4))
        x = self.bn5(torch.cat((mu, sg), 1))
        x = self.relu(self.bn6(self.fc6(x)))
        return self.fc7(x)


class GenderClassifier:
    """Probabilité qu'un extrait (mono 16 kHz, float32) soit une voix de femme."""

    def __init__(self, device: str = "cpu", log=None) -> None:
        from huggingface_hub import hf_hub_download
        from safetensors.torch import load_file

        try:
            path = hf_hub_download(GENDER_MODEL, "model.safetensors", revision=GENDER_REVISION, local_files_only=True)
        except Exception:
            if log:
                log(f"téléchargement du classifieur de voix homme/femme {GENDER_MODEL} (premier usage, 62 Mo)…")
            path = hf_hub_download(GENDER_MODEL, "model.safetensors", revision=GENDER_REVISION)
        model = ECAPAGender(C=1024)
        model.load_state_dict(load_file(path), strict=True)
        self.device = device
        self.model = model.to(device).eval()

    def p_female(self, x) -> float:
        import numpy as np

        x = np.ascontiguousarray(x, dtype=np.float32).reshape(-1)
        step = int(MAX_PIECE_SEC * SAMPLE_RATE)
        total, weight = 0.0, 0
        with torch.inference_mode():
            for a in range(0, len(x), step):
                piece = x[a : a + step]
                if a and len(piece) < SAMPLE_RATE:  # reste de moins d'1 s : ignoré
                    break
                logits = self.model(torch.from_numpy(piece).unsqueeze(0).to(self.device))
                p = float(torch.softmax(logits.float(), dim=1)[0, 1])
                total += p * len(piece)
                weight += len(piece)
        return total / weight if weight else 0.0
