import json
import sys

import cv2 as cv
import numpy as np


def bounds(mask):
    x, y, w, h = cv.boundingRect(np.uint8(mask))
    return [550 + x, 180 + y, w, h] if w and h else None


def measure(cap, frame):
    ok, image = cap.read()
    if not ok:
        raise ValueError(f'Missing frame {frame}')
    g = cv.cvtColor(image[180:880, 550:1370], cv.COLOR_BGR2GRAY)
    b = np.uint8(g > 25)
    h = cv.morphologyEx(b, cv.MORPH_OPEN, np.ones((1, 150), np.uint8))
    v = cv.morphologyEx(b, cv.MORPH_OPEN, np.ones((150, 1), np.uint8))
    top, bottom = np.flatnonzero(h.sum(axis=1) > 130)[[0, -1]]
    left, right = np.flatnonzero(v.sum(axis=0) > 130)[[0, -1]]
    horizontal = 101 <= frame < 110
    # Remove frame sides, then isolate the dotted separator by its many short runs.
    ink = g > 140
    ink[max(0, top-2):top+5, left:right+1] = False
    ink[bottom-4:bottom+3, left:right+1] = False
    ink[top:bottom+1, max(0, left-2):left+5] = False
    ink[top:bottom+1, right-4:right+3] = False
    span = b[top+8:bottom-7, left+8:right-7]
    if horizontal:
        span = span.T
    edges = np.count_nonzero(np.diff(span, axis=1), axis=1)
    start = int(len(edges)*(.40 if horizontal else .38))
    stop = int(len(edges)*(.60 if horizontal else .85))
    sep = (left if horizontal else top) + 8 + start + int(np.argmax(edges[start:stop]))
    if horizontal:
        ink[:, sep-4:sep+5] = False
        cells = [ink.copy(), ink.copy()]
        cells[0][:, sep:] = False
        cells[1][:, :sep] = False
    else:
        ink[sep-4:sep+5, :] = False
        upper, lower_first, lower_second = [ink.copy() for _ in range(3)]
        upper[sep:, :] = False
        mid = (left+right)//2
        for mask in (lower_first, lower_second):
            mask[:, :mid-66] = False
            mask[:, mid+67:] = False
            mask[:sep+22] = False
            mask[bottom-13:] = False
        split_at = bottom if frame == 110 else int(sep+(bottom-sep)*.53)
        if frame == 100:
            lower_first[:] = False
            lower_second[:] = False
        lower_first[split_at:] = False
        lower_second[:split_at] = False
        cells = [upper, lower_first, lower_second]
    return {'frame': frame, 'outer': [int(left)+550, int(top)+180, int(right-left)+1, int(bottom-top)+1],
            'divider': int(sep)+(550 if horizontal else 180), 'cells': [bounds(cell) for cell in cells]}


cap = cv.VideoCapture(sys.argv[1])
try:
    cap.set(cv.CAP_PROP_POS_FRAMES, 94)
    print(json.dumps([measure(cap, frame) for frame in range(94, 118)]))
finally:
    cap.release()
