"""Bounded-error piecewise linear approximation, preserving measured seconds."""
import math


def fit_track(samples, tolerances=None):
    tolerances = tolerances or dict(x=1.0, y=1.0, scale=0.005, rotation=0.5)
    if not samples or any(not math.isfinite(s['t']) for s in samples):
        raise ValueError('Finite, nonempty observations required')
    if any(b['t'] <= a['t'] for a, b in zip(samples, samples[1:])):
        raise ValueError('Observation times must increase strictly')
    tracks, errors = {}, {}
    for field, tolerance in tolerances.items():
        if not math.isfinite(tolerance) or tolerance <= 0 or any(not math.isfinite(s[field]) for s in samples):
            raise ValueError('Finite values and positive tolerances required')
        keep = {0, len(samples)-1}
        pending = [(0, len(samples)-1)]
        while pending:
            left, right = pending.pop()
            if right <= left+1:
                continue
            a, b = samples[left], samples[right]
            def residual(i):
                s = samples[i]
                fraction = (s['t']-a['t'])/(b['t']-a['t'])
                return abs(s[field]-(a[field]+fraction*(b[field]-a[field])))
            worst = max(range(left+1, right), key=residual)
            if residual(worst) > tolerance:
                keep.add(worst)
                pending.extend([(left, worst), (worst, right)])
        indices = sorted(keep)
        tracks[field] = [dict(t=samples[i]['t'], value=samples[i][field], easing='linear') for i in indices]
        max_error = 0.0
        for left, right in zip(indices, indices[1:]):
            a, b = samples[left], samples[right]
            for s in samples[left:right+1]:
                predicted = a[field]+(s['t']-a['t'])/(b['t']-a['t'])*(b[field]-a[field])
                max_error = max(max_error, abs(predicted-s[field]))
        errors[field] = max_error
    return dict(method='bounded piecewise linear v1', tracks=tracks, tolerances=tolerances,
                maxSampleError=errors, sampleCount=len(samples),
                limitations=['Error bounds apply at observed samples only', 'No extrapolation beyond tracked interval',
                             'Tracks are in input-video coordinates; not scene transforms'])
