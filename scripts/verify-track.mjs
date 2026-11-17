import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/verify-track.mjs <kinetic_sample.mp4>');
const dir = path.join(root, 'data/track-validation');
fs.mkdirSync(dir, { recursive: true });
const clip = path.join(dir, 'letter.avi');
const observations = path.join(dir, 'observations.json');
const simplification = path.join(dir, 'simplification.json');
execFileSync('ffmpeg', ['-v','error','-i',path.resolve(source),'-vf','trim=start=1.9:end=2.6,setpts=PTS-STARTPTS,fps=30','-an','-c:v','ffv1','-y',clip], {windowsHide:true});
const worker = path.join(root, 'workers/track');
execFileSync(path.join(worker, '.venv/Scripts/python.exe'), ['-m','track',clip,observations,'--region','400','300','105','120','--fps','30','--start-time','1.9','--fit-output',simplification], {cwd:worker,windowsHide:true});
const raw = JSON.parse(fs.readFileSync(observations));
const fit = JSON.parse(fs.readFileSync(simplification));
assert.equal(raw.stoppedReason, null);
assert.equal(raw.samples.length, 21);
// Independent formula from the sample generator, excluding its later global shrink.
const expectedY = t => { const p = Math.max(0,Math.min(1,(t-2)/.4)); return 360-110*(3*p*p-2*p*p*p); };
const maxYError = Math.max(...raw.samples.map(s => Math.abs(s.y-expectedY(s.t))));
assert.ok(maxYError < 3, `position error ${maxYError}`);
for (const field of ['x','y','scale','rotation']) assert.ok(fit.maxSampleError[field] <= fit.tolerances[field] + 1e-9);
const sampleKeys = fit.tracks.y;
function sample(t) {
  for(let i=1;i<sampleKeys.length;i++) if(t<=sampleKeys[i].t) {
    const a=sampleKeys[i-1],b=sampleKeys[i]; return a.value+(b.value-a.value)*(t-a.t)/(b.t-a.t);
  }
  return sampleKeys.at(-1).value;
}
const maxFittedYError = Math.max(...raw.samples.map(s=>Math.abs(sample(s.t)-expectedY(s.t))));
assert.ok(maxFittedYError < 3);
const result = {source:path.basename(source),from:1.9,to:2.6,samples:raw.samples.length,maxYErrorPx:maxYError,maxFittedYErrorPx:maxFittedYError,keys:Object.fromEntries(Object.entries(fit.tracks).map(([k,v])=>[k,v.length])),limitations:['One synthetic letter region only','Timing of appearance not measured','No scene application or cubic-bezier fitting yet']};
fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
