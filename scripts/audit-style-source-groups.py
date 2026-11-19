"""Check local source tags and screen for excerpt audio overlap with FFmpeg."""
import argparse
import hashlib
import itertools
import json
from pathlib import Path
import struct
import subprocess


MIN_OVERLAP = 24
DISTANCE = .14


def run(executable, *args):
    return subprocess.run([executable, *args],check=True,capture_output=True).stdout


def fingerprint(path, *time):
    payload = run('ffmpeg','-v','error',*time,'-i',path,'-map','0:a:0','-f','chromaprint','-fp_format','raw','-')
    return [word for (word,) in struct.iter_unpack('<I',payload)]


def compare(left, right):
    matches = []
    for offset in range(MIN_OVERLAP-len(right),len(left)-MIN_OVERLAP+1):
        start = max(0,offset)
        end = min(len(left),offset+len(right))
        differences = [(left[i]^right[i-offset]).bit_count()/32 for i in range(start,end)]
        if len(differences)<MIN_OVERLAP:
            continue
        # A short shared segment can be surrounded by different material.
        distances = [sum(differences[i:i+MIN_OVERLAP])/MIN_OVERLAP for i in range(len(differences)-MIN_OVERLAP+1)]
        best_start = min(range(len(distances)),key=distances.__getitem__)
        left_start = start+best_start
        support = left[left_start:left_start+MIN_OVERLAP]
        if len(set(support))<MIN_OVERLAP//2:
            continue
        matches.append(dict(distance=distances[best_start],offsetWords=offset,leftWord=left_start,rightWord=left_start-offset))
    return min(matches,key=lambda result:result['distance']) if matches else None


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('attribution',type=Path)
    parser.add_argument('out',type=Path)
    args=parser.parse_args()
    works=json.loads(args.attribution.read_text(encoding='utf-8'))['works']
    rows=[]
    prints={}
    for work in works:
        file=work['path']
        if hashlib.sha256(Path(file).read_bytes()).hexdigest()!=work['sourceSha256']:
            raise ValueError(f'Source identity changed: {file}')
        meta=json.loads(run('ffprobe','-v','error','-show_entries','format_tags:stream_tags','-of','json',file))
        tags=[meta.get('format',{}).get('tags',{}),*(stream.get('tags',{}) for stream in meta.get('streams',[]))]
        keys={'title','artist','album','album_artist','composer','publisher','comment','description','purl','copyright','author'}
        identity={key.lower():value for group in tags for key,value in group.items() if key.lower() in keys}
        prints[work['id']]=fingerprint(file)
        rows.append(dict(id=work['id'],sha256=work['sourceSha256'],identityTags=identity,
                         attributionBasis=work['credit'],originalWorkId=None,fingerprintWords=len(prints[work['id']])))
    long_clip=max(works,key=lambda work:work['durationSeconds'])
    original=fingerprint(long_clip['path'])
    excerpt=fingerprint(long_clip['path'],'-ss','2')
    control=compare(original,excerpt)
    assert control and control['distance']<=DISTANCE, control
    evidence=[]
    groups={row['id']:row['id'] for row in rows}
    for left,right in itertools.combinations(prints,2):
        result=compare(prints[left],prints[right])
        overlap=result is not None and result['distance']<=DISTANCE
        evidence.append(dict(left=left,right=right,matchCandidate=overlap,result=result))
        if overlap:
            old,new=groups[right],groups[left]
            groups.update({key:new for key,group in groups.items() if group==old})
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(dict(works=rows,positiveControl=control,positiveControlWork=long_clip['id'],
        minWords=MIN_OVERLAP,maxMeanBitDistance=DISTANCE,provisionalGroups=groups,pairs=evidence),indent=2),encoding='utf-8')
    print('Works, pairwise checks, overlap candidates:',len(rows),len(evidence),sum(row['matchCandidate'] for row in evidence))


if __name__=='__main__':
    main()
