"""Audit full-text cut versus staged entry on previously selected native frames."""
import argparse
from collections import Counter
import json
from pathlib import Path


# The frame interval records the checked change, not the entire sampled window.
REVIEWS = {
    'P06':('uncertain',266,267,'次の語の右端が画面端にかかる'),
    'P09':('staged',125,127,'先行する文を保ち、けとれが別コマで加わる'),
    'P10':('staged',180,184,'感の後に動が現れ、途中で向きも変わる'),
    'P12':('staged',67,69,'問いから切り替わり、ねぇが読めるまでに別の字形を挟む'),
    'P13':('staged',62,65,'顔がの後、おが現れてから別の字形が加わる'),
    'P15':('uncertain',300,304,'先行するらとの同一性と回転中の語の範囲を分けにくい'),
    'P16':('out-of-scope',58,59,'ですから、人型を主とする画面に切り替わる'),
    'P18':('one-frame',84,85,'がから枠内の2字がそろって出る'),
    'P28':('uncertain',126,127,'新しい大字の一部が画面端で切れる'),
    'P29':('uncertain',399,404,'小字が変形中で、最終的な語の全体を確認できない'),
    'P37':('uncertain',217,218,'日が出る位置を輪の白い線が遮る'),
    'P41':('uncertain',175,179,'前後とも画面端にかかり、新しい語の全体が不明'),
    'P42':('staged',28,31,'前の字が枠に隠れ、に、でが順に出る'),
    'P44':('uncertain',188,192,'変形が強く、文字列全体が読める時刻を決められない'),
    'P45':('uncertain',60,61,'新しい字が画面端で切れている'),
    'P46':('one-frame',158,159,'しずくに続き、新しい行がまとめて表示される'),
    'P47':('one-frame',132,133,'あぁが2字そろって表示される'),
    'P48':('one-frame',99,100,'前の文字列に代わって乗が1コマで現れる'),
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('opportunities',type=Path)
    parser.add_argument('out',type=Path)
    args=parser.parse_args()
    data=json.loads(args.opportunities.read_text(encoding='utf-8'))
    picked=[row for row in data['windows'] if row['review']=='changed']
    assert {row['id'] for row in picked}==REVIEWS.keys()
    rows=[]
    for row in picked:
        status,start,end,note=REVIEWS[row['id']]
        assert start in row['frames'] and end in row['frames'] and start<end
        if status=='one-frame':
            assert end==start+1
        rows.append(dict(id=row['id'],work=row['work'],group=row['group'],sourceSha256=row['sourceSha256'],
                         fps=row['fps'],reviewWindow=row['frames'],transition=[start,end],status=status,note=note))
    groups={key:dict(Counter(row['status'] for row in rows if row['group']==key)) for key in ('reference','control')}
    result=dict(cohorts=groups,rows=rows,
                scope='descriptive audit of one visible text change per sampled changed window; excludes unknown and pictogram-only targets')
    args.out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(groups)


if __name__=='__main__':
    main()
