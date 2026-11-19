"""Fit a fixed outline to each reviewed shot, with its own affine motion."""
import json
from pathlib import Path
import sys

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'workers/track/track'))
from sequence_representative import fit_pose


def observation(image, frame, region, polarity):
    height, width = image.shape[:2]
    x, y, right, bottom = [round(n * size) for n, size in zip(region, (width, height, width, height))]
    crop = image[y:bottom, x:right]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    if polarity == 'dark-blue':
        blue, green, red = cv2.split(crop)
        mask = ((red < 67) & (green < 83) & (blue < 100)).astype(np.uint8)
        # The source caption interrupts the underlying arrow. Restore ink
        # across those narrow gaps before fitting the arrow's own layer.
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (17, 17)))
    else:
        mask = (gray > 205 if polarity == 'cream' else gray > 28 if polarity == 'frame'
                else gray > 105 if polarity == 'bright' else gray < 157).astype(np.uint8)
    contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    contours = [cv2.approxPolyDP(p, .65, True).reshape(-1, 2) for p in contours if cv2.contourArea(p) >= 5]
    contours = [p for p in contours if len(p) >= 3]
    if not contours:
        return None
    a, b, w, h = cv2.boundingRect(np.concatenate(contours))
    if min(w, h) < 2:
        return None
    paths = [np.rint((p - [a, b]) * (4096 / np.array([w - 1, h - 1]))).astype(int).ravel().tolist() for p in contours]
    pixels = crop[mask != 0]
    rgb = np.median(pixels[::max(1, len(pixels)//1024)], axis=0).astype(int)[::-1]
    return dict(frame=frame, box=[x + a, y + b, w, h], paths=paths, fill='#' + ''.join(f'{c:02x}' for c in rgb))


def main():
    video, spec, output = sys.argv[1:]
    cases = json.loads(spec)
    cv2.setNumThreads(2)
    source = cv2.VideoCapture(video)
    fps = source.get(cv2.CAP_PROP_FPS)
    result = []
    for case in cases:
        rows = []
        for start, end in zip(case['boundaries'], case['boundaries'][1:]):
            source.set(cv2.CAP_PROP_POS_FRAMES, start)
            samples = []
            for frame in range(start, end):
                ok, image = source.read()
                if not ok:
                    raise ValueError(f'Cannot read {frame}F')
                row = observation(image, frame, case['region'], case['polarity'])
                if row:
                    samples.append({**row, 't': frame / fps})
            if not samples:
                continue
            fitted = fit_pose(samples)
            ref = next(row for row in samples if row['frame'] == fitted['shapeFrame'])
            rows.append(dict(reference=ref, tracks=fitted['tracks'], frames=[r['frame'] for r in samples],
                             shapeIoU=fitted['meanShapeIoU']))
        result.append(rows)
    source.release()
    Path(output).write_text(json.dumps(result, allow_nan=False), encoding='utf-8')


if __name__ == '__main__':
    main()
