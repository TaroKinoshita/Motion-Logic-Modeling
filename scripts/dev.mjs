// サーバー(4517)とVite(5173)を同時に起動する開発用スクリプト。
// MCPアダプターが先にサーバーを自動起動している場合は、それをそのまま使い Vite だけ起動する。
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const port = process.env.MLM_PORT ?? 4517;

const alreadyRunning = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })
  .then((r) => r.ok)
  .catch(() => false);

const procs = [];
if (alreadyRunning) {
  console.log(`[dev] ポート ${port} で Motion Logic サーバーが起動済みなので、それを使います。`);
  console.log('[dev] サーバーのコードを変更したときは `npm run stop` で止めてから起動し直してください。');
} else {
  procs.push(spawn(process.execPath, ['--watch', 'apps/server/src/index.ts'], { cwd: root, stdio: 'inherit' }));
}
procs.push(
  spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js')], {
    cwd: path.join(root, 'apps/web'),
    stdio: 'inherit',
  }),
);

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', stop);
