import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOps, demoScene, emptyScene, evaluateScene, hitTest, migrateScene, moveElementOps, resolveTime, resolveDuration, sampleTrack, scaleElementOps, selectionFrame, timelineKeys, validateScene } from '../src/index.ts';
import type { Scene, Track } from '../src/index.ts';

const measure = (text: string) => [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)].length * 10;
function textScene(): Scene {
  const scene = emptyScene();
  scene.elements = [{ id: 'word', type: 'text', text: 'AB', split: 'char', stagger: { interval: 0.5 }, transform: { x: 100, y: { keys: [{ t: 2, v: 100 }, { t: 3, v: 200 }] } }, unitTransform: { y: { keys: [{ t: 0, v: 40 }, { t: 1, v: 0 }] } } }];
  return scene;
}
test('v1 migration preserves evaluated frames and leaves source untouched', () => {
  const v2 = demoScene();
  const v1 = { ...v2, schemaVersion: 1 };
  const migrated = migrateScene(v1);
  assert.equal(v1.schemaVersion, 1);
  for (const t of [0, 0.48, 1.5, 3.5, 5.99]) assert.deepEqual(evaluateScene(migrated, t), evaluateScene(v2, t));
  assert.throws(() => migrateScene({ ...v1, tempo: { bpm: 120, offset: 0 } }));
  assert.throws(() => migrateScene({ ...v1, schemaVersion: 99 }));
});
test('beat times preserve measured offsets; durations ignore tempo offset', () => {
  assert.equal(resolveTime({ beat: 12, offsetSeconds: 0.03 }, { bpm: 120, offset: 1 }), 7.03);
  assert.equal(resolveTime({ beat: 12 }, { bpm: 100, offset: 0 }), 7.2);
  assert.equal(resolveTime(6.03, { bpm: 100, offset: 2 }), 6.03);
  assert.equal(resolveDuration({ beats: 1 }, { bpm: 120, offset: 2 }), 0.5);
  assert.throws(() => resolveTime({ beat: 1 }));
});
test('repeat boundaries reset at each cycle and hold the completed final value', () => {
  const track: Track = { keys: [{ t: 2, v: 0 }, { t: 2.5, v: 10 }], repeat: { every: 1, count: 2 } };
  assert.equal(sampleTrack(track, 1, 99), 0);
  assert.equal(sampleTrack(track, 2.25, 99), 5);
  assert.equal(sampleTrack(track, 2.75, 99), 10);
  assert.equal(sampleTrack(track, 3, 99), 0);
  assert.equal(sampleTrack(track, 4, 99), 10);
  assert.equal(sampleTrack(track, 9, 99), 10);
  const truncated: Track = { ...track, repeat: { every: 1, until: 2.25 } };
  assert.ok(Math.abs(sampleTrack(truncated, 9, 99) - 5) < 1e-10);
});
test('beat repeats retime their phase and retain repeat metadata when scaled', () => {
  const scene = emptyScene(); scene.tempo = { bpm: 120, offset: 0 };
  scene.elements = [{ id: 'pulse', type: 'ellipse', transform: { scaleX: { keys: [{ t: { beat: 12 }, v: 1 }, { t: { beat: 12.5 }, v: 2 }], repeat: { every: { beats: 1 }, count: 4 } } } }];
  assert.equal(evaluateScene(scene, 6.125)[0].matrix[0], 1.5);
  scene.tempo.bpm = 100;
  assert.ok(Math.abs(evaluateScene(scene, 7.35)[0].matrix[0] - 1.5) < 1e-10);
  const scaled = applyOps(scene, scaleElementOps(scene, 'pulse', 2));
  const track = scaled.elements[0].transform!.scaleX;
  assert.equal(typeof track === 'object' && track.repeat?.count, 4);
});
test('unit stagger delays entrance but whole-word movement stays simultaneous', () => {
  const scene = textScene();
  const first = evaluateScene(scene, 0.5, measure);
  assert.deepEqual(first.map(e => [e.cx, e.cy]), [[95, 120], [105, 140]]);
  const moved = evaluateScene(scene, 2.5, measure);
  assert.deepEqual(moved.map(e => e.cy), [150, 150]);
  scene.elements[0].stagger!.order = 'reverse';
  assert.deepEqual(evaluateScene(scene, 0.5, measure).map(e => e.cy), [140, 120]);
});
test('split graphemes, word whitespace and opacity use the same hit-test geometry', () => {
  const scene = textScene(); scene.elements[0].text = 'e\u0301👨‍👩‍👧‍👦';
  assert.equal(evaluateScene(scene, 1, measure).length, 2);
  scene.elements[0].text = 'A  B'; scene.elements[0].split = 'word';
  const units = evaluateScene(scene, 0.5, measure);
  assert.deepEqual(units.map(e => e.cy), [120, 140]);
  assert.equal(hitTest(scene, 0.5, units[1].cx, units[1].cy, measure)?.unitIndex, 2);
  scene.elements[0].unitTransform!.opacity = 0;
  assert.equal(hitTest(scene, 0.5, units[1].cx, units[1].cy, measure), null);
});
test('anchor pivot remains fixed through scale and rotation, including parent-space dragging', () => {
  const scene = emptyScene();
  scene.elements = [{ id: 'parent', type: 'group', transform: { x: 50, rotation: 90, scaleX: 2, scaleY: 2 } }, { id: 'child', type: 'rect', parentId: 'parent', anchorX: 10, transform: { x: 20, scaleX: 2, rotation: 90 } }];
  const frame = selectionFrame(scene, 'child', 0, measure)!;
  assert.ok(Math.abs(frame.cx - 50) < 1e-9);
  assert.ok(Math.abs(frame.cy - 40) < 1e-9);
  const moved = applyOps(scene, moveElementOps(scene, 'child', 12, -4, 0));
  const next = selectionFrame(moved, 'child', 0, measure)!;
  assert.ok(Math.abs(next.cx - 62) < 1e-9 && Math.abs(next.cy - 36) < 1e-9);
});
test('validation rejects missing tempo, invalid repeats and tempo-induced key inversion', () => {
  const scene = emptyScene();
  scene.elements = [{ id: 'a', type: 'rect', transform: { x: { keys: [{ t: { beat: 2 }, v: 0 }, { t: 1.5, v: 1 }] } } }];
  assert.ok(validateScene(scene).length);
  scene.tempo = { bpm: 120, offset: 0 }; assert.deepEqual(validateScene(scene), []);
  scene.tempo.bpm = 60; assert.ok(validateScene(scene).length);
  scene.elements[0].transform!.x = { keys: [{ t: 0, v: 1 }, { t: 2, v: 2 }], repeat: { every: 1, count: 2, until: 3 } };
  assert.equal(validateScene(scene).length, 2);
});
test('timeline expands only within bounds and caps pathological repeat counts', () => {
  const scene = textScene();
  assert.deepEqual(timelineKeys(scene.elements[0], scene).times, [0, 0.5, 1, 1.5, 2, 3]);
  scene.elements[0].transform = { x: { keys: [{ t: 0, v: 1 }], repeat: { every: 0.00001 } } };
  assert.equal(timelineKeys(scene.elements[0], scene, 100).truncated, true);
  assert.ok(timelineKeys(scene.elements[0], scene, 100).times.length <= 100);
});
