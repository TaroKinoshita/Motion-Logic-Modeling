"""Compare withheld-source choice and attribution models on the current corpus."""
import argparse
from collections import Counter
import json
from pathlib import Path

import numpy as np


ACTIONS = ('continue','grow','deep-shrink')
CHOICE_FEATURES = ('widthRatio','boxAreaRatio','previousGrowthObserved','historyIncomplete')
ATTRIBUTION_FEATURES = {
    'layout':['coverage','coverageSpread','boxCount','heightRatio','largestBox','centerDistance'],
    'flow':['flowMedian','flowP90','flowIqr','stillFraction'],
    'curves':['accelerationP90','decelerationP90','jerkP90','stopTransitions','motionStarts'],
    'contrast':['sizeContrastP90'],
}


def standardize(raw, fit):
    train = raw[fit]
    medians = np.array([np.median(col[np.isfinite(col)]) if np.isfinite(col).any() else 0 for col in train.T])
    filled = np.where(np.isfinite(raw),raw,medians)
    center = filled[fit].mean(axis=0)
    scale = filled[fit].std(axis=0)
    scale[scale<1e-8] = 1
    return (filled-center)/scale


def label_metrics(rows, candidates, method):
    by_action = {}
    for item in candidates:
        expected = [row for row in rows if row['actual']==item]
        by_action[item] = dict(correct=sum(row[method]==item for row in expected),total=len(expected))
    recalls = [entry['correct']/entry['total'] for entry in by_action.values() if entry['total']]
    return dict(correct=sum(row[method]==row['actual'] for row in rows),total=len(rows),
                balancedAccuracy=float(np.mean(recalls)) if recalls else None,byAction=by_action)


def fit_actions(raw,target,index,fit,labels):
    x = standardize(raw,fit)
    training = target[fit]
    seen = np.unique(training)
    nearest = training[np.argmin(np.sum((x[fit]-x[index])**2,axis=1))]
    train_design = np.column_stack([np.ones(fit.sum()),x[fit]])
    predictors = np.r_[1,x[index]]
    penalty = np.diag([0,*([4]*raw.shape[1])])
    weight = np.linalg.solve(train_design.T@train_design+penalty,train_design.T@np.eye(len(labels))[training])
    scores = predictors @ weight
    fitted = seen[np.argmax(scores[seen])]
    return dict(majority=labels[np.bincount(training).argmax()],nearest=labels[nearest],ridge=labels[fitted],
                trainingLabels=[labels[j] for j in seen],ridgeScores={labels[j]:float(scores[j]) for j in seen})


def choices(data, groups, audio):
    metrics = []
    for case in data:
        c=case['context']
        metrics.append([c['widthRatio'],c['boxAreaRatio'],float(c['growth']=='observed'),
                        float(c['growth']=='unknown-in-part-of-lookback')])
    raw = np.array(metrics)
    combined = np.column_stack([raw, np.array([[audio['audioByScaleChoice'][case['id']][key]
                           for key in audio['audioFeatures']] for case in data],dtype=float)])
    target = np.array([ACTIONS.index(case['action']) for case in data])
    source = np.array([groups[case['source']] for case in data])
    rows = []
    for i, case in enumerate(data):
        fit = source!=source[i]
        width = metrics[i][0]
        rows.append(dict(id=case['id'],source=case['source'],leftOutGroup=source[i],cohort=case['cohort'],
             actual=case['action'],observables=dict(zip(CHOICE_FEATURES,metrics[i])),always='continue',
             widthRule='deep-shrink' if width>=.5 else 'grow' if width<=.25 else 'continue',
             **fit_actions(raw,target,i,fit,ACTIONS), audioRidge=fit_actions(combined,target,i,fit,ACTIONS)['ridge']))
    cohorts = {}
    for name in ('uniform','discovery'):
        items = [row for row in rows if row['cohort']==name]
        cohorts[name] = {method: label_metrics(items,ACTIONS,method) for method in ('always','widthRule','nearest','ridge','audioRidge')}
    return dict(cohorts=cohorts,rows=rows)


