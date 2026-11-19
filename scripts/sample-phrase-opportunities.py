"""Create outcome-independent, native-frame samples for phrase review."""
import argparse
import hashlib
import json
from pathlib import Path
import random

import cv2
from PIL import Image, ImageDraw


FRACTIONS = (.2, .4, .6, .8)
SPAN = .20
EFFECTS_CLIP = 'Lyricsample7'
TILE_W, TILE_H, ROW_H = 224, 126, 150


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('attribution', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    inventory = json.loads(args.attribution.read_text(encoding='utf-8'))['works']
    windows = []
    thumbnails = {}
    for work in inventory:
        if work['id'] == EFFECTS_CLIP:
            continue
        source = Path(work['path'])
        if hashlib.sha256(source.read_bytes()).hexdigest() != work['sourceSha256']:
            raise ValueError(f'Source identity changed: {source}')
        capture = cv2.VideoCapture(str(source))
        fps = work['sourceFps']
        try:
            for fraction in FRACTIONS:
                center = round(fraction*(work['sourceFrames']-1))
                steps = round(SPAN*fps)
                start = center-steps//2
                frames = list(range(start,start+steps+1))
                key = (work['id'], fraction)
                windows.append(dict(work=work['id'], group=work['group'], fraction=fraction, frames=frames,
                                    fps=fps, sourceSha256=work['sourceSha256']))
                capture.set(cv2.CAP_PROP_POS_FRAMES,start)
                pictures = []
                for frame in frames:
                    ok, raw = capture.read()
                    if not ok:
                        raise ValueError(f'Cannot read {source} at {frame}F')
                    preview = cv2.resize(raw,(TILE_W,TILE_H),interpolation=cv2.INTER_AREA)
                    pictures.append(Image.fromarray(cv2.cvtColor(preview,cv2.COLOR_BGR2RGB)))
                thumbnails[key] = pictures
        finally:
            capture.release()
    random.Random(20261120).shuffle(windows)
    args.out.mkdir(parents=True,exist_ok=True)
    columns = max(map(len,thumbnails.values()))
    rows = 12
    for offset in range(0,len(windows),rows):
        subset = windows[offset:offset+rows]
        sheet = Image.new('RGB',(columns*TILE_W,len(subset)*ROW_H),'#181818')
        draw = ImageDraw.Draw(sheet)
        for index, row in enumerate(subset):
            row['id'] = f'P{offset+index+1:02d}'
            draw.text((6,index*ROW_H+4),row['id'],fill='white')
            for column, image in enumerate(thumbnails[row['work'],row['fraction']]):
                sheet.paste(image,(column*TILE_W,index*ROW_H+19))
        sheet.save(args.out/f'windows-{offset//rows+1}.jpg',quality=90)
    manifest = dict(sampleFractions=FRACTIONS,nominalSpanSeconds=SPAN,excluded=EFFECTS_CLIP,windows=windows)
    (args.out/'windows.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')


if __name__ == '__main__':
    main()
