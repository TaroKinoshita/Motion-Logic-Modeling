// Curated passages from the reconstructed reference works (docs/45, P1).
// Each passage is a frame window of a reconstructed project and the block groups to reuse.
// Text slots receive new lyrics; shape slots keep their outline. Groups were chosen by Claude from
// on-screen measurements (scripts/list-passage-blocks.mjs) and the source frames; duplicate tracks
// and fragments were left out. Frames are source frames (inclusive).
// Excluded: Lyricsample5 frame-filling glyphs (63-126F). Their reconstructed blocks squash frame to frame,
// so new words became tiny or stretched (checked 2026-11-20, docs/46). Lyricsample3 quick shots (1-90F):
// frames and glyphs share one outline, so the original text would leak; only the rebuilt frame scene is used.

export interface PassageSlot {
  group: string;
  role: 'text' | 'shape';
  /** Reading order of text slots. Tokens are assigned in this order. */
  order?: number;
  /** A later state of another text slot (e.g. the merged result shown for one frame); shows the same token. */
  alias?: number;
}

export interface PassageSpec {
  id: string;
  work: string;
  projectId: string;
  from: number;
  to: number;
  slots: PassageSlot[];
  /** Source frame ranges with a dark background. */
  dark?: [number, number][];
  tags: string[];
  /** What the scene does with its words (docs/50 step 3). Merge scenes are used only for kanji part triples. */
  kind?: 'merge' | 'swap' | 'pair' | 'append' | 'row' | 'cascade' | 'phrase';
  note: string;
}

