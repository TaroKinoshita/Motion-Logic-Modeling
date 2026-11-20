import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {LyricPlanRequest,planLyrics} from '../apps/server/src/lyric-planner.ts';

const output=process.argv[2];
assert.ok(output);
await mkdir(output,{recursive:true});
const summary=[];
const options={width:1920,height:1080,fps:30,duration:4};
for(const count of [1,2,4,8]) {
  for(const length of [1,5,15,50]) {
    for(const focus of [0,count-1]) {
      const input=LyricPlanRequest.parse({baseRevision:1,name:'range',lines:[{from:0,to:2,
        tokens:Array.from({length:count},(_,i)=>({text:'風'.repeat(length),at:i*.08,emphasis:i===focus}))}]});
      let result;
      try {
        const plan=planLyrics(input,options);
        assert.ok(plan.decisions[0].minimumFontSize>=options.height*.045);
        assert.equal(plan.scene.elements.filter(e=>e.type==='text').length,count);
        assert.equal(plan.audit.checkedFrames,120);
        result={status:'generated',layout:plan.decisions[0].arrangement,minFont:plan.decisions[0].minimumFontSize};
      } catch(error) {
        if(error.status!==422) throw error;
        result={status:'rejected',reason:error.message};
      }
      summary.push({count,length,focus,...result});
    }
  }
}
const carryInput=LyricPlanRequest.parse({baseRevision:1,name:'carry',lines:[
  {from:0,to:1,tokens:[{text:'風',at:0}]},{from:1,to:2,tokens:[{text:'空',at:1.3}]}]});
const carry=planLyrics(carryInput,options);
assert.equal(carry.decisions[1].retainedToken,'風');
assert.ok(!planLyrics({...carryInput,continuity:'none'},options).decisions[1].retainedToken);
assert.ok(!planLyrics({...carryInput,lines:[carryInput.lines[0],{...carryInput.lines[1],tokens:[{text:'空',at:1,emphasis:false}]}]},options)
 .decisions[1].retainedToken);
const short=planLyrics(LyricPlanRequest.parse({baseRevision:1,name:'short',
 lines:[{from:0,to:1,tokens:[{text:'風景',at:.9333333333}]}]}),options);
assert.equal(short.scene.elements.filter(e=>e.type==='text').length,1);
assert.ok(short.decisions[0].readingWarnings.length);
const oneFrame=planLyrics(LyricPlanRequest.parse({baseRevision:1,name:'one-frame',
 lines:[{from:0,to:1,tokens:[{text:'風',at:.966}]}]}),options);
assert.ok(oneFrame.decisions[0].readingWarnings.length);
await writeFile(output+'/range-checks.json',JSON.stringify({summary,carry:carry.decisions,
 shortWarnings:short.decisions[0].readingWarnings},null,2));
console.log('Inputs checked',summary.length,'generated',summary.filter(row=>row.status==='generated').length,
 'readability rejected',summary.filter(row=>row.status==='rejected').length);
