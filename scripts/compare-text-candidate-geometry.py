"""Compare OCR candidate geometry with separately recorded source boxes."""
import argparse
import hashlib
import json
from pathlib import Path
import runpy
from statistics import median

import cv2


# Source checkpoints reviewed at 480x270. The last eight were not used to
# choose the geometry-refinement rules. These are visual rect estimates.
CHECKPOINTS = (
    ('development','Lyricsample2',78,[(119,80,105,113),(260,80,104,112)]),
    ('development','Lyricsample3',85,[(186,121,25,26),(269,120,25,26)]),
    ('development','LyricOther6',73,[(49,89,83,80),(151,57,155,151),(332,96,85,80)]),
    ('development','LyricOther4',235,[(159,120,30,30),(284,121,27,29)]),
    ('additional','Lyricsample1',75,[(132,74,84,83),(265,78,80,81)]),
    ('additional','Lyricsample2',83,[(128,82,108,113),(265,82,104,112)]),
    ('additional','Lyricsample3',87,[(182,120,26,27),(272,120,25,26)]),
    ('additional','Lyricsample4',105,[(73,105,46,51),(123,125,111,16),(249,97,65,69)]),
    ('additional','Lyricsample6',128,[(19,84,419,119)]),
    ('additional','LyricOther2',254,[(157,97,164,77)]),
    ('additional','LyricOther5',425,[(208,55,62,61),(214,130,59,60)]),
    ('additional','LyricOther6',75,[(46,88,81,81),(151,59,157,150),(331,95,83,85)]),
)


def area(box):
    return box[2]*box[3]


def score(found,truth,intersection):
    predictions=[row['box'] for row in found]
    edges=[]
    for i, predicted in enumerate(predictions):
        for j, expected in enumerate(truth):
            shared=intersection(predicted,expected)
            iou=shared/(area(predicted)+area(expected)-shared)
            if iou>=.5:
                edges.append((iou,i,j))
    matched={}
    seen=set()
    for iou,i,j in sorted(edges,reverse=True):
        if i not in seen and j not in matched:
            matched[j]=dict(candidate=i+1,iou=iou,heightError=abs(predictions[i][3]/truth[j][3]-1))
            seen.add(i)
    merged=sum(sum(intersection(box,expected)>=area(expected)*.45 for expected in truth)>=2 for box in predictions)
    return dict(matches=list(matched.values()),covered=len(matched),missing=len(truth)-len(matched),
                mergedCandidates=merged,complete=len(matched)==len(truth),candidateCount=len(found),boxes=found)


def main():
    parser=argparse.ArgumentParser()
    for key in ('attribution','model','out'):
        parser.add_argument(key,type=Path)
    args=parser.parse_args()
    api=runpy.run_path(str(Path(__file__).with_name('ppocr-text-candidates.py')))
    detector=api['Detector'](args.model)
    works={w['id']:w for w in json.loads(args.attribution.read_text(encoding='utf-8'))['works']}
    rows=[]
    for split,name,frame,boxes in CHECKPOINTS:
        source=works[name]
        assert hashlib.sha256(Path(source['path']).read_bytes()).hexdigest()==source['sourceSha256']
        capture=cv2.VideoCapture(source['path'])
        capture.set(cv2.CAP_PROP_POS_FRAMES,frame)
        ok,raw=capture.read()
        capture.release()
        if not ok:
            raise ValueError(f'Cannot decode {name}:{frame}')
        truth=[[x/480,y/270,w/480,h/270] for x,y,w,h in boxes]
        measured={}
        for label,enabled in (('legacy',False),('refined',True)):
            items,ms=detector.detect(raw,refine=enabled)
            measured[label]={**score(items,truth,api['intersection']),'ms':ms}
        rows.append(dict(split=split,clip=name,frame=frame,sha256=source['sourceSha256'],truth=truth,**measured))
    summary={}
    for split in ('development','additional'):
        cases=[row for row in rows if row['split']==split]
        summary[split]={}
        for label in ('legacy','refined'):
            measured=[row[label] for row in cases]
            heights=[match['heightError'] for row in measured for match in row['matches']]
            summary[split][label]=dict(completeFrames=sum(row['complete'] for row in measured),frames=len(cases),
                matchedBlocks=sum(row['covered'] for row in measured),expectedBlocks=sum(len(row['truth']) for row in cases),
                mergedCandidates=sum(row['mergedCandidates'] for row in measured),heightErrorMedian=median(heights) if heights else None,
                cpuMilliseconds=median(row['ms'] for row in measured))
    args.out.write_text(json.dumps(dict(summary=summary,rows=rows),indent=2,allow_nan=False),encoding='utf-8')
    print(json.dumps(summary,indent=2))


if __name__=='__main__':
    main()
