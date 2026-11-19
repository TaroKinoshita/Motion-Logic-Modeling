"""Find source-frame candidates for shared phrase motion in both cohorts."""
import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


WIDTH, HEIGHT = 640, 360
DIAGONAL = np.hypot(WIDTH, HEIGHT)
DEEP_MAX_RATIO = .5
DEEP_HELD_TOLERANCE = .02


def regions(frame):
    background = np.median(np.concatenate((frame[:, :24], frame[:, -24:]), axis=1), axis=1)
    background = cv2.GaussianBlur(background[:, None, :].astype(np.float32), (1, 9), 0)
    delta = np.max(np.abs(frame.astype(np.float32) - background), axis=2)
    mask = (delta > 35).astype(np.uint8)
    mask[:8] = mask[-8:] = 0
    mask[:, :12] = mask[:, -12:] = 0
    _, ids, stats, _ = cv2.connectedComponentsWithStats(mask)
    x, y, w, h, area = stats.T
    valid = (area >= 16) & (area <= 0.25 * WIDTH * HEIGHT) & (w * h <= .45 * WIDTH * HEIGHT)
    valid[0] = False
    mask = valid[ids].astype(np.uint8)
    boxes = {}
    for kernel in ((1, 1), (21, 5), (49, 7), (83, 9)):
        inflated = cv2.dilate(mask, np.ones(kernel[::-1], np.uint8))
        _, groups, group_stats, _ = cv2.connectedComponentsWithStats(inflated)
        for index, (left, top, outer_w, outer_h, _) in enumerate(group_stats[1:], 1):
            window = np.s_[top:top+outer_h, left:left+outer_w]
            content = mask[window] & (groups[window] == index)
            rows, cols = np.where(content)
            if len(rows) < 85:
                continue
            x1, x2, y1, y2 = cols.min(), cols.max()+1, rows.min(), rows.max()+1
            box = (int(left+x1), int(top+y1), int(x2-x1), int(y2-y1))
            if box in boxes or box[2] < 20 or box[3] < 12 or box[2]*box[3] > .30*WIDTH*HEIGHT:
                continue
            signature = cv2.resize(content[y1:y2, x1:x2].astype(np.float32), (80, 40), interpolation=cv2.INTER_AREA) > .28
            boxes[box] = signature
    return list(boxes.items())


def match(previous, current):
    """Pick one preceding tight region per region, without assigning an identity across gaps."""
    if not previous or not current:
        return {}
    a = np.array([box for box, _ in previous])
    b = np.array([box for box, _ in current])
    centers_a = a[:, :2] + a[:, 2:]/2
    centers_b = b[:, :2] + b[:, 2:]/2
    distance = np.linalg.norm(centers_b[:, None] - centers_a, axis=2) / DIAGONAL
    with np.errstate(divide='ignore'):
        ratios = np.log(b[:, None, 2:]/a[:, 2:])
    available = (distance <= .24) & (np.abs(ratios).max(axis=2) <= 1.25)
    links = {}
    for j, indices in enumerate(available):
        best = .52
        for i in np.flatnonzero(indices):
            src, dst = previous[i][1], current[j][1]
            overlap = np.count_nonzero(src & dst)/max(1, np.count_nonzero(src | dst))
            merit = overlap - .62*distance[j, i] - .12*np.max(np.abs(ratios[j, i]))
            if merit > best:
                best = merit
                links[j] = (int(i), overlap, float(distance[j, i]), ratios[j, i].tolist())
    return links


