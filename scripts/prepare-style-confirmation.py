"""Validate a source manifest and choose fixed, paired windows without using pictures."""
import argparse
from collections import defaultdict
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import random
import subprocess


STRATA = ((0,1/3),(1/3,2/3),(2/3,1))
SPAN = 5
SEED = 20261120
TEXT_SAMPLE_OFFSETS = (.5,1.5,2.5,3.5,4.5)


def media(path):
    args = ['ffprobe','-v','error','-select_streams','v:0','-show_entries',
            'format=duration:stream=avg_frame_rate,duration','-of','json',str(path)]
    result = json.loads(subprocess.run(args,check=True,capture_output=True).stdout)
    stream = result['streams'][0]
    return float(stream.get('duration',result['format']['duration'])),stream['avg_frame_rate']


def prepare(rows, base, known_hashes):
    fields = ('workId','title','sourcePath','credit','creditEvidence','songId','language','genre','matchId','role')
    records, pairs = [], defaultdict(list)
    seen_hashes = set()
    seen_works = set()
    for item in rows:
        missing = [key for key in fields if not isinstance(item.get(key),str) or not item[key].strip()]
        if missing:
            raise ValueError(f'Incomplete source row {item.get("workId")}: {missing}')
        if item['role'] not in ('reference','control'):
            raise ValueError(f'Unknown source role for {item["workId"]}')
        source = (base/Path(item['sourcePath'])).resolve(strict=True)
        with source.open('rb') as fd:
            digest = hashlib.file_digest(fd,'sha256').hexdigest()
        if item['workId'] in seen_works or digest in seen_hashes or digest in known_hashes:
            raise ValueError(f'Repeated or previously reviewed source: {item["workId"]}')
        seen_works.add(item['workId'])
        seen_hashes.add(digest)
        duration,fps = media(source)
        if duration<SPAN:
            raise ValueError(f'Too short for the five-second window: {item["workId"]}')
        row = {**item,'sourcePath':str(source),'sha256':digest,'durationSeconds':duration,'fps':fps}
        records.append(row)
        pairs[item['matchId']].append(row)

    for match,pair in sorted(pairs.items()):
        if sorted(row['role'] for row in pair)!=['control','reference']:
            raise ValueError(f'Match {match} must contain one reference and one control work')
        if len({(row['language'],row['genre']) for row in pair})!=1:
            raise ValueError(f'Check language and genre for match {match}')
        rng = random.Random(f'{SEED}:{match}')
        fractions = [rng.uniform(start,end) for start,end in STRATA]
        for row in pair:
            row['windows'] = [dict(relativeStart=fraction,startSeconds=fraction*(row['durationSeconds']-SPAN),
                                   durationSeconds=SPAN) for fraction in fractions]
            fps = float(Fraction(row['fps']))
            if fps<=0:
                raise ValueError(f'Invalid frame rate: {row["workId"]}')
            row['textReviewFrames'] = sorted({round((window['startSeconds']+offset)*fps)
                                              for window in row['windows'] for offset in TEXT_SAMPLE_OFFSETS})
    # Any known song or series relationship is kept together on hold-out.
    memberships = {row['workId']:{row['workId']} for row in records}
    for key in ('songId','seriesId','matchId'):
        first = {}
        for row in records:
            value = row.get(key,'').strip()
            if value:
                cluster = memberships[row['workId']]
                if value in first:
                    cluster = cluster | memberships[first[value]]
                    for member in cluster:
                        memberships[member] = cluster
                else:
                    first[value] = row['workId']
    for row in records:
        row['holdoutGroup'] = min(memberships[row['workId']])
    return dict(spanSeconds=SPAN,seed=SEED,works=records,matchedPairs=len(pairs),status='prepared' if records else 'awaiting-sources')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('manifest',type=Path)
    parser.add_argument('prior_attribution',type=Path)
    parser.add_argument('out',type=Path)
    args=parser.parse_args()
    manifest=json.loads(args.manifest.read_text(encoding='utf-8'))
    prior=json.loads(args.prior_attribution.read_text(encoding='utf-8'))
    result=prepare(manifest['works'],args.manifest.parent,{row['sourceSha256'] for row in prior['works']})
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(result['status'],len(result['works']),result['matchedPairs'])


if __name__=='__main__':
    main()
