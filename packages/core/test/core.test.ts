import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyOps,
  demoScene,
  emptyScene,
  evaluateScene,
  hitTest,
  moveElementOps,
  rotateElementOps,
  sampleTrack,
  sampleTrajectory,
  scaleElementOps,
  shiftKeyTimeOps,
  SceneSchema,
  validateScene,
} from '../src/index.ts';

test('sampleTrack: 線形補間と端の保持', () => {
  const track = { keys: [{ t: 1, v: 0 }, { t: 3, v: 100 }] };
  assert.equal(sampleTrack(track, 0, -1), 0);
  assert.equal(sampleTrack(track, 2, -1), 50);
  assert.equal(sampleTrack(track, 9, -1), 100);
  assert.equal(sampleTrack(undefined, 2, 7), 7);
  assert.equal(sampleTrack(42, 2, 7), 42);
});

test('sampleTrack: hold は次のキーまで値を保つ', () => {
  const track = { keys: [{ t: 0, v: 5, ease: 'hold' as const }, { t: 1, v: 9 }] };
  assert.equal(sampleTrack(track, 0.99, 0), 5);
  assert.equal(sampleTrack(track, 1, 0), 9);
});

test('sampleTrack: overshoot は目標値を一度超える', () => {
  const track = { keys: [{ t: 0, v: 0, ease: 'overshoot' as const }, { t: 1, v: 100 }] };
  const max = Math.max(...Array.from({ length: 50 }, (_, i) => sampleTrack(track, i / 50, 0)));
  assert.ok(max > 100);
});

test('evaluateScene: 親の変換が子に合成される', () => {
  const scene = emptyScene();
  scene.elements = [
    { id: 'g', type: 'group', transform: { x: 100, y: 50, rotation: 90 } },
    { id: 'c', type: 'rect', parentId: 'g', transform: { x: 10, y: 0 } },
  ];
  const [c] = evaluateScene(scene, 0);
  assert.equal(c.element.id, 'c');
  assert.ok(Math.abs(c.cx - 100) < 1e-9);
  assert.ok(Math.abs(c.cy - 60) < 1e-9);
});

test('evaluateScene: 表示区間外の要素は返さない', () => {
  const scene = emptyScene();
  scene.elements = [{ id: 'a', type: 'rect', inPoint: 1, outPoint: 2 }];
  assert.equal(evaluateScene(scene, 0.5).length, 0);
  assert.equal(evaluateScene(scene, 1.5).length, 1);
  assert.equal(evaluateScene(scene, 2).length, 0);
});

test('validateScene: 重複・循環・存在しない親を検出', () => {
  const scene = emptyScene();
  scene.elements = [
    { id: 'a', type: 'rect', parentId: 'b' },
    { id: 'b', type: 'rect', parentId: 'a' },
    { id: 'b', type: 'rect', parentId: 'zzz' },
  ];
  const issues = validateScene(scene).join('\n');
  assert.match(issues, /重複/);
  assert.match(issues, /循環/);
  assert.match(issues, /存在しません/);
});

test('applyOps: patchElement は transform をトラック単位でマージし、元を変更しない', () => {
  const scene = demoScene();
  const next = applyOps(scene, [{ op: 'patchElement', id: 'bar1', patch: { fill: '#ff0000', transform: { y: 100 } } }]);
  const bar = next.elements.find((e) => e.id === 'bar1')!;
  assert.equal(bar.fill, '#ff0000');
  assert.equal(bar.transform?.y, 100);
  assert.ok(typeof bar.transform?.x === 'object');
  assert.notEqual(scene.elements[0].fill, '#ff0000');
});

test('hitTest / moveElementOps: 回転した親の子を、シーン座標どおりに動かせる', () => {
  const scene = emptyScene();
  scene.elements = [
    { id: 'g', type: 'group', transform: { x: 100, y: 50, rotation: 90, scaleX: 2, scaleY: 2 } },
    { id: 'c', type: 'rect', parentId: 'g', width: 20, height: 20, transform: { x: { keys: [{ t: 0, v: 10 }, { t: 1, v: 30 }] }, y: 0 } },
  ];
  assert.equal(hitTest(scene, 0, 100, 70)?.element.id, 'c');
  assert.equal(hitTest(scene, 0, 300, 300), null);
  const moved = applyOps(scene, moveElementOps(scene, 'c', 40, -10, 0));
  const [c] = evaluateScene(moved, 0);
  assert.ok(Math.abs(c.cx - 140) < 1e-6 && Math.abs(c.cy - 60) < 1e-6);
  const x = moved.elements[1].transform?.x;
  assert.ok(typeof x === 'object' && x.keys.length === 2 && Math.abs(x.keys[1].v - x.keys[0].v - 20) < 1e-6);
});

test('scale / rotate / shiftKeyTime: キー全体に作用し、隣のキーを追い越さない', () => {
  const scene = demoScene();
  const scaled = applyOps(scene, scaleElementOps(scene, 'burst', 2));
  const sx = scaled.elements.find((e) => e.id === 'burst')!.transform!.scaleX;
  assert.ok(typeof sx === 'object' && sx.keys[0].v === 0.2 && sx.keys[1].v === 12);
  const rotated = applyOps(scene, rotateElementOps(scene, 'bar1', 30));
  assert.equal(rotated.elements[0].transform?.rotation, 30);

  // bar1: x のキーは 0.4 と 1、opacity のキーは 0.4, 0.55, 3.4, 3.5
  const shifted = applyOps(scene, shiftKeyTimeOps(scene, 'bar1', 0.4, 0.9));
  const tr = shifted.elements[0].transform!;
  assert.ok(typeof tr.x === 'object' && tr.x.keys[0].t === 0.9);
  assert.ok(typeof tr.opacity === 'object' && tr.opacity.keys[0].t === 0.549); // 0.55 の手前で止まる
  assert.deepEqual(validateScene(shifted), []);
  assert.deepEqual(shiftKeyTimeOps(scene, 'bar1', 2.2, 3), []);
});

test('sampleTrajectory: 表示区間をフレームごとにサンプルする', () => {
  const scene = demoScene();
  const pts = sampleTrajectory(scene, 'bar1');
  assert.ok(pts.length > 100 && pts.length <= 601);
  assert.equal(pts[0].x, -200);
  assert.ok(Math.abs(pts[pts.length - 1].x - 380) < 1e-6);
});

test('SceneSchema: デモシーンは妥当で、未知のキーは拒否される', () => {
  assert.ok(SceneSchema.safeParse(demoScene()).success);
  assert.deepEqual(validateScene(demoScene()), []);
  const bad = { ...demoScene(), elements: [{ id: 'x', type: 'rect', colour: 'red' }] };
  assert.equal(SceneSchema.safeParse(bad).success, false);
});
