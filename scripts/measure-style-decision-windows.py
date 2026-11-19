"""Measure the first frame of reviewed windows before the visible choice."""
import argparse
import hashlib
import json
from pathlib import Path
import runpy
import subprocess

import cv2
import numpy as np


# All three have a visible word before the addition and retain it afterwards.
ADDITIONS = {'P06','P09','P37'}
WINDOW_FEATURES = ('foregroundCoverage','componentCount','heightContrast','largestExtent','centerDistance')
AUDIO_FEATURES = ('recentRmsChangeDb','recentSpectralFlux')
EXAMPLES = [
    ('entry-after-addition','Lyricsample4',[103,104,112],'先行の字を保持して次の字を加える'),
    ('replace-then-add','Lyricsample2',[75,76,77],'青を一度下げ、空と青を順に出す'),
    ('fast-then-hold','Lyricsample2',[77,78,82,87],'青一字の右方向の移動が急減速する'),
    ('hold-near-still','LyricOther4',[310,311,312,313,314],'痛いの寸法は安定し、中心は少し移動する'),
    ('hold-with-rotation','LyricOther6',[70,71,72,73,74,75,76],'三字を維持しつつ個別に回転する'),
    ('size-hierarchy','Lyricsample4',[103,104,112],'大小を対比させて表示する'),
    ('size-hierarchy','LyricOther6',[287,290,293],'行内の大字と小字を同時に維持する'),
]


def audio_context(source,frame,cache):
    rate = 12000
    key = source['id']
    if key not in cache:
        raw = subprocess.run(['ffmpeg','-v','error','-i',source['path'],'-map','0:a:0','-vn','-ac','1',
                              '-ar',str(rate),'-f','f32le','-'],check=True,capture_output=True).stdout
        cache[key] = np.frombuffer(raw,dtype='<f4')
    anchor = round(frame/source['sourceFps']*rate)
    segment = cache[key][max(0,anchor-round(.32*rate)):anchor]
    if len(segment)<round(.32*rate):
        return dict.fromkeys(AUDIO_FEATURES)
    rms = lambda values: float(np.sqrt(np.mean(values**2)))+1e-8
    rms_change = 20*np.log10(rms(segment[-960:])/rms(segment[:1920]))
    size,hop = 480,240
    spectra = np.array([np.abs(np.fft.rfft(np.hanning(size)*segment[i:i+size]))
                        for i in range(0,len(segment)-size+1,hop)])
    normalized = spectra/np.maximum(spectra.sum(axis=1,keepdims=True),1e-8)
    flux = np.maximum(np.diff(normalized,axis=0),0).sum(axis=1)
    return dict(zip(AUDIO_FEATURES,[float(rms_change),float(max(flux[-6:]))]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('attribution',type=Path)
    parser.add_argument('opportunities',type=Path)
    parser.add_argument('choices',type=Path)
    parser.add_argument('out',type=Path)
    args = parser.parse_args()
    studies = runpy.run_path(str(Path(__file__).with_name('verify-style-attribution.py')))
    feature_fn = studies['features']
    width,height = studies['W'],studies['H']
    inputs = {row['id']:row for row in json.loads(args.attribution.read_text(encoding='utf-8'))['works']}
    options = json.loads(args.opportunities.read_text(encoding='utf-8'))['windows']
    rows = []
    checked = set()
    cache = {}
    for window in options:
        decision = {'continued':'continue','grew':'grow','changed':'append' if window['id'] in ADDITIONS else 'replace'}.get(window['review'])
        if decision is None:
            continue
        source = inputs[window['work']]
        file = Path(source['path'])
        if source['id'] not in checked:
            assert hashlib.sha256(file.read_bytes()).hexdigest()==source['sourceSha256']==window['sourceSha256']
            checked.add(source['id'])
        capture = cv2.VideoCapture(str(file))
        try:
            capture.set(cv2.CAP_PROP_POS_FRAMES,window['frames'][0])
            ok, frame = capture.read()
            if not ok:
                raise ValueError(f'Cannot read {source["id"]}:{window["frames"][0]}')
        finally:
            capture.release()
        frame = cv2.resize(frame,(width,height),interpolation=cv2.INTER_AREA)
        features = {}
        for mode in ('row','edge'):
            _, measurements = feature_fn(frame,mode)
            features[mode] = {name:float(value) if np.isfinite(value) else None for name,value in zip(WINDOW_FEATURES,measurements)}
        rows.append(dict(id=window['id'],source=source['id'],sourceSha256=source['sourceSha256'],
                         inputFrame=window['frames'][0],lastOutcomeFrame=window['frames'][-1],
                         actual=decision,review=window['note'],features=features,
                         audioBefore=audio_context(source,window['frames'][0],cache)))

    examples = [dict(kind=kind,source=work,frames=frames,note=reason,sourceSha256=inputs[work]['sourceSha256'])
                for kind,work,frames,reason in EXAMPLES]
    scales = json.loads(args.choices.read_text(encoding='utf-8'))['rows']
    audio_by_choice = {case['id']:audio_context(inputs[case['source']],case['anchorFrame'],cache) for case in scales}
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(dict(
        method='one predetermined first frame per reviewed window; following scale/text choices labeled from footage',
        replaceMeaning='a text boundary involved replacement, initial appearance or removal without a readable identical full line',
        unscoreable=[dict(id=row['id'],source=row['work'],review=row['review'],note=row['note'])
                    for row in options if row['id'] not in {r['id'] for r in rows}],
        features=WINDOW_FEATURES,audioFeatures=AUDIO_FEATURES,audioByScaleChoice=audio_by_choice,
        windows=rows,sourceReviewedExamples=examples),ensure_ascii=False,indent=2),encoding='utf-8')
    print('Labeled windows, source examples:',len(rows),len(examples))


if __name__=='__main__':
    main()
