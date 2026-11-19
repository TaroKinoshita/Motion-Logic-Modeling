import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {probe} from '../apps/server/src/media.ts';
import {REPO_ROOT} from '../apps/server/src/store.ts';

export const phraseScalePolicy={threshold:1.5,minContextFrames:4};
export function detectPhraseDrop(samples,policy=phraseScalePolicy) {
  return samples.flatMap((row,i)=>{
    if(i<policy.minContextFrames||samples.length-i<policy.minContextFrames) return [];
    const previous=samples[i-1];
    const context=samples.slice(i-policy.minContextFrames,i+policy.minContextFrames);
    if(row.h<=0||context.some((item,index)=>index>0&&item.frame!==context[index-1].frame+1)) return [];
    const ratio=previous.h/row.h;
    return ratio>=policy.threshold?[{frame:row.frame,beforeFrame:previous.frame,ratio}]:[];
  });
}

const selection=z.strictObject({media:z.string().min(1),first:z.number().int().nonnegative(),end:z.number().int().positive(),
  roi:z.tuple([z.number().int().nonnegative(),z.number().int().nonnegative(),z.number().int().positive(),z.number().int().positive()]),
  polarity:z.enum(['light-background','dark-background']).default('light-background'),
  identity:z.enum(['same-phrase','different-text','unreviewed']).default('unreviewed')});

async function assess(file,output) {
  const input=selection.parse(JSON.parse(await readFile(file,'utf8')));
  const media=path.resolve(path.dirname(file),input.media);
  const source=await probe(media,path.basename(media));
  const {first,end,roi}=input;
  if(source.variableFrameRate||end-first<8||end-first>240||end>(source.frameCount??Math.round(source.duration*source.fps))||
    roi[0]+roi[2]>source.width||roi[1]+roi[3]>source.height) throw new Error('Use a fixed-rate source and a valid ROI and 8–240 frame interval');
  const worker=path.join(REPO_ROOT,'workers','track');
  const python=process.env.MLM_TRACK_PYTHON??path.join(worker,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const samples=JSON.parse(execFileSync(python,[path.join(worker,'track','corpus_foreground.py'),media,String(first),String(end),
    JSON.stringify(roi),input.polarity],{encoding:'utf8',windowsHide:true}));
  const found=detectPhraseDrop(samples.map(({frame,box})=>({frame,h:box[3]})));
  const result={sourceSha256:source.sha256,fps:source.fps,rule:phraseScalePolicy,frameRange:[first,end],roi,
    polarity:input.polarity,identityAssessment:input.identity,found,samples,
    result:input.identity==='unreviewed'?'needs-visual-review':input.identity==='different-text'?'different-text':found.length?'present':'absent-in-window'};
  await writeFile(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({found,result:result.result}));
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  const [input,output]=process.argv.slice(2);
  if(!input||!output) throw new Error('Supply a reviewed-interval JSON and an output path');
  await assess(input,output);
}
