import {createCanvas} from '@napi-rs/canvas';
import {z} from 'zod';
import {emptyScene,fontSpec,evaluateScene,canvasMeasurer,type Scene,type SceneElement,type Track} from '@mlm/core';
import {getProject,getDocuments,HttpError,checkScene} from './store.ts';
import {saveGeneratedProject} from './modeling.ts';
import './fonts.ts';
import {stageWithPassages,fitInsideFrame} from './passage-staging.ts';
import {execFileSync} from 'node:child_process';
import {sourcePath} from './media.ts';

/** Loudness rank per line (0 quiet .. 1 loud) from the RMS of the audio, for the song-structure layer. */
export function lineIntensity(audioPath:string,lines:{from:number;to:number}[]) {
  const rate=8000;
  const raw=execFileSync(process.env.MLM_FFMPEG??'ffmpeg',['-v','error','-i',audioPath,'-ac','1','-ar',String(rate),'-f','f32le','pipe:1'],
    {maxBuffer:1<<28,windowsHide:true});
  const pcm=new Float32Array(raw.buffer,raw.byteOffset,Math.floor(raw.byteLength/4));
  const rms=lines.map(line=>{
    const a=Math.max(0,Math.floor(line.from*rate)),b=Math.min(pcm.length,Math.ceil(line.to*rate));
    let sum=0;for(let i=a;i<b;i++) sum+=pcm[i]*pcm[i];
    return Math.sqrt(sum/Math.max(1,b-a));
  });
  const order=[...rms.keys()].sort((x,y)=>rms[x]-rms[y]);
  const rank=new Array(rms.length).fill(.5);
  order.forEach((index,position)=>{rank[index]=rms.length>1?position/(rms.length-1):.5;});
  return {rank,rms};
}

const token=z.strictObject({text:z.string().trim().min(1).max(100),at:z.number().nonnegative(),emphasis:z.boolean().default(false)});
export const LyricPlanRequest=z.strictObject({
  baseRevision:z.number().int().positive(),name:z.string().trim().min(1).max(100),
  actor:z.string().min(1).max(40).default('human'),variation:z.number().int().min(0).max(2).default(0),
  alignment:z.enum(['estimated','verified']).default('estimated'),
  minFontHeight:z.number().min(.025).max(.12).default(.045),
  continuity:z.enum(['auto','none']).default('auto'),
  /** passage: reuse reconstructed reference passages (docs/45). rules: hand-set shot rules (docs/44, baseline). */
  method:z.enum(['passage','rules']).default('passage'),
  lines:z.array(z.strictObject({from:z.number().nonnegative(),to:z.number().positive(),
    tokens:z.array(token).min(1).max(8)})).min(1).max(100),
});
type Input=z.infer<typeof LyricPlanRequest>;
export type AppearanceBinding={blockId:string;groupId:string;text:SceneElement};

/** Dress the current block scene. Motion and lifetime stay on its editable parents. */
export function dressLyricBlocks(blockScene:Scene,bindings:AppearanceBinding[]):Scene {
  const byId=new Map(bindings.map(binding=>[binding.blockId,binding]));
  const scene:Scene={...structuredClone(blockScene),elements:blockScene.elements.map(element=>{
    const binding=byId.get(element.id);
    if(!binding) return structuredClone(element);
    if(element.type!=='rect'||element.parentId!==binding.groupId) throw new HttpError(422,'ブロックの親を変更したため外観との対応を確認してください');
    const group=blockScene.elements.find(item=>item.id===binding.groupId);
    if(!group||group.type!=='group') throw new HttpError(422,'動きの親グループがありません');
    return {...structuredClone(binding.text),parentId:group.id,inPoint:element.inPoint,outPoint:element.outPoint};
  })};
  checkScene(scene);
  return scene;
}
type Box={x:number;y:number;w:number;h:number};
type Key={t:number;v:number;ease?:'hold'|'easeOut'|'linear'};
const overlaps=(a:Box,b:Box)=>Math.min(a.x+a.w/2,b.x+b.w/2)>Math.max(a.x-a.w/2,b.x-b.w/2)+1 &&
  Math.min(a.y+a.h/2,b.y+b.h/2)>Math.max(a.y-a.h/2,b.y-b.h/2)+1;

