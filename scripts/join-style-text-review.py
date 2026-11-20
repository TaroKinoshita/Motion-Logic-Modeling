"""Attach blind role judgments to the exact boxes and original source IDs."""
import argparse
import hashlib
import json
from pathlib import Path


ROLES = {'lyric','ruby','subtitle','graphic','frame','discard'}


def join(candidates,judgments,private):
    if candidates['reviewId']!=judgments['reviewId']:
        raise ValueError('Roles belong to a different review bundle')
    positions = [[(frame['frame'],frame['blocks']) for frame in row['frames']] for row in candidates['works']]
    fingerprint = hashlib.sha256(json.dumps([candidates['detectorSha256'],private,positions],sort_keys=True).encode()).hexdigest()
    if fingerprint!=candidates['reviewId']:
        raise ValueError('Boxes or source map changed since export')
    aliases = {row['label']:row for row in private}
    works = {row['label']:row for row in candidates['works']}
    if set(aliases)!=set(works) or set(works)!=set(judgments['works']):
        raise ValueError('Missing or unexpected source aliases')
    results = {}
    for alias, work in works.items():
        input_frames=work['frames']
        labels=judgments['works'][alias]
        original=aliases[alias]
        if [row['frame'] for row in input_frames]!=[row['frame'] for row in labels] or [
                row['frame'] for row in labels]!=original['frames']:
            raise ValueError(f'Frame selection changed: {alias}')
        reviewed=[]
        for source,row in zip(input_frames,labels):
            roles=row['roles']
            blocks=[]
            if row['status']=='reviewed' and len(roles)==len(source['blocks']) and set(roles)<=ROLES:
                blocks=[{'role':role,'box':box['box']} for role,box in zip(roles,source['blocks']) if role!='discard']
            elif row['status']!='unreadable' or roles:
                raise ValueError(f'Invalid review for {alias}:{row["frame"]}')
            reviewed.append(dict(frame=row['frame'],status=row['status'],blocks=blocks))
        results[original['workId']]=dict(sha256=original['sha256'],frames=reviewed)
    return dict(works=results,reviewId=candidates['reviewId'],detectorSha256=candidates['detectorSha256'])


def main():
    parser=argparse.ArgumentParser()
    for key in ('candidates','roles','private_map','out'):
        parser.add_argument(key,type=Path)
    args=parser.parse_args()
    read=lambda file:json.loads(file.read_text(encoding='utf-8'))
    data=join(read(args.candidates),read(args.roles),read(args.private_map))
    args.out.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Joined',len(data['works']))


if __name__=='__main__':
    main()
