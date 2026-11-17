import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(import.meta.dirname, '..');
const data = path.join(root, 'data/v2-validation');
const port = process.env.MLM_VERIFY_PORT ?? '4520';
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['apps/server/src/index.ts'], { cwd: root, env: { ...process.env, MLM_PORT: port, MLM_DATA_DIR: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stderr.on('data', d => logs += d); server.stdout.on('data', d => logs += d);
let client;
async function request(route, body) {
  const response = await fetch(base + route, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
try {
  for (let n = 0; ; n++) {
    if (server.exitCode !== null) throw new Error(logs);
    try { const health = await request('/api/health'); assert.equal(path.resolve(health.body.dataDir), data); break; }
    catch (err) { if (n > 50) throw err; await new Promise(r => setTimeout(r, 100)); }
  }
  const id = JSON.parse(fs.readFileSync(path.join(data, 'report.json'))).projects[1];
  const initial = (await request(`/api/projects/${id}`)).body;
  const http = await request(`/api/projects/${id}/detect-beats`, { baseRevision: initial.project.revision, actor: 'test-http' });
  assert.equal(http.status, 200, JSON.stringify(http.body));
  assert.equal(http.body.beats.length, 20);
  const stale = await request(`/api/projects/${id}/detect-beats`, { baseRevision: initial.project.revision });
  assert.equal(stale.status, 409);
  client = new Client({ name: 'beat-integration', version: '1' });
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'apps/mcp/src/index.ts')], env: { ...env, MLM_SERVER_URL: base }, stderr: 'pipe' }));
  assert.equal((await client.listTools()).tools.length, 15);
  const mcp = await client.callTool({ name: 'detect_beats', arguments: { project_id: id, base_revision: http.body.project.revision } });
  assert.ok(!mcp.isError, JSON.stringify(mcp));
  const frames = await client.callTool({ name: 'get_frames', arguments: { project_id: id, kind: 'compare', times: [0.5], cell_width: 640, region: { x: 350, y: 230, w: 580, h: 300 }, grid_step: 50 } });
  assert.ok(!frames.isError, JSON.stringify(frames));
  fs.writeFileSync(path.join(data, 'region-compare.jpg'), Buffer.from(frames.content.find(c => c.type === 'image').data, 'base64'));
  const badRegion = await fetch(base + `/api/projects/${id}/frames?region=` + encodeURIComponent(JSON.stringify({x:1279,y:0,w:10,h:10})));
  assert.equal(badRegion.status, 400);
  const comparison = await request(`/api/projects/${id}/compare`, { from: 0.5, to: 1.5, width: 640 });
  assert.equal(comparison.status, 200, JSON.stringify(comparison.body));
  assert.equal(comparison.body.frameCount, 30);
  assert.ok(comparison.body.ssim.mean >= -1 && comparison.body.ssim.mean <= 1);
  const comparisonMcp = await client.callTool({ name: 'compare_segment', arguments: { project_id: id, from: 0.5, to: 1.5, width: 640 } });
  assert.ok(!comparisonMcp.isError, JSON.stringify(comparisonMcp));
  const comparisonData = JSON.parse(comparisonMcp.content.find(c => c.type === 'text').text);
  assert.deepEqual(comparisonData.ssim, comparison.body.ssim);
  assert.equal((await request(`/api/projects/${id}/compare`, { from: 2, to: 1 })).status, 400);
  fs.writeFileSync(path.join(data, 'compare-verification.json'), JSON.stringify(comparison.body, null, 2));
  const state = (await request(`/api/projects/${id}`)).body;
  assert.deepEqual(state.scene.tempo, initial.scene.tempo);
  assert.deepEqual(state.scene.markers.filter(m => m.origin === 'manual'), initial.scene.markers.filter(m => m.origin === 'manual'));
  // The update must win, whether it lands before the initial revision check or during analysis.
  const pending = request(`/api/projects/${id}/detect-beats`, { baseRevision: state.project.revision, actor: 'test-race' });
  const edit = await request(`/api/projects/${id}/scene`, { baseRevision: state.project.revision, ops: [{ op: 'setSceneProps', props: { background: state.scene.background } }], note: 'concurrent edit probe' });
  assert.equal(edit.status, 200);
  assert.equal((await pending).status, 409);
  const empty = (await request('/api/projects', { name: 'Beat validation: no media' })).body;
  assert.equal((await request(`/api/projects/${empty.project.id}/detect-beats`, { baseRevision: empty.project.revision })).status, 400);
  const result = { regionMcp: 'pass', regionBoundsHttp: 'pass', http: 'pass', mcp: 'pass', staleRevision: 'pass', concurrentEdit: 'pass', noMedia: 'pass', manualPreserved: true, tempoUnchanged: true, bpm: http.body.bpm, beats: http.body.beats.length };
  fs.writeFileSync(path.join(data, 'beats-http-verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await client?.close(); server.kill(); }
