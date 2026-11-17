import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

async function start() {
// Load exactly the registered server font files before measuring or drawing text.
const response = await fetch('/api/fonts');
if (!response.ok) throw new Error('フォント一覧を取得できません');
const { fonts } = await response.json();
await Promise.all(fonts.map(async (font: { family: string; weight: number; url: string }) => {
  const face = new FontFace(font.family, `url(${font.url})`, { weight: String(font.weight) });
  document.fonts.add(await face.load());
}));
createRoot(document.getElementById('root')!).render(<App />);

}
void start().catch(err => {
  document.getElementById('root')!.textContent = `起動できません: ${String(err)}。サーバーの接続とフォント設定を確認して再読み込みしてください。`;
});
