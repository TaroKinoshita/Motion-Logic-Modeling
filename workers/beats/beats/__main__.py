"""python -m beats input.wav output.json; no network or model downloads."""
import argparse
import hashlib
import json
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf


def structure_candidates(y, sr, hop, envelope, beats, rms):
    """Suggest audible changes and a four-beat accent phase for human review."""
    if len(beats) < 12:
        return [], []
    frames = librosa.time_to_frames(beats, sr=sr, hop_length=hop)
    cycle = len(frames) // 4 * 4
    accents = np.array([np.max(envelope[max(0, f - 2):f + 3], initial=0) for f in frames[:cycle]])
    phases = accents.reshape(-1, 4).mean(axis=0)
    highest, runner_up = np.sort(phases)[-2:][::-1]
    phase = int(np.argmax(phases))
    plausible = highest > 0 and (highest - runner_up) / highest >= .12
    downbeats = [float(t) for t in beats[phase::4]] if plausible else []

    if len(beats) < 20:
        return downbeats, []
    chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=hop)
    candidates = []
    for i in range(4, len(frames) - 4):
        left, split, right = frames[i - 4], frames[i], frames[i + 4]
        if left >= split or split >= right:
            continue
        before = chroma[:, left:split].mean(axis=1)
        after = chroma[:, split:right].mean(axis=1)
        normalized = np.linalg.norm(before) * np.linalg.norm(after)
        color = 1 - np.dot(before, after) / normalized if normalized > 1e-8 else 0
        level_before, level_after = rms[left:split].mean(), rms[split:right].mean()
        level = abs(level_before - level_after) / max(1e-6, level_before, level_after)
        candidates.append((i, .7 * color + .3 * level))
    filtered = []
    for index, score in sorted(candidates, key=lambda row: -row[1]):
        if score >= .28 and all(abs(index - previous) >= 8 for previous in filtered):
            filtered.append(index)
    return downbeats, [float(beats[i]) for i in sorted(filtered)]


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
    beats = np.asarray(beats)
    beats = beats[(beats >= 0) & (beats < duration)]
    downbeats, sections = structure_candidates(y, target_sr, hop, envelope, beats, rms)
    return {
        "bpm": float(np.asarray(bpm).reshape(-1)[0]),
        "beats": beats.tolist(),
        "onsets": [float(t) for t in onsets if 0 <= t < duration],
        "downbeats": downbeats,
        "sectionBoundaries": sections,
        "energy": {"stepSeconds": hop / target_sr, "rms": rms.tolist()},
        "duration": duration, "origin": "estimated",
        "tool": "librosa", "version": librosa.__version__,
        "dependencies": {"numpy": np.__version__, "soundfile": sf.__version__},
        "params": {"sampleRate": target_sr, "hopLength": hop, "trim": False,
                   "startBpm": 120, "tightness": 100, "rmsFrameLength": 2048,
                   "structureCandidates": "4-beat accent phase (12+ beats); chroma and RMS change (20+ beats)"},
        "inputSha256": hashlib.sha256(Path(file).read_bytes()).hexdigest(),
        "notes": ["Beat positions may continue through missing percussion.",
                  "Four-beat meter is a hypothesis. Chroma/RMS boundaries are change points, without intro/verse/chorus labels."]
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
