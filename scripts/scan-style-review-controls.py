"""Apply the fixed crop and background screen to the existing corpus."""
import argparse
import json
from pathlib import Path
import runpy


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('attribution',type=Path)
    parser.add_argument('out',type=Path)
    args = parser.parse_args()
    module = runpy.run_path(str(Path(__file__).with_name('verify-style-attribution.py')))
    module['cv2'].setNumThreads(2)
    sources = json.loads(args.attribution.read_text(encoding='utf-8'))['works']
    works = []
    for work in sources:
        result = module['scan']({**work,'sha256':work['sourceSha256']},controlled=True)
        works.append(result)
        print(result['id'],result['edgeBands'],result['distinctPlainFrames'],result['distinctFrames'],flush=True)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps({'works':works},indent=2,allow_nan=False),encoding='utf-8')


if __name__=='__main__':
    main()
