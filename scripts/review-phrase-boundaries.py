"""Create source contact sheets for the next lyric-display boundary."""
import argparse
import json
import hashlib
from pathlib import Path

import cv2
from PIL import Image, ImageDraw


OFFSETS = (0, .08, .16, .25, .33, .50, .67)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('attribution', type=Path)
    parser.add_argument('choices', type=Path)
    args = parser.parse_args()
    works = {row['id']:row for row in json.loads(args.attribution.read_text(encoding='utf-8'))['works']}
    choices = json.loads(args.choices.read_text(encoding='utf-8'))['rows']
    folder = args.choices.parent
    checked = set()
    index = []
    for offset in range(0,len(choices),10):
        subset = choices[offset:offset+10]
        canvas = Image.new('RGB',(len(OFFSETS)*216,len(subset)*147),'#191919')
        draw = ImageDraw.Draw(canvas)
        for row, item in enumerate(subset):
            work = works[item['source']]
            source = Path(work['path'])
            if source not in checked:
                if hashlib.sha256(source.read_bytes()).hexdigest() != item['sourceSha256']:
                    raise ValueError(f'Source identity changed: {source}')
                checked.add(source)
            fps = work['sourceFps']
            frames = [min(work['sourceFrames']-1,item['anchorFrame']+round(delta*fps)) for delta in OFFSETS]
            index.append(dict(id=item['id'],source=item['source'],frames=frames,fps=fps))
            capture = cv2.VideoCapture(str(source))
            try:
                for column, frame in enumerate(frames):
                    capture.set(cv2.CAP_PROP_POS_FRAMES,frame)
                    ok, image = capture.read()
                    if not ok:
                        raise ValueError(f'Cannot read {source}:{frame}')
                    tile = cv2.resize(cv2.cvtColor(image,cv2.COLOR_BGR2RGB),(216,122),interpolation=cv2.INTER_AREA)
                    x,y = column*216,row*147
                    canvas.paste(Image.fromarray(tile),(x,y+18))
                    draw.text((x+6,y+23),f'{frame}F',fill='white',stroke_width=1,stroke_fill='black')
            finally:
                capture.release()
            draw.text((6,row*147+4),f'{item["id"]} | {item["source"]}',fill='white')
        canvas.save(folder/f'boundaries-{offset//10+1}.jpg',quality=91)
    (folder/'boundaries-index.json').write_text(json.dumps(index,indent=2),encoding='utf-8')


if __name__ == '__main__':
    main()
