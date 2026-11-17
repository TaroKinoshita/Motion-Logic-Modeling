"""python -m beats input.wav output.json; no network or model downloads."""
import argparse
import hashlib
import json
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf


def analyze(file):
    y, sr = sf.read(file, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if not len(y) or not np.isfinite(y).all():
        raise ValueError("Audio must contain finite samples")
    target_sr, hop = 22050, 256
    if sr != target_sr:
        y = librosa.resample(y, orig_sr=sr, target_sr=target_sr)
    envelope = librosa.onset.onset_strength(y=y, sr=target_sr, hop_length=hop)
    bpm, beats = librosa.beat.beat_track(onset_envelope=envelope, sr=target_sr,
                                        hop_length=hop, trim=False, units="time")
    onsets = librosa.onset.onset_detect(onset_envelope=envelope, sr=target_sr,
                                       hop_length=hop, units="time")
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    duration = len(y) / target_sr
    return {
        "bpm": float(np.asarray(bpm).reshape(-1)[0]),
        "beats": [float(t) for t in beats if 0 <= t < duration],
        "onsets": [float(t) for t in onsets if 0 <= t < duration],
        "energy": {"stepSeconds": hop / target_sr, "rms": rms.tolist()},
        "duration": duration, "origin": "estimated",
        "tool": "librosa", "version": librosa.__version__,
        "dependencies": {"numpy": np.__version__, "soundfile": sf.__version__},
        "params": {"sampleRate": target_sr, "hopLength": hop, "trim": False,
                   "startBpm": 120, "tightness": 100, "rmsFrameLength": 2048},
        "inputSha256": hashlib.sha256(Path(file).read_bytes()).hexdigest(),
        "notes": ["Beat positions may continue through missing percussion.",
                  "Onsets and RMS do not identify kick drums or musical sections."]
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("output")
    args = parser.parse_args()
    result = analyze(args.audio)
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    temporary.replace(target)
    print(json.dumps({"bpm": result["bpm"], "beatCount": len(result["beats"])}))


if __name__ == "__main__":
    main()
