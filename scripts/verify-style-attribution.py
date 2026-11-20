"""Matched-duration, leave-excerpt-out attribution for the Lyricsample corpus."""
import argparse
import hashlib
from itertools import combinations
import json
from pathlib import Path

import cv2
import numpy as np


W, H, RATE, SECONDS = 480, 270, 12, 5
GROUPS = {
    'layout': ['coverage', 'coverageSpread', 'boxCount', 'heightRatio', 'largestBox', 'centerDistance'],
    'motion': ['flowMedian', 'flowP90', 'flowIqr', 'stillFraction'],
    'curves': ['accelerationP90', 'decelerationP90', 'jerkP90', 'stopTransitions', 'motionStarts', 'sizeContrastP90'],
    'appearance': ['saturation', 'saturatedFraction', 'luminance', 'darkFraction'],
}


def features(frame, mode):
    # Per-row medians tolerate letterboxing and horizontal background bands.
    if mode == 'row':
        background = np.median(np.concatenate((frame[:, :20], frame[:, -20:]), axis=1), axis=1)
        background = cv2.GaussianBlur(background[:, None, :].astype(np.float32), (1, 9), 0)
        difference = np.abs(frame.astype(np.float32) - background).max(axis=2)
        detected = (difference > 31).astype(np.uint8)
    else:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        local = cv2.GaussianBlur(gray, (0, 0), 5)
        detected = (cv2.absdiff(gray, local) > 15).astype(np.uint8)
    detected[:8] = detected[-8:] = 0
    detected[:, :10] = detected[:, -10:] = 0
    n, ids, stats, centers = cv2.connectedComponentsWithStats(detected)
    area = stats[1:, cv2.CC_STAT_AREA]
    extents = stats[1:, :4]
    valid = (area >= 20) & (area <= W * H * .35) & (extents[:, 2] * extents[:, 3] <= W * H * .45)
    mask = np.r_[False, valid][ids]
    features = np.full(5, np.nan)
    if valid.any():
        boxes = extents[valid]
        heights = np.sort(boxes[:, 3])
        largest = int(np.argmax(boxes[:, 2] * boxes[:, 3]))
        features = [float(mask.mean()), len(boxes), float(heights[-1] / heights[-2]) if len(heights)>1 else 1.,
                    float(boxes[largest, 2]*boxes[largest, 3]/(W*H)),
                    float(np.linalg.norm((centers[1:][valid][largest]-[W/2,H/2])/[W,H]))]
    return mask, features


def average_rows(rows):
    def summary(i, kind='median'):
        values = [row[i] for row in rows if np.isfinite(row[i])]
        if not values:
            return None
        return float(np.median(values) if kind=='median' else np.quantile(values,.75)-np.quantile(values,.25))
    return dict(coverage=summary(0),coverageSpread=summary(0,'iqr'),boxCount=summary(1),heightRatio=summary(2),
                largestBox=summary(3),centerDistance=summary(4))


def summarize_motion(rows, possible):
    if not rows:
        return dict(flowMedian=None,flowP90=None,flowIqr=None,stillFraction=None,continuity=0)
    speed, high = np.array(rows).T
    return dict(flowMedian=float(np.median(speed)),flowP90=float(np.median(high)),
                flowIqr=float(np.quantile(speed,.75)-np.quantile(speed,.25)),
                stillFraction=float((speed < .015).mean()),continuity=len(rows)/possible)


def summarize_curves(pairs, screen_rows, mode, durations):
    # Three consecutive valid flow intervals before differentiating. A cut or
    # unavailable mask breaks the chain; gaps never become zero velocity.
    speed = [motion[mode][0] if mode in motion else None for _, motion in pairs]
    times = np.cumsum([0, *durations])
    midpoint = (times[1:]+times[:-1])/2
    filtered = [None]*len(speed)
    for i in range(1,len(speed)-1):
        if None not in speed[i-1:i+2]:
            filtered[i] = (speed[i-1]+2*speed[i]+speed[i+1])/4
    gradients = [None if left is None or right is None else (right-left)/(midpoint[i+1]-midpoint[i])
                 for i,(left,right) in enumerate(zip(filtered,filtered[1:]))]
    present = [a for a in gradients if a is not None]
    jerk = [abs(right-left)/((midpoint[i+2]-midpoint[i])/2)
            for i,(left,right) in enumerate(zip(gradients,gradients[1:])) if left is not None and right is not None]
    stops = starts = 0
    transitions = 0
    for left,right in zip(speed,speed[1:]):
        if left is None or right is None:
            continue
        transitions += 1
        stops += left>=.08 and right<=.015
        starts += left<=.015 and right>=.08
    height = [row[2] for row in screen_rows if np.isfinite(row[2])]
    quantile = lambda values: float(np.quantile(values,.9)) if values else None
    return dict(accelerationP90=quantile([max(0,a) for a in present]),
                decelerationP90=quantile([max(0,-a) for a in present]),jerkP90=quantile(jerk),
                stopTransitions=float(stops/transitions) if transitions else None,
                motionStarts=float(starts/transitions) if transitions else None,sizeContrastP90=quantile(height),
                validAdjacentFlowPairs=transitions,validAccelerations=len(present),validJerks=len(jerk))

