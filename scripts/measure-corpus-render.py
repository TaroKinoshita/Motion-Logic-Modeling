"""Compare foreground silhouettes on aligned source and editable-render frames."""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def read(v):
    ok, image = v.read()
    return cv2.resize(image, (480, 270), interpolation=cv2.INTER_AREA) if ok else None


def foreground(frame, profile):
    border = np.concatenate([frame[0], frame[-1], frame[:, 0], frame[:, -1]])
    backdrop = np.median(border, axis=0)
    if profile == 'type-only':
        mask = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) >= 85
    elif profile == 'framed-type':
        mask = np.abs(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(float) - backdrop.mean()) >= 18
    else:
        mask = np.abs(frame.astype(np.float32) - backdrop.astype(np.float32)).max(axis=2) >= 25
    if profile == 'type-only':
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
        keep = np.zeros(n, dtype=bool)
        keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= 5
        mask = keep[labels]
    return mask


def box(mask):
    return np.array(cv2.boundingRect(mask.astype(np.uint8)), dtype=float)


def stats(values):
    if not values:
        return None
    return dict(median=float(np.median(values)), max=float(np.max(values)), count=len(values))


def compare(source, rendition, profile):
    original = cv2.VideoCapture(str(source))
    model = cv2.VideoCapture(str(rendition))
    frames, scores, centers, relative_sizes, missing, extra = 0, [], [], [], [], []
    intersection = union = 0
    try:
        while True:
            a, b = read(original), read(model)
            if a is None or b is None:
                if a is not None or b is not None:
                    raise ValueError('Frame counts do not match')
                break
            left, right = foreground(a, profile), foreground(b, profile)
            if np.any(left | right):
                overlap = int((left & right).sum())
                total = int((left | right).sum())
                intersection += overlap
                union += total
                scores.append((frames, overlap / total))
            if left.any() and right.any():
                abox, bbox = box(left), box(right)
                center = (abox[:2] + abox[2:] / 2) - (bbox[:2] + bbox[2:] / 2)
                centers.append(float(np.linalg.norm(center) / np.hypot(480, 270)))
                relative_sizes.append(float(np.max(np.abs(bbox[2:] - abox[2:]) / abox[2:])))
            elif left.any():
                missing.append(frames)
            elif right.any():
                extra.append(frames)
            frames += 1
    finally:
        original.release()
        model.release()
    if not frames:
        raise ValueError('No comparable video')
    return dict(frames=frames, areaWeightedIoU=intersection / union if union else None,
                medianFrameIoU=float(np.median([score for _, score in scores])) if scores else None,
                globalBoxCenterErrorByFrameDiagonal=stats(centers), globalBoxSizeRelativeMaxError=stats(relative_sizes),
                noModelForegroundFrames=missing, extraModelForegroundFrames=extra,
                worstFrames=[dict(frame=f, iou=score) for f, score in sorted(scores, key=lambda row: row[1])[:10]],
                scope='Automatic silhouette diagnostic; global foreground box includes all visible roles')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('rendition', type=Path)
    parser.add_argument('profile')
    args = parser.parse_args()
    cv2.setNumThreads(2)
    print(json.dumps(compare(args.source, args.rendition, args.profile), allow_nan=False))
