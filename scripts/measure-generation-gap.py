"""Compare reference lyric videos and generated videos with the same screen statistics.

Per frame (sampled near 12 fps by whole-frame steps, 480x270): foreground = pixels whose luminance differs from the
border median by >= 50. Foreground components are merged with a small dilation into blocks.
Reported per video (medians over frames that have foreground):
  hero_h      height of the tallest block / frame height
  blocks      number of blocks with area >= 0.05% of the frame
  coverage    foreground bounding-box area / frame area (union of blocks)
  center_dx   |foreground bbox center x - 0.5| (normalized)
  still_runs  median length in seconds of runs where the foreground barely changes
  change_rate fraction of consecutive sample pairs with a visible change
  cut_rate    hard changes (most of the foreground replaced) per second
These are screen-level proxies, not semantic text measurements.

Usage: python measure-generation-gap.py out.json name=path.mp4 [name=path.mp4 ...]
"""
import json, sys
import cv2
import numpy as np

W, H, RATE = 480, 270, 12


def frames(path, info):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = max(1, round(fps / RATE))
    info['rate'] = fps / step
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            yield cv2.cvtColor(cv2.resize(frame, (W, H), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        i += 1
    cap.release()


def measure(path):
    rows, prev, info = [], None, {}
    for gray in frames(path, info):
        border = np.concatenate([gray[0], gray[-1], gray[:, 0], gray[:, -1]])
        mask = (np.abs(gray.astype(int) - int(np.median(border))) >= 50).astype(np.uint8)
        merged = cv2.dilate(mask, np.ones((5, 5), np.uint8))
        n, _, stats, _ = cv2.connectedComponentsWithStats(merged)
        boxes = [s for s in stats[1:] if s[4] >= W * H * 0.0005]
        row = {'fg': bool(boxes)}
        if boxes:
            x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes)
            x1 = max(b[0] + b[2] for b in boxes); y1 = max(b[1] + b[3] for b in boxes)
            row.update(hero_h=max(b[3] for b in boxes) / H, blocks=len(boxes),
                       coverage=(x1 - x0) * (y1 - y0) / (W * H), center_dx=abs((x0 + x1) / 2 / W - .5))
        if prev is not None:
            union = np.logical_or(mask, prev).sum()
            diff = np.logical_xor(mask, prev).sum()
            ratio = diff / union if union else 0.0
            row['changed'] = ratio > .02
            row['cut'] = ratio > .6
        rows.append(row)
        prev = mask
    fg = [r for r in rows if r['fg']]
    med = lambda k: float(np.median([r[k] for r in fg])) if fg else None
    rate = info['rate']
    runs, run = [], 0
    for r in rows[1:]:
        if r['changed']:
            if run: runs.append(run / rate)
            run = 0
        else:
            run += 1
    if run: runs.append(run / rate)
    pairs = rows[1:]
    seconds = len(rows) / rate
    return {
        'seconds': round(seconds, 2),
        'hero_h': med('hero_h'), 'hero_h_p90': float(np.percentile([r['hero_h'] for r in fg], 90)) if fg else None,
        'blocks': med('blocks'), 'coverage': med('coverage'), 'center_dx': med('center_dx'),
        'still_run_median_s': float(np.median(runs)) if runs else None,
        'change_rate': sum(r['changed'] for r in pairs) / max(1, len(pairs)),
        'cut_rate_per_s': sum(r['cut'] for r in pairs) / max(1, seconds),
    }


if __name__ == '__main__':
    out = {}
    for arg in sys.argv[2:]:
        name, path = arg.split('=', 1)
        out[name] = measure(path)
        print(name, {k: (round(v, 3) if isinstance(v, float) else v) for k, v in out[name].items()})
    json.dump(out, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
