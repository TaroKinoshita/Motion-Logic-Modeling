"""Compare reviewed checkpoints by foreground overlap and OCR disagreement."""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys
import unicodedata

import cv2
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'workers/track/track'))
from blocking_sample import Recognizer


def crop_at(cap, frame, region):
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame)
    ok, image = cap.read()
    if not ok:
        raise ValueError(f'Cannot read {frame}F')
    height, width = image.shape[:2]
    x0, y0, x1, y1 = [round(n * s) for n, s in zip(region, (width, height, width, height))]
    return cv2.resize(image[y0:y1, x0:x1], (480, 256), interpolation=cv2.INTER_AREA)


def reading(value):
    return ''.join(unicodedata.normalize('NFKC', value).split())


def compare(source, original, corrected, case, recognizer):
    rows, tiles = [], []
    for frame in case['checks']:
        images = [crop_at(cap, frame, case['region']) for cap in (source, original, corrected)]
        polarity = case['polarity']
        threshold = dict(cream=205, frame=28, bright=105, dark=157, **{'dark-blue':83})[polarity]
        grays = [cv2.cvtColor(im, cv2.COLOR_BGR2GRAY) for im in images]
        masks = [g < threshold if polarity.startswith('dark') else g > threshold for g in grays]
        scores, ocr = [], []
        for im, mask in zip(images, masks):
            scores.append(float(np.count_nonzero(masks[0] & mask) / max(1, np.count_nonzero(masks[0] | mask))))
            rect = cv2.boundingRect(mask.astype(np.uint8))
            ocr.append(recognizer.recognize(im, rect) if min(rect[2:]) >= 8 else {'text':'', 'confidence':None})
        def status(candidate):
            a, b = ocr[0], ocr[candidate]
            if min(a['confidence'] or 0, b['confidence'] or 0) < .9 or not reading(a['text']) or not reading(b['text']):
                return 'needs-review'
            return 'match' if reading(a['text']) == reading(b['text']) else 'disagreement'
        rows.append(dict(frame=frame, roiIoUBefore=scores[1], roiIoUAfter=scores[2], sourceOCR=ocr[0],
                         beforeOCR=ocr[1], afterOCR=ocr[2], before=status(1), after=status(2)))
        tiles.append((frame, images))
    return rows, tiles


def sheet(tiles, target):
    image = Image.new('RGB', (960, len(tiles) * 200), '#181818')
    artist = ImageDraw.Draw(image)
    for i, (frame, images) in enumerate(tiles):
        for column, (panel, label) in enumerate(zip(images, ('Source', 'Before', 'After'))):
            x, y = column * 320, i * 200
            artist.text((x + 8, y + 5), f'{frame}F / {label}', fill='white')
            image.paste(Image.fromarray(cv2.cvtColor(cv2.resize(panel, (320, 171)), cv2.COLOR_BGR2RGB)), (x, y + 22))
    image.save(target, quality=92)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('inventory', type=Path)
    parser.add_argument('model', type=Path)
    args = parser.parse_args()
    cv2.setNumThreads(2)
    names = {r['sample']: r['path'] for r in json.loads(args.inventory.read_text(encoding='utf-8'))}
    recognizer = Recognizer(args.model)
    output = args.root / 'Corrections'
    report = {}
    index = ['# 6本のレビュー修正版', '', '[OCR・輪郭照合の結果](recognition-audit.json)', '',
             '比較画像は左から元動画、旧版、修正版。OCRの要確認は低信頼・判読不能を含む。', '',
             '| 素材 | 4画面 | 文字差し替え | 修正前後のコマ |', '| --- | --- | --- | --- |']
    for number in (2, 3, 4, 5, 6, 7):
        entry = f'Lyricsample{number}'
        folder = output / entry
        metadata = json.loads((folder / 'report.json').read_text(encoding='utf-8'))
        caps = [cv2.VideoCapture(str(file)) for file in (names[number], args.root / entry / '04-editable.mp4', folder / '04-editable.mp4')]
        cases = []
        for item in metadata['shotAudit']:
            frames, tiles = compare(*caps, item, recognizer)
            file = f"{item['id']}-before-after.jpg"
            sheet(tiles, folder / file)
            cases.append(dict(id=item['id'], label=item['label'], frames=frames, image=file))
        for cap in caps:
            cap.release()
        links = [f"[{case['label']}]({entry}/{case['image']})" for case in cases]
        if number == 4:
            cap_paths = [names[number], args.root / entry / '05-replacement.mp4', folder / '05-replacement.mp4']
            variants = [cv2.VideoCapture(str(file)) for file in cap_paths]
            tiles = [(frame, [crop_at(cap, frame, (0, .2, 1, .74)) for cap in variants])
                     for frame in (12, 20, 108, 116, 130, 151, 179)]
            sheet(tiles, folder / 'replacement-before-after.jpg')
            for cap in variants:
                cap.release()
            links.append(f'[差し替えと訳の表示]({entry}/replacement-before-after.jpg)')
        frames = [frame for case in cases for frame in case['frames']]
        report[entry] = dict(projectId=metadata['projectId'], variantId=metadata['variantId'], cases=cases,
                             ocrBefore=Counter(row['before'] for row in frames), ocrAfter=Counter(row['after'] for row in frames))
        index.append(f'| {entry} | [4画面]({entry}/01-comparison.mp4) | [文字差し替え]({entry}/05-replacement.mp4) | {" ・ ".join(links)} |')
    (output / 'recognition-audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    (output / 'INDEX.md').write_text('\n'.join(index) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
