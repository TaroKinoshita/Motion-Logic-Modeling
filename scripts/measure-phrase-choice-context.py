"""Measure context available before a sampled phrase-scale decision."""
import argparse
import hashlib
import json
from pathlib import Path
import runpy

import cv2
import numpy as np
from PIL import Image, ImageDraw


BOX = runpy.run_path(str(Path(__file__).with_name('measure-phrase-checkpoints.py')))['box']
LOOKBACK = .33

# Bounding regions are fractions of the original image. They limit measurement
# to the main lyric and leave surrounding graphics outside where possible.
REGIONS = {
    'P02': ((.28,.42,.71,.57),'light'),
    'P04': ((.30,.40,.69,.57),'light'),
    'P07': ((.43,.23,.88,.77),'dark'),
    'P11': ((.06,.14,.96,.83),'light'),
    'P17': ((.28,.34,.68,.71),'bright-white'),
    'P19': ((.18,.36,.80,.68),'white'),
    'P20': ((.27,.30,.76,.64),'white',40),
    'P24': ((.25,.27,.77,.61),'dark'),
    'P25': ((.16,.32,.62,.70),'white'),
    'P30': ((.34,.20,.67,.92),'color'),
    'P32': ((.025,.27,.98,.76),'dark',119),
    'P34': ((.418,.435,.536,.556),'dark'),
    'P35': ((.17,.23,.79,.88),'white'),
    'P38': ((.17,.45,.82,.59),'white'),
    'P39': ((.16,.24,.86,.78),'white'),
    'P40': ((.40,.42,.60,.56),'white'),
}
DISCOVERY_REGIONS = {
    ('Lyricsample5',196): ((.24,.34,.76,.66),'light'),
    ('Lyricsample5',280): ((.24,.34,.76,.66),'light'),
    ('Lyricsample6',128): ((.025,.27,.98,.76),'dark'),
    ('Lyricsample6',273): ((.13,.26,.90,.79),'dark'),
}


def measured_box(image, roi, mode):
    if mode not in ('white', 'bright-white'):
        try:
            return BOX(image,roi,mode,40)
        except ValueError:
            return None
    height,width = image.shape[:2]
    left,top,right,bottom = [round(fraction*size) for fraction,size in zip(roi,(width,height,width,height))]
    rgb = image[top:bottom,left:right]
    level, saturation = (205, 25) if mode=='bright-white' else (175, 45)
    rows,cols = np.where((rgb.min(axis=2)>=level)&((rgb.max(axis=2)-rgb.min(axis=2))<=saturation))
    if not len(cols):
        return None
    return [left+int(cols.min()),top+int(rows.min()),int(np.ptp(cols))+1,int(np.ptp(rows))+1]


def read_context(work, anchor, roi, mode):
    fps = work['sourceFps']
    left = max(0,anchor-round(LOOKBACK*fps))
    capture = cv2.VideoCapture(work['path'])
    capture.set(cv2.CAP_PROP_POS_FRAMES,left)
    rows, views = [], []
    try:
        for frame in range(left,anchor+2):
            ok, image = capture.read()
            if not ok:
                raise ValueError(f'Cannot read {work["id"]}:{frame}')
            height,width = image.shape[:2]
            rect = measured_box(image,roi,mode)
            rows.append(dict(frame=frame,box=rect))
            if frame in (left,(anchor+left)//2,anchor-1,anchor,anchor+1):
                views.append((frame,cv2.resize(image,(240,135),interpolation=cv2.INTER_AREA),rect,(width,height)))
    finally:
        capture.release()
    return rows, views


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('attribution', type=Path)
    parser.add_argument('opportunities', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    works = {work['id']:work for work in json.loads(args.attribution.read_text(encoding='utf-8'))['works']}
    selected = [row for row in json.loads(args.opportunities.read_text(encoding='utf-8'))['windows'] if row['eligible']]
    assert {row['id'] for row in selected}==REGIONS.keys()
    cases = []
    for row in selected:
        roi,mode,*override = REGIONS[row['id']]
        anchor = override[0] if override else row['frames'][len(row['frames'])//2]
        cases.append((row['id'],row['work'],anchor,roi,mode,'grow' if row['review']=='grew' else 'continue','uniform'))
    for (work,anchor),(roi,mode) in DISCOVERY_REGIONS.items():
        cases.append((f'{work}-{anchor}',work,anchor,roi,mode,'deep-shrink','discovery'))
    checked = set()
    results = []
    images = []
    for name,source,anchor,roi,mode,action,cohort in cases:
        work = works[source]
        if source not in checked:
            assert hashlib.sha256(Path(work['path']).read_bytes()).hexdigest()==work['sourceSha256']
            checked.add(source)
        rows, views = read_context(work,anchor,roi,mode)
        width,height = views[-1][3]
        rect = rows[-2]['box']
        size = None if rect is None else dict(widthRatio=rect[2]/width,heightRatio=rect[3]/height,boxAreaRatio=rect[2]*rect[3]/(width*height))
        results.append(dict(id=name,source=source,group=work['group'],sourceSha256=work['sourceSha256'],
             anchorFrame=anchor,cohort=cohort,action=action,roi=roi,segmentation=mode,observedPreSize=size,frames=rows))
        images.append(views)
    args.out.mkdir(parents=True,exist_ok=True)
    for offset in range(0,len(results),10):
        subset = results[offset:offset+10]
        sheet = Image.new('RGB',(1200,len(subset)*159),'#171717')
        draw = ImageDraw.Draw(sheet)
        for index,(item,views) in enumerate(zip(subset,images[offset:offset+10])):
            y = index*159
            draw.text((5,y+4),f'{item["id"]} | {item["source"]} | {item["action"]}',fill='white')
            for j,(frame,picture,rect,(width,height)) in enumerate(views):
                if rect:
                    x0,y0,w,h = rect
                    cv2.rectangle(picture,(round(240*x0/width),round(135*y0/height)),
                                  (round(240*(x0+w)/width),round(135*(y0+h)/height)),(72,235,80),1)
                x = j*240
                sheet.paste(Image.fromarray(cv2.cvtColor(picture,cv2.COLOR_BGR2RGB)),(x,y+19))
                draw.text((x+5,y+22),f'{frame}F',fill='white',stroke_width=1,stroke_fill='black')
        sheet.save(args.out/f'context-{offset//10+1}.jpg',quality=92)
    path = args.out/'measurements.json'
    path.write_text(json.dumps(dict(lookbackSeconds=LOOKBACK,rows=results),ensure_ascii=False,indent=2),encoding='utf-8')


if __name__ == '__main__':
    main()
