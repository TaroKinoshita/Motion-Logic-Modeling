"""Keep calibration and retrospective validation separate in the report."""
import argparse
import json
from pathlib import Path


CALIBRATION = {'Lyricsample5', 'Lyricsample6'}
EFFECTS = {'Lyricsample7'}
VISUAL_REVIEW = {
    ('Lyricsample5', 138): ('unmeasurable', '同じ「嘲られ」が縮む。直前に字形が画面端で切れ、語全体の幅を測れない。'),
    ('Lyricsample7', 190): ('effects-excluded', '同じ「蹴っ飛ばしたら」が縮む。エフェクトありの別枠。'),
    ('LyricOther5', 422): ('rejected', '「青」「に」の重なりが解け、字間が開く。語全体の縮小ではない。'),
    ('LyricOther5', 432): ('rejected', '「青に」から「混ざって」に交代する。'),
}


def judge(case):
    start = case['transitionFrame']
    frames = {row['frame']: row['boxes'] for row in case['observations']}
    ratios = {}
    drifts = {}
    for threshold in frames[start]:
        base = frames[start][threshold][2:]
        changed = frames[start+1][threshold][2:]
        ratios[threshold] = [current/previous for previous, current in zip(base,changed)]
        drifts[threshold] = [max(abs(frames[frame][threshold][axis+2]/side-1) for frame in (start+2,start+3))
                             for axis, side in enumerate(changed)]
    return dict(work=case['work'],text=case['text'],frame=start,ratios=ratios,drifts=drifts,
                passes=max(max(row) for row in ratios.values())<=.50 and max(max(row) for row in drifts.values())<=.02)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('screen', type=Path)
    parser.add_argument('checkpoints', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    works = json.loads(args.screen.read_text(encoding='utf-8'))['comparisons']
    checked = json.loads(args.checkpoints.read_text(encoding='utf-8'))
    assert all(next(work for work in works if work['id']==case['work'])['sourceSha256']==case['sourceSha256']
               for case in checked)
    comparisons = [judge(case) for case in checked if 'phrase scale step' in case['category']]
    by_work = {work['id']:work for work in works}
    for case in comparisons:
        case['screened'] = any(row['startFrame']==case['frame'] for row in by_work[case['work']]['deepShrinkScreen'])
    direct = {(case['work'],case['frame']):case for case in comparisons}
    for work in works:
        for row in work['deepShrinkScreen']:
            key = (work['id'],row['startFrame'])
            if key in direct:
                row['review'] = dict(status='confirmed' if direct[key]['passes'] else 'rejected', basis='source checkpoint')
            else:
                status, note = VISUAL_REVIEW.get(key,('unreviewed',''))
                row['review'] = dict(status=status,note=note)
    groups = {'calibration':CALIBRATION, 'referenceReview':{w['id'] for w in works if w['group']=='reference'}-CALIBRATION-EFFECTS,
              'controlReview':{w['id'] for w in works if w['group']=='control'}, 'effectsReview':EFFECTS}
    counts = {}
    for label, members in groups.items():
        counts[label] = [dict(work=work['id'],frames=work['sourceFrames'],framesWithRegions=work['framesWithRegions'],
                              events=[dict(frame=row['startFrame'],**row['review']) for row in work['deepShrinkScreen']])
                         for work in works if work['id'] in members]
    result = dict(criteria=dict(maxWidthAndHeightRatio=.50,maxPerAxisDrift=.02,holdFramesAfterChange=2),
                  cohorts=counts, reviewedSourceCheckpoints=comparisons,
                  scope='screening results, with source adjudication only for listed checkpoints')
    args.out.write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')


if __name__ == '__main__':
    main()
