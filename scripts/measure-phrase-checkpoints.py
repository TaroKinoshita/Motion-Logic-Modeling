"""Measure reviewed text regions at source resolution using several thresholds."""
import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


# Regions isolate all the main glyphs being measured, omitting subtitles and
# unrelated neighbors. Coordinates are fractions of the original image.
CASES = (
    ('Lyricsample2', '青', range(77, 88), (0.10, 0.24, 0.50, 0.75), 'dark', 'glyph arrival and settling', 77),
    ('Lyricsample5', '顔が', range(52, 57), (0.29, 0.30, 0.71, 0.69), 'dark', 'phrase scale step', 52),
    ('Lyricsample5', 'ユラユラ', range(195, 201), (0.24, 0.34, 0.76, 0.66), 'light', 'phrase scale step', 196),
    ('Lyricsample5', 'カラカラ', range(279, 285), (0.24, 0.34, 0.76, 0.66), 'light', 'phrase scale step', 280),
    ('Lyricsample6', 'やめろよ', range(126, 133), (0.025, 0.27, 0.98, 0.76), 'dark', 'phrase scale step', 128),
    ('Lyricsample6', '回った', range(271, 279), (0.13, 0.26, 0.90, 0.79), 'dark', 'phrase scale step', 273),
    ('LyricOther2', '余計', range(252, 260), (0.27, 0.32, 0.73, 0.69), 'light', 'phrase scale step', 254),
    ('LyricOther4', '痛い', range(282, 288), (0.23, 0.27, 0.77, 0.78), 'color', 'phrase scale step and recolor', 283),
    ('LyricOther4', '痛い', range(310, 315), (0.23, 0.27, 0.77, 0.78), 'light', 'held phrase', 310),
)


def box(image, region, mode, threshold):
    height, width = image.shape[:2]
    left, top, right, bottom = [round(fraction*size) for fraction, size in zip(region, (width,height,width,height))]
    crop = image[top:bottom,left:right]
    if mode == 'color':
        difference = np.abs(crop.astype(float)-np.median(crop,axis=(0,1))).max(axis=2)
        rows, cols = np.where(difference > threshold)
    else:
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        if mode == 'light':
            gray = 255-gray
        rows, cols = np.where(gray < np.percentile(gray,90) - threshold)
    if not len(cols):
        raise ValueError('No foreground at a reviewed checkpoint')
    return [left+int(cols.min()), top+int(rows.min()), int(np.ptp(cols))+1, int(np.ptp(rows))+1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('attribution', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    works = {work['id']:work for work in json.loads(args.attribution.read_text(encoding='utf-8'))['works']}
    checked = set()
    result = []
    canvas = Image.new('RGB', (5*256, len(CASES)*170), '#181818')
    labels = ImageDraw.Draw(canvas)
    for work_id, text, frames, region, mode, category, transition in CASES:
        work = works[work_id]
        path = work['path']
        if work_id not in checked:
            assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == work['sourceSha256']
            checked.add(work_id)
        capture = cv2.VideoCapture(path)
        capture.set(cv2.CAP_PROP_POS_FRAMES, frames.start)
        observations = []
        review_frames = sorted({frames.start, transition, transition+1, min(transition+3,frames.stop-1),frames.stop-1})
        y = len(result)*170
        labels.text((6,y+4), f'{work_id} | {category}', fill='white')
        try:
            for frame in frames:
                ok, image = capture.read()
                if not ok:
                    raise ValueError(f'Cannot read frame {frame} of {path}')
                observations.append(dict(frame=frame,width=image.shape[1],height=image.shape[0],
                    boxes={str(level):box(image,region,mode,level) for level in (40,50,60)}))
                if frame in review_frames:
                    x = review_frames.index(frame)*256
                    tile = cv2.resize(cv2.cvtColor(image, cv2.COLOR_BGR2RGB), (256,144), interpolation=cv2.INTER_AREA)
                    canvas.paste(Image.fromarray(tile),(x,y+20))
                    labels.text((x+6,y+22), f'{frame}F', fill='white', stroke_width=1, stroke_fill='black')
        finally:
            capture.release()
        result.append(dict(work=work_id, group=work['group'], text=text, category=category, transitionFrame=transition,
            sourceSha256=work['sourceSha256'], fps=work['sourceFps'], roi=region, thresholdMode=mode, observations=observations))
    args.out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    canvas.save(args.out.with_name('reviewed-checkpoints.jpg'), quality=92)


if __name__ == '__main__':
    main()