def entry_windows(data,groups):
    labels = ('continue','grow','append','replace')
    cases = data['windows']
    target = np.array([labels.index(case['actual']) for case in cases])
    source = np.array([groups[case['source']] for case in cases])
    audio = np.array([[case['audioBefore'][key] for key in data['audioFeatures']] for case in cases],dtype=float)
    result = {}
    for mode in ('row','edge'):
        raw = np.array([[case['features'][mode][key] for key in data['features']] for case in cases],dtype=float)
        combined = np.column_stack([raw,audio])
        rows = []
        for i,case in enumerate(cases):
            fit = source!=source[i]
            rows.append(dict(id=case['id'],source=case['source'],actual=case['actual'],alwaysReplace='replace',
                **fit_actions(raw,target,i,fit,labels),audioRidge=fit_actions(combined,target,i,fit,labels)['ridge']))
        result[mode] = dict(rows=rows,methods={method:label_metrics(rows,labels,method)
                                for method in ('alwaysReplace','majority','nearest','ridge','audioRidge')})
    return result


def authors(works, groups):
    result = []
    for subset in ('all','without-effects'):
        sample = [work for work in works if subset=='all' or work['id']!='Lyricsample7']
        target = np.array([work['group'] for work in sample])
        source = np.array([groups[work['id']] for work in sample])
        for window in ('center','early','late'):
            for mask in ('row','edge'):
                for feature_groups in (('layout',),('layout','flow'),('curves',),('layout','curves'),
                                       ('layout','contrast'),('layout','curves','contrast')):
                    names = [name for group in feature_groups for name in ATTRIBUTION_FEATURES[group]]
                    raw = np.array([[w['windows'][window][mask][name] for name in names] for w in sample],dtype=float)
                    rows = []
                    for index, werk in enumerate(sample):
                        fit = source!=source[index]
                        x = standardize(raw,fit)
                        a = x[fit&(target=='reference')].mean(axis=0)
                        b = x[fit&(target=='control')].mean(axis=0)
                        shares = ((x[index]-b)**2-(x[index]-a)**2)/len(names)
                        rows.append(dict(id=werk['id'],actual=werk['group'],group=source[index],
                             centroid='reference' if shares.sum()>0 else 'control',
                             margin=float(shares.sum()),contributions=dict(zip(names,shares.tolist())),
                             missing=[name for name,v in zip(names,raw[index]) if not np.isfinite(v)]))
                    result.append(dict(subset=subset,window=window,mask=mask,features=feature_groups,
                         **label_metrics(rows,('reference','control'),'centroid'),rows=rows))
    return result


def attribution_stability(evaluation):
    cohorts = {}
    for subset in ('all','without-effects'):
        runs = [run for run in evaluation if run['subset']==subset and run['features']==('layout','curves')]
        reference_votes = Counter(row['id'] for run in runs for row in run['rows'] if row['centroid']=='reference')
        rows = []
        for row in runs[0]['rows']:
            n = reference_votes[row['id']]
            prediction = 'reference' if n>=5 else 'control' if n<=1 else 'uncertain'
            rows.append(dict(id=row['id'],actual=row['actual'],referenceVotes=n,runs=len(runs),prediction=prediction))
        cohorts[subset] = rows
    return cohorts


def read(file):
    return json.loads(file.read_text(encoding='utf-8'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('attribution',type=Path)
    parser.add_argument('groups',type=Path)
    parser.add_argument('choices',type=Path)
    parser.add_argument('opportunities',type=Path)
    parser.add_argument('boundaries',type=Path)
    parser.add_argument('entry_windows',type=Path)
    args = parser.parse_args()
    works = read(args.attribution)['works']
    groups = read(args.groups)['provisionalGroups']
    choices_data = read(args.choices)['rows']
    opportunity_data = read(args.opportunities)['windows']
    boundary_data = read(args.boundaries)['rows']
    entries = read(args.entry_windows)
    windows = Counter(row['review'] for row in opportunity_data)
    attribution = authors(works,groups)
    report = dict(scope='provisional excerpt groups based on file and overlapping audio only',
                  opportunityCounts=dict(windows),opportunities=opportunity_data,observedBoundaries=boundary_data,
                  choiceEvaluation=choices(choices_data,groups,entries),entryChoiceEvaluation=entry_windows(entries,groups),
                  attributionEvaluation=attribution,attributionStability=attribution_stability(attribution))
    args.groups.with_name('comparisons.json').write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False),
                                                        encoding='utf-8')
    for cohort, data in report['choiceEvaluation']['cohorts'].items():
        print(cohort,{key:(value['correct'],value['total']) for key,value in data.items()})
    for mode,data in report['entryChoiceEvaluation'].items():
        print('entry',mode,{key:(value['correct'],value['total']) for key,value in data['methods'].items()})
    for entry in report['attributionEvaluation']:
        if entry['window']=='center' and entry['mask']=='row':
            print(entry['subset'],entry['features'],entry['correct'],entry['total'],round(entry['balancedAccuracy'],3))


if __name__=='__main__':
    main()
