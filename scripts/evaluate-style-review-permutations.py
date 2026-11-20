"""Evaluate fixed and searched settings under the same exact label shuffles."""
import argparse
from itertools import combinations
import json
from math import comb
from pathlib import Path
import runpy

import numpy as np


SETTINGS = [('layout',),('layout','flow'),('curves',),('layout','curves'),
            ('layout','contrast'),('layout','curves','contrast')]
WINDOWS = ('center','early','late')
MASKS = ('row','edge')


def label_orders(n,count):
    positives = np.zeros((n,comb(n,count)),dtype=bool)
    for index,members in enumerate(combinations(range(n),count)):
        positives[list(members),index] = True
    return positives


def classify(matrix,labels,standardize):
    predictions = np.zeros_like(labels)
    for i in range(len(matrix)):
        fit = np.arange(len(matrix))!=i
        x = standardize(matrix,fit)
        positives = labels[fit].T.astype(float)
        negatives = 1-positives
        a = (positives@x[fit])/positives.sum(axis=1,keepdims=True)
        b = (negatives@x[fit])/negatives.sum(axis=1,keepdims=True)
        predictions[i] = ((x[i]-a)**2).sum(axis=1)<((x[i]-b)**2).sum(axis=1)
    positive_recall = (predictions&labels).sum(axis=0)/labels.sum(axis=0)
    negative_recall = ((~predictions)&(~labels)).sum(axis=0)/(~labels).sum(axis=0)
    return (positive_recall+negative_recall)/2,predictions


def distribution(observed,null):
    count = int((null>=observed-1e-12).sum())
    return dict(observed=float(observed),asOrMoreExtreme=count,total=len(null),p=count/len(null))


def make_matrix(works,names,window,mask):
    return np.array([[work['windows'][window][mask][key] for key in names] for work in works],dtype=float)


def review(works,feature_groups,standardize):
    actual = np.array([work['group']=='reference' for work in works])
    labels = label_orders(len(works),int(actual.sum()))
    observed_index = int(np.flatnonzero(np.all(labels==actual[:,None],axis=0))[0])
    all_scores = []
    settings = []
    scores_by_setting = {}
    for effects in (True,False):
        mask = np.array([effects or work['id']!='Lyricsample7' for work in works])
        selected = [work for work, keep in zip(works,mask) if keep]
        for window in WINDOWS:
            for mode in MASKS:
                for combination in SETTINGS:
                    names = [name for key in combination for name in feature_groups[key]]
                    matrix = make_matrix(selected,names,window,mode)
                    scores,_ = classify(matrix,labels[mask],standardize)
                    scores_by_setting[effects,window,mode,combination] = scores
                    all_scores.append(scores)
                    settings.append(dict(includesEffects=effects,window=window,mask=mode,features=combination,
                                         balancedAccuracy=float(scores[observed_index])))
    primary = scores_by_setting[True,'center','row',('layout','curves')]
    baseline = scores_by_setting[True,'center','row',('layout',)]
    maximum = np.max(all_scores,axis=0)
    duration,guesses = classify(np.array([[w['durationSeconds']] for w in works]),labels,standardize)
    return dict(fixed=distribution(primary[observed_index],primary),
                incremental=distribution((primary-baseline)[observed_index],primary-baseline),
                maximumAcrossSettings=distribution(maximum[observed_index],maximum),settings=settings,
                lengthOnly={**distribution(duration[observed_index],duration),
                            'correct':int((guesses[:,observed_index]==actual).sum())})


def size_hierarchy(works):
    pairs = [work for work in works if work['dominantPairFrames']>=12]
    cohort = np.array([work['group']=='reference' for work in pairs],dtype=bool)
    if cohort.sum()<2 or (~cohort).sum()<2:
        return None
    rates = np.array([w['highContrastPairFrames']/w['dominantPairFrames'] for w in pairs])
    labels = label_orders(len(pairs),int(cohort.sum()))
    statistic = lambda group: (rates@group)/group.sum(axis=0)-(rates@(~group))/(~group).sum(axis=0)
    return {**distribution(abs(statistic(cohort)),np.abs(statistic(labels))),
            'difference':float(statistic(cohort)), 'referenceMean':float(rates[cohort].mean()),
            'referenceMedian':float(np.median(rates[cohort])), 'controlMean':float(rates[~cohort].mean()),
            'controlMedian':float(np.median(rates[~cohort])), 'referenceClips':int(cohort.sum()),'controlClips':int((~cohort).sum()),
            'rates':[dict(id=w['id'],rate=float(rate)) for w,rate in zip(pairs,rates)]}


def controlled(works,feature_groups,standardize):
    names = feature_groups['layout']+feature_groups['curves']
    eligible = [work for work in works if work['distinctPlainFrames']>=30 and
                any(work['windows'][name]['row']['validAccelerations']>=3 for name in WINDOWS)]
    data = dict(eligibility=[dict(id=w['id'],group=w['group'],eligible=w in eligible,edgeBands=w['edgeBands'],
                plainFrames=w['distinctPlainFrames'],frames=w['distinctFrames'],pairFrames=w['dominantPairFrames'],
                highContrastPairFrames=w['highContrastPairFrames']) for w in works])
    if sum(w['group']=='reference' for w in eligible)>=2 and sum(w['group']=='control' for w in eligible)>=2:
        raw = np.array([[[w['windows'][window]['row'][key] for key in names] for window in WINDOWS]
                        for w in eligible],dtype=float)
        count = np.isfinite(raw).sum(axis=1)
        composite = np.divide(np.nansum(raw,axis=1),count,out=np.full(count.shape,np.nan),where=count>0)
        actual = np.array([w['group']=='reference' for w in eligible])
        labels = label_orders(len(eligible),int(actual.sum()))
        observed = int(np.flatnonzero(np.all(labels==actual[:,None],axis=0))[0])
        scores,guesses = classify(composite,labels,standardize)
        data['classification'] = {**distribution(scores[observed],scores),
            'correct':int((guesses[:,observed]==actual).sum()), 'n':len(eligible)}
    data['sizeHierarchy'] = size_hierarchy(eligible)
    data['sizeHierarchyWithoutFrameHeavy3'] = size_hierarchy([w for w in eligible if w['id']!='Lyricsample3'])
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('historical',type=Path)
    parser.add_argument('out',type=Path)
    parser.add_argument('--controlled',type=Path)
    args = parser.parse_args()
    prior = json.loads(args.historical.read_text(encoding='utf-8'))['works']
    module = runpy.run_path(str(Path(__file__).with_name('compare-style-study-models.py')))
    groups,scale = module['ATTRIBUTION_FEATURES'],module['standardize']
    result = dict(historical=review(prior,groups,scale))
    if args.controlled:
        work = json.loads(args.controlled.read_text(encoding='utf-8'))['works']
        result['controlled']=controlled(work,groups,scale)
        # A review strip shows patterned content surviving the perimeter
        # screen. Remove both identified pattern-prone clips as a stress test.
        clean_candidate = [row for row in work if row['id'] not in {'LyricOther2','LyricOther5'}]
        result['excludePatternProneClips']=controlled(clean_candidate,groups,scale)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(result,indent=2,allow_nan=False),encoding='utf-8')
    print({key:value for key,value in result['historical'].items() if key!='settings'})
    if 'controlled' in result:
        print({key:value for key,value in result['controlled'].items() if key!='eligibility'})


if __name__=='__main__':
    main()