/** Content and cue driven layout. All geometry is in a normalized design space. */
export function planLyrics(input:Input,options:{width:number;height:number;fps:number;duration:number}) {
  const {width,height,fps,duration}=options;
  if(!Number.isFinite(fps)||fps<=0||!Number.isFinite(duration)||duration<=0) throw new HttpError(422,'有効な映像長とfpsが必要です');
  const snap=(value:number)=>Math.round(value*fps)/fps;
  const scene:Scene={...emptyScene(),...options,background:'#eee8dc',elements:[],markers:[]};
  const ctx=createCanvas(1,1).getContext('2d');
  const appearance:AppearanceBinding[]=[];
  const addBlock=(shapes:SceneElement[],text:SceneElement)=>{
    ctx.font=fontSpec(text);ctx.textAlign='center';ctx.textBaseline='middle';
    const m=ctx.measureText(text.text??'');
    const groupId=text.id+':motion',blockId=text.id+':block';
    shapes.push({id:groupId,name:text.name??text.text,type:'group',parentId:text.parentId,
      inPoint:text.inPoint,outPoint:text.outPoint,transform:text.transform});
    shapes.push({id:blockId,name:'動きのブロック',type:'rect',parentId:groupId,
      inPoint:text.inPoint,outPoint:text.outPoint,fill:text.fill,
      width:m.actualBoundingBoxLeft+m.actualBoundingBoxRight,height:m.actualBoundingBoxAscent+m.actualBoundingBoxDescent,
      transform:{x:(m.actualBoundingBoxRight-m.actualBoundingBoxLeft)/2,
        y:(m.actualBoundingBoxDescent-m.actualBoundingBoxAscent)/2}});
    const {transform:_,...localText}=text;
    appearance.push({blockId,groupId,text:{...localText,parentId:groupId}});
  };
  const records:{line:number;inverted:boolean;arrangement:'above'|'beside';shots:{token:string;at:number;fontSize:number;inkHeight:number;smallestFont:number;
    companions:string[];entrance:number}[];retainedToken?:string;carryReason:string;minimumFontSize:number;readingWarnings:string[];reasons:string[]}[]=[];
  const ink='#1d2a2c',paper='#eee8dc';
  const validated=input.lines.map((line,i)=>{
    const from=snap(line.from),to=snap(line.to);
    if(from>=to||to>duration+1e-8||(i>0&&from<snap(input.lines[i-1].to))) throw new HttpError(422,'歌詞区間は音源内で重ならないよう指定してください');
    const tokens=line.tokens.map(item=>({...item,at:snap(item.at)}));
    if(tokens.some((item,k)=>item.at<from||item.at>=to||(k>0&&item.at<tokens[k-1].at))) throw new HttpError(422,'語の開始は行内で順に指定してください');
    return {...line,from,to,tokens};
  });
  // Shot staging. Values marked (corpus) come from measured reference passages; the rest are design values.
  const RATIO=2.5;            // (corpus) a kept word shrinks ~2.5x in one frame: Lyricsample6 2.46 / 2.50 (docs/22)
  const KEEP=2;               // earlier words kept small on screen; reference median is 3-6 screen blocks (docs/44)
  const CREEP=1.12;           // continuous zoom so the frame is rarely static; references change in >90% of samples (docs/44)
  const ENTER=1.06, SHIFT=.06*width, SETTLE=4/fps; // jump then settle (corpus shape: Lyricsample2 77-87F, docs/21)
  // Compact composition: references keep the foreground box near 8-25% of the frame (docs/44).
  const maxW=width*.52, maxTotal=width*.84/CREEP/ENTER, gap=height*.03;
  const family='MLM BIZ UD Gothic';
  const inkOf=(text:string,fontSize:number)=>{
    ctx.font=fontSpec({id:'m',type:'text',fontFamily:family,fontWeight:700,fontSize});
    ctx.textAlign='center';ctx.textBaseline='middle';
    const m=ctx.measureText(text);
    return {w:m.actualBoundingBoxLeft+m.actualBoundingBoxRight,h:m.actualBoundingBoxAscent+m.actualBoundingBoxDescent,
      dx:(m.actualBoundingBoxRight-m.actualBoundingBoxLeft)/2,dy:(m.actualBoundingBoxDescent-m.actualBoundingBoxAscent)/2};
  };
  const fitFont=(text:string,maxWidth:number,maxHeight:number)=>{
    const base=inkOf(text,100);
    return 100*Math.min(maxWidth/Math.max(1,base.w),maxHeight/Math.max(1,base.h));
  };
  let previousInverted=false;
  for(const [i,line] of validated.entries()) {
    const {tokens,from,to}=line;
    // Design rule: invert a line that carries an emphasized word, never two lines in a row.
    const inverted:boolean=tokens.some(item=>item.emphasis)&&!previousInverted&&(i+input.variation)%2===1;
    previousInverted=inverted;
    const fg=inverted?paper:ink;
    const parent='planned:'+i;
    const shapes:SceneElement[]=[];
    shapes.push({id:parent+':bg',type:'rect',width,height,fill:inverted?ink:paper,inPoint:from,outPoint:to,
      transform:{x:width/2,y:height/2}});
    shapes.push({id:parent,type:'group',inPoint:from,outPoint:to,transform:{x:width/2,y:height/2,
      scaleX:{keys:[{t:from,v:1,ease:'linear'},{t:to,v:CREEP}]},scaleY:{keys:[{t:from,v:1,ease:'linear'},{t:to,v:CREEP}]}}});
    // Arrangement per line: kept words above the main word, or in a column beside it (design values).
    let mode:'above'|'beside'=(i+input.variation)%2===0?'above':'beside';
    // Base font per word: the size it has while it is the main word of its shot.
    // Emphasized words get the large size; others stay smaller so main words differ between shots (T1, docs/24).
    // An emphasized word clears the kept words and takes the frame alone (T1: one main word, docs/24).
    const keptBefore=(s:number)=>{
      if(tokens[s].emphasis) return [];
      // Words cleared by an earlier emphasized word do not come back.
      const cleared=tokens.reduce((last,item,k)=>k<s&&item.emphasis?k:last,0);
      // Long words would be unreadable at 1/RATIO, so they are not kept (design value: 8 characters).
      return tokens.map((_,k)=>k).filter(k=>k<s&&k>=Math.max(s-KEEP,cleared)&&Array.from(tokens[k].text).length<=8);
    };
    const fontsFor=(arrangement:'above'|'beside')=>tokens.map((item,k)=>{
      const n=keptBefore(k).length;
      const cap=height*(item.emphasis?.58:.30);
      if(arrangement==='above') {
        const stackLimit=(height*.78/CREEP/ENTER-n*gap)/(1+n/RATIO);
        return fitFont(item.text,maxW,Math.min(stackLimit,cap));
      }
      return fitFont(item.text,n?maxW*.8:maxW,Math.min(height*.72/CREEP/ENTER,cap));
    });
    let fonts=fontsFor(mode);
    // Layout of shot s: word s is main; the previous KEEP words stay small, oldest first.
    const layout=(s:number,arrangement:'above'|'beside')=>{
      const kept=keptBefore(s);
      const heroInk=inkOf(tokens[s].text,fonts[s]);
      const small=kept.map(k=>{
        const own=inkOf(tokens[k].text,fonts[k]);
        const scale=(heroInk.h/RATIO)/Math.max(1,own.h);
        return {k,scale,w:own.w*scale,h:own.h*scale,own};
      });
      const hero={k:s,scale:1,w:heroInk.w,h:heroInk.h,own:heroInk};
      const at=(item:typeof hero,cx:number,cy:number)=>
        ({k:item.k,scale:item.scale,x:cx-item.own.dx*item.scale,y:cy-item.own.dy*item.scale});
      const column=small.reduce((sum,item)=>sum+item.h,0)+gap*Math.max(0,small.length-1);
      if(arrangement==='beside'&&small.length) {
        const colW=Math.max(...small.map(item=>item.w));
        const total=colW+gap*2+hero.w;
        const left=-total/2;
        let top=-column/2;
        const placed=small.map(item=>{const cy=top+item.h/2;top+=item.h+gap;return at(item,left+colW-item.w/2,cy);});
        return {placed:[...placed,at(hero,left+colW+gap*2+hero.w/2,0)],width:total};
      }
      const total=column+(small.length?gap:0)+hero.h;
      let top=-total/2;
      const placed=small.map(item=>{
        const cy=top+item.h/2;top+=item.h+gap;
        return at(item,Math.min(maxTotal/2-item.w/2,Math.max(-maxTotal/2+item.w/2,-hero.w/2+item.w/2)),cy);
      });
      return {placed:[...placed,at(hero,0,top+hero.h/2)],width:Math.max(hero.w,...small.map(item=>item.w))};
    };
    if(mode==='beside'&&tokens.some((_,s)=>layout(s,'beside').width>maxTotal)) {mode='above';fonts=fontsFor(mode);}
    const poses=tokens.map(()=>[] as {t:number;x:number;y:number;scale:number;enter:boolean}[]);
    const shots:typeof records[number]['shots']=[];
    for(const [s,item] of tokens.entries()) {
      const placed=layout(s,mode).placed;
      for(const pose of placed) poses[pose.k].push({t:item.at,x:pose.x,y:pose.y,scale:pose.scale,enter:pose.k===s});
      shots.push({token:item.text,at:item.at,fontSize:fonts[s],inkHeight:inkOf(item.text,fonts[s]).h,
        smallestFont:Math.min(...placed.map(p=>fonts[p.k]*p.scale)),
        companions:placed.filter(p=>p.k!==s).map(p=>tokens[p.k].text),entrance:SETTLE});
    }
    for(const [k,item] of tokens.entries()) {
      // Leave at the first later shot that does not keep this word.
      const leaving=tokens.findIndex((_,s)=>s>k&&!keptBefore(s).includes(k));
      const exit=leaving>=0?tokens[leaving].at:to;
      const keys={x:[] as Key[],y:[] as Key[],scale:[] as Key[]};
      for(const [p,pose] of poses[k].entries()) {
        const next=poses[k][p+1]?.t??exit;
        const settle=Math.min(next-1/fps,snap(pose.t+SETTLE));
        // Beside: enter from the open right side so the main word never slides into the kept column.
        const direction=mode==='beside'||(k+i+input.variation)%2===0?1:-1;
        if(pose.enter&&settle>pose.t) {
          keys.x.push({t:pose.t,v:pose.x+direction*SHIFT,ease:'easeOut'},{t:settle,v:pose.x,ease:'hold'});
          keys.y.push({t:pose.t,v:pose.y,ease:'hold'});
          keys.scale.push({t:pose.t,v:pose.scale*ENTER,ease:'easeOut'},{t:settle,v:pose.scale,ease:'hold'});
        } else {
          keys.x.push({t:pose.t,v:pose.x,ease:'hold'});keys.y.push({t:pose.t,v:pose.y,ease:'hold'});
          keys.scale.push({t:pose.t,v:pose.scale,ease:'hold'});
        }
      }
      const asTrack=(list:Key[]):Track=>list.length===1?list[0].v:{keys:list};
      addBlock(shapes,{id:parent+':word:'+k,parentId:parent,type:'text',text:item.text,name:item.text,
        fontFamily:family,fontWeight:700,fontSize:fonts[k],fill:fg,inPoint:item.at,outPoint:exit,
        transform:{x:asTrack(keys.x),y:asTrack(keys.y),scaleX:asTrack(keys.scale),scaleY:asTrack(keys.scale)}});
      scene.markers!.push({t:item.at,kind:'note',label:item.text,origin:input.alignment==='verified'?'manual':'estimated'});
    }
    // Carry across lines (T2): before the first word arrives, keep the previous line's last word small.
    const previous=i>0?validated[i-1]:undefined;
    const prior=previous?.tokens.at(-1);
    const carry=input.continuity==='auto'&&previous&&prior&&from-previous.to<.2&&tokens[0].at-from>=3/fps?prior.text:undefined;
    const carryReason=carry?'次の語の登場前に前の行の最後の語を小さく保持':
      input.continuity==='none'?'保持を無効に指定':!previous?'最初の行':'次の語がすぐ出る、または行の間が離れている';
    if(carry) {
      const font=Math.max(height*input.minFontHeight,fitFont(carry,maxW,height*.30)/RATIO);
      const ink=inkOf(carry,font);
      addBlock(shapes,{id:parent+':carry',parentId:parent,type:'text',text:carry,name:carry,fontFamily:family,fontWeight:700,
        fontSize:font,fill:fg,inPoint:from,outPoint:tokens[0].at,transform:{x:-ink.dx,y:-ink.dy}});
    }
    scene.elements.push(...shapes);
    const minimum=Math.min(...shots.map(shot=>shot.smallestFont));
    if(minimum<height*input.minFontHeight) throw new HttpError(422,
      '行'+(i+1)+'は指定した最低文字サイズで配置できません。行を分けるか、同時に表示する語を減らしてください');
    const readingWarnings=tokens.flatMap(item=>Array.from(item.text).length/(to-item.at)>16?[
      item.text+'の表示時間が短く、読む速さの確認が必要']:[]);
    records.push({line:i+1,inverted,arrangement:mode,shots,retainedToken:carry,carryReason,minimumFontSize:minimum,readingWarnings,
      reasons:['語ごとに主役を切り替える','直前の2語を約2.5分の1で残す（コーパスの1コマ縮小）。強調語は単独で大きく',
        '中央にまとめ（幅52%以内）、行全体を連続して拡大','登場は1コマで跳んで4コマで落ち着く','強調語のある行を1行おきまで反転（設計値）']});
  }
  const blockScene=structuredClone(scene);
  const finalScene=dressLyricBlocks(blockScene,appearance);
  const measure=canvasMeasurer(ctx);
  const checkedFrames=Math.ceil(duration*fps);
  if(checkedFrames>7200) throw new HttpError(422,'生成は7200フレーム以内にしてください');
  for(let frame=0;frame<checkedFrames;frame++) {
    const boxes=evaluateScene(finalScene,frame/fps,measure).filter(ev=>ev.element.type==='text').map(ev=>{
      ctx.font=fontSpec(ev.element);ctx.textAlign='center';ctx.textBaseline='middle';
      const m=ctx.measureText(ev.element.text??''),[a,b,c,d,x,y]=ev.matrix;
      const points=[-m.actualBoundingBoxLeft,m.actualBoundingBoxRight].flatMap(u=>[-m.actualBoundingBoxAscent,m.actualBoundingBoxDescent]
        .map(v=>[a*u+c*v+x,b*u+d*v+y]));
      const left=Math.min(...points.map(p=>p[0])),right=Math.max(...points.map(p=>p[0]));
      const top=Math.min(...points.map(p=>p[1])),bottom=Math.max(...points.map(p=>p[1]));
      if(left<0||right>width||top<0||bottom>height) throw new HttpError(422,'移動中に文字が画面をはみ出します。行の語数を調整してください');
      return {x:(left+right)/2,y:(top+bottom)/2,w:right-left,h:bottom-top};
    });
    if(boxes.some((box,k)=>boxes.slice(k+1).some(other=>overlaps(box,other)))) {
      throw new HttpError(422,'移動中に文字が重なります。行の語数を調整してください');
    }
  }
  return {scene:finalScene,blockScene,appearance,decisions:records,audit:{checkedFrames,overlaps:0,outside:0}};
}

