"""Measure foreground for a selected text passage with a known luminance polarity."""

import json
import sys

import cv2 as cv
import numpy as np


def measure(file, first, end, roi, polarity='light-background'):
    capture = cv.VideoCapture(file)
    capture.set(cv.CAP_PROP_POS_FRAMES, first)
    x, y, w, h = roi
    result = []
    try:
        for frame in range(first, end):
            ok, image = capture.read()
            if not ok:
                raise ValueError(f'Missing source frame {frame}')
            gray = cv.cvtColor(image[y:y+h, x:x+w], cv.COLOR_BGR2GRAY)
            if polarity == 'dark-background':
                gray = 255 - gray
            bg = np.percentile(gray, 90)
            if bg < 180:
                raise ValueError(f'Frame {frame}: unexpected or changed background polarity')
            mask = np.uint8(gray < bg - 50)
            ys, xs = np.nonzero(mask)
            if not len(xs):
                raise ValueError(f'Frame {frame}: empty foreground')
            result.append({'frame': frame, 'box': [x+int(xs.min()), y+int(ys.min()),
                                                  int(xs.max()-xs.min()+1), int(ys.max()-ys.min()+1)]})
    finally:
        capture.release()
    return result


if __name__ == '__main__':
    polarity = sys.argv[5] if len(sys.argv) > 5 else 'light-background'
    print(json.dumps(measure(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), json.loads(sys.argv[4]), polarity)))
