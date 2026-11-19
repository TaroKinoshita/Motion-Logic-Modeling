"""Join visual labels to source IDs and report continuation opportunities."""
import argparse
from collections import Counter
import json
from pathlib import Path


ELIGIBLE = {'continued', 'grew'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('manifest', type=Path)
    parser.add_argument('labels', type=Path)
    args = parser.parse_args()
    data = json.loads(args.manifest.read_text(encoding='utf-8'))
    labels = json.loads(args.labels.read_text(encoding='utf-8'))
    windows = data['windows']
    if len(windows) != len(labels) or {row['id'] for row in windows} != labels.keys():
        raise ValueError('Review must cover exactly the sampled windows')
    for row in windows:
        status, reason = labels[row['id']]
        row.update(eligible=status in ELIGIBLE, review=status, note=reason)
    cohorts = {}
    for group in ('reference','control'):
        rows = [row for row in windows if row['group']==group]
        cohorts[group] = dict(windows=len(rows),eligible=sum(row['eligible'] for row in rows),
            clipsWithEligible=len({row['work'] for row in rows if row['eligible']}),
            reviewCounts=dict(Counter(row['review'] for row in rows)))
    out = args.manifest.with_name('opportunities.json')
    out.write_text(json.dumps({**data,'cohorts':cohorts},ensure_ascii=False,indent=2),encoding='utf-8')
    for group, row in cohorts.items():
        print(group, row)


if __name__ == '__main__':
    main()
