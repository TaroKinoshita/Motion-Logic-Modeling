"""Extract editable outlines and screen-space tracks from flat-background footage."""

import argparse
import json
from pathlib import Path
from time import perf_counter

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

from blocking_sample import Recognizer


def extract(frame, offset=(0, 0), background=None):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    border = np.concatenate((gray[0, :], gray[-1, :], gray[:, 0], gray[:, -1]))
    if background is None:
        background = int(np.median(border))
    dark = background >= 128
    difference = cv2.subtract(background, gray) if dark else cv2.subtract(gray, background)
    mask = cv2.threshold(difference, 24, 255, cv2.THRESH_BINARY)[1]
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return background, []
    detections = []
    for index, contour in enumerate(contours):
        if hierarchy[0][index][3] != -1 or len(contour) < 3:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        area = cv2.contourArea(contour)
        if area < 3 or area > gray.size * .65:
            continue
        holes = []
        child = hierarchy[0][index][2]
        while child >= 0:
            holes.append(contours[child])
            child = hierarchy[0][child][0]
        inner = gray[y:y + h, x:x + w][mask[y:y + h, x:x + w] > 0]
        ink = int(np.percentile(inner, 22 if dark else 78))
        detections.append({
            "box": [x + offset[0], y + offset[1], w, h],
            "center": np.array([x + w / 2 + offset[0], y + h / 2 + offset[1]]),
            "parts": [contour, *holes],
            "ink": ink,
            "area": area,
        })
    return background, detections


def group_components(parts):
    """Attach nearby fragments to a substantial overlapping glyph, retaining their contours."""
    groups = []
    for part in sorted(parts, key=lambda part: -part["area"]):
        x, y, w, h = part["box"]
        for group in groups:
            gx, gy, gw, gh = group["box"]
            dx = max(0, gx - x - w, x - gx - gw)
            dy = max(0, gy - y - h, y - gy - gh)
            overlap_x = min(x + w, gx + gw) - max(x, gx)
            overlap_y = min(y + h, gy + gh) - max(y, gy)
            near = max(dx, dy) <= min(10, .13 * min(max(w, h), max(gw, gh)))
            aligned = overlap_x > min(w, gw) * .4 or overlap_y > min(h, gh) * .6
            if near and aligned and (w * h > 40 or (dx == 0 and dy == 0)):
                left, top = min(x, gx), min(y, gy)
                ww, hh = max(x + w, gx + gw) - left, max(y + h, gy + gh) - top
                group["box"] = [left, top, ww, hh]
                group["center"] = np.array([left + ww / 2, top + hh / 2])
                group["parts"].extend(part["parts"])
                break
        else:
            groups.append(part)
    return groups


def paths_for(detection, offset):
    x, y, w, h = detection["box"]
    origin = np.array([x - offset[0], y - offset[1]])
    scale = np.array([4096 / max(1, w - 1), 4096 / max(1, h - 1)])
    paths = []
    for contour in detection["parts"]:
        polygon = cv2.approxPolyDP(contour, .65, True).reshape((-1, 2))
        if len(polygon) >= 3:
            paths.append(np.rint((polygon - origin) * scale).astype(int).ravel().tolist())
    return paths


