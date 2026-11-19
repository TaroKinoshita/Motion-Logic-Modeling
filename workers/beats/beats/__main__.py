"""python -m beats input.wav output.json; no network or model downloads."""
import argparse
import hashlib
import json
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf


def structure_candidates(y, sr, hop, envelope, beats, rms, tuning=None):
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
    chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=hop,tuning=tuning)
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


def portable_beats(envelope, sr, hop):
    """Find an onset-aligned path with a penalty for deviations from the estimated period."""
    if not np.any(envelope > 0) or len(envelope) < 3:
        return 0., np.array([])
    bpm = float(librosa.feature.tempo(onset_envelope=envelope, sr=sr, hop_length=hop)[0])
    period = max(1, round(60 * sr / (bpm * hop)))
    offsets = np.arange(-period, period + 1)
    smoothing = np.exp(-.5 * (32 * offsets / period) ** 2)
    normalized = envelope.astype(np.float64) / max(np.finfo(np.float64).tiny, float(envelope.std(ddof=1)))
    score = np.convolve(normalized, smoothing)[period:period + len(envelope)]
    first_threshold = .01 * score.max()
    gaps = np.arange(max(1, round(period / 2)), 2 * period + 1)
    penalties = 100 * np.log(gaps / period) ** 2
    total = score.copy()
    previous = np.full(len(score), -1, dtype=int)
    first = True
    for i, value in enumerate(score):
        count = np.searchsorted(gaps, i, side="right")
        if count:
            positions = i - gaps[:count]
            candidates = total[positions] - penalties[:count]
            best = int(np.argmax(candidates))
            total[i] += candidates[best]
            if not first or value >= first_threshold:
                previous[i] = positions[best]
        if value >= first_threshold:
            first = False
    local_maxima = np.flatnonzero(librosa.util.localmax(total) & (score >= first_threshold))
    if not len(local_maxima):
        return bpm, np.array([])
    strong = local_maxima[total[local_maxima] >= .5 * np.median(total[local_maxima])]
    cursor = int(strong[-1] if len(strong) else local_maxima[-1])
    positions = []
    while cursor >= 0:
        positions.append(cursor)
        cursor = previous[cursor]
    usable = np.flatnonzero(score >= first_threshold)
    if not len(usable):
        return bpm, np.array([])
    beats = [frame for frame in reversed(positions) if usable[0] <= frame <= usable[-1]]
    return bpm, librosa.frames_to_time(beats, sr=sr, hop_length=hop)


def analyze(file, portable=False):
    y, sr = sf.read(file, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if not len(y) or not np.isfinite(y).all():
        raise ValueError("Audio must contain finite samples")
    target_sr, hop = 22050, 256
    if sr != target_sr:
        y = librosa.resample(y, orig_sr=sr, target_sr=target_sr)
    envelope = librosa.onset.onset_strength(y=y, sr=target_sr, hop_length=hop)
    if portable:
        bpm, beats = portable_beats(envelope, target_sr, hop)
    else:
        bpm, beats = librosa.beat.beat_track(onset_envelope=envelope, sr=target_sr,
                                            hop_length=hop, trim=False, units="time")
    onsets = librosa.onset.onset_detect(onset_envelope=envelope, sr=target_sr,
                                       hop_length=hop, units="time")
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    duration = len(y) / target_sr
    beats = np.asarray(beats)
    beats = beats[(beats >= 0) & (beats < duration)]
    downbeats, sections = structure_candidates(y, target_sr, hop, envelope, beats, rms, tuning=0. if portable else None)
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
                   "beatTracker": "numpy-onset-path" if portable else "librosa.beat.beat_track",
                   "portableBeatRevision": 2 if portable else None,
                   "chromaTuning": "440Hz-reference" if portable else "estimated",
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
    parser.add_argument("--portable", action="store_true")
    args = parser.parse_args()
    result = analyze(args.audio, args.portable)
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    temporary.replace(target)
    print(json.dumps({"bpm": result["bpm"], "beatCount": len(result["beats"])}))


if __name__ == "__main__":
    main()
