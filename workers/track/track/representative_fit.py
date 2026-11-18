"""Compare bounded linear and eased keys on the same observed glyph boxes."""
import json
import sys

from easing import fit_eased_track


def main():
    samples, pins = json.loads(sys.argv[1])
    tolerances = dict(x=2, y=2, width=2, height=2)
    linear = fit_eased_track(samples, tolerances, allow_cubic=False, pinned_times=pins)
    eased = fit_eased_track(samples, tolerances, pinned_times=pins)
    print(json.dumps(dict(linear=linear, eased=eased), allow_nan=False))


if __name__ == '__main__':
    main()
