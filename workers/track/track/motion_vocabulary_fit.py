"""Fit the same normalized motion samples with linear and eased tracks."""
import json
import sys

from easing import fit_eased_track


if __name__ == '__main__':
    samples, tolerances, pins = json.loads(sys.argv[1])
    results = {}
    for name, enabled in [('linear', False), ('eased', True)]:
        tracks, errors = {}, {}
        for field, tolerance in tolerances.items():
            model = fit_eased_track(samples, {field: tolerance}, allow_cubic=enabled,
                                    pinned_times=[samples[i]['t'] for i in pins[field]])
            tracks.update(model['tracks'])
            errors.update(model['maxSampleError'])
        results[name] = dict(tracks=tracks, maxSampleError=errors)
    print(json.dumps(results, allow_nan=False))