/** Build with the requested method. Both return a block scene, its appearance and the dressed scene. */
export function buildLyrics(input:Input,options:{width:number;height:number;fps:number;duration:number;audioPath?:string}) {
  if(input.method==='rules') return planLyrics(input,options);
  const snap=(v:number)=>Math.round(v*options.fps)/options.fps;
  const lines=input.lines.map((line,i)=>{
    const from=snap(line.from),to=snap(line.to);
    if(from>=to||to>options.duration+1e-8||(i>0&&from<snap(input.lines[i-1].to))) throw new HttpError(422,'歌詞区間は音源内で重ならないよう指定してください');
    const tokens=line.tokens.map(t=>({...t,at:snap(t.at)}));
    if(tokens.some((t,k)=>t.at<from||t.at>=to||(k>0&&t.at<tokens[k-1].at))) throw new HttpError(422,'語の開始は行内で順に指定してください');
    return {from,to,tokens};
  });
  const loud=options.audioPath?lineIntensity(options.audioPath,lines):undefined;
  const staged=stageWithPassages(lines,{...options,variation:input.variation,intensity:loud?.rank});
  const fitted=fitInsideFrame(staged.blockScene,staged.appearance,options,dressLyricBlocks,staged.sourceWidth);
  return {scene:fitted.scene,blockScene:staged.blockScene,appearance:staged.appearance,decisions:staged.records,entrances:staged.entrances,loudness:loud?.rms,
    audit:{checkedFrames:Math.ceil(options.duration*options.fps),framesWithTextPartlyOutside:fitted.outsideFrames,shrunkText:fitted.adjusted}};
}

