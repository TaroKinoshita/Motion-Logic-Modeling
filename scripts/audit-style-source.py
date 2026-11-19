"""Re-measure selected source regions without using project or rendered-scene geometry."""
import hashlib
import json
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'workers/track/track'))
from representative_affine import mask, search


def audited_box(image, roi, threshold):
    x, y, w, h = roi
    gray = cv2.cvtColor(image[y:y+h, x:x+w], cv2.COLOR_BGR2GRAY)
    mask = gray < np.percentile(gray, 90) - threshold
    rows, cols = np.nonzero(mask)
    if not len(cols):
        raise ValueError('No foreground in selected region')
    return [x+int(cols.min()), y+int(rows.min()), int(np.ptp(cols))+1, int(np.ptp(rows))+1]

def silhouette(image, light):
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image[h//4:3*h//4, :], cv2.COLOR_BGR2GRAY)
    if light:
        gray = 255-gray
    foreground = np.uint8(gray < np.percentile(gray, 90)-50)
    contours, _ = cv2.findContours(foreground, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    paths = [c.reshape(-1, 2) for c in contours if cv2.contourArea(c) >= 12]
    vertices = np.concatenate(paths)
    low, high = vertices.min(axis=0), vertices.max(axis=0)
    return [(p-low)/(high-low)-.5 for p in paths]


def shape_checks(file):
    capture = cv2.VideoCapture(file)
    results = []
    try:
        for anchor, targets, light in [(129, [130, 131], False), (144, [147, 150], True)]:
            paths = []
            for frame in [anchor, *targets]:
                capture.set(cv2.CAP_PROP_POS_FRAMES, frame)
                ok, image = capture.read()
                if not ok:
                    raise ValueError(f'Cannot read shape frame {frame}')
                paths.append(silhouette(image, light))
            for frame, observed in zip(targets, paths[1:]):
                axis, (fitted, _, _) = search(paths[0], mask(observed), False)
                results.append(dict(anchorFrame=anchor, frame=frame, axisAlignedIoU=axis, fittedIoU=fitted,
                                    unexplainedOverlap=1-fitted))
    finally:
        capture.release()
    return results


def main():
    inventory, report, out = map(Path, sys.argv[1:])
    materials = {row['sample']: row for row in json.loads(inventory.read_text(encoding='utf-8'))}
    historical = json.loads(report.read_text(encoding='utf-8'))
    selections = [
        (1, [80, 81, 82], None, 'parts-to-result'),
        (2, [75, 76, *range(77, 88)], [210, 260, 780, 560], 'large-left-glyph'),
        (4, [96, 103, 104, 112], None, 'retained-lead'),
        (6, [126, 127, 128, 129, 130, 131], [0, 280, 1920, 570], 'retained-phrase'),
    ]
    results, tiles = {}, []
    for number, frames, roi, label in selections:
        source = materials[number]
        if hashlib.sha256(Path(source['path']).read_bytes()).hexdigest() != source['sha256']:
            raise ValueError(f'Source identity changed in sample {number}')
        capture = cv2.VideoCapture(source['path'])
        rows = []
        try:
            for frame in frames:
                capture.set(cv2.CAP_PROP_POS_FRAMES, frame)
                ok, image = capture.read()
                if not ok:
                    raise ValueError(f'Cannot read {number}:{frame}')
                boxes = ({str(threshold): audited_box(image, roi, threshold) for threshold in (40, 50, 60)}
                         if roi and (number != 2 or frame >= 77) else None)
                rows.append(dict(frame=frame, boxes=boxes))
                if frame in (80, 81, 82, 75, 76, 77, 78, 87, 103, 104, 112, 128, 129, 130):
                    tiles.append((f'Lyricsample{number}  {frame}F', cv2.resize(image, (320, 180), interpolation=cv2.INTER_AREA)))
        finally:
            capture.release()
        results[label] = dict(sample=number, sourceSha256=source['sha256'], roi=roi, frames=rows)

    def metrics(threshold):
        two = {row['frame']: row['boxes'][threshold] for row in results['large-left-glyph']['frames'] if row['boxes']}
        six = {row['frame']: row['boxes'][threshold] for row in results['retained-phrase']['frames']}
        center = lambda frame: two[frame][0] + (two[frame][2]-1)/2
        return dict(arrivalDxPx=center(78)-center(77),
                    settledMaxDxPx=max(abs(center(f)-center(f-1)) for f in range(82, 88)),
                    heightRatio128To129=six[128][3]/six[129][3])
    numerical = {str(value): metrics(str(value)) for value in (40, 50, 60)}
    out.mkdir(parents=True, exist_ok=True)
    canvas = Image.new('RGB', (1280, 201*((len(tiles)+3)//4)), '#181818')
    draw = ImageDraw.Draw(canvas)
    for i, (label, image) in enumerate(tiles):
        x, y = i%4*320, i//4*201
        draw.text((x+5, y+4), label, fill='white')
        canvas.paste(Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB)), (x, y+20))
    canvas.save(out / 'source-checkpoints.jpg', quality=93)
    old = next(row['values'] for row in historical['measures'] if row['sample'] == 2)
    (out / 'source-audit.json').write_text(json.dumps({
        'method': 'source frames only; independently selected regions and three luminance thresholds; same reviewer',
        'recheck': numerical, 'priorSample2': old, 'cases': results,
        'shapePilot': {'sample': 6, 'method': 'tight-box normalized silhouettes and the existing bounded affine search',
                       'rows': shape_checks(materials[6]['path'])},
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(numerical, ensure_ascii=False))


if __name__ == '__main__':
    main()
