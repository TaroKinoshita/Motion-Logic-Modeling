"""Measure visible ink and its frame-to-frame change without background dominating."""

import json
import sys

import cv2
import numpy as np


def mask(frame):
    if frame.shape[:2] != (540, 960):
        frame = cv2.resize(frame, (960, 540), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    background = float(np.median(np.r_[gray[0], gray[-1], gray[:, 0], gray[:, -1]]))
    return abs(gray.astype(np.float32) - background) >= 50


def similarity(left, right):
    union = (left | right).sum()
    return float((left & right).sum() / union) if union else None


def main():
    videos = [cv2.VideoCapture(name) for name in sys.argv[1:]]
    rows, previous = [], None
    while True:
        frames = [video.read() for video in videos]
        if not all(ok for ok, _ in frames):
            if any(ok for ok, _ in frames):
                raise RuntimeError("The comparison videos differ in frame count")
            break
        source, baseline, revised = current = [mask(frame) for _, frame in frames]
        row = {"frame": len(rows), "previousInkIoU": similarity(source, baseline), "revisedInkIoU": similarity(source, revised)}
        if previous:
            ref_change, before_change, after_change = [a ^ b for a, b in zip(current, previous)]
            row["previousMotionIoU"] = similarity(ref_change, before_change)
            row["revisedMotionIoU"] = similarity(ref_change, after_change)
        rows.append(row)
        previous = current
    for video in videos:
        video.release()
    ranges = {"whole":[0,183], "intro":[3,27], "merge":[71,94], "rotation":[150,160]}
    summary = {}
    for name, (start, end) in ranges.items():
        summary[name] = {}
        for key in ("previousInkIoU", "revisedInkIoU", "previousMotionIoU", "revisedMotionIoU"):
            values = [row[key] for row in rows[start:end] if row.get(key) is not None]
            summary[name][key] = round(float(np.mean(values)), 4) if values else None
    print(json.dumps({"summary":summary,"rows":rows}))


if __name__ == "__main__":
    main()