export function generatePlannedLyrics(id:string,input:Input) {
  const source=getProject(id);
  if(source.project.revision!==input.baseRevision) throw new HttpError(409,'最新のリビジョンを読み直してください');
  if(!source.project.source?.hasAudio) throw new HttpError(422,'音源を取り込んでください');
  const built=buildLyrics(input,{width:source.scene.width,height:source.scene.height,fps:source.scene.fps,duration:source.scene.duration,
    audioPath:input.method==='passage'?sourcePath(source.project):undefined});
  const blocking=saveGeneratedProject(input.name+' ブロッキング',built.blockScene,id,input.actor,{adaptation:{
    kind:'lyric-blocking',input,decisions:built.decisions,appearance:built.appearance,
    sourceProjectId:id,sourceRevision:input.baseRevision,weightOrigin:input.method==='passage'?'reference passages, hand-set selection scores':'hand-set constraints',
  }});
  return {...saveGeneratedProject(input.name,built.scene,blocking.project.id,input.actor,{adaptation:{
    kind:'general-lyric-plan',input,decisions:built.decisions,audit:built.audit,weightOrigin:'hand-set constraints',
    blockingProjectId:blocking.project.id,blockingRevision:blocking.project.revision,
    sourceProjectId:id,sourceRevision:input.baseRevision,sourceSha256:source.project.source.sha256,
  }}),blocking,decisions:built.decisions,audit:built.audit};
}

export const DressLyricsRequest=z.strictObject({baseRevision:z.number().int().positive(),name:z.string().trim().min(1).max(100),actor:z.string().default('human')});
export function generateLyricAppearance(id:string,input:z.infer<typeof DressLyricsRequest>) {
  const source=getProject(id);
  if(source.project.revision!==input.baseRevision) throw new HttpError(409,'最新のリビジョンを読み直してください');
  const doc=getDocuments(id).adaptation as {kind?:string;appearance?:AppearanceBinding[]}|undefined;
  if(doc?.kind!=='lyric-blocking'||!Array.isArray(doc.appearance)) throw new HttpError(422,'歌詞ブロッキングのプロジェクトを開いてください');
  const scene=dressLyricBlocks(source.scene,doc.appearance);
  return saveGeneratedProject(input.name,scene,id,input.actor,{adaptation:{kind:'lyric-appearance',
    blockingProjectId:id,blockingRevision:input.baseRevision,appearance:doc.appearance}});
}
