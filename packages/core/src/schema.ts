// 共通シーン表現（scene.json）のスキーマ。
// UI・サーバー・MCP・描画のすべてがこの定義を唯一の基準として使う。
// 未知のキーはエラーにする（AIの書き間違いを黙って捨てないため）。
import { z } from 'zod';

export const SCHEMA_VERSION = 1;

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

export const SceneSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  duration: z.number().positive(),
  background: z.string(),
  elements: z.array(ElementSchema),
  markers: z.array(MarkerSchema).optional(),
});

/** シーンへの部分更新。MCPとUIの両方がこの形で変更を送る。 */
export const SceneOpSchema = z.discriminatedUnion('op', [
  /** 同じidがあれば丸ごと置換、なければ追加。 */
  z.strictObject({ op: z.literal('upsertElement'), element: ElementSchema }),
  /** 既存要素に上書きマージ。transformはトラック単位でマージ。 */
  z.strictObject({ op: z.literal('patchElement'), id: z.string(), patch: ElementSchema.partial() }),
  z.strictObject({ op: z.literal('removeElement'), id: z.string() }),
  z.strictObject({
    op: z.literal('setSceneProps'),
    props: SceneSchema.pick({ width: true, height: true, fps: true, duration: true, background: true }).partial(),
  }),
  z.strictObject({ op: z.literal('setMarkers'), markers: z.array(MarkerSchema) }),
]);

export type Ease = z.infer<typeof EaseSchema>;
export type Key = z.infer<typeof KeySchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Transform = z.infer<typeof TransformSchema>;
export type SceneElement = z.infer<typeof ElementSchema>;
export type Marker = z.infer<typeof MarkerSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type SceneOp = z.infer<typeof SceneOpSchema>;

/** 入力メディアの情報（project.json の source）。 */
export interface SourceManifest {
  fileName: string;
  sha256: string;
  sizeBytes: number;
  width: number;
  height: number;
  /** ffprobe の r_frame_rate をそのまま保持（例 "30000/1001"）。 */
  frameRate: string;
  fps: number;
  /** ffprobe の avg_frame_rate。r_frame_rate と食い違う場合は可変フレームレートの疑い。 */
  avgFrameRate?: string;
  /** r_frame_rate と avg_frame_rate が1%以上違う（簡易判定）。時刻→フレーム番号の対応が一定でない可能性。 */
  variableFrameRate?: boolean;
  duration: number;
  frameCount: number | null;
  hasAudio: boolean;
  importedAt: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  schemaVersion: number;
  /** 変更のたびに1増える。更新時は baseRevision と一致しないと拒否される。 */
  revision: number;
  createdAt: string;
  updatedAt: string;
  source?: SourceManifest;
}

export interface HistoryEntry {
  revision: number;
  at: string;
  actor: string;
  note: string;
}
