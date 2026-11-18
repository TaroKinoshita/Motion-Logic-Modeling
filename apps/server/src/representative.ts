import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { EaseSchema, validateBlocking } from '@mlm/core';
import type { Blocking, Scene, Track, Transform } from '@mlm/core';
import { z } from 'zod';
import { getBlocking } from './blocking.ts';
import { sourcePath } from './media.ts';
import { commit, createProject, getDocuments, getProject, HttpError, projectDir, REPO_ROOT, trashProject } from './store.ts';

const frame = z.number().int().nonnegative();
export const RepresentativeRequest = z.strictObject({
  baseRevision: z.number().int().positive(), actor: z.string().min(1).max(40).default('human'),
  label: z.string().trim().min(1).max(75), fragmentIds: z.array(z.string().min(1)).min(1).max(8),
  from: frame, to: frame, shapeFrame: frame, geometry: z.enum(['box','affine']).optional(),
});
const sampleSchema = z.object({ frame, box: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]) });
export const contourObservation = z.object({ kind: z.literal('block-contour'), samples: z.array(sampleSchema) });
type Sample = z.infer<typeof sampleSchema>;
type Property = 'x' | 'y' | 'width' | 'height';
const fields = z.enum(['x', 'y', 'width', 'height']);
const keys = z.array(z.object({ t: z.number(), value: z.number(), easing: EaseSchema })).min(1);
const fitSchema = z.object({ tracks: z.record(fields, keys), maxSampleError: z.record(fields, z.number().nonnegative()) });
const fitComparison = z.object({ linear: fitSchema, eased: fitSchema });
const affineFields=z.enum(['x','y','scaleX','scaleY','rotation','shearX']);
const affineSchema=z.object({fit:z.object({tracks:z.record(affineFields,keys),maxSampleError:z.record(affineFields,z.number().nonnegative())}),
  metrics:z.array(z.object({frame,axisAlignedIou:z.number(),affineIou:z.number()}))});
const run = promisify(execFile);

