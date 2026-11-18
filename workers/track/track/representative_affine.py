"""Fit a fixed silhouette to observed contours using bounded affine poses."""
import json
import math
import sys

import cv2
import numpy as np

from easing import fit_eased_track


def polygon_paths(sample):
    return [np.asarray(path, np.float64).reshape(-1, 2) / 4096 - .5 for path in sample['paths']]


def mask(paths):
    raster = np.zeros((100, 100), np.uint8)
    cv2.fillPoly(raster, [np.rint(47 + points * 94).astype(np.int32) for points in paths], 1)
    return raster


def pose(paths, target, sx, sy, sign):
    linear = np.array([[sign, sx], [sign * sy, 1.]])
    transformed = [points @ linear.T for points in paths]
    vertices = np.concatenate(transformed)
    lower, upper = vertices.min(axis=0), vertices.max(axis=0)
    gain = 1 / np.maximum(upper - lower, 1e-8)
    offset = -(upper + lower) * gain / 2
    result = mask([points * gain + offset for points in transformed])
    intersection = np.count_nonzero(result & target)
    union = np.count_nonzero(result | target)
    return intersection / max(union, 1), gain[:, None] * linear, offset


def search(paths, target, allow_flip):
    baseline = pose(paths, target, 0., 0., 1)
    best = baseline
    chosen = (0., 0., 1)
    for step, radius in ((.24, 2), (.08, 2), (.025, 2)):
        sx, sy, current_sign = chosen
        for sign in ((1, -1) if allow_flip and step == .24 else (current_sign,)):
            for x in range(-radius, radius + 1):
                for y in range(-radius, radius + 1):
                    u, v = sx + x * step, sy + y * step
                    if abs(u) > .65 or abs(v) > .65:
                        continue
                    candidate = pose(paths, target, u, v, sign)
                    penalty = .07 if sign < 0 else 0
                    if candidate[0] - penalty > best[0] - (.07 if chosen[2] < 0 else 0):
                        best, chosen = candidate, (u, v, sign)
    return baseline[0], best if best[0] >= baseline[0] + .015 else baseline


def analyze(samples, shape_frame, pins):
    shape = next(sample for sample in samples if sample['frame'] == shape_frame)
    nominal = np.array(shape['box'][2:], np.float64) - 1
    paths = polygon_paths(shape)
    poses, metrics = [], []
    for sample in samples:
        left, top, w, h = sample['box']
        bounds = np.maximum([w - 1, h - 1], .01)
        target = mask(polygon_paths(sample))
        baseline, (score, matrix, offset) = search(paths, target, w / shape['box'][2] < .75)
        a, c, b, d = (bounds[:, None] * matrix / nominal).flatten()
        scale_x = math.copysign(math.hypot(a, b), a)
        cos, sin = a / scale_x, b / scale_x
        x, y = np.array([left, top]) + bounds * (.5 + offset)
        poses.append(dict(t=sample['t'], x=x, y=y, scaleX=scale_x, scaleY=cos * d - sin * c,
                          rotation=math.degrees(math.atan2(sin, cos)), shearX=cos * c + sin * d))
        metrics.append(dict(frame=sample['frame'], axisAlignedIou=baseline, affineIou=score))
    tolerances = dict(x=2, y=2, scaleX=.004, scaleY=.004, rotation=.3, shearX=.004)
    return dict(fit=fit_eased_track(poses, tolerances, pinned_times=pins), metrics=metrics)


if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf-8') as source:
        print(json.dumps(analyze(**json.load(source)), allow_nan=False))
