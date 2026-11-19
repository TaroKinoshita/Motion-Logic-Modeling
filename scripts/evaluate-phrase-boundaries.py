"""Compare the observed next visible-text boundary to the scale choice."""
import argparse
import json
from pathlib import Path


# Bracketed by the sampled frames in the review strips. A new visible token
# counts even when the previous text stays on screen. Recoloring does not.
CHANGES = {
    'P02':(44,49), 'P04':(172,174), 'P07':(152,157), 'P11':(78,81),
    'P17':(326,328), 'P19':None, 'P20':None, 'P24':(80,82),
    'P25':None, 'P30':(432,435), 'P32':None, 'P34':(207,209),
    'P35':(335,340), 'P38':None, 'P39':None, 'P40':(108,111),
    'Lyricsample5-196':(204,208), 'Lyricsample5-280':(288,292),
    'Lyricsample6-128':None, 'Lyricsample6-273':None,
}
NEAR = .33


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('choices',type=Path)
    args = parser.parse_args()
    data = json.loads(args.choices.read_text(encoding='utf-8'))['rows']
    index = {row['id']:row for row in json.loads(args.choices.with_name('boundaries-index.json').read_text(encoding='utf-8'))}
    assert CHANGES.keys()==index.keys()
    rows = []
    for item in data:
        key = item['id']
        meta = index[key]
        start = item['anchorFrame']
        horizon = start+round(NEAR*meta['fps'])
        assert horizon in meta['frames']
        change = CHANGES[key]
        assert change is None or all(frame in meta['frames'] for frame in change)
        near = change is not None and change[1]<=horizon
        assert near or change is None or horizon<=change[0], f'Unresolved near-boundary classification: {key}'
        rows.append(dict(id=key,source=item['source'],cohort=item['cohort'],action=item['action'],
            anchorFrame=start,horizonFrame=horizon,firstVisibleChangeBracket=change,
            nearVisibleChange=near,lastSampleFrame=meta['frames'][-1]))
    summary = {}
    for cohort in ('uniform','discovery'):
        subset = [row for row in rows if row['cohort']==cohort]
        summary[cohort] = dict(rows=len(subset),near=sum(row['nearVisibleChange'] for row in subset),
            shrinkWhenNearCorrect=sum(row['action']==('deep-shrink' if row['nearVisibleChange'] else 'continue') for row in subset))
    args.choices.with_name('boundary-comparison.json').write_text(json.dumps(
        dict(horizonSeconds=NEAR,summary=summary,rows=rows),ensure_ascii=False,indent=2),encoding='utf-8')
    print(summary)


if __name__ == '__main__':
    main()
