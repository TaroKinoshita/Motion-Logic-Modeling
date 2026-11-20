"""Evaluate verified lyric blocks on preselected frames of paired works."""
import argparse
from collections import defaultdict
from fractions import Fraction
import hashlib
import itertools
import json
import math
from pathlib import Path


MIN_PAIRED_FRAMES = 6
HEIGHT_RATIO = 2
MIN_BLOCKS = 6
TARGET_BLOCKS = [10,15]


def validate_box(box):
    if (not isinstance(box,list) or len(box)!=4 or not all(isinstance(value,(int,float)) and math.isfinite(value) for value in box)):
        raise ValueError('Expected a normalized [left, top, width, height] box')
    x,y,w,h = box
    if min(x,y)<0 or min(w,h)<=0 or max(x+w,y+h)>1+1e-9:
        raise ValueError(f'Box outside the source frame: {box}')


def measure(source, review, background):
    name = source['workId']
    if source['sha256']!=review['sha256'] or source['sha256']!=background['sha256']:
        raise ValueError(f'Source changed since annotation: {name}')
    intervals = background['approvedBackgroundRanges']
    if any(not 0<=start<end<=source['durationSeconds'] for start,end in intervals):
        raise ValueError(f'Invalid background range: {name}')
    frames = review['frames']
    annotated = [frame['frame'] for frame in frames]
    if sorted(annotated)!=source['textReviewFrames']:
        raise ValueError(f'Text review must cover precisely the fixed sample frames: {name}')
    fps = float(Fraction(source['fps']))
    results = []
    for row in sorted(frames,key=lambda frame:frame['frame']):
        frame = row['frame']
        status = row['status']
        if status not in ('reviewed','unreadable'):
            raise ValueError(f'Unknown text status at {name}:{frame}')
        blocks = row.get('blocks',[])
        if status=='unreadable' and blocks:
            raise ValueError(f'Unreadable frame cannot supply measured blocks: {name}:{frame}')
        for block in blocks:
            if block['role'] not in ('lyric','ruby','subtitle','graphic','frame','uncertain'):
                raise ValueError(f'Unknown block type at {name}:{frame}')
            validate_box(block['box'])
        heights = sorted((block['box'][3] for block in blocks if block['role']=='lyric'),reverse=True)
        flat = any(start<=frame/fps<end for start,end in intervals)
        ratio = heights[0]/heights[1] if flat and status=='reviewed' and len(heights)>=2 and all(
            block['role']!='uncertain' for block in blocks) else None
        results.append(dict(frame=frame,plainBackground=flat,reviewStatus=status,mainTextBlocks=len(heights),
                            heightRatio=ratio,blocks=blocks))
    valid = [row['heightRatio'] for row in results if row['heightRatio'] is not None]
    return dict(id=name,sourceSha256=source['sha256'],group=source['role'],matchId=source['matchId'],
                holdoutGroup=source['holdoutGroup'],pairedTextFrames=len(valid),
                highContrastTextFrames=sum(value>=HEIGHT_RATIO-1e-12 for value in valid),frames=results)


def compare(measured):
    pairs = defaultdict(dict)
    for work in measured:
        pairs[work['matchId']][work['group']] = work
    effects = defaultdict(list)
    rows = []
    for match, pair in sorted(pairs.items()):
        reference,control=pair['reference'],pair['control']
        a,b=reference['pairedTextFrames'],control['pairedTextFrames']
        if a<MIN_PAIRED_FRAMES or b<MIN_PAIRED_FRAMES:
            rows.append(dict(matchId=match,reason='too few frames with two verified main lyric blocks',
                             referenceFrames=a,controlFrames=b))
            continue
        assert reference['holdoutGroup']==control['holdoutGroup']
        rate=reference['highContrastTextFrames']/a
        baseline=control['highContrastTextFrames']/b
        effects[reference['holdoutGroup']].append(rate-baseline)
        rows.append(dict(matchId=match,holdoutGroup=reference['holdoutGroup'],reference=rate,control=baseline,
                         difference=rate-baseline,referenceFrames=a,controlFrames=b))
    n=len(effects)
    data=dict(primary='share of reviewed frames with at least two main lyric blocks where the top two heights differ by at least 2x',
              fixedHeightRatio=HEIGHT_RATIO,fixedMinimumPairedFramesPerWork=MIN_PAIRED_FRAMES,
              pairs=rows,independentBlocks=n,minimumBlocksForTwoSidedPBelow05=MIN_BLOCKS,targetIndependentBlocks=TARGET_BLOCKS)
    if not n:
        return {**data,'status':'insufficient-eligible-blocks'}
    estimates=[sum(group)/len(group) for group in effects.values()]
    effect=sum(estimates)/n
    if n>20:
        raise ValueError('Exact enumeration is configured for at most 20 independent blocks')
    tail=sum(abs(sum(sign*value for sign,value in zip(signs,estimates))/n)>=abs(effect)-1e-12
             for signs in itertools.product((-1,1),repeat=n))
    total=2**n
    return {**data,'status':'evaluated' if n>=MIN_BLOCKS else 'small-sample-pilot','difference':effect,
            'asOrMoreExtreme':tail,'total':total,'p':tail/total,'minimumPossibleTwoSidedP':2/total}


def load_reviews(file,sources):
    result=json.loads(file.read_text(encoding='utf-8'))['works']
    if set(result)!={row['workId'] for row in sources}:
        raise ValueError(f'Review must cover the prepared works: {file}')
    return result


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('prepared',type=Path)
    parser.add_argument('out',type=Path)
    parser.add_argument('--background-review',type=Path)
    parser.add_argument('--text-review',type=Path)
    args=parser.parse_args()
    sources=json.loads(args.prepared.read_text(encoding='utf-8'))['works']
    measured=[]
    if not sources:
        result={'status':'awaiting-sources'}
    elif not args.background_review or not args.text_review:
        result={'status':'awaiting-reviewed-background-and-text'}
    else:
        backgrounds=load_reviews(args.background_review,sources)
        reviews=load_reviews(args.text_review,sources)
        text_provenance=json.loads(args.text_review.read_text(encoding='utf-8'))
        if not text_provenance.get('reviewId') or text_provenance.get('detectorSha256') != +                'a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d':
            raise ValueError('Use role judgments joined to the pinned detector candidates')
        for source in sources:
            name=source['workId']
            with Path(source['sourcePath']).open('rb') as file:
                if hashlib.file_digest(file,'sha256').hexdigest()!=source['sha256']:
                    raise ValueError(f'Source changed on disk: {name}')
            measured.append(measure(source,reviews[name],backgrounds[name]))
        result=compare(measured)
        result['textReviewId']=text_provenance['reviewId']
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps({**result,'measurements':measured},ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    print(result['status'],len(measured))


if __name__=='__main__':
    main()
