"""Rough prosody measures for comparing synthetic voices (a proxy, NOT a substitute for listening).

    python tools/narration/prosody.py <file.wav> [...]

Per file: speech rate is not measured here (see voice.json); this reports the pitch contour of voiced 40 ms frames
(autocorrelation F0 in 70–350 Hz), its spread in semitones (higher = less monotone), and the share of frames voiced.
"""
import sys
import wave

import numpy as np


def load(path):
    with wave.open(path) as w:
        sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    dtype = {2: np.int16, 4: np.int32}[sw]
    x = np.frombuffer(raw, dtype=dtype).astype(np.float64)
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x / np.abs(x).max(), sr


def f0_track(x, sr, win=0.04, hop=0.01):
    n, h = int(sr * win), int(sr * hop)
    lo, hi = int(sr / 350), int(sr / 70)
    out = []
    for i in range(0, len(x) - n, h):
        f = x[i:i + n] * np.hanning(n)
        if np.sqrt(np.mean(f ** 2)) < 0.03:
            continue
        ac = np.correlate(f, f, mode='full')[n - 1:]
        ac /= ac[0] + 1e-9
        lag = lo + int(np.argmax(ac[lo:hi]))
        if ac[lag] > 0.45:
            out.append(sr / lag)
    return np.array(out)


for p in sys.argv[1:]:
    x, sr = load(p)
    f0 = f0_track(x, sr)
    st = 12 * np.log2(f0 / np.median(f0))
    print(f"{p}: voiced frames {len(f0)}, median F0 {np.median(f0):.0f} Hz, "
          f"pitch spread (st, 10–90%) {np.percentile(st, 90) - np.percentile(st, 10):.1f}, std {st.std():.2f} st")
