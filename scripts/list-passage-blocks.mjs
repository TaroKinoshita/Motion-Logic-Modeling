// List the visually significant block groups of a reconstructed project in a frame window.
// Used to curate passages for retargeting. Prints per group: frames on screen, max on-screen
// height/width (fraction of the frame), label and child kinds.
// Usage: node scripts/list-passage-blocks.mjs <projectId> <fromFrame> <toFrame> [minHeight=0.06]
import {getProject} from '../apps/server/src/store.ts';
import {evaluateScene,canvasMeasurer} from '@mlm/core';
import {createCanvas} from '@napi-rs/canvas';
import '../apps/server/src/fonts.ts';
const measure=canvasMeasurer(createCanvas(1,1).getContext('2d'));

const [id,fromArg,toArg,minArg]=process.argv.slice(2);
const {scene}=getProject(id);
const from=Number(fromArg),to=Number(toArg),minH=Number(minArg??.06);
const fps=scene.fps,W=scene.width,H=scene.height;
const byId=new Map(scene.elements.map(e=>[e.id,e]));
const groups=new Map();
for(let f=from;f<=to;f++) {
  for(const ev of evaluateScene(scene,(f+.5)/fps,measure)) {
    const el=ev.element;
    if(el.type!=='rect'&&el.type!=='text') continue;
    const parent=el.parentId?byId.get(el.parentId):undefined;
    if(!parent||parent.type!=='group') continue;
    const [a,b,c,d]=ev.matrix;
    const w=(el.width??0)*Math.hypot(a,b),h=(el.height??0)*Math.hypot(c,d);
    const row=groups.get(parent.id)??{id:parent.id,name:parent.name,frames:[],maxH:0,maxW:0,kinds:new Set(),cx:[],cy:[]};
    if(!row.frames.includes(f)) row.frames.push(f);
    row.maxH=Math.max(row.maxH,h/H);row.maxW=Math.max(row.maxW,w/W);
    row.kinds.add(el.type+(el.outline?':outline':'')+(el.text?':'+el.text:''));
    row.cx.push(ev.matrix[4]/W);row.cy.push(ev.matrix[5]/H);
    groups.set(parent.id,row);
  }
}
const rows=[...groups.values()].filter(r=>r.maxH>=minH||[...r.kinds].some(k=>k.startsWith('text')))
  .sort((p,q)=>p.frames[0]-q.frames[0]);
for(const r of rows) {
  const mean=list=>(list.reduce((s,v)=>s+v,0)/list.length).toFixed(2);
  console.log([r.id,r.name,`F${r.frames[0]}-${r.frames.at(-1)}`,`h${r.maxH.toFixed(2)}`,`w${r.maxW.toFixed(2)}`,
    `c(${mean(r.cx)},${mean(r.cy)})`,[...r.kinds].join('|')].join('  '));
}
console.log('background',scene.background,'fps',fps,'size',W,H);
