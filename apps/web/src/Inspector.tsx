import { useEffect, useState } from 'react';
import { ElementSchema } from '@mlm/core';
import type { HistoryEntry, SceneOp } from '@mlm/core';
import { api } from './api.ts';
import type { ProjectData } from './api.ts';

interface Props {
  data: ProjectData;
  history: HistoryEntry[];
  selectedId: string | null;
  onApply: (ops: SceneOp[], note: string) => Promise<void>;
  onAddRect: () => void;
  onSelect: (id: string | null) => void;
  onImported: (data: ProjectData) => void;
  onRevert: (revision: number) => void;
  onDetectCuts: (threshold: number) => void;
  onError: (err: unknown) => void;
}

/** 右パネル。元動画の取り込み、選択要素の編集（当面はJSON直接編集）、履歴。 */
export function Inspector({ data, history, selectedId, onApply, onAddRect, onSelect, onImported, onRevert, onDetectCuts, onError }: Props) {
  const { project, scene } = data;
  const selected = scene.elements.find((e) => e.id === selectedId) ?? null;
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [threshold, setThreshold] = useState(10);

  useEffect(() => {
    setDraft(selected ? JSON.stringify(selected, null, 2) : '');
    setDraftError('');
    // リビジョンが変わったら（AIの変更など）編集欄も最新に合わせる。
  }, [selectedId, project.revision]);

  const applyDraft = () => {
    try {
      const parsed = ElementSchema.safeParse(JSON.parse(draft));
      if (!parsed.success) {
        setDraftError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
        return;
      }
      const ops: SceneOp[] = [];
      if (selected && parsed.data.id !== selected.id) ops.push({ op: 'removeElement', id: selected.id });
      ops.push({ op: 'upsertElement', element: parsed.data });
      void onApply(ops, `要素 ${parsed.data.id} を編集`);
      onSelect(parsed.data.id);
    } catch (err) {
      setDraftError(`JSONとして読めません: ${(err as Error).message}`);
    }
  };

  const importMedia = async (run: () => Promise<ProjectData>) => {
    setBusy(true);
    try {
      onImported(await run());
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="inspector">
      <section>
        <h3>元動画</h3>
        {project.source ? (
          <p className="dim">
            {project.source.width}×{project.source.height}　{project.source.frameRate} fps　{project.source.duration.toFixed(3)} 秒
            {project.source.hasAudio ? '　音声あり' : '　音声なし'}
          </p>
        ) : (
          <p className="dim">未取り込み</p>
        )}
        <div className="line">
          <input placeholder="動画ファイルの絶対パス" value={path} onChange={(e) => setPath(e.target.value)} />
          <button disabled={busy || !path} onClick={() => importMedia(() => api.importPath(project.id, path))}>
            取り込む
          </button>
        </div>
        <input
          type="file"
          accept="video/*"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importMedia(() => api.upload(project.id, file));
          }}
        />
        {busy && <p className="dim">取り込み中…</p>}
        {project.source && (
          <div className="line">
            <button onClick={() => onDetectCuts(threshold)} title="画面全体の変化量からカット候補を推定してマーカーを置く。フラッシュや強い動きも拾う">
              カット候補を検出
            </button>
            <label className="dim">
              しきい値{' '}
              <input
                type="number"
                min={1}
                max={100}
                value={threshold}
                onChange={(e) => setThreshold(Math.min(100, Math.max(1, Number(e.target.value) || 10)))}
                style={{ width: 60 }}
              />
            </label>
          </div>
        )}
      </section>

      <section>
        <h3>
          要素
          <button onClick={onAddRect}>矩形を追加</button>
        </h3>
        {selected ? (
          <>
            <textarea value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
            {draftError && <pre className="error">{draftError}</pre>}
            <div className="line">
              <button onClick={applyDraft}>適用</button>
              <button
                onClick={() => {
                  void onApply([{ op: 'removeElement', id: selected.id }], `要素 ${selected.id} を削除`);
                  onSelect(null);
                }}
              >
                削除
              </button>
            </div>
          </>
        ) : (
          <p className="dim">タイムラインの行をクリックすると編集できます。</p>
        )}
      </section>

      <section>
        <h3>履歴</h3>
        <ul className="history">
          {[...history].reverse().map((h) => (
            <li key={h.revision}>
              <span>
                r{h.revision} <b className={h.actor === 'human' ? '' : 'ai'}>{h.actor}</b> {h.note}
              </span>
              {h.revision !== project.revision && <button onClick={() => onRevert(h.revision)}>戻す</button>}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
