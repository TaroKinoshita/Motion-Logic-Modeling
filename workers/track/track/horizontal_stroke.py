"""Measure a long top stroke and its vertical stem inside supplied glyph boxes."""

import json
import sys

import cv2 as cv
import numpy as np


def longest_run(row):
    edges = np.flatnonzero(np.diff(np.r_[False, row, False]))
    return max(zip(edges[::2], edges[1::2]), key=lambda run: run[1] - run[0], default=(0, 0))


def measure(capture, samples):
    result = []
    for frame, (x, y, w, h) in samples:
        capture.set(cv.CAP_PROP_POS_FRAMES, frame)
        ok, image = capture.read()
        if not ok:
            raise ValueError(f'Could not read frame {frame}')
        roi = cv.cvtColor(image[y:y+h, x:x+w], cv.COLOR_BGR2GRAY)
        _, ink = cv.threshold(roi, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU)
        top = []
        for row, pixels in enumerate(ink[:max(1, h // 4)]):
            start, end = longest_run(pixels > 0)
            if end - start >= w * .70:
                top.append((row, start, end))
        if not top:
            raise ValueError(f'No horizontal stroke at frame {frame}')
        rows, left, right = np.array(top).T
        left, right = int(np.median(left)), int(np.median(right))
        upper, lower = int(rows.min()), int(rows.max()) + 1
        stem = [longest_run(pixels[:int(w * .65)] > 0) for pixels in ink[h//3:(h*2)//3]]
        stem = [(l, r) for l, r in stem if r - l >= 3]
        if len(stem) < h / 6:
            raise ValueError(f'No vertical stem at frame {frame}')
        stem_left, stem_right = map(int, np.median(stem, axis=0))
        result.append({'frame': frame, 'bar': [x+left, y+upper, right-left, lower-upper],
                       'stem': [x+stem_left, y+lower, stem_right-stem_left, h-lower]})
    return result


if __name__ == '__main__':
    capture = cv.VideoCapture(sys.argv[1])
    try:
        print(json.dumps(measure(capture, json.loads(sys.argv[2]))))
    finally:
        capture.release()
