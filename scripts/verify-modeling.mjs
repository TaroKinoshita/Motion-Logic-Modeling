import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root=path.resolve(import.meta.dirname,'..'),data=path.join(root,'data/modeling-validation');
fs.mkdirSync(data,{recursive:true});
const port=process.env.MLM_VERIFY_PORT??'4524',base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['apps/server/src/index.ts'],{cwd:root,env:{...process.env,MLM_PORT:port,MLM_DATA_DIR:data},windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs='',client;server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
async function req(route,body,expected=200) {
  const response=await fetch(base+route,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const json=await response.json();assert.equal(response.status,expected,JSON.stringify(json));return json;
}
const report={checks:[]};
try {
  for(let i=0;;i++) {try{const h=await req('/api/health');assert.equal(path.resolve(h.dataDir),data);break;}catch(err){if(i>60||server.exitCode!==null)throw new Error(logs+String(err));await new Promise(r=>setTimeout(r,100));}}
  let source=await req('/api/projects',{name:'M3 reference',template:'demo'},201);
  const id=source.project.id,route=`/api/projects/${id}`;
  source.scene.elements.push({id:'hold',type:'rect',width:100,height:100,transform:{x:{keys:[{t:0,v:0},{t:1,v:100},{t:2,v:100},{t:3,v:200}]},y:300}});
  source.scene.markers=Array.from({length:12},(_,i)=>({t:i*.5,kind:'beat',origin:'manual'}));
  source=await req(route+'/scene',{baseRevision:source.project.revision,scene:source.scene});
  const prior=source.project.revision;
  const measured=await req(route+'/measure-events',{baseRevision:prior,events:[{label:'arrival',t:.97,origin:'manual',elementId:'hold'},{label:'release',t:2.04,origin:'manual',elementId:'hold'}]});
  assert.ok(Math.abs(measured.measurements[0].offsetSeconds+.03)<1e-10);
  assert.ok(Math.abs(measured.measurements[1].offsetSeconds-.04)<1e-10);
  await req(route+'/measure-events',{baseRevision:prior,events:[{label:'stale',t:1,origin:'manual'}]},409);
  const hypothesis={id:'h1',text:'停止時間が解放の印象に関係するという仮説',observationIds:measured.measurements.map(m=>m.id),status:'accepted'};
  const rule={id:'r1',hypothesisId:'h1',kind:'hold',elementId:'hold',property:'x',keyIndex:1};
  source=await req(route+'/model',{baseRevision:measured.project.revision,hypotheses:[hypothesis],rules:[rule]});
  await req(route+'/model',{baseRevision:source.project.revision,hypotheses:[{...hypothesis,observationIds:['missing']}],rules:[rule]},422);
  const before=await req(route+'/documents');
  const variants=[];
  for(const seconds of [0,.5,1.5]) variants.push(await req(route+'/variant',{baseRevision:source.project.revision,ruleId:'r1',seconds,name:`Hold ${seconds}`}));
  assert.deepEqual(variants[0].scene.elements.find(e=>e.id==='hold').transform.x.keys.map(k=>k.t),[0,1,2]);
  assert.equal((await req(route)).project.revision,source.project.revision);
  const edited=await req(route+'/scene',{baseRevision:source.project.revision,ops:[{op:'setSceneProps',props:{background:'#111111'}}]});
  await req(route+'/variant',{baseRevision:edited.project.revision,ruleId:'r1',seconds:0,name:'stale rule'},409);
  source=await req(route+'/revert',{baseRevision:edited.project.revision,toRevision:source.project.revision});
  const restored=await req(route+'/revert',{baseRevision:source.project.revision,toRevision:prior});
  assert.deepEqual(await req(route+'/documents'),{});
  source=await req(route+'/revert',{baseRevision:restored.project.revision,toRevision:source.project.revision});
  assert.deepEqual(await req(route+'/documents'),before);
  report.checks.push('event offsets -0.03/+0.04 seconds','stale revisions and missing evidence rejected','three hold variants; source unchanged','documents revert and restore with scene');
  let target=await req('/api/projects',{name:'M4 new music'},201);
  const wav=path.join(data,'new-music.wav');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=22050:duration=8','-y',wav],{windowsHide:true});
  target=await req(`/api/projects/${target.project.id}/music`,{baseRevision:target.project.revision,path:wav});
  const detected=await req(`/api/projects/${target.project.id}/detect-beats`,{baseRevision:target.project.revision});
  target=await req(`/api/projects/${target.project.id}`);
  // Synthetic sine is deliberately not used as beat ground truth. Supply manual markers.
  target.scene.markers=Array.from({length:12},(_,i)=>({t:.25+i*.65,kind:'beat',origin:'manual'}));
  target=await req(`/api/projects/${target.project.id}/scene`,{baseRevision:target.project.revision,scene:target.scene});
  const request={baseRevision:source.project.revision,targetProjectId:target.project.id,targetRevision:target.project.revision,name:'M4 adapted'};
  const adapted=await req(route+'/adapt',{...request,sections:[{sourceFrom:0,sourceTo:3,targetFrom:0,targetTo:5,elementIds:source.scene.elements.filter(e=>e.id!=='burst').map(e=>e.id),reason:'前半に長い尺を配分する'},{sourceFrom:3,sourceTo:6,targetFrom:5,targetTo:8,elementIds:['burst'],reason:'解放を後半に残す'}]});
  assert.equal(adapted.scene.elements.find(e=>e.id==='hold').transform.x.keys[1].t,5/3);
  assert.equal(adapted.project.source.sha256,target.project.source.sha256);
  const baselines=await req(route+'/adapt-baselines',request);
  assert.equal(baselines.projects.length,3);
  await req(route+'/adapt',{...request,targetRevision:1,sections:[{sourceFrom:0,sourceTo:6,targetFrom:0,targetTo:8,elementIds:source.scene.elements.map(e=>e.id),reason:'stale'}]},409);
  const exported=await req(`/api/projects/${adapted.project.id}/export`,{from:0,to:1,width:320,withAudio:true});
  assert.ok(exported.frameCount===30,JSON.stringify(exported));
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',exported.path],{encoding:'utf8',windowsHide:true}));
  assert.equal(Number(probe.streams.find(s=>s.codec_type==='video').nb_frames),30);
  assert.ok(probe.streams.some(s=>s.codec_type==='audio'));
  const picture=await fetch(base+`/api/projects/${adapted.project.id}/frames?kind=render&times=0.5,2,4,5.5,6.5,7.5&cellWidth=320&columns=3`);
  assert.equal(picture.status,200);
  fs.writeFileSync(path.join(data,'adapted-frames.jpg'),Buffer.from(await picture.arrayBuffer()));
  report.checks.push('audio import and beat worker executed','section adaptation preserves target music','three baselines generated','stale target rejected','adapted video exported with audio');
  client=new Client({name:'modeling-verification',version:'1'});
  const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'apps/mcp/src/index.ts')],env:{...env,MLM_SERVER_URL:base},stderr:'pipe'}));
  const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='model_project'));
  const documentCall=await client.callTool({name:'model_project',arguments:{project_id:adapted.project.id,operation:'documents'}});
  assert.ok(!documentCall.isError,JSON.stringify(documentCall));
  assert.equal(JSON.parse(documentCall.content[0].text).adaptation.kind,'sections');
  const sourceMedia=process.argv[2];
  if(sourceMedia) {
    let tracked=await req('/api/projects',{name:'M2 tracked letter'},201);
    tracked=await req(`/api/projects/${tracked.project.id}/media`,{path:path.resolve(sourceMedia)});
    const original=tracked.project.revision;
    const tracking=await client.callTool({name:'model_project',arguments:{project_id:tracked.project.id,operation:'track-region',input:{baseRevision:original,from:1.9,to:2.6,region:{x:400,y:300,w:105,h:120}}}},undefined, {timeout:180000});
    assert.ok(!tracking.isError,JSON.stringify(tracking));
    tracked=await req(`/api/projects/${tracked.project.id}`);
    const docs=await req(`/api/projects/${tracked.project.id}/documents`);
    assert.equal(Object.keys(docs.observations).length,1);
    assert.equal(tracked.scene.elements.length,1);
    assert.equal(tracked.scene.elements[0].transform.y.keys.length,12);
    report.trackedProject=tracked.project.id;
    report.checks.push('tracking via MCP applies fitted keys and stores raw observations');
  }
  report.sourceProject=id;report.targetProject=target.project.id;report.adaptedProject=adapted.project.id;report.variantProjects=variants.map(v=>v.project.id);report.baselineProjects=baselines.projects.map(p=>p.project.id);report.beatWorkerBpm=detected.bpm;
  fs.writeFileSync(path.join(data,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await client?.close();server.kill();}

