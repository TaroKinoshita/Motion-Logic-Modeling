import { useEffect, useState } from 'react';
import { ElementSchema, snapElementTimesOps } from '@mlm/core';
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
  const [busyLabel, setBusyLabel] = useState('');
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

  const importMedia = async (run: () => Promise<ProjectData>, label = '取り込み中…') => {
    setBusyLabel(label);
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
        <h3>テンポ</h3>
        <label>BPM <input type="number" min={1} defaultValue={scene.tempo?.bpm ?? 120} key={`bpm-${project.revision}`} onBlur={e => {
          const bpm = Number(e.currentTarget.value);
          if (bpm > 0 && bpm !== scene.tempo?.bpm) void onApply([{ op: 'setSceneProps', props: { tempo: { bpm, offset: scene.tempo?.offset ?? 0 } } }], 'テンポを変更');
        }} /></label>
        <p className="dim">拍で指定した動きが追従します。元動画と音声の速度は変わりません。</p>
      </section>
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
        {busy && <p className="dim">{busyLabel}</p>}
        {project.source && (
          <div className="line">
            <button disabled={busy} onClick={() => importMedia(async () => {
              const response = await fetch(`/api/projects/${project.id}/detect-beats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision: project.revision, actor: 'human' }) });
              const result = await response.json(); if (!response.ok) throw new Error(result.error);
              return api.getProject(project.id);
            }, '拍を解析中…')}>拍を推定</button>
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
            <div className="line">
              <button onClick={()=>void onApply(snapElementTimesOps(scene,selected.id,'frame'),'選択要素の秒時刻をフレーム境界へ吸着')}>時刻→フレーム</button>
              <button title="±1フレーム以内のカットへ秒指定のキーと表示区間を合わせる。拍指定は保持。" onClick={()=>void onApply(snapElementTimesOps(scene,selected.id,'cut'),'選択要素の秒時刻を近くのカットへ吸着')}>時刻→近くのカット</button>
            </div>
            {selected.type === 'text' && <div className="line">
              <label>書体 <select value={selected.fontFamily??''} onChange={e=>{
                const element={...selected};
                if(e.target.value) element.fontFamily=e.target.value; else delete element.fontFamily;
                void onApply([{op:'upsertElement',element}],'書体を変更');
              }}><option value="">既定</option>{[...new Set(Array.from(document.fonts).filter(font=>font.status==='loaded'&&font.weight===String(selected.fontWeight??700)).map(font=>font.family))].map(family=><option key={family} value={family}>{family.replace(/^MLM /,'')}</option>)}</select></label>
              <form className="line" key={`spacing-${selected.id}-${project.revision}`} onSubmit={e=>{
                e.preventDefault();
                const raw=new FormData(e.currentTarget).get('spacing');
                if(typeof raw!=='string'||raw==='') return;
                const letterSpacing=Number(raw);
                if(Number.isFinite(letterSpacing)&&letterSpacing!==(selected.letterSpacing??0)) void onApply([{op:'patchElement',id:selected.id,patch:{letterSpacing,split:selected.split??'char'}}],'字間を変更（未分割は文字分割へ）');
              }}><label>字間(px)<input name="spacing" type="number" step="any" defaultValue={selected.letterSpacing??0}/></label><button type="submit">字間を適用</button></form>
              <label>分割 <select value={selected.split ?? ''} onChange={e => {
                const element = { ...selected };
                if (e.currentTarget.value) element.split = e.currentTarget.value as 'char' | 'word';
                else { delete element.split; delete element.stagger; delete element.unitTransform; delete element.letterSpacing; }
                void onApply([{ op: 'upsertElement', element }], '文字分割を変更');
              }}><option value="">なし</option><option value="char">文字</option><option value="word">単語</option></select></label>
              {selected.split && <label>時間差（秒）<input type="number" min={0} step={0.01}
                key={`stagger-${project.revision}`}
                disabled={typeof selected.stagger?.interval === 'object'}
                defaultValue={typeof selected.stagger?.interval === 'number' ? selected.stagger.interval : 0}
                onBlur={e => { const interval = Number(e.currentTarget.value); if (interval >= 0) void onApply([{ op: 'patchElement', id: selected.id, patch: { stagger: { ...selected.stagger, interval } } }], '文字の時間差を変更'); }} /></label>}
            </div>}
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
        <h3>推定マーカー</h3>
        {(scene.markers ?? []).some(m => m.origin === 'estimated') ? <>
          <button onClick={() => void onApply([{ op: 'setMarkers', markers: (scene.markers ?? []).filter(m => m.origin !== 'estimated') }], '推定マーカーを一括削除')}>推定分をすべて削除</button>
          <ul className="history">{(scene.markers ?? []).map((m, index) => m.origin === 'estimated' && <li key={index}>
            <span>{m.kind} {m.t.toFixed(3)}秒 {m.label ?? ''}</span>
            <button onClick={() => void onApply([{ op: 'setMarkers', markers: (scene.markers ?? []).map((item, i) => i === index ? { ...item, origin: 'manual' } : item) }], `推定${m.kind} ${m.t}秒を確定`)}>確定</button>
            <button onClick={() => void onApply([{ op: 'setMarkers', markers: (scene.markers ?? []).filter((_, i) => i !== index) }], `推定${m.kind} ${m.t}秒を却下`)}>却下</button>
          </li>)}</ul>
        </> : <p className="dim">確認待ちの推定マーカーはありません。</p>}
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