export const PASSAGES: PassageSpec[] = [
  { id: 'L1-kaku', kind: 'phrase', work: 'Lyricsample1', projectId: 'p_mwm2asd0bxoq', from: 3, to: 26,
    slots: [{ group: 'track:lyrics:1', role: 'text', order: 0 }, { group: 'track:lyrics:10', role: 'text', order: 1 }],
    tags: ['flow', 'squash', 'contact'], note: '一字が流れ込み横につぶれ、二字目が接して入る' },
  { id: 'L1-tacho', kind: 'pair', work: 'Lyricsample1', projectId: 'p_mwm2asd0bxoq', from: 27, to: 70,
    slots: [{ group: 'track:lyrics:20', role: 'text', order: 0 }, { group: 'track:lyrics:21', role: 'text', order: 1 }],
    tags: ['pair', 'hold-first'], note: '二字が並び、後の字が先に消えて最初の字が残る' },
  { id: 'L1-meshi', kind: 'merge', work: 'Lyricsample1', projectId: 'p_mwm2asd0bxoq', from: 71, to: 91,
    slots: [{ group: 'track:lyrics:74', role: 'text', order: 0 }, { group: 'track:lyrics:75', role: 'text', order: 1 },
      { group: 'track:lyrics:88', role: 'text', order: 2 }, { group: 'track:lyrics:83', role: 'text', alias: 2 }],
    dark: [[82, 91]], tags: ['pair', 'merge', 'invert', 'big-result'], note: '二字が並び、1コマで合わさり、反転して大きな一字になる' },
  { id: 'L1-fukakai', kind: 'row', work: 'Lyricsample1', projectId: 'p_mwm2asd0bxoq', from: 160, to: 182,
    slots: [{ group: 'track:lyrics:178', role: 'text', order: 0 }, { group: 'track:lyrics:172', role: 'text', order: 1 },
      { group: 'track:lyrics:177', role: 'text', order: 2 }],
    tags: ['triple', 'tilt'], note: '三字が傾いた並びから揃う' },
  { id: 'L6-yamero', kind: 'phrase', work: 'Lyricsample6', projectId: 'p_mwmxbrhgm497', from: 120, to: 141,
    slots: [{ group: 'review:6:0', role: 'text', order: 0 }],
    tags: ['phrase', 'collective-shrink'], note: '語全体が大きく出て、1コマで約2.5分の1に縮む' },
  { id: 'L7-kakumei', kind: 'pair', work: 'Lyricsample7', projectId: 'p_mwmxc1tivqow', from: 205, to: 221,
    slots: [{ group: 'track:corpus7:184', role: 'text', order: 0 }, { group: 'track:corpus7:189', role: 'text', order: 1 }],
    dark: [[205, 221]], tags: ['pair', 'big'], note: '大きな一字の後に二字目が並ぶ' },
  { id: 'L7-keitou', kind: 'swap', work: 'Lyricsample7', projectId: 'p_mwmxc1tivqow', from: 160, to: 204,
    slots: [{ group: 'track:corpus7:141', role: 'text', order: 0 }, { group: 'track:corpus7:145', role: 'text', order: 1 }],
    dark: [[160, 204]], tags: ['pair', 'big', 'tilt'], note: '大きな二字が傾きを伴って入れ替わる' },
  { id: 'L7-zenya', kind: 'row', work: 'Lyricsample7', projectId: 'p_mwmxc1tivqow', from: 235, to: 242,
    slots: [{ group: 'review:7:6', role: 'text', order: 0 }, { group: 'review:7:7', role: 'text', order: 1 },
      { group: 'review:7:8', role: 'text', order: 2 }, { group: 'review:7:9', role: 'text', order: 3 }],
    dark: [[235, 242]], tags: ['row', 'four'], note: '四字が横一列に並ぶ' },
  { id: 'L4-bar', kind: 'append', work: 'Lyricsample4', projectId: 'p_mwmxcdyz8efl', from: 1, to: 32,
    slots: [{ group: 'review:4:color:0', role: 'text', order: 0 }, { group: 'review:4:color:1', role: 'text', order: 1 },
      { group: 'review:4:shape:bar', role: 'shape' }],
    tags: ['phrase', 'bar', 'append'], note: '帯の上に句が出て、続きの句に置き換わる' },
  { id: 'L4-ring', kind: 'phrase', work: 'Lyricsample4', projectId: 'p_mwmxcdyz8efl', from: 33, to: 56,
    slots: [{ group: 'review:4:color:2', role: 'text', order: 0 }, { group: 'review:4:shape:ring', role: 'shape' }],
    tags: ['phrase', 'big', 'ring'], note: '大きな句と輪が重なる' },
  { id: 'L4-dobun', kind: 'append', work: 'Lyricsample4', projectId: 'p_mwmxcdyz8efl', from: 104, to: 139,
    slots: [{ group: 'review:4:0', role: 'text', order: 0 }, { group: 'review:4:1', role: 'text', order: 1 }],
    tags: ['pair', 'anchor-keep'], note: '先の字を残して次の大きな字が入る' },
  { id: 'L4-arrow', kind: 'phrase', work: 'Lyricsample4', projectId: 'p_mwmxcdyz8efl', from: 148, to: 191,
    slots: [{ group: 'review:4:color:3', role: 'text', order: 0 }, { group: 'review-shot:arrow:149', role: 'shape' },
      { group: 'review-shot:arrow:154', role: 'shape' }, { group: 'review-shot:arrow:169', role: 'shape' },
      { group: 'review-shot:arrow:173', role: 'shape' }, { group: 'review-shot:arrow:176', role: 'shape' }],
    tags: ['phrase', 'arrow'], note: '大きな矢印の上を句が横切る' },
  { id: 'L6-matta', kind: 'phrase', work: 'Lyricsample6', projectId: 'p_mwmxbrhgm497', from: 262, to: 289,
    slots: [{ group: 'review:6:1', role: 'text', order: 0 }],
    tags: ['phrase', 'collective-shrink'], note: '語全体が大きく出て、1コマで約2.5分の1に縮む' },
  { id: 'L2-aozora', kind: 'pair', work: 'Lyricsample2', projectId: 'p_mwmx2avlxwiw', from: 68, to: 90,
    slots: [{ group: 'review:2:0', role: 'text', order: 0 }, { group: 'review:2:1', role: 'text', order: 1 },
      { group: 'review:2:2', role: 'text', alias: 0 }],
    tags: ['small-then-big', 'pair', 'jump-settle'], note: '小さな一字の後、大きな二字が跳んで止まる' },
  { id: 'L1-spread', kind: 'pair', work: 'Lyricsample1', projectId: 'p_mwm2asd0bxoq', from: 93, to: 116,
    slots: [{ group: 'track:lyrics:99', role: 'text', order: 0 }, { group: 'track:lyrics:100', role: 'text', order: 1 }],
    tags: ['pair', 'spread'], note: '二字が左右に離れて並ぶ' },
  { id: 'L3-frame', kind: 'pair', work: 'Lyricsample3', projectId: 'p_mwmxbqmcyr26', from: 94, to: 100,
    slots: [{ group: 'glyph:94:0', role: 'text', order: 0 }, { group: 'glyph:94:1', role: 'text', order: 1 },
      { group: 'frame:94', role: 'shape' }],
    dark: [[94, 100]], tags: ['frame', 'vertical', 'big-small'], note: '縦長の枠の上に大きな字、枠の中に小さな字' },
  { id: 'L6-kandou', kind: 'pair', work: 'Lyricsample6', projectId: 'p_mwmxbrhgm497', from: 181, to: 199,
    slots: [{ group: 'track:corpus6:91', role: 'text', order: 0 }, { group: 'track:corpus6:92', role: 'text', order: 1 }],
    tags: ['big', 'tilt', 'small-then-big'], note: '小さな字の後に大きく傾いた字が入る' },
  { id: 'L6-moudoku', kind: 'pair', work: 'Lyricsample6', projectId: 'p_mwmxbrhgm497', from: 200, to: 217,
    slots: [{ group: 'track:corpus6:96', role: 'text', order: 0 }, { group: 'track:corpus6:95', role: 'text', order: 1 }],
    tags: ['big', 'pair', 'cluster'], note: '大きな二字が斜めに組まれる' },
  { id: 'L6-tokuno', kind: 'swap', work: 'Lyricsample6', projectId: 'p_mwmxbrhgm497', from: 220, to: 255,
    slots: [{ group: 'track:corpus6:107', role: 'text', order: 0 }, { group: 'track:corpus6:109', role: 'text', order: 1 }],
    tags: ['big', 'fill', 'pair'], note: '画面を埋める二字が入れ替わる' },
  { id: 'L6-zenbu', kind: 'pair', work: 'Lyricsample6', projectId: 'p_mwmxbrhgm497', from: 110, to: 119,
    slots: [{ group: 'track:corpus6:65', role: 'text', order: 0 }, { group: 'track:corpus6:66', role: 'text', order: 1 }],
    tags: ['pair'], note: '二字が並ぶ' },
  { id: 'L7-senten', kind: 'pair', work: 'Lyricsample7', projectId: 'p_mwmxc1tivqow', from: 26, to: 34,
    slots: [{ group: 'review:7:0', role: 'text', order: 0 }, { group: 'review:7:1', role: 'text', order: 1 }],
    dark: [[26, 34]], tags: ['big', 'pair'], note: '大きな二字が並ぶ' },
  { id: 'L7-seimei', kind: 'append', work: 'Lyricsample7', projectId: 'p_mwmxc1tivqow', from: 77, to: 90,
    slots: [{ group: 'review:7:2', role: 'text', order: 0 }, { group: 'review:7:3', role: 'text', order: 1 },
      { group: 'review:7:4', role: 'text', order: 2 }],
    dark: [[77, 90]], tags: ['row', 'append'], note: '小さな字が一字ずつ横に足される' },
  { id: 'L2-somaru', kind: 'cascade', work: 'Lyricsample2', projectId: 'p_mwmx2avlxwiw', from: 48, to: 64,
    slots: [{ group: 'track:corpus2:118', role: 'text', order: 0 }, { group: 'track:corpus2:123', role: 'text', order: 1 },
      { group: 'track:corpus2:122', role: 'text', order: 2 }],
    tags: ['vertical', 'cascade', 'big'], note: '大きな字から縦に字が流れ落ちる' },
];
