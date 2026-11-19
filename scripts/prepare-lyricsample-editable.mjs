import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {analyzeSequence,sequenceDesign} from '../apps/server/src/block-sequence.ts';
import {getBlocking} from '../apps/server/src/blocking.ts';
import {detectBeats} from '../apps/server/src/beats.ts';
import {detectCuts} from '../apps/server/src/media.ts';
import {saveGeneratedProject} from '../apps/server/src/modeling.ts';
import {createSequenceModel} from '../apps/server/src/sequence-model.ts';
import {getDocuments,getProject} from '../apps/server/src/store.ts';

const [manifest,outDir,...selected]=process.argv.slice(2);
if(!manifest||!outDir) throw new Error('Supply the corpus manifest, output directory and optional sample numbers');
const corpus=JSON.parse(await fs.readFile(manifest,'utf8'));
await fs.mkdir(outDir,{recursive:true});
process.env.UV_CACHE_DIR??=path.resolve(outDir,'cache','uv');
process.env.NUMBA_CACHE_DIR??=path.resolve(outDir,'cache','numba');
process.env.PYTHONFAULTHANDLER??='1';
await fs.mkdir(process.env.NUMBA_CACHE_DIR,{recursive:true});
const actor='corpus-editable';
const needsAudio=project=>!project.audioAnalysis?.beats?.length||
  (project.audioAnalysis.params?.beatTracker==='numpy-onset-path'&&project.audioAnalysis.params?.portableBeatRevision!==2);

for(const sample of (selected.length?selected.map(Number):[2,3,4,5,6,7])) {
  try {
    const work=corpus.works.find(work=>work.sample===sample);
    const {project,scene}=getProject(work.projectId);
    assert.equal(project.source.sha256,work.sourceSha256);
    const file=path.join(outDir,`sample-${sample}-analysis.json`);
    const profile=sample===7?'type-only':sample===3?'framed-type':[2,4,5].includes(sample)?'flat-color':undefined;
    const prior=JSON.parse(await fs.readFile(file,'utf8').catch(error=>{
      if(error.code!=='ENOENT') throw error;
      return 'null';
    }));
    const checkpoint=prior?.profile===(profile??'luma')?prior:null;
    if(checkpoint?.model&&!needsAudio(getProject(checkpoint.model.projectId).project)) {
      assert.equal(getProject(checkpoint.model.projectId).project.source.sha256,work.sourceSha256);
      console.log(sample,'already modeled',checkpoint.model.projectId);
      continue;
    }
    let analysis=checkpoint;
    if(!analysis) {
      const cuts=sample===7?[]:await detectCuts(project,12);
      const to=project.source.frameCount;
      // Scdet missed every low-occupancy shot change in sample 3. Use visually
      // identified layout transitions as track boundaries, even at low contrast.
      const layoutCuts=sample===3?[1,12,19,25,29,31,37,43,49,55,65,71,80,85,91,101,110,119,123,125,127,131,135,139,143]:[];
      const options={from:0,to,profile,
        cuts:[...new Set([...layoutCuts,...cuts.map(cut=>Math.round(cut.t*scene.fps))])].sort((a,b)=>a-b),
        ocrFrames:Array.from({length:Math.ceil(to/6)},(_,i)=>i*6)};
      console.log(sample,'measuring',to,'frames',profile??'luma');
      const raw=await analyzeSequence(project,options);
      const measured=sequenceDesign(project,scene,raw,options,`corpus${sample}`);
      const name=`Lyricsample${sample} · 全編の計測`;
      const saved=saveGeneratedProject(name,measured.scene,work.projectId,actor,
        {...measured.design,observations:{...getDocuments(work.projectId).observations,...measured.observations}});
      analysis={sample,rawProjectId:saved.project.id,sourceProjectId:work.projectId,sourceRevision:project.revision,
        sourceSha256:project.source.sha256,frames:to,profile:profile??'luma',cuts:options.cuts,rawBlocks:measured.design.blocks.items.length};
      await fs.writeFile(file,JSON.stringify(analysis,null,2));
    }
    let raw=getBlocking(analysis.rawProjectId);
    if(needsAudio(raw.project)) {
      try {
        const audio=await detectBeats(raw.project.id,raw.project.revision,actor);
        console.log(sample,'estimated beats',audio.beats.length,audio.bpm);
        raw=getBlocking(analysis.rawProjectId);
      } catch(error) {
        console.error(sample,'audio:',error.message);
      }
    }
    console.log(sample,'fitting',raw.design.blocks.items.length,'tracks');
    const fitted=await createSequenceModel(raw.project.id,{baseRevision:raw.project.revision,actor});
    assert.equal(fitted.design.appearance.filter(binding=>binding.contours?.length).length,0);
    assert.equal(Math.round(fitted.design.blocks.to*fitted.scene.fps),analysis.frames);
    analysis.model={projectId:fitted.project.id,revision:fitted.project.revision,blocks:fitted.design.blocks.items.length};
    await fs.writeFile(file,JSON.stringify(analysis,null,2));
    console.log(sample,'modeled',analysis.model.projectId);
  } catch(error) {
    console.error(sample,error.message,String(error.detail??'').split('\n').slice(-8).join('\n'),error.stack);
    process.exitCode=1;
  }
}
