import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sampleTrack } from '@mlm/core';

const [base, projectId, outputDir] = process.argv.slice(2);
if (!base || !projectId || !outputDir) throw new Error('Specify the server URL, Lyricsample1 contour project ID and output directory');
const output = path.resolve(outputDir);
await fs.mkdir(output, { recursive: true });
const request = async (id, endpoint = '', body, status = 200) => {
  const response = await fetch(`${base}/api/projects/${id}${endpoint}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
};
const { project } = await request(projectId);
assert.equal(project.source.sha256, '251ecc12d05d3f000e8ac473b6c9763e8961a19989a89a519823d941bebe9cb3');
const args = { baseRevision: project.revision, actor: 'verification', label: 'Lyricsample1 · 各',
  fragmentIds: ['track:lyrics:1', 'track:lyrics:9'], from: 3, to: 27, shapeFrame: 21 };
await request(projectId, '/blocking/representative', { ...args, baseRevision: project.revision + 1 }, 409);
await request(projectId, '/blocking/representative', { ...args, fragmentIds: [args.fragmentIds[0], args.fragmentIds[0]] }, 422);
const fixed = await request(projectId, '/blocking/representative', args, 201);
const substitution = await request(projectId, '/blocking/representative', { ...args, label: 'Lyricsample1 · 右' }, 201);
const changed = await request(substitution.project.id, '/blocking/edit', { actor: 'verification', baseRevision: substitution.project.revision,
  edit: { kind: 'text', blockId: args.fragmentIds[0], text: '右' } });
assert.deepEqual(changed.scene.elements[0], { ...fixed.scene.elements[0], name: changed.scene.elements[0].name });
assert.deepEqual(changed.design.events, fixed.design.events);
assert.deepEqual(fixed.fit.missingFrames, [15]);
assert.equal(fixed.fit.fitSampleCount, 23);
assert.equal(changed.scene.elements[1].text, '右');
assert.ok(!changed.scene.elements[1].outline && !changed.scene.elements[1].vector);
assert.equal((await request(projectId)).project.revision, project.revision);

const { fps } = fixed.scene;
const parent = fixed.scene.elements[0];
const child = fixed.scene.elements[1];
const docs = await request(fixed.project.id, '/documents');
const rows = fixed.fit.observationIds.flatMap(id => docs.observations[id]?.samples ?? []).filter(row => row.frame >= args.from && row.frame < args.to);
const errors = rows.map(({ frame, box: [x, y, w, h] }) => {
  const t = frame / fps;
  const get = key => sampleTrack(parent.transform[key], t, 0);
  return { frame, centerPx: Math.hypot(get('x') - x - (w - 1) / 2, get('y') - y - (h - 1) / 2),
    widthRelative: Math.abs(get('scaleX') * child.width - (w - 1)) / (w - 1),
    heightRelative: Math.abs(get('scaleY') * child.height - (h - 1)) / (h - 1) };
});
assert.equal(errors.length, 23);
const summary = Object.fromEntries(['centerPx', 'widthRelative', 'heightRelative'].map(key => {
  const values = errors.map(row => row[key]).sort((a, b) => a - b);
  return [key, { median: values[Math.floor(values.length / 2)], max: values.at(-1) }];
}));
const videos = [];
for (const [data, file] of [[fixed, '01_fixed_shape.mp4'], [changed, '02_replaced_glyph.mp4']]) {
  const result = await request(data.project.id, '/blocking/export', {});
  const target = path.join(output, file);
  await fs.copyFile(result.path, target);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames', '-of', 'json', target], { encoding: 'utf8' }));
  assert.equal(Number(probe.streams.find(stream => stream.codec_type === 'video').nb_read_frames), 24);
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
  videos.push({ projectId: data.project.id, revision: data.project.revision, file });
}
const width = 960, height = 540, header = 40;
const pane = (x,y) => execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(output, videos[0].file),
  '-vf', `crop=${width}:${height}:${x}:${y},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
const reference = pane(0,header), model = pane(width,height+2*header);
const byFrame = rows.map(({ frame, box: [left, top, w, h] }) => {
  const offset = (frame - args.from) * width * height;
  const kx = width / fixed.scene.width, ky = height / fixed.scene.height;
  const x0 = Math.floor(left * kx), x1 = Math.ceil((left + w) * kx);
  const y0 = Math.floor(top * ky), y1 = Math.ceil((top + h) * ky);
  let intersection = 0, union = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = offset + y * width + x;
    const sourceInk = x >= x0 && x < x1 && y >= y0 && y < y1 && reference[index] < 128;
    const modelInk = model[index] < 128;
    intersection += Number(sourceInk && modelInk);
    union += Number(sourceInk || modelInk);
  }
  assert.ok(union > 0);
  return { frame, iou: intersection / union };
});
const shapeComparison = { kind: 'fixed glyph vs original video; source clipped to matched contour box; height 540, luma <128',
  average: byFrame.reduce((sum,row)=>sum+row.iou,0)/byFrame.length, worst: byFrame.reduce((a,b)=>a.iou<b.iou?a:b), byFrame };
const report = { sourceProjectId: projectId, sourceRevision: project.revision, fixed: fixed.fit, videos, summary, errors, shapeComparison,
  events: fixed.design.events, comparisonBasis: 'same contour-box observations used in fitting; independent annotation pending' };
await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ videos, summary, shapeComparison, fit: fixed.fit, output }, null, 2));