def assign(previous, detections, frame):
    if not previous or not detections:
        return {}
    cost = np.full((len(previous), len(detections)), 1e6)
    for row, track in enumerate(previous):
        last = track["samples"][-1]
        _, _, old_w, old_h = last["box"]
        old_center = track["center"]
        velocity = track["velocity"] * min(frame - last["frame"], 2)
        for col, candidate in enumerate(detections):
            _, _, width, height = candidate["box"]
            ratio = max(width * height / (old_w * old_h), old_w * old_h / (width * height))
            scale = max(24, np.hypot(old_w, old_h), np.hypot(width, height))
            delta = candidate["center"] - old_center
            separation = min(np.linalg.norm(delta), np.linalg.norm(delta - velocity))
            if ratio <= 12 and separation <= max(35, scale * .95):
                cost[row, col] = separation / scale + .24 * abs(np.log(ratio)) + .08 * (frame - last["frame"] - 1)
    indices = zip(*linear_sum_assignment(cost))
    return {col: previous[row] for row, col in indices if cost[row, col] < 1.05}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--ocr-model", type=Path)
    args = parser.parse_args()
    conf = json.loads(args.config.read_text(encoding="utf-8")) if args.config else {}
    bounds = conf.get("region")
    offset = tuple(bounds[:2]) if bounds else (0, 0)
    cuts = set(conf.get("cuts", []))
    ocr_frames = set(conf.get("ocrFrames", []))
    recognizer = Recognizer(args.ocr_model) if args.ocr_model else None
    capture = cv2.VideoCapture(str(args.video))
    if not capture.isOpened():
        raise RuntimeError(f"Unable to open {args.video}")
    fps = capture.get(cv2.CAP_PROP_FPS)
    if fps <= 0:
        raise RuntimeError("Video frame rate unavailable")
    tracks, backgrounds, shared = [], [], []
    active = []
    frame = 0
    started = perf_counter()
    try:
        while frame < conf.get("to", float("inf")):
            ok, image = capture.read()
            if not ok:
                break
            if bounds:
                gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
                background = int(np.median(np.concatenate((gray[0], gray[-1], gray[:,0], gray[:,-1]))))
                x, y, w, h = bounds
                _, parts = extract(image[y:y + h, x:x + w], offset, background)
            else:
                background, parts = extract(image)
            backgrounds.append(background)
            visible = conf.get("from", 0) <= frame < conf.get("to", float("inf"))
            detections = group_components(parts) if visible else []
            active = [track for track in active if frame - track["samples"][-1]["frame"] <= 2]
            if frame in cuts or (frame and (background >= 128) != (backgrounds[-2] >= 128)):
                active = []
            matches = assign(active, detections, frame)
            shifts = []
            for col, detection in enumerate(detections):
                paths = paths_for(detection, offset)
                if not paths:
                    continue
                track = matches.get(col)
                sample = {"frame": frame, "box": detection["box"], "paths": paths, "ink": detection["ink"]}
                if recognizer and frame in ocr_frames and detection["area"] >= 350:
                    sample["ocr"] = recognizer.recognize(image, detection["box"])
                if track is None:
                    track = {"id": len(tracks) + 1, "samples": [], "velocity": np.zeros(2)}
                    tracks.append(track)
                    active.append(track)
                else:
                    dt = frame - track["samples"][-1]["frame"]
                    track["velocity"] = (detection["center"] - track["center"]) / dt
                    if detection["area"] >= 350 and dt == 1:
                        shifts.append((track["velocity"], detection["center"]))
                track["center"] = detection["center"]
                track["samples"].append(sample)
            if len(shifts) >= 3:
                displacement, centers = np.array([s[0] for s in shifts]), np.array([s[1] for s in shifts])
                spread = float(np.ptp(centers, axis=0).max())
                move = np.median(displacement, axis=0)
                residual = float(np.median(np.linalg.norm(displacement - move, axis=1)))
                if spread >= 160 and np.linalg.norm(move) >= 3 and residual < 3:
                    shared.append({"frame": frame, "support": len(shifts), "spread": spread,
                                   "movement": move.tolist(), "medianResidual": residual})
            frame += 1
            if conf.get("to") and (frame % 24 == 0 or frame == conf["to"]):
                print(f"PROGRESS {frame}/{conf['to']}", flush=True)
    finally:
        capture.release()
    result = {"fps": fps, "frames": frame, "backgrounds": backgrounds, "cameraCandidates": shared,
              "tracks": [{"id": t["id"], "samples": t["samples"]} for t in tracks],
              "runtimeSeconds": round(perf_counter() - started, 3), "opencv": cv2.__version__}
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
