"""Check simple choice rules without pooling discovery and sampled examples."""
import argparse
from collections import Counter
import json
from pathlib import Path


WIDE = .50
NARROW = .25
GROWTH = 1.40

# First frame of an identifiable, uninterrupted run of the target text in
# the reviewed lookback. Earlier frames can contain different or warped text.
READABLE_FROM = {
    'P02':31, 'P04':158, 'P07':134, 'P11':70, 'P17':314, 'P19':287, 'P20':36,
    'P24':71, 'P25':102, 'P30':424, 'P32':119, 'P34':198, 'P35':317, 'P38':204,
    'P39':232, 'P40':93,
    'Lyricsample5-196':193, 'Lyricsample5-280':277, 'Lyricsample6-128':119, 'Lyricsample6-273':263,
}


def context(row):
    start = READABLE_FROM[row['id']]
    assert row['frames'][0]['frame']<=start<=row['anchorFrame']
    history = [frame for frame in row['frames'] if start<=frame['frame']<=row['anchorFrame']]
    steps = []
    for left, right in zip(history,history[1:]):
        if left['box'] is None or right['box'] is None:
            continue
        changes = [new/old for old,new in zip(left['box'][2:],right['box'][2:])]
        if min(changes)>=GROWTH:
            steps.append(dict(fromFrame=left['frame'],toFrame=right['frame'],widthRatio=changes[0],heightRatio=changes[1]))
    complete = start==row['frames'][0]['frame'] and all(frame['box'] is not None for frame in history)
    if steps:
        growth = 'observed'
    else:
        growth = 'none-in-full-lookback' if complete else 'unknown-in-part-of-lookback'
    width = row['observedPreSize']['widthRatio']
    return dict(widthRatio=width,boxAreaRatio=row['observedPreSize']['boxAreaRatio'],wide=width>=WIDE,
                readableFromFrame=start,growth=growth,previousGrowthSteps=steps)


def result(rows, choices):
    return dict(correct=sum(actual['action']==guess for actual,guess in zip(rows,choices)),total=len(rows),
                predicted=dict(Counter(choices)))


def by_width(row):
    width = row['context']['widthRatio']
    if width >= WIDE:
        return 'deep-shrink'
    if width <= NARROW:
        return 'grow'
    return 'continue'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('measurements',type=Path)
    args = parser.parse_args()
    data = json.loads(args.measurements.read_text(encoding='utf-8'))
    rows = data['rows']
    for row in rows:
        row['context'] = context(row)
    cohorts = {}
    for name in ('uniform','discovery'):
        subset = [row for row in rows if row['cohort']==name]
        cohorts[name] = {
            'maintainOnly':result(subset,['continue']*len(subset)),
            'whenWideShrink':result(subset,['deep-shrink' if row['context']['wide'] else 'continue' for row in subset]),
            'threeWayByWidth':result(subset,[by_width(row) for row in subset]),
            'whenRecentGrowthShrink':result(subset,['deep-shrink' if row['context']['growth']=='observed' else 'continue' for row in subset]),
            'previousGrowthEvidence':dict(Counter(row['context']['growth'] for row in subset)),
        }
        print(name,cohorts[name])
    report = dict(shrinkWidthThreshold=WIDE,growWidthThreshold=NARROW,priorGrowthThresholdBothAxes=GROWTH,lookbackSeconds=data['lookbackSeconds'],
        cohorts=cohorts,rows=[{k:v for k,v in row.items() if k!='frames'} for row in rows])
    args.measurements.with_name('choice-comparison.json').write_text(
        json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')


if __name__ == '__main__':
    main()
