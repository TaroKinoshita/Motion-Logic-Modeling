"""Measure isolated foreground shapes without relying on optical flow."""
import cv2
import numpy as np


def describe(mask, x, y):
    moments = cv2.moments(mask, binaryImage=True)
    left, top, width, height = cv2.boundingRect(mask)
    if not moments['m00'] or min(width, height) < 4:
        raise ValueError('Not enough foreground in initial region')
    shape = cv2.resize(mask[top:top+height, left:left+width], (64, 64), interpolation=cv2.INTER_NEAREST).astype(bool)
    box = dict(x=x+left, y=y+top, w=width, h=height)
    return box, shape, moments['m00'], (x+moments['m10']/moments['m00'], y+moments['m01']/moments['m00'])


def track_silhouette(video, region, start, fps, polarity, threshold):
    mode = cv2.THRESH_BINARY_INV if polarity == 'dark' else cv2.THRESH_BINARY

    def mask(frame):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        return cv2.threshold(gray, threshold, 255, mode)[1]

    capture = cv2.VideoCapture(str(video))
    try:
        ok, frame = capture.read()
        if not ok or abs(capture.get(cv2.CAP_PROP_FPS)-fps) > 0.001:
            raise ValueError('Expected a readable fixed-rate clip')
        x, y, w, h = region
        height, width = frame.shape[:2]
        if min(x, y) < 0 or min(w, h) < 4 or x+w > width or y+h > height:
            raise ValueError('Initial region is outside the frame or too small')
        initial = describe(mask(frame)[y:y+h, x:x+w], x, y)
        ref, ref_shape, ref_area, _ = initial
        if ref['w'] >= w or ref['h'] >= h:
            raise ValueError('Initial box must enclose the glyph with a margin')

        def sample(index, measurement, score):
            box, _, _, (cx, cy) = measurement
            return dict(t=start+index/fps, x=cx, y=cy, scale=box['h']/ref['h'], rotation=0,
                        confidence=score, bounds=box, widthScale=box['w']/ref['w'])

        samples = [sample(0, initial, 1)]
        previous_shape = ref_shape
        pending = None
        gaps = []
        index = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            index += 1
            current = mask(frame)
            # Dilate just to group nearby strokes; measure on the original mask.
            grouped = cv2.dilate(current, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19)))
            n, labels, stats, _ = cv2.connectedComponentsWithStats(grouped)
            candidates = []
            for label in range(1, n):
                left, top, cw, ch, _ = map(int, stats[label])
                if not (0.55*ref['w'] <= cw <= 1.7*ref['w'] and 0.55*ref['h'] <= ch <= 1.7*ref['h']):
                    continue
                patch = current[top:top+ch, left:left+cw].copy()
                patch[labels[top:top+ch, left:left+cw] != label] = 0
                box, shape, area, center = measured = describe(patch, left, top)
                if not 0.45 <= area/ref_area <= 2.1:
                    continue
                def overlap(other):
                    return float(np.count_nonzero(shape & other)/np.count_nonzero(shape | other))
                reference_overlap = overlap(ref_shape)
                score = overlap(previous_shape)
                distance = np.hypot(center[0]-samples[-1]['x'], center[1]-samples[-1]['y'])
                if reference_overlap >= .45 and score >= .58 and distance <= ref['w']*1.65:
                    candidates.append((score-.12*distance/ref['w'], score, measured))
            candidates.sort(key=lambda item: item[0], reverse=True)
            if not candidates or (len(candidates)>1 and candidates[0][0]-candidates[1][0] < .06):
                if pending is not None:
                    break
                pending = start+index/fps
                continue
            if pending is not None:
                gaps.append(pending)
                pending = None
            _, score, measured = candidates[0]
            previous_shape = measured[1]
            samples.append(sample(index, measured, score))
        return dict(tool='OpenCV threshold silhouette', version=cv2.__version__, origin='estimated',
                    region=dict(x=x,y=y,w=w,h=h), initialBounds=ref, fps=fps, samples=samples,
                    gapTimes=gaps, stoppedReason='ambiguous_or_missing_silhouette' if pending is not None else None,
                    stoppedAt=pending, params=dict(polarity=polarity,threshold=threshold,connectKernelPx=19,minOverlap=.58,minReferenceOverlap=.45),
                    confidenceMeaning='normalized foreground overlap with previous accepted glyph; not a probability',
                    limitations=['Rotation is not estimated', 'One missing frame may be interpolated by fitting'])
    finally:
        capture.release()
