// Reproducible integration/acceptance check. Isolated data; never edits the original sample.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createCanvas } from '@napi-rs/canvas';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { migrateScene, layoutText, canvasMeasurer, validateScene } from '../packages/core/src/index.ts';
import '../apps/server/src/fonts.ts';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'data/v2-validation');
fs.mkdirSync(dir, { recursive: true });
const port = process.env.MLM_VERIFY_PORT ?? '4518';
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['apps/server/src/index.ts'], { cwd: root, env: { ...process.env, MLM_PORT: port, MLM_DATA_DIR: dir }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
const report = { at: new Date().toISOString(), checks: [], comparison: [] };
async function api(route, body) {
  const res = await fetch(base + route, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}
let client;
try {
  for (let i = 0; ; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try { const health = await api('/api/health'); assert.equal(path.resolve(health.dataDir), dir, '検証用でないサーバーには接続しません'); break; } catch (err) { if (i > 50) throw err; }
    await new Promise(r => setTimeout(r, 100));
  }
  const sampleId = process.argv[2] ?? 'p_mwh3s99t2w85';
  const sampleDir = path.join(root, 'data/projects', sampleId);
  const original = JSON.parse(fs.readFileSync(path.join(sampleDir, 'scene.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(sampleDir, 'project.json'), 'utf8'));
  const baseline = migrateScene(original);
  const v2 = structuredClone(baseline); v2.tempo = { bpm: 120, offset: 0 };
  const measure = canvasMeasurer(createCanvas(1, 1).getContext('2d'));
  const groups = [
    { prefix: 'm', word: 'MOTION', interval: 0.06, gap: 4 },
    { prefix: 'l', word: 'LOGIC', interval: { beats: 0.5 }, gap: 4 },
    { prefix: 'n', word: 'NEW SONG', interval: 0.08, gap: 0 },
  ];
  for (const g of groups) {
    const old = v2.elements.filter(e => new RegExp(`^${g.prefix}[0-9]+$`).test(e.id));
    const first = old[0];
    const el = { ...first, id: `${g.prefix}-word`, name: g.word, text: g.word, split: 'char', letterSpacing: g.gap, fontFamily: 'MLM Arial', stagger: { interval: g.interval }, transform: { y: 0 }, unitTransform: {} };
    const layout = layoutText(el, measure);
    el.transform.x = old.reduce((sum, e) => sum + e.transform.x - layout.units[Number(e.id.slice(1))].x, 0) / old.length;
    if (g.prefix === 'm') el.unitTransform = { y: first.transform.y, opacity: first.transform.opacity };
    if (g.prefix === 'l') {
      el.inPoint = { beat: 4 };
      el.unitTransform = { y: { keys: first.transform.y.keys.map(k => ({ ...k, t: { beat: 4, offsetSeconds: k.t - 2 } })) }, opacity: { keys: [{ t: { beat: 4, offsetSeconds: -0.000001 }, v: 0, ease: 'hold' }, { t: { beat: 4 }, v: 1 }] } };
    }
    if (g.prefix === 'n') {
      delete el.inPoint; el.transform.y = 360;
      el.unitTransform.opacity = { keys: [{ t: 8.279999, v: 0, ease: 'hold' }, { t: 8.28, v: 1 }] };
    }
    el.note = 'v2関係記述。文字位置は旧シーンから全体位置を合わせた合成素材検証用';
    const at = v2.elements.indexOf(first);
    v2.elements = v2.elements.filter(e => !old.includes(e));
    v2.elements.splice(at, 0, el);
  }
  for (const el of v2.elements.filter(e => /^c[0-2]$/.test(e.id))) {
    for (const axis of ['scaleX', 'scaleY']) {
      el.transform[axis] = { keys: el.transform[axis].keys.slice(0, 3).map(k => ({ ...k, t: { beat: k.t * 2 } })), repeat: { every: { beats: 1 }, count: 4 } };
    }
    el.inPoint = { beat: 12 }; el.outPoint = { beat: 16 };
    el.note = '毎拍の脈動を1周期とrepeatで記述';
  }
  assert.deepEqual(validateScene(v2), []);
  report.size = { v1Elements: original.elements.length, v2Elements: v2.elements.length, v1Bytes: Buffer.byteLength(JSON.stringify(original)), v2Bytes: Buffer.byteLength(JSON.stringify(v2)) };
  fs.writeFileSync(path.join(dir, 'sample-v2.json'), JSON.stringify(v2, null, 2));
  const projects = [];
  for (const [name, scene] of [['v1 baseline', baseline], ['v2 relations', v2]]) {
    let data = await api('/api/projects', { name });
    data = await api(`/api/projects/${data.project.id}/media`, { path: path.join(sampleDir, 'media', meta.source.fileName) });
    data = await api(`/api/projects/${data.project.id}/scene`, { baseRevision: data.project.revision, scene, note: 'v2受け入れ検証' });
    projects.push(data);
  }
  report.projects = projects.map(p => p.project.id);
  // Seed an actual historical v1 fixture, then exercise read, commit and revert through HTTP.
  const fixture = path.join(dir, 'projects', 'migration_fixture');
  fs.mkdirSync(path.join(fixture, 'history'), { recursive: true });
  const fixtureScene = JSON.stringify(original);
  fs.writeFileSync(path.join(fixture, 'scene.json'), fixtureScene);
  fs.writeFileSync(path.join(fixture, 'project.json'), JSON.stringify({ ...meta, id: 'migration_fixture', revision: 1, schemaVersion: 1, source: undefined }));
  fs.writeFileSync(path.join(fixture, 'history/r000001.json'), JSON.stringify({ revision: 1, scene: original, actor: 'test', note: 'v1 fixture' }));
  assert.equal((await api('/api/projects/migration_fixture')).scene.schemaVersion, 2);
  assert.equal(fs.readFileSync(path.join(fixture, 'scene.json'), 'utf8'), fixtureScene);
  await api('/api/projects/migration_fixture/scene', { baseRevision: 1, ops: [{ op: 'setSceneProps', props: { background: '#123456' } }] });
  const reverted = await api('/api/projects/migration_fixture/revert', { baseRevision: 2, toRevision: 1 });
  assert.equal(reverted.project.schemaVersion, 2); assert.equal(reverted.scene.background, original.background);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'history/r000001.json'))).scene.schemaVersion, 1);
  report.checks.push('v1 read without write, v2 commit, v1 historical revert');
  client = new Client({ name: 'mlm-v2-verification', version: '1.0' });
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'apps/mcp/src/index.ts')], env: { ...env, MLM_SERVER_URL: base }, stderr: 'pipe' }));
  const id = projects[1].project.id;
  const tools = await client.listTools(); assert.equal(tools.tools.length, 12);
  const update = await client.callTool({ name: 'update_scene', arguments: { project_id: id, base_revision: projects[1].project.revision, ops: [{ op: 'setSceneProps', props: { tempo: { bpm: 100, offset: 0 } } }] } });
  assert.ok(!update.isError);
  const image = await client.callTool({ name: 'get_frames', arguments: { project_id: id, kind: 'render', times: [0.5, 2.5, 7.35, 9], cell_width: 640 } });
  assert.ok(!image.isError);
  fs.writeFileSync(path.join(dir, 'mcp-100bpm.jpg'), Buffer.from(image.content.find(c => c.type === 'image').data, 'base64'));
  let current = await api(`/api/projects/${id}`);
  assert.equal(current.scene.tempo.bpm, 100);
  const stale = await client.callTool({ name: 'update_scene', arguments: { project_id: id, base_revision: 1, ops: [{ op: 'setSceneProps', props: { duration: 8 } }] } });
  assert.equal(stale.isError, true);
  await api(`/api/projects/${id}/scene`, { baseRevision: current.project.revision, ops: [{ op: 'setSceneProps', props: { tempo: { bpm: 120, offset: 0 } } }] });
  report.checks.push('12 MCP tools, beat tempo update, image return, stale revision rejected');
  const exports = [];
  for (const p of projects) exports.push(await api(`/api/projects/${p.project.id}/export`, { from: 0, to: 10, width: 1280, withAudio: false }));
  for (const e of exports) {
    const probe = spawnSync(process.env.MLM_FFPROBE ?? 'ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', e.path], { encoding: 'utf8', windowsHide: true });
    assert.equal(probe.status, 0); assert.equal(JSON.parse(probe.stdout).streams[0].nb_read_frames, '300');
  }
  report.checks.push('both 10s exports contain 300 frames');
  const source = path.join(sampleDir, 'media', meta.source.fileName);
  for (const [from, to] of [[0, 2], [2, 4], [4, 4.5], [4.5, 6], [6, 8], [8, 10]]) {
    const values = [];
    for (const e of exports) {
      const filter = `[0:v]trim=start=${from}:end=${to},setpts=PTS-STARTPTS,format=yuv420p[a];[1:v]trim=start=${from}:end=${to},setpts=PTS-STARTPTS,format=yuv420p[b];[a][b]ssim`;
      const run = spawnSync(process.env.MLM_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-i', source, '-i', e.path, '-lavfi', filter, '-an', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, maxBuffer: 4e6 });
      assert.equal(run.status, 0, run.stderr);
      values.push(Number(/All:([0-9.]+)/.exec(run.stderr)[1]));
    }
    report.comparison.push({ from, to, v1: values[0], v2: values[1], delta: values[1] - values[0] });
  }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client?.close(); server.kill();
}