def bouts(traces, bounds, fps):
    candidates = {'one-frame-shrink': [], 'fast-then-hold': [], 'hold': []}
    dwell = int(np.ceil(.12*fps))
    for index, (origins, edges) in enumerate(zip(bounds, traces)):
        for key, box in enumerate(origins):
            cursor, start_hold, pace = key, index, []
            while start_hold >= 1 and (link := traces[start_hold].get(cursor)):
                old, _, distance, scales = link
                if distance*fps > .035 or max(abs(value) for value in scales) > .044:
                    break
                pace.append(link)
                cursor, start_hold = old, start_hold-1
                if len(pace) >= dwell:
                    break
            if len(pace) == dwell:
                preceding = traces[start_hold].get(cursor)
                area = box[2]*box[3]/(WIDTH*HEIGHT)
                hold_scale = max(abs(sum(link[3][axis] for link in pace)) for axis in (0, 1))
                if hold_scale > .06:
                    continue
                if not preceding or preceding[2]*fps > .035 or max(map(abs, preceding[3])) > .044:
                    candidates['hold'].append((area, start_hold, index, cursor, key, dict(dwellSeconds=dwell/fps)))
                recent = []
                for endpoint in range(start_hold, max(0, start_hold-int(.20*fps)-1), -1):
                    entry = traces[endpoint].get(cursor)
                    if not entry or max(map(abs, entry[3])) > .22:
                        break
                    cursor, similarity, distance, _ = entry
                    recent.append((distance*fps, endpoint, cursor, similarity))
                if recent:
                    peak, endpoint, old, similarity = max(recent)
                    if peak >= .42:
                        speeds = [sample[0] for sample in reversed(recent) if sample[1] >= endpoint]
                        candidates['fast-then-hold'].append((peak * similarity * area**.35,
                            endpoint-1, index, old, key, dict(entrySpeedDiagonalPerSecond=peak,
                            settledMaxSpeedDiagonalPerSecond=max(item[2] for item in pace)*fps,
                            speedsBeforeHold=speeds, holdStartFrame=start_hold,
                            dwellSeconds=dwell/fps, entryShapeIou=similarity)))
            if key in edges:
                old, similarity, distance, scales = edges[key]
                if max(scales) <= np.log(.78) and abs(scales[0]-scales[1]) <= np.log(1.3) and similarity >= .64:
                    area = bounds[index-1][old][2]*bounds[index-1][old][3]/(WIDTH*HEIGHT)
                    candidates['one-frame-shrink'].append((-max(scales)*similarity*area**.35, index-1, index, old, key,
                        dict(widthRatio=float(np.exp(scales[0])),heightRatio=float(np.exp(scales[1])),
                             shapeIou=similarity,displacementDiagonal=distance)))
    return candidates


def deep_shrinks(traces, bounds):
    """Keep every possible event frame for manual identity and extent verification."""
    events = {}
    for end in range(3, len(traces)):
        for last, final_link in traces[end].items():
            middle = final_link[0]
            first_link = traces[end-1].get(middle)
            if first_link is None:
                continue
            after = first_link[0]
            step = traces[end-2].get(after)
            if step is None or step[1] < .6:
                continue
            before = step[0]
            boxes = [bounds[end-3][before], bounds[end-2][after], bounds[end-1][middle], bounds[end][last]]
            sizes = np.array(boxes)[:, 2:]
            # Relax the screen for rounding at 640 px. The final test uses the
            # full words at source resolution and the exact fixed thresholds.
            if np.any(sizes[1]/sizes[0] > DEEP_MAX_RATIO+.02):
                continue
            drift = np.max(np.abs(sizes[2:]-sizes[1]),axis=0)
            if np.any(drift > np.maximum(2, sizes[1]*(DEEP_HELD_TOLERANCE+.02))):
                continue
            score = step[1] * float(np.prod(sizes[0]))**.35
            row = dict(startFrame=end-3,endFrame=end,startBox=boxes[0],endBox=boxes[-1],boxes=boxes,score=score)
            events.setdefault(end-3, []).append(row)
    rows = []
    for frame, variants in sorted(events.items()):
        best, *others = sorted(variants, key=lambda row: -row['score'])
        rows.append({**best,'alternatives':len(others),'id':f'deep-shrink:{frame}'})
    return rows


def scan(work):
    source = Path(work['path'])
    if hashlib.sha256(source.read_bytes()).hexdigest() != work['sourceSha256']:
        raise ValueError(f'Source identity changed: {source}')
    capture = cv2.VideoCapture(str(source))
    fps = capture.get(cv2.CAP_PROP_FPS)
    previous, previous_frame, bounds, traces, boundaries = [], None, [], [], []
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            picture = cv2.resize(frame, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA)
            current = regions(picture)
            difference = None if previous_frame is None else cv2.absdiff(previous_frame, picture).max(axis=2)
            cut = difference is not None and (difference.mean() > 48 or (difference > 50).mean() > .54)
            if cut:
                boundaries.append(len(bounds))
            traces.append({} if cut else match(previous, current))
            bounds.append([box for box, _ in current])
            previous, previous_frame = current, picture
    finally:
        capture.release()
    if len(bounds) != work['sourceFrames']:
        raise ValueError(f'Frame count mismatch: {source} ({len(bounds)})')
    results = {}
    counts = {}
    for kind, rows in bouts(traces, bounds, fps).items():
        ranked = []
        for score, start, end, old, new, values in sorted(rows, key=lambda row: -row[0]):
            if any(abs(start-hit['startFrame']) < .23*fps for hit in ranked):
                continue
            ranked.append(dict(id=f"{work['id']}:{kind}:{start}", startFrame=start, endFrame=end,
                               startBox=bounds[start][old], endBox=bounds[end][new], score=score, **values))
        counts[kind] = len(ranked)
        results[kind] = ranked[:3]
    usable = sum(any(box[2] >= 30 for box in boxes) for boxes in bounds)
    deep = deep_shrinks(traces, bounds)
    return dict(id=work['id'], group=work['group'], sourceSha256=work['sourceSha256'], sourceFrames=len(bounds),
                fps=fps, framesWithRegions=usable, boundaryFrames=boundaries, counts=counts, candidates=results,
                deepShrinkScreen=deep)