export async function createRepresentative(id: string, input: z.infer<typeof RepresentativeRequest>) {
  const { project, scene, design } = getBlocking(id);
  if (project.revision !== input.baseRevision) throw new HttpError(409, '最新のリビジョンを読み直してください');
  if (!design || !project.source || project.source.variableFrameRate) throw new HttpError(422, '固定フレームレートの輪郭計測が必要です');
  const { fps } = scene;
  const { from, to, label, fragmentIds, shapeFrame } = input;
  if (to - from < 2 || to - from > 48 || from / fps < design.blocks.from || to / fps > design.blocks.to ||
      shapeFrame < from || shapeFrame >= to || new Set(fragmentIds).size !== fragmentIds.length) {
    throw new HttpError(422, '比較区間内の2〜48コマと、その中の代表形、重複しない断片を指定してください');
  }

  const docs = getDocuments(id);
  const observations = docs.observations as Record<string, unknown> ?? {};
  const rows = new Map<number, Sample>();
  const shapes = new Map<number, NonNullable<Blocking['appearance'][number]['contours']>[number]>();
  const evidence = new Set<string>();
  for (const fragmentId of fragmentIds) {
    const block = design.blocks.items.find(item => item.id === fragmentId);
    const group = scene.elements.find(el => el.id === fragmentId);
    const binding = design.appearance.find(item => item.blockId === fragmentId);
    if (!block || !group || group.parentId || !binding?.contours?.length) throw new HttpError(422, `画面座標の輪郭断片を指定してください: ${fragmentId}`);
    const fragmentRows = new Map<number, Sample>();
    for (const key of block.observationIds) {
      const observation = contourObservation.safeParse(observations[key]);
      if (!observation.success) continue;
      for (const row of observation.data.samples) fragmentRows.set(row.frame, row);
      evidence.add(key);
    }
    let count = 0;
    for (const shape of binding.contours) {
      const n = Math.round(shape.t * fps);
      const row = fragmentRows.get(n);
      if (n < from || n >= to || !row) continue;
      if (rows.has(n)) throw new HttpError(422, `同じコマに複数の断片があります: ${n}F`);
      rows.set(n, row);
      shapes.set(n, shape);
      count++;
    }
    if (!count) throw new HttpError(422, `区間内に元の輪郭計測がありません: ${fragmentId}`);
  }
  const shape = shapes.get(shapeFrame);
  const shapeBox = rows.get(shapeFrame)?.box;
  if (!shape || !shapeBox || !rows.has(from) || !rows.has(to - 1) || shapeBox[2] < 2 || shapeBox[3] < 2) {
    throw new HttpError(422, '開始・最終コマの観測と、幅・高さが2px以上の代表形を指定してください');
  }

  const ordered = [...rows.values()].sort((a, b) => a.frame - b.frame);
  const missingFrames: number[] = [];
  const pins: number[] = [];
  for (const [index, row] of ordered.entries()) {
    if (!index) continue;
    const previous = ordered[index - 1].frame;
    const gap = row.frame - previous - 1;
    if (gap > 4) throw new HttpError(422, '5コマ以上の欠測を含む区間は分けてください');
    if (gap) pins.push(previous / fps, row.frame / fps);
    for (let n = previous + 1; n < row.frame; n++) missingFrames.push(n);
  }
  const samples = ordered.map(({ frame, box: [left, top, width, height] }) => ({
    t: frame / fps, x: left + (width - 1) / 2, y: top + (height - 1) / 2, width: width - 1, height: height - 1,
  }));
  const python = process.env.MLM_TRACK_PYTHON ?? path.join(REPO_ROOT, 'workers', 'track', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let fits: z.infer<typeof fitComparison>;
  let affine: z.infer<typeof affineSchema>|undefined;
  try {
    const worker = path.join(REPO_ROOT, 'workers', 'track', 'track', 'representative_fit.py');
    const { stdout } = await run(python, [worker, JSON.stringify([samples, pins])], { windowsHide: true, timeout: 20_000 });
    fits = fitComparison.parse(JSON.parse(stdout));
    if(input.geometry==='affine') {
      const cache=await mkdtemp(path.join(projectDir(id),'cache','representative-'));
      try {
        const params=path.join(cache,'params.json');
        await writeFile(params,JSON.stringify({samples:ordered.map(row=>({...row,...shapes.get(row.frame)})),shape_frame:shapeFrame,pins}));
        const result=await run(python,[path.join(path.dirname(worker),'representative_affine.py'),params],{windowsHide:true,timeout:20_000});
        affine=affineSchema.parse(JSON.parse(result.stdout));
      } finally {await rm(cache,{recursive:true,force:true});}
    }
  } catch (error) {
    throw new HttpError(422, '代表形のキー近似に失敗しました。workers/trackの環境を確認してください', String(error));
  }
  if (getProject(id).project.revision !== input.baseRevision) throw new HttpError(409, '近似中に元のリビジョンが変更されました');

  const [,, rawWidth, rawHeight] = shapeBox;
  const width = rawWidth - 1, height = rawHeight - 1;
  const track = (key: Property, unit = 1): Track => convert(fits.eased.tracks[key],unit);
  const transform:Transform=affine?Object.fromEntries(Object.entries(affine.fit.tracks).map(([key,rows])=>[key,convert(rows)])):
    { x: track('x'), y: track('y'), scaleX: track('width', width), scaleY: track('height', height) };
  const blockId = fragmentIds[0], childId = `${blockId}:representative`;
  const life = { inPoint: from / fps, outPoint: to / fps };
  const shade = shape.luma.toString(16).padStart(2, '0');
  const next: Scene = { ...scene, elements: [
    { id: blockId, name: label, type: 'group', ...life, transform },
    { id: childId, name: label, type: 'rect', parentId: blockId, width, height, fill: `#${shade.repeat(3)}`, outline: shape.paths },
  ] };
  const linked = new Set(fragmentIds);
  const remap = (ids: string[]) => ids.some(ref => linked.has(ref)) ? [blockId] : [];
  const shownEvents = design.events.flatMap(event => {
    if (event.t < life.inPoint || event.t >= life.outPoint || event.status === 'rejected') return [];
    const inputs = remap(event.inputs), outputs = remap(event.outputs);
    if (!inputs.length && !outputs.length && (event.inputs.length || event.outputs.length)) return [];
    if (['merge', 'split', 'replace'].includes(event.kind)) return [];
    event.observationIds.forEach(key => evidence.add(key));
    return [{ ...event, inputs, outputs, until: event.until === undefined ? undefined : Math.min(event.until, life.outPoint) }];
  });
  const fitId = randomUUID();
  const fitObservation = {
    id: fitId, kind: 'representative-fit', origin: 'estimated', sourceProjectId: id, sourceRevision: project.revision,
    sourceSha256: project.source.sha256, fragmentIds, shapeFrame, from, to, fitSampleCount: samples.length,
    missingFrames, observationIds: [...evidence], method: 'manually selected fragments; fixed contour; bounded linear or monotone cubic',
    geometry:input.geometry??'box', affine:affine?{metrics:affine.metrics,maxSampleError:affine.fit.maxSampleError,keyCount:keyCount(affine.fit)}:undefined,
    linearKeys: keyCount(fits.linear), easedKeys: keyCount(fits.eased), maxSampleError: fits.eased.maxSampleError,
  };
  const model: Blocking = {
    blocks: { ...design.blocks, from: life.inPoint, to: life.outPoint, measuredTo: undefined, derived: true,
      items: [{ id: blockId, label, color: '#64c7e7', extent: { cx: 0, cy: 0, width, height }, observationIds: [...evidence, fitId] }] },
    events: shownEvents,
    appearance: [{ blockId, childIds: [childId] }],
  };
  validateBlocking(next, model);
  const created = createProject(`${label} · 代表形`, next, input.actor);
  try {
    await copyFile(sourcePath(project), sourcePath({ ...created.project, source: project.source }));
    return { ...commit(created.project.id, { baseRevision: created.project.revision, actor: input.actor, note: '代表形と変形キーを保存',
      meta: meta => { meta.source = project.source; meta.audioAnalysis = project.audioAnalysis; },
      documents: () => ({ ...model, observations: { ...Object.fromEntries([...evidence].filter(key => key in observations).map(key => [key, observations[key]])), [fitId]: fitObservation } }),
    }), design: model, fit: fitObservation };
  } catch (error) {
    trashProject(created.project.id, input.actor);
    throw error;
  }
}

function convert(rows:z.infer<typeof keys>,unit=1):Track {
  const keys=rows.map(row=>({t:row.t,v:row.value/unit,ease:row.easing}));
  return keys.every(row=>row.v===keys[0].v)?keys[0].v:{keys};
}

function keyCount(fit: {tracks:Record<string,z.infer<typeof keys>>}) {
  return Object.values(fit.tracks).reduce((count, keys) => count + (keys.every(key => key.value === keys[0].value) ? 0 : keys.length), 0);
}
