"""Measure the color-separated title, shapes and arrow caption in Lyricsample4."""

import json
import sys

import cv2
import numpy as np


def measure(video):
    cv2.setNumThreads(2)
    capture = cv2.VideoCapture(video)
    rows = {}
    frame = -1

    def record(name, mask, x1, y1, x2, y2, largest=False):
        left, right = round(x1 * width), round(x2 * width)
        top, bottom = round(y1 * height), round(y2 * height)
        region = mask[top:bottom, left:right].astype(np.uint8)
        points, _ = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        points = [poly for poly in points if cv2.contourArea(poly) >= 6]
        if not points:
            return
        shape = max(points, key=cv2.contourArea) if largest else np.concatenate(points)
        x, y, w, h = cv2.boundingRect(shape)
        if w >= 4 and h >= 4:
            rows.setdefault(name, []).append(dict(frame=frame, box=[left + x, top + y, w, h]))

    try:
        while True:
            ok, image = capture.read()
            if not ok:
                break
            frame += 1
            height, width = image.shape[:2]
            b, g, r = cv2.split(image)
            cream = (r >= 177) & (g >= 157) & (b >= 126)
            dark = (r < 67) & (g <= 83) & (b <= 100)
            gold = (r >= 137) & (g >= 106) & (b < 130)
            if 1 <= frame < 33:
                record('title', cream, 0., .18, .9, .565)
                record('bar', dark, 0., .21, 1., .85, largest=True)
            if 33 <= frame < 55:
                record('elapsed', cream, .1, .22, .79, .65)
                record('ring', gold, .35, .14, 1., 1., largest=True)
                record('dark-circle', dark, .10, 0., .73, .87, largest=True)
            if 149 <= frame < 192:
                record('night', cream, .12, .23, .57 if frame >= 173 else .67, .84)
            if 104 <= frame < 139:
                record('right-clause', cream, .65, .32, 1., .68)
    finally:
        capture.release()
    return rows


if __name__ == '__main__':
    print(json.dumps(measure(sys.argv[1])))
