import {useState} from 'react';
import {api} from './api.ts';

export function LyricPlanner({id,revision,duration,onError}:{id:string;revision:number;duration:number;onError:(error:unknown)=>void}) {
  const [busy,setBusy]=useState(false);
  const [created,setCreated]=useState<string>();
  const [result,setResult]=useState<Awaited<ReturnType<typeof api.planLyrics>>>();
  const initial={name:'歌詞から構成',alignment:'estimated',minFontHeight:.045,continuity:'auto',
    lines:[{from:0,to:Math.min(duration,2),tokens:[{text:'風',at:0,emphasis:true},{text:'をほどいて',at:Math.min(.4,duration/4)}]}]};
  return <details><summary>歌詞と時刻から構成を生成</summary>
    <p>行と語の時刻・強調を指定します（秒）。まずブロックの動きを作り、その親グループに文字を載せます。</p>
    <form key={id} onSubmit={async event=>{
      event.preventDefault();
      const fields=new FormData(event.currentTarget);
      setBusy(true);
      setResult(undefined);
      setCreated(undefined);
      try {
        const result=await api.planLyrics(id,{...JSON.parse(String(fields.get('plan'))),baseRevision:revision});
        setCreated(result.project.id);
        setResult(result);
      } catch(error) {onError(error);}
      finally {setBusy(false);}
    }}>
      <textarea name="plan" rows={10} defaultValue={JSON.stringify(initial,null,2)} aria-label="歌詞と表示時刻"/>
      <button disabled={busy}>{busy?'生成中':'ブロッキングと文字版を生成'}</button>
    </form>
    {created&&<a href={'#'+created}>生成したプロジェクトを開く</a>}
    {result&&<>
      <p><a href={'#'+result.blocking.project.id}>① ブロッキングを開いて確認・編集</a> → <a href={'#'+result.project.id}>② 文字を載せた版を開く</a></p>
      <p>{result.audit.checkedFrames}コマを検査。文字の重なり{result.audit.overlaps}件、画面外{result.audit.outside}件。</p>
      <table><thead><tr><th>行</th><th>構図</th><th>動き</th><th>受け渡し・注意</th></tr></thead>
        <tbody>{result.decisions.map(row=><tr key={row.line}><td>{row.line}</td><td>{({side:'左右',stack:'上下',stair:'段階',reading:'読む順'} as Record<string,string>)[row.selected]??row.selected}</td>
          <td>{({'cut-and-hold':'切り替えて保持','settle-up':'下から収束','slide-settle':'横から収束'} as Record<string,string>)[row.motion]??row.motion}</td>
          <td>{row.carryReason}{row.readingWarnings.map(warning=><p key={warning}>{warning}</p>)}</td></tr>)}</tbody></table>
    </>}
    <p>ブロッキングの編集後は、そのプロジェクトを開いた状態で下の操作を使います。動きの親グループを引き継いだ別プロジェクトを作ります。</p>
    <button disabled={busy} onClick={async()=>{
      setBusy(true);
      try {
        const dressed=await api.dressLyrics(id,{baseRevision:revision,name:'ブロッキングから文字を適用'});
        setResult(undefined);setCreated(dressed.project.id);
      } catch(error){onError(error);} finally {setBusy(false);}
    }}>現在のブロッキングに文字を載せる</button>
  </details>;
}
