// 共通シーン表現（scene.json）のスキーマ。
// UI・サーバー・MCP・描画のすべてがこの定義を唯一の基準として使う。
// 未知のキーはエラーにする（AIの書き間違いを黙って捨てないため）。
import { z } from 'zod';

const SCHEMA_VERSION = 1;

/** キーから次のキーまでの区間の補間。cubicは CSS cubic-bezier と同じ4値。 */
export const EaseSchema = z.union([
  z.enum(['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut', 'overshoot', 'anticipate']),
  z.strictObject({ cubic: z.tuple([z.number(), z.number(), z.number(), z.number()]) }),
]);

export const KeySchema = z.strictObject({
  /** 秒。シーン先頭からの絶対時刻。拍などに丸めない。 */
  t: z.number(),
  v: z.number(),
  ease: EaseSchema.optional(),
});

/** 数値なら固定値、keysならキーフレーム。 */
export const TrackSchema = z.union([z.number(), z.strictObject({ keys: z.array(KeySchema).min(1) })]);

export const TransformSchema = z.strictObject({
  /** 要素中心の位置（px）。親がある場合は親のローカル座標。 */
  x: TrackSchema.optional(),
  y: TrackSchema.optional(),
  scaleX: TrackSchema.optional(),
  scaleY: TrackSchema.optional(),
  /** 度。時計回りが正。 */
  rotation: TrackSchema.optional(),
  /** 0..1。親からは継承しない（AEと同じ扱い）。 */
  opacity: TrackSchema.optional(),
});

export const ElementSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().optional(),
  /** group は描画されない変換の親（AEのヌル相当）。 */
  type: z.enum(['rect', 'ellipse', 'text', 'group']),
  parentId: z.string().optional(),
  /** 表示区間（秒）。省略時は 0 〜 scene.duration。 */
  inPoint: z.number().optional(),
  outPoint: z.number().optional(),
  zIndex: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  cornerRadius: z.number().optional(),
  fill: z.string().optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),
  text: z.string().optional(),
  fontSize: z.number().optional(),
  fontWeight: z.number().optional(),
  transform: TransformSchema.optional(),
  /** 元映像のどの要素を置き換えたか等の自由記述。 */
  note: z.string().optional(),
});

export const MarkerSchema = z.strictObject({
  t: z.number(),
  kind: z.enum(['cut', 'beat', 'downbeat', 'section', 'note']),
  label: z.string().optional(),
  /** 計測・推定・人手のどれ由来か。推定値を事実として扱わないため。 */
  origin: z.enum(['measured', 'estimated', 'manual']).optional(),
});

export const SceneV1Schema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  duration: z.number().positive(),
  background: z.string(),
  elements: z.array(ElementSchema),
  markers: z.array(MarkerSchema).optional(),
});