def contact_sheet(source, result, folder):
    rows = [(kind, row) for kind, items in result['candidates'].items() for row in items]
    offsets = lambda row: [max(0,row['startFrame']-1),row['startFrame'],row['startFrame']+1,row['endFrame'],
                           min(result['sourceFrames']-1,row['endFrame']+2)]
    needed = {frame for _, row in rows for frame in offsets(row)}
    capture = cv2.VideoCapture(source)
    pictures = {}
    try:
        for index in sorted(needed):
            capture.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, raw = capture.read()
            if not ok:
                raise ValueError(f'Cannot export review frame {index} of {source}')
            pictures[index] = cv2.resize(raw, (256, 144), interpolation=cv2.INTER_AREA)
    finally:
        capture.release()
    canvas = Image.new('RGB', (1280,max(1,len(rows))*174), '#181818')
    draw = ImageDraw.Draw(canvas)
    for line, (kind, row) in enumerate(rows):
        y = line*174
        draw.text((5,y+4), row['id'], fill='white')
        for col, index in enumerate(offsets(row)):
            picture = pictures[index].copy()
            box = row['startBox'] if col == 1 else row['endBox'] if col == 3 else None
            if box:
                x1,y1,w,h = box
                cv2.rectangle(picture, (round(.4*x1),round(.4*y1)), (round(.4*(x1+w)),round(.4*(y1+h))), (60,215,32), 1)
            canvas.paste(Image.fromarray(cv2.cvtColor(picture,cv2.COLOR_BGR2RGB)), (256*col,y+20))
            draw.text((256*col+5,y+154), f'{index}F', fill='white')
    canvas.save(folder/f"{result['id']}.jpg", quality=91)


def deep_contact_sheet(works, results, file):
    rows = [(work, hit) for work, result in zip(works,results) for hit in result['deepShrinkScreen']]
    if not rows:
        return
    canvas = Image.new('RGB', (1280,len(rows)*170), '#181818')
    labels = ImageDraw.Draw(canvas)
    for i, (work, hit) in enumerate(rows):
        start = hit['startFrame']
        frames = range(max(0,start-1),start+4)
        capture = cv2.VideoCapture(work['path'])
        try:
            capture.set(cv2.CAP_PROP_POS_FRAMES,frames.start)
            for j, frame in enumerate(frames):
                ok, raw = capture.read()
                if not ok:
                    raise ValueError(f'Cannot read {work["id"]}:{frame}')
                thumbnail = cv2.resize(cv2.cvtColor(raw,cv2.COLOR_BGR2RGB),(256,144),interpolation=cv2.INTER_AREA)
                x, y = j*256, i*170
                canvas.paste(Image.fromarray(thumbnail),(x,y+20))
                labels.text((x+5,y+25),f'{frame}F',fill='white',stroke_width=1,stroke_fill='black')
        finally:
            capture.release()
        labels.text((5,i*170+4),f'{work["id"]} | {start}F -> {start+1}F',fill='white')
    canvas.save(file,quality=92)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('attribution', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    cv2.setNumThreads(2)
    works = json.loads(args.attribution.read_text(encoding='utf-8'))['works']
    args.out.mkdir(parents=True, exist_ok=True)
    results = []
    for work in works:
        item = scan(work)
        contact_sheet(work['path'], item, args.out)
        print(item['id'], item['sourceFrames'], [row['startFrame'] for row in item['deepShrinkScreen']], flush=True)
        results.append(item)
    (args.out/'candidates.json').write_text(json.dumps(dict(
        method='auto candidates; normalized silhouettes and tight region groups; glyph identity unverified',
        measurementPixels=[WIDTH, HEIGHT], comparisons=results), indent=2, allow_nan=False), encoding='utf-8')
    deep_contact_sheet(works, results, args.out/'deep-shrink-screen.jpg')


if __name__ == '__main__':
    main()
