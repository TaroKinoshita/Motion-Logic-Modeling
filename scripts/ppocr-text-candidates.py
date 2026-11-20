"""Run the pinned PP-OCRv5 Mobile detection model on CPU."""
from pathlib import Path
import hashlib
import time

import cv2
import numpy as np
import onnxruntime as ort


MODEL_SHA256 = 'a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d'


class Detector:
    def __init__(self, path: Path):
        self.sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
        if self.sha256 != MODEL_SHA256:
            raise ValueError('Use the pinned PaddlePaddle PP-OCRv5 Mobile detector')
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.log_severity_level = 3
        self.session = ort.InferenceSession(str(path), options, providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name

    def detect(self, frame, refine=True):
        start = time.perf_counter()
        candidates = self.detect_at(frame,960)+self.detect_at(frame,480)
        candidates.sort(key=lambda row:row['box'][2]*row['box'][3],reverse=True)
        kept = []
        for row in candidates:
            x,y,w,h = row['box']
            overlaps = []
            for item in kept:
                a,b,c,d = item['box']
                area = max(0,min(x+w,a+c)-max(x,a))*max(0,min(y+h,b+d)-max(y,b))
                overlaps.append(area/(w*h))
            if max(overlaps,default=0)<.82:
                kept.append(row)
        if refine:
            kept = [part for row in kept for part in refine_extent(frame,row)]
            kept = sorted(kept,key=lambda row:-row['box'][2]*row['box'][3])
            unique=[]
            for item in kept:
                x,y,w,h=item['box']
                if not any(intersection(item['box'],other['box'])/(w*h)>.84 for other in unique):
                    unique.append(item)
            kept=unique
        kept.sort(key=lambda row:(row['box'][1],row['box'][0]))
        return kept,(time.perf_counter()-start)*1000

    def detect_at(self, frame, long_side):
        height,width = frame.shape[:2]
        ratio = long_side/max(height,width)
        h,w = [max(32,int(np.ceil(side*ratio/32))*32) for side in (height,width)]
        resized = cv2.resize(frame,(w,h)).astype(np.float32)/255
        mean = np.array([.485,.456,.406],dtype=np.float32)
        std = np.array([.229,.224,.225],dtype=np.float32)
        tensor = np.ascontiguousarray(((resized-mean)/std).transpose(2,0,1)[None])
        prob = self.session.run(None,{self.input_name:tensor})[0].squeeze()
        if prob.ndim!=2 or prob.min()<0 or prob.max()>1:
            raise ValueError('Unexpected text detection probability map')
        ph,pw = prob.shape
        contours,_ = cv2.findContours(np.uint8(prob>.3),cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
        candidates = []
        for contour in contours[:1000]:
            x,y,box_w,box_h = cv2.boundingRect(contour)
            if min(box_w,box_h)<3 or cv2.contourArea(contour)<12:
                continue
            local = np.zeros((box_h,box_w),dtype=np.uint8)
            cv2.drawContours(local,[contour-np.array([[[x,y]]],dtype=np.int32)],-1,1,-1)
            confidence = float(prob[y:y+box_h,x:x+box_w][local!=0].mean())
            if confidence<.60:
                continue
            # Keep the tight activated extent for the ratio measurement. The
            # reviewer sees this boundary and can flag combined/missed text.
            blocks = [x/pw,y/ph,box_w/pw,box_h/ph]
            candidates.append(dict(box=blocks,confidence=confidence,inputLongSide=long_side))
        return candidates


def intersection(a,b):
    x,y,w,h=a
    u,v,ww,hh=b
    return max(0,min(u+ww,x+w)-max(x,u))*max(0,min(v+hh,y+h)-max(y,v))


def refine_extent(frame,candidate):
    """Recover ink around an OCR anchor, or split strongly separated lobes."""
    height,width=frame.shape[:2]
    x,y,w,h=candidate['box']
    if h<.022:
        return [candidate]
    pad_x=min(.10,.55*h*height/width)
    pad_y=min(.12,.53*h)
    left,top=max(0,round((x-pad_x)*width)),max(0,round((y-pad_y)*height))
    right,bottom=min(width,round((x+w+pad_x)*width)),min(height,round((y+h+pad_y)*height))
    crop=frame[top:bottom,left:right]
    border=np.concatenate((crop[0],crop[-1],crop[:,0],crop[:,-1])).astype(np.int16)
    med=np.median(border,axis=0)
    if (np.abs(border-med).max(axis=1)<=13).mean()<.70:
        return [candidate]
    mask=np.uint8(np.abs(crop.astype(np.int16)-med).max(axis=2)>32)
    count,labels,stats,_=cv2.connectedComponentsWithStats(mask)
    valid=np.zeros(count,dtype=bool)
    for i,(px,py,cw,ch,area) in enumerate(stats[1:],1):
        if px<=1 or py<=1 or px+cw>=mask.shape[1]-1 or py+ch>=mask.shape[0]-1:
            continue
        if area>=max(5,.002*(h*height)**2):
            valid[i]=True
    field=valid[labels]
    occupied=np.flatnonzero(field.any(axis=0))
    if not len(occupied):
        return [candidate]
    runs=np.split(occupied,np.flatnonzero(np.diff(occupied)>max(3,round(.15*h*height)))+1)
    refined=[]
    for run in runs:
        start,stop=int(run[0]),int(run[-1])+1
        rows,cols=np.where(field[:,start:stop])
        if not len(rows):
            continue
        box=[(left+start+int(cols.min()))/width,(top+int(rows.min()))/height,
             (int(np.ptp(cols))+1)/width,(int(np.ptp(rows))+1)/height]
        _,_,bw,bh=box
        common=intersection(box,candidate['box'])
        if bh<.43*h or bh>2.25*h or common<min(bw*bh,w*h)*.23:
            continue
        refined.append({**candidate,'box':box,'geometry':'ink'})
    return refined or [candidate]
