"""Measure visible block extents from seeded frame ranges; OCR is optional evidence."""

import argparse
import json
from pathlib import Path
from time import perf_counter

import cv2
import numpy as np


def foreground(gray, light):
    flag = cv2.THRESH_BINARY_INV if light else cv2.THRESH_BINARY
    _, mask = cv2.threshold(gray, 0, 255, flag | cv2.THRESH_OTSU)
    return mask


def measure(mask, roi, min_area):
    x, y, w, h = roi
    crop = mask[y:y + h, x:x + w]
    count, _, stats, _ = cv2.connectedComponentsWithStats(crop)
    components = [
        [int(left) + x, int(top) + y, int(width), int(height), int(area)]
        for left, top, width, height, area in stats[1:count]
        if min_area <= area < crop.size * 0.85
    ]
    if not components:
        return None
    left = min(part[0] for part in components)
    top = min(part[1] for part in components)
    right = max(part[0] + part[2] for part in components)
    bottom = max(part[1] + part[3] for part in components)
    return {
        "box": [left, top, right - left, bottom - top],
        "touchesRoi": left == x or top == y or right == x + w or bottom == y + h,
        "components": components,
    }


def polarity(frame):
    width = max(1, frame.shape[1] // 100)
    height = max(1, frame.shape[0] // 100)
    edges = [frame[:height], frame[-height:], frame[:, :width], frame[:, -width:]]
    return np.median(np.concatenate([edge[::2, ::2].ravel() for edge in edges])) >= 128


class Recognizer:
    def __init__(self, folder):
        import onnxruntime as ort
        import yaml

        model = folder / "inference.onnx"
        self.labels = ["", *yaml.safe_load((folder / "inference.yml").read_text(
            encoding="utf-8"))["PostProcess"]["character_dict"], " "]
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.log_severity_level = 3
        self.session = ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.version = ort.__version__

    def recognize(self, frame, rect):
        x, y, w, h = rect
        pad = max(4, round(min(w, h) * 0.12))
        crop = frame[max(0, y - pad):y + h + pad, max(0, x - pad):x + w + pad]
        width = min(320, int(np.ceil(48 * crop.shape[1] / crop.shape[0])))
        rgb = cv2.resize(crop, (width, 48)).astype(np.float32)
        pixels = np.zeros((1, 3, 48, 320), dtype=np.float32)
        pixels[0, :, :, :width] = (rgb.transpose(2, 0, 1) / 255.0 - 0.5) / 0.5
        start = perf_counter()
        probs = self.session.run(None, {self.input_name: pixels})[0][0]
        if probs.shape[1] != len(self.labels):
            raise ValueError("Recognition model and dictionary size differ")
        indices = probs.argmax(axis=1)
        positions = [
            i for i, value in enumerate(indices)
            if value and (i == 0 or value != indices[i - 1])
        ]
        return {
            "text": "".join(self.labels[indices[i]] for i in positions),
            "confidence": float(np.mean([probs[i, indices[i]] for i in positions])) if positions else None,
            "inferenceMs": round((perf_counter() - start) * 1000, 1),
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("config", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--ocr-model", type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    recognizer = Recognizer(args.ocr_model) if args.ocr_model else None
    requested = {(target["id"], target["frame"]) for target in config.get("ocr", [])}
    video = cv2.VideoCapture(str(args.video))
    if not video.isOpened():
        raise RuntimeError(f"Cannot open video {args.video}")
    rows, inversions = [], []
    previous = None
    frame_index = 0
    start = perf_counter()
    try:
        while True:
            ok, frame = video.read()
            if not ok:
                break
            light = polarity(frame)
            if previous is not None and light != previous:
                inversions.append({"frame": frame_index, "background": "light" if light else "dark"})
            previous = light
            lanes = [lane for lane in config["lanes"] if lane["from"] <= frame_index < lane["to"]]
            if lanes:
                mask = foreground(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), light)
                for lane in lanes:
                    observation = measure(mask, lane["roi"], lane.get("minArea", 16))
                    row = {"id": lane["id"], "frame": frame_index, "measurement": observation}
                    if observation and recognizer and (lane["id"], frame_index) in requested:
                        row["ocr"] = recognizer.recognize(frame, observation["box"])
                    rows.append(row)
            frame_index += 1
    finally:
        video.release()
    result = {
        "framesDecoded": frame_index,
        "frames": rows,
        "inversions": inversions,
        "elapsedSeconds": round(perf_counter() - start, 2),
        "ocrRuntime": {"provider": "CPUExecutionProvider", "onnxruntime": recognizer.version} if recognizer else None,
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