def stable_bands(frames):
    margins = [[],[]]
    for frame in frames:
        for side, edge in enumerate((frame,frame[::-1])):
            edge = edge[:H//5].astype(np.int16)
            color = np.median(edge[:4],axis=(0,1))
            matches = (np.max(np.abs(edge-color),axis=2)<=12).mean(axis=1) >= .96
            failures = np.flatnonzero(~matches)
            height = int(failures[0]) if len(failures) else 0
            if 5<=height<=H//6:
                inside = edge[height+2:height+6]
                different = (np.max(np.abs(inside-color),axis=2)>=22).mean()
                if different>=.78:
                    margins[side].append(height)
    return [int(round(np.median(values))) if len(values)>=.8*len(frames) and np.ptp(values)<=4 else 0
            for values in margins]


def plain_perimeter(frame):
    colors = []
    cells = [(y,x) for y in range(6) for x in range(10) if y in (0,5) or x in (0,9)]
    for y,x in cells:
        tile = frame[y*H//6:(y+1)*H//6,x*W//10:(x+1)*W//10][::3,::3].astype(np.int16)
        median = np.median(tile,axis=(0,1))
        if (np.max(np.abs(tile-median),axis=2)<=8).mean()>=.90:
            colors.append(median)
    if not colors:
        return False
    colors = np.array(colors)
    matches = (np.abs(colors[:,None]-colors).max(axis=2)<=15).sum(axis=1)
    return bool(matches.max()>=np.ceil(len(cells)*2/3))


def scan(source, controlled=False):
    filename = Path(source['path'])
    sha = hashlib.sha256(filename.read_bytes()).hexdigest()
    if 'sha256' in source and sha != source['sha256']:
        raise ValueError(f'Hash mismatch: {filename}')
    cap = cv2.VideoCapture(str(filename))
    fps, n = cap.get(cv2.CAP_PROP_FPS), int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if not np.isfinite(fps) or fps < RATE:
        cap.release()
        raise ValueError(f'Expected at least {RATE} fps: {filename}')
    duration = n/fps
    if duration < SECONDS:
        cap.release()
        raise ValueError(f'Expected a duration of at least {SECONDS} s: {filename}')
    starts = {name: offset*(duration-SECONDS) for name, offset in
              [('early',.25 if controlled else 0),('center',.5),('late',.75 if controlled else 1)]}
    planned = source.get('plannedStarts')
    if planned is not None:
        if len(planned)!=3 or any(start<0 or start>duration-SECONDS+.5/fps for start in planned):
            cap.release()
            raise ValueError(f'Invalid planned five-second windows: {filename}')
        starts = dict(zip(starts,planned))
    indices = {name: [round((start+i/RATE)*fps) for i in range(RATE*SECONDS)] for name,start in starts.items()}
    wanted = set(index for part in indices.values() for index in part)
    buffers = {}
    try:
        i = 0
        for index in sorted(wanted):
            if index-i>round(3*fps):
                if not cap.set(cv2.CAP_PROP_POS_FRAMES,index):
                    raise ValueError(f'Cannot seek {filename}:{index}')
                i = index
            for frame in range(i,index+1):
                if not cap.grab():
                    raise ValueError(f'Unexpected end at {filename}:{frame}')
            ok, frame = cap.retrieve()
            if not ok:
                raise ValueError(f'Cannot decode {filename}:{index}')
            buffers[index] = cv2.resize(frame,(W,H),interpolation=cv2.INTER_AREA)
            i = index+1
    finally:
        cap.release()
    top, bottom = stable_bands(list(buffers.values())[::4]) if controlled else (0,0)
    if top or bottom:
        buffers = {index:cv2.resize(frame[top:H-bottom],(W,H),interpolation=cv2.INTER_AREA) for index,frame in buffers.items()}
    # Cache each cropped frame and consecutive pair irrespective of window overlap.
    screen = {}
    transitions = {}
    approved_background = source.get('approvedBackgroundRanges')
    for i in wanted:
        frame = buffers[i]
        gray = cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
        hsv = cv2.cvtColor(frame,cv2.COLOR_BGR2HSV)
        if approved_background is None:
            plain = not controlled or plain_perimeter(frame)
        else:
            plain = any(start <= i/fps < end for start,end in approved_background)
        screen[i] = dict(gray=gray, raw=frame, masks={mode:features(frame,mode) for mode in ('row','edge')},
                         plain=plain,
                         appearance=[np.median(hsv[:,:,1])/255,(hsv[:,:,1]>75).mean(),np.median(gray)/255,(gray<75).mean()])
    for left,right in sorted({pair for part in indices.values() for pair in zip(part,part[1:])}):
        a,b = screen[left],screen[right]
        difference = cv2.absdiff(a['raw'],b['raw']).max(axis=2)
        # Suppress whole-screen changes independently of the foreground mask.
        cut = float((difference>45).mean())>.48 or float(difference.mean())>46
        if cut:
            transitions[left,right] = (True,{})
            continue
        if not a['plain'] or not b['plain']:
            transitions[left,right] = (False,{})
            continue
        flow = cv2.calcOpticalFlowFarneback(a['gray'],b['gray'],None,.5,3,21,3,5,1.2,0)
        speed = np.hypot(flow[:,:,0],flow[:,:,1])*fps/((right-left)*np.hypot(W,H))
        motion = {}
        for mode in ('row','edge'):
            mask = cv2.dilate(np.uint8(a['masks'][mode][0] | b['masks'][mode][0]),np.ones((5,5),np.uint8))!=0
            if 50 <= mask.sum() <= W*H*.64:
                motion[mode] = [float(np.median(speed[mask])),float(np.quantile(speed[mask],.9))]
        transitions[left,right] = (False,motion)
    windows = {}
    for name,part in indices.items():
        pairs = [transitions[pair] for pair in zip(part,part[1:])]
        appearance = dict(zip(GROUPS['appearance'],np.median([screen[i]['appearance'] for i in part],axis=0).tolist()))
        modes = {}
        for mode in ('row','edge'):
            rows = [screen[i]['masks'][mode][1] if screen[i]['plain'] else [np.nan]*5 for i in part]
            motion = [measured[mode] for _,measured in pairs if mode in measured]
            modes[mode] = {**average_rows(rows),**summarize_motion(motion,len(pairs)),
                           **summarize_curves(pairs,rows,mode,[(b-a)/fps for a,b in zip(part,part[1:])]),
                           'coverageFrames':sum(bool(np.isfinite(row[0])) for row in rows),'flowPairs':len(motion)}
        windows[name] = dict(fromSeconds=part[0]/fps,toLastSampleSeconds=part[-1]/fps,
                             sampledFrames=len(part),sourceFrames=part,cutPairs=sum(cut for cut,_ in pairs),
                             appearance=appearance,**modes)
    return dict(id=source.get('workId',filename.stem),sourceSha256=sha,path=str(filename),group=source['group'],
                credit=source['credit'],originalWorkId=None,sourceFps=fps,sourceFrames=n,
                durationSeconds=duration,windows=windows,**(
                    dict(edgeBands=[top,bottom],distinctFrames=len(wanted),
                        distinctPlainFrames=sum(item['plain'] for item in screen.values()),
                        dominantPairFrames=sum(bool(item['plain'] and item['masks']['row'][1][1]>=2) for item in screen.values()),
                        highContrastPairFrames=sum(bool(item['plain'] and item['masks']['row'][1][1]>=2 and item['masks']['row'][1][2]>=2)
                                                    for item in screen.values())) if controlled else {}))


def balanced(labels,predictions):
    return float(np.mean([(predictions[labels==target]==target).mean() for target in (0,1)]))


def standardized_folds(matrix):
    folds = []
    for i in range(len(matrix)):
        train = np.arange(len(matrix))!=i
        observations = matrix[train]
        # Median imputation and scale use the training fold only.
        med = np.array([np.median(col[np.isfinite(col)]) if np.isfinite(col).any() else 0 for col in observations.T])
        filled = np.where(np.isfinite(matrix),matrix,med)
        scale = filled[train].std(axis=0)
        scale[scale<1e-9] = 1
        folds.append((train,(filled-med)/scale))
    return folds


def predict(folds, labels):
    rows=[]
    for i,(train,values) in enumerate(folds):
        a = values[train & (labels==1)].mean(axis=0)
        b = values[train & (labels==0)].mean(axis=0)
        center = values[i]
        da = float(np.mean((center-a)**2))
        db = float(np.mean((center-b)**2))
        rows.append((int(da<db),db-da,da,db,((center-b)**2-(center-a)**2)/len(center)))
    return rows


def test(works, window, group, mode, label_orders=()):
    names = sum((GROUPS[key] for key in group),[])
    vectors = np.array([[work['windows'][window]['appearance' if k in GROUPS['appearance'] else mode].get(k)
                         for k in names] for work in works],dtype=float)
    labels = np.array([int(w['group']=='reference') for w in works])
    folds = standardized_folds(vectors)
    result = predict(folds,labels)
    pred = np.array([row[0] for row in result])
    score = balanced(labels,pred)
    # One predeclared setting uses a local permutation reference only. The
    # 7 reference excerpts can share source works, so this is descriptive.
    p = None
    if len(label_orders):
        null = [balanced(order,np.array([r[0] for r in predict(folds,order)])) for order in label_orders]
        p = float(np.mean(np.asarray(null)>=score-1e-12))
    rows = []
    for i,(w,(guess,margin,dref,dcontrol,contributions)) in enumerate(zip(works,result)):
        rows.append(dict(id=w['id'],actual=w['group'],prediction=['control','reference'][guess],
            margin=margin,referenceDistance=dref,controlDistance=dcontrol,
            missingFeatures=[k for k,v in zip(names,vectors[i]) if not np.isfinite(v)],
            contributions=dict(zip(names,contributions.tolist()))))
    return dict(window=window,mask=mode,groups=group,balancedAccuracy=score,correct=int((labels==pred).sum()),
                referenceRecall=float(pred[labels==1].mean()),controlRecall=float((1-pred[labels==0]).mean()),
                descriptiveShuffleTail=p,rows=rows)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--inventory',type=Path,required=True)
    parser.add_argument('--controls',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    cv2.setNumThreads(2)
    sources=[{**row,'group':'reference','credit':'same credited editor, user supplied'}
             for row in json.loads(args.inventory.read_text(encoding='utf-8'))]
    sources.extend(dict(path=str(args.controls/f'LyricOther{i}.mp4'),group='control',credit=f'distinct editor {i}, user supplied')
                   for i in range(1,7))
    works=[]
    for source in sources:
        item=scan(source)
        works.append(item)
        print(item['id'],item['sourceFrames'],item['windows']['center']['row']['coverageFrames'],flush=True)
    assert len(set(work['sourceSha256'] for work in works))==13
    label_orders=[]
    for chosen in combinations(range(13),7):
        order=np.zeros(13,dtype=int);order[list(chosen)]=1;label_orders.append(order)
    comparisons=[]
    for window in ('center','early','late'):
        for mode in ('row','edge'):
            for groups in (['layout','motion'],['layout'],['motion'],['appearance'],['layout','motion','appearance'],
                           ['curves'],['layout','curves'],['layout','motion','curves']):
                if mode=='edge' and groups==['appearance']:
                    continue
                primary=window=='center' and mode=='row' and groups==['layout','motion']
                comparisons.append(test(works,window,groups,mode,label_orders if primary else ()))
    first=comparisons[0]
    votes={work['id']:[row['prediction'] for config in comparisons if config['groups']==['layout','motion']
                       for row in config['rows'] if row['id']==work['id']] for work in works}
    args.out.mkdir(parents=True,exist_ok=True)
    info=dict(status='exploratory excerpt-level exercise',protocol=dict(sampleRate=RATE,seconds=SECONDS,
        resolution=[W,H],groups=GROUPS,foldUnit='input excerpt; original work/series IDs unavailable',
        primary='center / row background / layout and motion',baselineBalancedAccuracy=.5,
        motionMeaning='apparent foreground optical flow, including camera and segmentation effects',totalLabelOrders=len(label_orders)),
        works=works,comparisons=comparisons,robustness=votes)
    (args.out/'report.json').write_text(json.dumps(info,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    without_effects_clip = [work for work in works if work['id'] != 'Lyricsample7']
    sensitivity = test(without_effects_clip, 'center', ['layout','motion'], 'row')
    (args.out/'without-lyricsample7.json').write_text(json.dumps(sensitivity,indent=2,allow_nan=False),encoding='utf-8')
    lines=['# 作家判定の初回比較','','7参考抜粋と6対照抜粋。両群とも1件ずつ除外して判定。','',
           '| 抜粋 | 申告 | 主設定 | 構図・動きの6条件で同担当と出た回数 |',
           '| --- | --- | --- | ---: |']
    lines.extend(f"| {row['id']} | {row['actual']} | {row['prediction']} | {votes[row['id']].count('reference')}/6 |" for row in first['rows'])
    lines.extend(['','| 設定 | 正答 | 均衡正答率 | 同担当の再現率 | 対照の再現率 |',
                  '| --- | ---: | ---: | ---: | ---: |'])
    lines.extend(f"| {row['window']} / {row['mask']} / {' + '.join(row['groups'])} | {row['correct']}/13 | {row['balancedAccuracy']:.3f} | {row['referenceRecall']:.3f} | {row['controlRecall']:.3f} |"
                 for row in comparisons)
    lines.extend(['','[全計測値と判定根拠](report.json) · [対照素材のコマ一覧](controls.jpg)',
                  '', '判定は入力抜粋単位。作品・曲・シリーズの独立性は追加確認が必要。'])
    (args.out/'SUMMARY.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print('Primary',first['correct'],first['balancedAccuracy'],first['descriptiveShuffleTail'])


if __name__ == '__main__':
    main()
