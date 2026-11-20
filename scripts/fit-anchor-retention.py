"""Measure visible anchor choices and compare held-out weighted decisions."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import runpy

import cv2
import numpy as np


# Same readable anchor survives until the new text appears (retain), or
# disappears (switch). Ambiguous identity and missing anchors are excluded.
REVIEWS={
 'P02':('switch','得意げにから染へ'), 'P04':('retain','ありふれた夜のが次の語と同居'),
 'P07':('switch','白・歪からdonutsへ'), 'P11':('uncertain','同じ字の並べ替えと要素IDを判別できない'),
 'P17':('retain','先行するああが別の語と同居'), 'P24':('other','食と反は同一字の保持と区別して合字に分類'),
 'P30':('switch','青にから混ざってへ'), 'P34':('retain','夢をを残して語を追加'),
 'P35':('retain','あぁを残して別の語が加わる'), 'P40':('switch','フォーカスが消えて別の文字に交代'),
 'Lyricsample5-196':('other','主な文字が消え、新しい文字が見えない'),
 'Lyricsample5-280':('switch','カラカラが消え、なに切り替わる'),
 'P06':('retain','むきが残り出してが加わる'), 'P09':('retain','どと分を残して文末に文字が加わる'),
 'P10':('switch','別の文から感と動に切り替わる'), 'P12':('uncertain','先行する問いの一部が画面端で欠けている'),
 'P13':('switch','顔がからおへ切り替わる'), 'P15':('uncertain','らの継続か置換か確かめられない'),
 'P16':('other','次の主役が人物図形'), 'P18':('switch','がから枠内の2字に切り替わる'),
 'P28':('uncertain','画面端で先行文字が欠ける'), 'P29':('uncertain','先行文字が欠け、小字の同一性も不明'),
 'P37':('retain','輪の左側に今が残り日が加わる'), 'P41':('uncertain','前後の主要字が画面端にかかる'),
 'P42':('switch','先行する2字が消え、でまで順に切り替わる'),
 'P44':('other','直前が空白で、直後も可読文字がない'),
 'P45':('switch','もうが消え、続くやっが見える'),
 'P46':('other','先行する主役が図形で保持する本文がない'),
 'P47':('uncertain','先行字が画面下で欠ける'), 'P48':('switch','複数の字が消え、乗が出る'),
}
NAMES=('foregroundCoverage','regionCount','heightContrast','largestExtent','centerDistance','recentPixelChange')


def before(source, frame, features, width, height):
    capture=cv2.VideoCapture(source['path'])
    previews=[]
    try:
        for index in (max(0,frame-2),frame):
            capture.set(cv2.CAP_PROP_POS_FRAMES,index)
            ok,img=capture.read()
            if not ok:
                raise ValueError(f'Cannot read {source["id"]}:{index}')
            previews.append(cv2.resize(img,(width,height),interpolation=cv2.INTER_AREA))
    finally:
        capture.release()
    _,values=features(previews[1],'row')
    delta=cv2.absdiff(*previews).max(axis=2)
    return [*(float(value) if np.isfinite(value) else None for value in values),float((delta>40).mean())]


def fit_matrix(data,target,index,fit,standardize):
    if len(set(target[fit]))<2:
        return None
    values=standardize(data,fit)
    train=np.column_stack([np.ones(fit.sum()),values[fit]])
    weights=np.linalg.solve(train.T@train+np.diag([0,*([4]*data.shape[1])]),train.T@(target[fit]-.5))
    margin=float(np.r_[1,values[index]]@weights)
    return dict(prediction='retain' if margin>0 else 'switch',margin=margin,
                weights=dict(zip(('bias',*NAMES),weights.tolist())))


def evaluate(rows,groups,standardize):
    selected=[r for r in rows if r['choice'] in ('retain','switch')]
    data=np.array([r['beforeFeatures'] for r in selected],dtype=float)
    labels=np.array([int(r['choice']=='retain') for r in selected])
    work_groups=np.array([groups[r['work']] for r in selected])
    references=np.array([r['group']=='reference' for r in selected])
    predictions=[]
    for i,row in enumerate(selected):
        fit=work_groups!=work_groups[i]
        predictions.append(dict(id=row['id'],work=row['work'],group=row['group'],choice=row['choice'],
             fixedWhenCueUnknown='switch',learned=fit_matrix(data,labels,i,fit,standardize),
             learnedReferenceOnly=fit_matrix(data,labels,i,fit&references,standardize) if references[i] else None))
    summary={}
    for name,subset,field in [('pooled',predictions,'learned'),
                               ('referenceOnly',[r for r in predictions if r['group']=='reference'],'learnedReferenceOnly')]:
        scored=[r for r in subset if r[field] is not None]
        metrics={}
        for method in ('fixedWhenCueUnknown',field):
            predict=lambda r: r[method] if isinstance(r[method],str) else r[method]['prediction']
            counts={label:[sum(predict(r)==label for r in scored if r['choice']==label),
                           sum(r['choice']==label for r in scored)] for label in ('switch','retain')}
            metrics[method]=dict(correct=sum(hit for hit,_ in counts.values()),total=len(scored),byChoice=counts)
        summary[name]=dict(available=len(subset),unscored=len(subset)-len(scored),methods=metrics)
    return dict(summary=summary,predictions=predictions)


def main():
    parser=argparse.ArgumentParser()
    for field in ('attribution','groups','boundaries','native','out'):
        parser.add_argument(field,type=Path)
    args=parser.parse_args()
    read=lambda file:json.loads(file.read_text(encoding='utf-8'))
    sources={row['id']:row for row in read(args.attribution)['works']}
    intervals=[(r['id'],r['source'],*r['firstVisibleChangeBracket']) for r in read(args.boundaries)['rows'] if r['firstVisibleChangeBracket']]
    intervals.extend((r['id'],r['work'],*r['transition']) for r in read(args.native)['rows'])
    assert {key for key,*_ in intervals}==REVIEWS.keys()
    scanner=runpy.run_path(str(Path(__file__).with_name('verify-style-attribution.py')))
    stats=runpy.run_path(str(Path(__file__).with_name('compare-style-study-models.py')))
    rows=[]
    verified=set()
    for key,work,start,end in intervals:
        choice,note=REVIEWS[key]
        source=sources[work]
        if work not in verified:
            with Path(source['path']).open('rb') as file:
                if hashlib.file_digest(file,'sha256').hexdigest()!=source['sourceSha256']:
                    raise ValueError(f'Source changed on disk: {work}')
            verified.add(work)
        observables=before(source,start,scanner['features'],scanner['W'],scanner['H']) if choice in ('retain','switch') else None
        rows.append(dict(id=key,work=work,group=source['group'],sourceSha256=source['sourceSha256'],
                         beforeFrame=start,afterFrame=end,choice=choice,note=note,beforeFeatures=observables))
    result=evaluate(rows,read(args.groups)['provisionalGroups'],stats['standardize'])
    args.out.write_text(json.dumps(dict(choiceCounts=dict(Counter(row['choice'] for row in rows)),
                features=NAMES,rows=rows,**result),ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    print(result['summary'])


if __name__=='__main__':
    main()
