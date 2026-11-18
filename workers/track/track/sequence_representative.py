"""Model contour observations with a fixed outline per track and compact transforms."""

import json
import sys

import numpy as np

from easing import fit_eased_track
from representative_affine import analyze, mask, polygon_paths


def similarity(left, right):
    return np.count_nonzero(left & right) / max(1, np.count_nonzero(left | right))


def stitch(tracks, cuts):
    """Only connect reciprocal matches with a clear margin at a short observation gap."""
    def center(row):
        x, y, w, h = row['box']
        return np.array([x + w / 2, y + h / 2])

    endpoints = {item['id']: [mask(polygon_paths(item['samples'][i])) for i in (0, -1)] for item in tracks}
    incoming, outgoing = {}, {}
    for a in tracks:
        if a['protected']:
            continue
        previous = a['samples']
        left = previous[-1]
        for b in tracks:
            if a is b or b['protected'] or min(len(previous), len(b['samples'])) > 2:
                continue
            right = b['samples'][0]
            gap = right['frame'] - left['frame']
            if gap not in (1, 2, 3) or any(left['frame'] < cut <= right['frame'] for cut in cuts):
                continue
            _, _, w, h = left['box']
            _, _, nw, nh = right['box']
            if abs(left['luma'] - right['luma']) > 18 or min(w, nw) / max(w, nw) < .7 or min(h, nh) / max(h, nh) < .7:
                continue
            velocity = (center(left) - center(previous[-2])) / (left['frame'] - previous[-2]['frame']) if len(previous) > 1 else np.zeros(2)
            error = np.linalg.norm(center(left) + gap * velocity - center(right))
            limit = max(4, min(w, h) * .2)
            if error > limit:
                continue
            overlap = similarity(endpoints[a['id']][1], endpoints[b['id']][0])
            if overlap < .87:
                continue
            cost = error / limit * .5 + (1 - overlap) * 2 + .08 * (gap - 1)
            outgoing.setdefault(a['id'], []).append((cost, b['id']))
            incoming.setdefault(b['id'], []).append((cost, a['id']))

    def top(options):
        rows = sorted(options)
        return rows[0][1] if len(rows) == 1 or rows[1][0] - rows[0][0] > .20 else None

    links = {}
    for ident, options in outgoing.items():
        target = top(options)
        if target is not None and top(incoming[target]) == ident:
            links[ident] = target

    successor_ids = set(links.values())
    by_id = {track['id']: track for track in tracks}
    for track in tracks:
        if track['id'] in successor_ids:
            continue
        group, rows, ident = [track['id']], list(track['samples']), track['id']
        while ident in links:
            ident = links[ident]
            group.append(ident)
            rows.extend(by_id[ident]['samples'])
        yield group, rows


def fit_pose(samples):
    masks = [mask(polygon_paths(row)) for row in samples]
    eligible = [i for i, row in enumerate(samples) if min(row['box'][2:]) >= 2]
    candidates = eligible or list(range(len(samples)))
    if len(candidates) > 13:
        candidates = [candidates[i] for i in np.linspace(0, len(candidates) - 1, 13, dtype=int)]
    best = max(candidates, key=lambda i: (np.mean([similarity(masks[i], other) for other in masks]), -abs(i - len(samples) / 2)))
    reference = samples[best]
    comparison = [similarity(masks[best], other) for other in masks]
    nominal_w, nominal_h = [max(.01, side - 1) for side in reference['box'][2:]]
    box_rows = []
    for row in samples:
        x, y, width, height = row['box']
        box_rows.append(dict(t=row['t'], x=x + (width - 1) / 2, y=y + (height - 1) / 2,
                             scaleX=max(.01, width - 1) / nominal_w, scaleY=max(.01, height - 1) / nominal_h))
    pins = []
    for a, b in zip(samples, samples[1:]):
        if b['frame'] - a['frame'] > 1:
            pins.extend((a['t'], b['t']))
    box_fit = fit_eased_track(box_rows, dict(x=1.5, y=1.5, scaleX=1.25 / nominal_w, scaleY=1.25 / nominal_h), pinned_times=pins)
    result = dict(shapeFrame=reference['frame'], geometry='box', tracks=box_fit['tracks'],
                  meanShapeIoU=float(np.mean(comparison)), minShapeIoU=float(min(comparison)))
    relative_short_side = min(nominal_w, nominal_h)
    if len(samples) < 3 or not all(min(row['box'][2:]) >= 2 for row in samples) or relative_short_side < 6 or result['meanShapeIoU'] >= .91:
        return result
    affine = analyze(samples, reference['frame'], pins)
    gain = np.array([row['affineIou'] - row['axisAlignedIou'] for row in affine['metrics']])
    if np.mean(gain) >= .035 and np.count_nonzero(gain > .025) >= 2:
        accepted = [row['affineIou'] for row in affine['metrics']]
        result.update(geometry='affine', tracks=affine['fit']['tracks'], meanShapeIoU=float(np.mean(accepted)), minShapeIoU=float(min(accepted)))
    return result


