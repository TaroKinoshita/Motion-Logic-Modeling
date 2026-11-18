"""Compress a sampled track into the fewest bounded-error linear or cubic segments."""
import numpy as np


def fit_eased_track(samples):
    tolerances = dict(x=2.0, y=2.0, scale=.01, widthScale=.01, rotation=.5)
    times = np.array([row['t'] for row in samples])
    if not len(times) or np.any(np.diff(times) <= 0):
        raise ValueError('Expected ordered motion samples')
    tracks, errors = {}, {}
    for field, tolerance in tolerances.items():
        values = np.array([row[field] for row in samples])
        n = len(values)
        costs = [(0, 0)] + [(n+1, n+1)]*(n-1)
        links = [None]*n
        for right in range(1, n):
            for left in range(right):
                segment = values[left:right+1]
                u = (times[left:right+1]-times[left])/(times[right]-times[left])
                delta = segment[-1]-segment[0]
                linear = segment[0]+delta*u
                error = float(np.max(np.abs(segment-linear)))
                easing = 'linear'
                if error > tolerance and len(segment) >= 5 and abs(delta) > tolerance:
                    basis = np.column_stack((3*u*(1-u)**2, 3*u*u*(1-u)))
                    controls = np.linalg.lstsq(basis, (segment-segment[0])/delta-u**3, rcond=None)[0]
                    # Keep the fit monotone. Overshoot needs more evidence than sparse video frames.
                    if 0 <= controls[0] <= controls[1] <= 1:
                        predicted = segment[0]+delta*(basis@controls+u**3)
                        error = float(np.max(np.abs(segment-predicted)))
                        easing = {'cubic': [1/3, float(controls[0]), 2/3, float(controls[1])]}
                cost = (costs[left][0]+1, costs[left][1]+(easing != 'linear'))
                if error <= tolerance and cost < costs[right]:
                    costs[right] = cost
                    links[right] = left, easing, error
        keys = [dict(t=float(times[-1]), value=float(values[-1]), easing='linear')]
        max_error = 0.0
        right = n-1
        while right:
            left, ease, error = links[right]
            keys.append(dict(t=float(times[left]),value=float(values[left]),easing=ease))
            max_error = max(max_error,error)
            right = left
        tracks[field] = list(reversed(keys))
        errors[field] = max_error
    return dict(method='bounded linear or monotone cubic v1',tracks=tracks,tolerances=tolerances,
                maxSampleError=errors,sampleCount=len(samples),
                limitations=['Bounds apply only at observed samples', 'Missing frames are not observations'])
