import fs from 'node:fs';
import path from 'node:path';
import { GlobalFonts } from '@napi-rs/canvas';
import type { Scene } from '@mlm/core';

// Explicit allowlist: never resolve a filesystem path supplied in scene JSON.
const root = path.join(process.env.WINDIR ?? 'C:/Windows', 'Fonts');
export const fonts = [
  { id: 'arial-400', family: 'MLM Arial', weight: 400, path: path.join(root, 'arial.ttf') },
  { id: 'arial-700', family: 'MLM Arial', weight: 700, path: path.join(root, 'arialbd.ttf') },
].filter(f => fs.existsSync(f.path) && GlobalFonts.registerFromPath(f.path, f.family));

export function checkFonts(scene: Scene): void {
  for (const el of scene.elements) if (el.fontFamily && !fonts.some(f => f.family === el.fontFamily && f.weight === (el.fontWeight ?? 700))) {
    throw new Error(`フォント未登録: ${el.fontFamily} / ${el.fontWeight ?? 700}（GET /api/fontsで確認）`);
  }
}
