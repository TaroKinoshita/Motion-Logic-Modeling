"""Fit a fixed sprite, vectorize its alpha, and emit source-pixel transforms."""
import json
import math
from pathlib import Path
import subprocess
import sys
from time import perf_counter

import cv2
import fsd
from fsd.engine.optimization_sample import optimization_sample
from fsd.models.tam.tracker.model import resnet
from hydra import compose, initialize_config_dir
import numpy as np
from PIL import Image
import torch

from easing import fit_eased_track


def main():
    source, params, target, vector_python = sys.argv[1:]
    params, target = Path(params), Path(target)
    cfg = json.loads(params.read_text("utf-8"))
    work = target.parent
    clip = work / "clip"
    clip.mkdir()
    run = work / "fit"
    x, y, w, h = cfg["region"]
    frames = []
    foreground_color = None
    capture = cv2.VideoCapture(source)
    try:
        for frame in range(cfg["to"]):
            ok, image = capture.read()
            if not ok:
                raise ValueError(f"Video ended at frame {frame}")
            if frame < cfg["from"]:
                continue
            height, width = image.shape[:2]
            if not frames:
                rgb=cv2.cvtColor(image,cv2.COLOR_BGR2RGB)
                border=np.concatenate((rgb[0],rgb[-1],rgb[:,0],rgb[:,-1]))
                background_color=np.median(border,axis=0).astype(np.uint8)
                seed=rgb[y:y+h,x:x+w]
                foreground=seed[np.abs(seed.astype(np.float64)-background_color).mean(axis=2)>48]
                if len(foreground):
                    foreground_color=np.median(foreground,axis=0).astype(np.uint8)
            ratio = min(1, 384/max(width,height))
            resized = cv2.resize(image,(round(width*ratio),round(height*ratio)),interpolation=cv2.INTER_AREA)
            frames.append(Image.fromarray(cv2.cvtColor(resized,cv2.COLOR_BGR2RGBA)))
    finally:
        capture.release()
    frames[0].save(clip/"clip.png",save_all=True,append_images=frames[1:],duration=round(1000/cfg["fps"]),loop=0)
    (clip/"clip.json").write_text(json.dumps({"key_box":[[y/height,(y+h)/height,x/width,(x+w)/width]],"key_index":[0]}),"utf-8")
    roots = Path(fsd.__path__[0])
    for name in ("sam_vit_b_01ec64.pth","XMem-s012.pth"):
        item=roots/"cache"/"checkpoints"/name
        if not item.is_file() or item.stat().st_size < 100_000_000:
            raise FileNotFoundError(f"Fast Sprite model asset missing: {name}")
    if not torch.cuda.is_available():
        raise RuntimeError("Fast Sprite CUDA is unavailable in the configured environment")
    torch.cuda.reset_peak_memory_stats()
    # XMem loads the complete state dict with strict=True, including both encoders.
    # Skip the redundant ImageNet initialization so jobs only read local weights.
    for name in ("resnet18","resnet50"):
        create=getattr(resnet,name)
        setattr(resnet,name,lambda pretrained=True,extra_dim=0,create=create: create(pretrained=False,extra_dim=extra_dim))
    start=perf_counter()
    with initialize_config_dir(version_base=None,config_dir=str(roots/"configs")):
        config=compose(config_name="crello_sample",overrides=[
            f'in_dir="{clip.as_posix()}"',f'out_dir="{run.as_posix()}"',"device=cuda",
            "engine.n_iters=30","engine.save_interval=30","engine.timelimit_minute=2",
        ])
    optimization_sample(config)
    state_path=sorted((run/"sprites").glob("iter_*/params.json"))[-1]
    info=json.loads(state_path.read_text("utf-8"))
    _,*foreground=info["layer_order"]
    layers=[]
    for index in foreground:
        image=np.asarray(Image.open(state_path.parent/info["texture_paths"][index]).convert("RGBA"))
        mask=image[:,:,3]>=128
        if not mask.any():
            continue
        yy,xx=np.where(mask)
        y0,y1,x0,x1=int(yy.min()),int(yy.max())+1,int(xx.min()),int(xx.max())+1
        oh,ow=mask.shape
        mask_file=work/f"mask-{index}.png"
        Image.fromarray(np.where(mask[y0:y1,x0:x1],0,255).astype(np.uint8)).save(mask_file)
        commands=json.loads(subprocess.check_output([vector_python,str(Path(__file__).with_name("vtracer_outline.py")),str(mask_file)]))
        fill="#"+bytes(foreground_color if foreground_color is not None else np.median(image[mask,:3],axis=0).astype(np.uint8)).hex()
        samples=[]
        previous_angle=None
        for i,(matrix,opacity) in enumerate(zip(info["matrices"][index],info["opacity"][index])):
            a,c,u,b,d,v,*_=np.asanyarray(matrix).flatten()
            a,b,c,d=a,b*height/width,c*width/height,d
            scale_x=math.hypot(a,b)
            if scale_x<1e-8:
                raise ValueError("Singular foreground transform")
            angle=math.degrees(math.atan2(b,a))
            if previous_angle is not None:
                angle+=360*round((previous_angle-angle)/360)
            previous_angle=angle
            samples.append(dict(t=(cfg["from"]+i)/cfg["fps"],x=(u+1)*width/2,y=(v+1)*height/2,
                                scaleX=scale_x,scaleY=(a*d-b*c)/scale_x,shearX=(a*c+b*d)/scale_x,
                                rotation=angle,opacity=float(opacity)))
        fit=fit_eased_track(samples,dict(x=2,y=2,scaleX=.003,scaleY=.003,shearX=.003,rotation=.35,opacity=.015))
        layers.append(dict(vector=commands,fill=fill,width=width*(x1-x0)/ow,height=height*(y1-y0)/oh,
                           cx=width*((x0+x1)/(2*ow)-.5),cy=height*((y0+y1)/(2*oh)-.5),fit=fit,samples=samples))
    if not layers:
        raise ValueError("Fast Sprite did not find an opaque foreground texture")
    color="#"+bytes(background_color).hex()
    target.write_text(json.dumps(dict(layers=layers,background=color,seconds=perf_counter()-start,
                                      peakCudaBytes=torch.cuda.max_memory_allocated()),allow_nan=False),"utf-8")


if __name__=="__main__":
    main()