def shape_spans(samples):
    size = len(samples)
    if size < 8 or size > 240:
        return [(0, size)]
    masks = [mask(polygon_paths(row)) for row in samples]
    affinities = np.eye(size)
    for i in range(size):
        for j in range(i + 1, size):
            affinities[i, j] = affinities[j, i] = similarity(masks[i], masks[j])
    prefix = np.pad(affinities.cumsum(axis=1), ((0, 0), (1, 0)))

    def score(start, end):
        return max(prefix[start:end, end] - prefix[start:end, start])

    spans = [(0, size)]
    while len(spans) < min(4, size // 4):
        candidates = []
        for start, end in spans:
            original = score(start, end)
            candidates.extend((score(start, i) + score(i, end) - original, start, i, end)
                              for i in range(start + 4, end - 3))
        if not candidates:
            break
        gain, start, cut, end = max(candidates)
        if gain < .9:
            break
        index = spans.index((start, end))
        spans[index:index + 1] = [(start, cut), (cut, end)]
    return spans


def model(samples):
    spans = shape_spans(samples)
    poses = [(fit_pose(samples[start:end]), start, end) for start, end in spans]
    if len(poses) == 1:
        return dict(poses[0][0], poses=[dict(shapeFrame=poses[0][0]['shapeFrame'], fromFrame=samples[0]['frame'])])
    by_frame = {sample['frame']: sample for sample in samples}
    base = poses[0][0]['shapeFrame']
    nominal = [max(.01, side - 1) for side in by_frame[base]['box'][2:]]
    fields = list(dict.fromkeys(name for pose, _, _ in poses for name in pose['tracks']))
    tracks, summary = {name: [] for name in fields}, []
    for pose, start, end in poses:
        frame = pose['shapeFrame']
        width, height = [max(.01, side - 1) for side in by_frame[frame]['box'][2:]]
        factors = dict(scaleX=width / nominal[0], scaleY=height / nominal[1], shearX=height / nominal[1])
        for name in fields:
            keys = pose['tracks'].get(name, [dict(t=samples[start]['t'], value=0, easing='linear'),
                                             dict(t=samples[end - 1]['t'], value=0, easing='linear')])
            rows = [dict(row, value=row['value'] * factors.get(name, 1)) for row in keys]
            rows[-1]['easing'] = 'hold'
            tracks[name].extend(rows)
        summary.append(dict(shapeFrame=frame, fromFrame=samples[start]['frame']))
    return dict(shapeFrame=base, poses=summary, geometry='affine' if 'rotation' in fields else 'box', tracks=tracks,
                meanShapeIoU=sum(pose['meanShapeIoU'] * (end - start) for pose, start, end in poses) / len(samples),
                minShapeIoU=min(pose['minShapeIoU'] for pose, _, _ in poses))


def main():
    with open(sys.argv[1], encoding='utf-8') as source:
        inputs = json.load(source)
    models = {}
    for members, samples in stitch(inputs['tracks'], inputs['cuts']):
        models[members[0]] = dict(model(samples), members=members)
    with open(sys.argv[2], 'w', encoding='utf-8') as output:
        json.dump(models, output, allow_nan=False)


if __name__ == '__main__':
    main()
