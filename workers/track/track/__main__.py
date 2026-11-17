import argparse
import json
import math
import hashlib
from pathlib import Path
import cv2
import numpy as np


def track(video, region, start, fps):
    if not math.isfinite(start) or start < 0 or not math.isfinite(fps) or fps <= 0:
        raise ValueError('Invalid start time or fps')
    cap = cv2.VideoCapture(str(video))
    samples = []
    reason = None
    try:
        ok, frame = cap.read()
        if not ok:
            raise ValueError('Cannot decode first frame')
        if abs(cap.get(cv2.CAP_PROP_FPS) - fps) > 0.001:
            raise ValueError('Input must be a constant-frame-rate clip matching fps')
        x, y, w, h = region
        height, width = frame.shape[:2]
        if min(x, y) < 0 or min(w, h) <= 0 or x+w > width or y+h > height or fps <= 0:
            raise ValueError('Invalid region or fps')
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        mask = np.zeros_like(gray); mask[y:y+h, x:x+w] = 255
        points = cv2.goodFeaturesToTrack(gray, mask=mask, maxCorners=120, qualityLevel=0.01, minDistance=3)
        if points is None or len(points) < 6:
            raise ValueError('At least six textured feature points are required')
        initial_count = len(points)
        center = np.array([x+w/2, y+h/2, 1.0])
        cumulative = np.eye(3)
        samples.append(dict(t=start, x=float(center[0]), y=float(center[1]), scale=1.0, rotation=0.0, confidence=1.0))
        index = 0
        previous_angle = 0.0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            index += 1
            next_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            nxt, status, _ = cv2.calcOpticalFlowPyrLK(gray, next_gray, points, None, winSize=(21,21), maxLevel=3)
            if nxt is None:
                reason = 'optical_flow_failed'; break
            back, back_status, _ = cv2.calcOpticalFlowPyrLK(next_gray, gray, nxt, None, winSize=(21,21), maxLevel=3)
            if back is None:
                reason = 'backward_flow_failed'; break
            good = (status.ravel() == 1) & (back_status.ravel() == 1) & (np.linalg.norm(back-points, axis=2).ravel() < 1.5)
            if np.count_nonzero(good) < 6:
                reason = 'insufficient_features'; break
            affine, inliers = cv2.estimateAffinePartial2D(points[good], nxt[good], method=cv2.RANSAC, ransacReprojThreshold=2)
            if affine is None or inliers is None:
                reason = 'affine_fit_failed'; break
            confidence = int(inliers.sum()) / initial_count
            step_scale = float(np.hypot(affine[0,0], affine[1,0]))
            if confidence < 0.25 or not 0.5 < step_scale < 2:
                reason = 'low_confidence'; break
            cumulative = np.vstack([affine, [0,0,1]]) @ cumulative
            cx, cy, _ = cumulative @ center
            angle = float(np.degrees(np.arctan2(cumulative[1,0], cumulative[0,0])))
            angle += round((previous_angle-angle)/360)*360
            previous_angle = angle
            samples.append(dict(t=start+index/fps, x=float(cx), y=float(cy), scale=float(np.hypot(cumulative[0,0],cumulative[1,0])), rotation=angle, confidence=confidence))
            points = nxt[good][inliers.ravel().astype(bool)].reshape(-1,1,2)
            gray = next_gray
        return dict(tool='OpenCV LK + partial affine RANSAC', version=cv2.__version__, origin='estimated',
                    region=dict(x=x,y=y,w=w,h=h), fps=fps, samples=samples, stoppedReason=reason,
                    stoppedAt=start+index/fps if reason else None,
                    params=dict(maxCorners=120, qualityLevel=0.01, minDistance=3, forwardBackwardThreshold=1.5, ransacThreshold=2, minConfidence=0.25),
                    confidenceMeaning='surviving RANSAC inliers / initial feature count; not a probability')
    finally:
        cap.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('video'); parser.add_argument('output')
    parser.add_argument('--region', type=int, nargs=4, required=True)
    parser.add_argument('--start-time', type=float, default=0)
    parser.add_argument('--fps', type=float, required=True)
    parser.add_argument('--fit-output', help='Separate JSON file for proposed linear keys')
    args = parser.parse_args()
    if args.fit_output and Path(args.fit_output).resolve() == Path(args.output).resolve():
        raise ValueError('Observation and fitted keys require different files')
    result = track(args.video, args.region, args.start_time, args.fps)
    with open(args.video, 'rb') as source:
        result['inputSha256'] = hashlib.file_digest(source, 'sha256').hexdigest()
    target = Path(args.output); temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps(result, allow_nan=False), encoding='utf-8'); temp.replace(target)
    if args.fit_output:
        from .fit import fit_track
        fit = fit_track(result['samples'])
        fit['observationSha256'] = hashlib.sha256(target.read_bytes()).hexdigest()
        fitted = Path(args.fit_output); fit_temp = fitted.with_suffix('.tmp')
        fit_temp.write_text(json.dumps(fit, allow_nan=False), encoding='utf-8'); fit_temp.replace(fitted)
    print(json.dumps(dict(samples=len(result['samples']), stoppedReason=result['stoppedReason'])))


if __name__ == '__main__':
    main()
