"""Export the preselected frames with normalized guides and hidden cohort labels."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import runpy

import cv2
from PIL import Image, ImageDraw


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('prepared',type=Path)
    parser.add_argument('out',type=Path)
    parser.add_argument('--detector',type=Path)
    args=parser.parse_args()
    works=json.loads(args.prepared.read_text(encoding='utf-8'))['works']
    random.Random(20261120).shuffle(works)
    args.out.mkdir(parents=True,exist_ok=True)
    detector = None
    if args.detector:
        detector = runpy.run_path(str(Path(__file__).with_name('ppocr-text-candidates.py')))['Detector'](args.detector)
    private_map=[]
    candidates=[]
    for index,source in enumerate(works,1):
        tag=f'text-{index:03}'
        filename=Path(source['sourcePath'])
        with filename.open('rb') as file:
            if hashlib.file_digest(file,'sha256').hexdigest()!=source['sha256']:
                raise ValueError(f'Source changed on disk: {source["workId"]}')
        frames=source['textReviewFrames']
        count=len(frames)
        canvas=Image.new('RGB',(1280,207*((count+3)//4)),'#171717')
        guides=Image.new('RGB',canvas.size,'#171717')
        title=ImageDraw.Draw(canvas)
        marks=ImageDraw.Draw(guides)
        video=cv2.VideoCapture(str(filename))
        detections=[]
        try:
            for i,frame in enumerate(frames):
                video.set(cv2.CAP_PROP_POS_FRAMES,frame)
                ok,bgr=video.read()
                if not ok:
                    raise ValueError(f'Cannot read {source["workId"]}:{frame}')
                tile=Image.fromarray(cv2.cvtColor(cv2.resize(bgr,(320,180),interpolation=cv2.INTER_AREA),cv2.COLOR_BGR2RGB))
                x,y=i%4*320,i//4*207
                for panel,draw in ((canvas,title),(guides,marks)):
                    panel.paste(tile,(x,y+23))
                    draw.text((x+4,y+4),f'{tag} | {frame}F',fill='white')
                for line in range(1,10):
                    marks.line((x+32*line,y+23,x+32*line,y+202),fill='#74534d')
                    marks.line((x,y+23+18*line,x+319,y+23+18*line),fill='#74534d')
                if detector:
                    blocks,ms=detector.detect(bgr)
                    for label,block in enumerate(blocks,1):
                        left,top,width,height=block['box']
                        x1,y1=x+round(320*left),y+23+round(180*top)
                        x2,y2=x+round(320*(left+width)),y+23+round(180*(top+height))
                        marks.rectangle((x1,y1,x2,y2),outline='#f6b32e',width=2)
                        marks.text((x1,max(y+23,y1-12)),str(label),fill='#f6b32e',stroke_width=1,stroke_fill='#101010')
                    detections.append(dict(frame=frame,blocks=blocks,inferenceMs=ms))
        finally:
            video.release()
        canvas.save(args.out/f'{tag}.jpg',quality=93)
        guides.save(args.out/f'{tag}-grid.jpg',quality=93)
        private_map.append(dict(label=tag,workId=source['workId'],sha256=source['sha256'],frames=frames))
        if detector:
            candidates.append(dict(label=tag,frames=detections))
    (args.out/'source-map.json').write_text(json.dumps(private_map,ensure_ascii=False,indent=2),encoding='utf-8')
    if detector:
        positions = [[(frame['frame'],frame['blocks']) for frame in row['frames']] for row in candidates]
        fingerprint = hashlib.sha256(json.dumps([detector.sha256,private_map,positions],sort_keys=True).encode()).hexdigest()
        bundle = dict(reviewId=fingerprint,detectorSha256=detector.sha256,works=candidates)
        (args.out/'candidates.json').write_text(json.dumps(bundle,indent=2),encoding='utf-8')
        template = Path(__file__).with_name('style-text-review.html').read_text(encoding='utf-8')
        (args.out/'review.html').write_text(template.replace('/* CANDIDATE_DATA */ null',json.dumps(bundle)),encoding='utf-8')
    print('Exported sheets',len(private_map))


if __name__=='__main__':
    main()
