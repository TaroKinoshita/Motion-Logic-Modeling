// プロジェクトのディスク保存。リビジョン付きで、UIとMCPの両方がここを通って読み書きする。
//
//   data/projects/<id>/project.json   メタ情報・現在のリビジョン・入力メディア情報
//   data/projects/<id>/scene.json     現在のシーン
//   data/projects/<id>/history/       リビジョンごとのシーンの控え（巻き戻し用）
//   data/projects/<id>/media/         取り込んだ元動画
//   data/projects/<id>/cache/         抽出フレームなど再生成できるもの
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, SceneSchema, validateScene } from '@mlm/core';
import type { HistoryEntry, ProjectMeta, Scene } from '@mlm/core';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
export const DATA_DIR = path.resolve(process.env.MLM_DATA_DIR ?? path.join(REPO_ROOT, 'data'));
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

export class HttpError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export interface ChangeEvent {
  projectId: string;
  revision: number;
  actor: string;
}
export const events = new EventEmitter();

export function projectDir(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpError(400, `不正なプロジェクトID: ${id}`);
  return path.join(PROJECTS_DIR, id);
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** スキーマ検査と整合性検査を通ったシーンだけを返す。 */
export function checkScene(input: unknown): Scene {
  const parsed = SceneSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(422, 'シーンがスキーマに合いません', parsed.error.issues);
  }
  const issues = validateScene(parsed.data);
  if (issues.length) throw new HttpError(422, 'シーンの整合性に問題があります', issues);
  return parsed.data;
}

export function listProjects(): ProjectMeta[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((id) => fs.existsSync(path.join(PROJECTS_DIR, id, 'project.json')))
    .map((id) => readJson<ProjectMeta>(path.join(PROJECTS_DIR, id, 'project.json')))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getProject(id: string): { project: ProjectMeta; scene: Scene } {
  const dir = projectDir(id);
  if (!fs.existsSync(path.join(dir, 'project.json'))) throw new HttpError(404, `プロジェクト ${id} がありません`);
  return {
    project: readJson<ProjectMeta>(path.join(dir, 'project.json')),
    scene: readJson<Scene>(path.join(dir, 'scene.json')),
  };
}

function writeRevision(dir: string, project: ProjectMeta, scene: Scene, actor: string, note: string): void {
  const entry: HistoryEntry = { revision: project.revision, at: project.updatedAt, actor, note };
  writeJson(path.join(dir, 'history', `r${String(project.revision).padStart(6, '0')}.json`), { ...entry, scene });
  writeJson(path.join(dir, 'scene.json'), scene);
  writeJson(path.join(dir, 'project.json'), project);
  events.emit('change', { projectId: project.id, revision: project.revision, actor } satisfies ChangeEvent);
}

export function createProject(name: string, scene: Scene, actor: string): { project: ProjectMeta; scene: Scene } {
  const id = `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = projectDir(id);
  for (const sub of ['history', 'media', 'cache']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const now = new Date().toISOString();
  const project: ProjectMeta = { id, name, schemaVersion: SCHEMA_VERSION, revision: 1, createdAt: now, updatedAt: now };
  const checked = checkScene(scene);
  writeRevision(dir, project, checked, actor, 'プロジェクト作成');
  return { project, scene: checked };
}

export interface CommitInput {
  /** 呼び出し側が読んだ時点のリビジョン。現在値と違えば 409。null は検査なし（サーバー内部処理用）。 */
  baseRevision: number | null;
  actor: string;
  note: string;
  scene?: (current: Scene) => Scene;
  meta?: (current: ProjectMeta) => void;
}

/** 変更を1リビジョンとして確定する。ファイル操作は同期なので他の変更と混ざらない。 */
export function commit(id: string, input: CommitInput): { project: ProjectMeta; scene: Scene } {
  const { project, scene } = getProject(id);
  if (input.baseRevision !== null && input.baseRevision !== project.revision) {
    throw new HttpError(
      409,
      `リビジョンが古いです（送信 ${input.baseRevision} / 現在 ${project.revision}）。最新を読み直してから変更してください`,
      { currentRevision: project.revision },
    );
  }
  let next: Scene;
  try {
    next = checkScene(input.scene ? input.scene(scene) : scene);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(422, (err as Error).message);
  }
  input.meta?.(project);
  project.revision += 1;
  project.updatedAt = new Date().toISOString();
  writeRevision(projectDir(id), project, next, input.actor, input.note);
  return { project, scene: next };
}

/** プロジェクトを data/trash/ へ移す（完全には消さない。フォルダを戻せば復元できる）。 */
export function trashProject(id: string, actor: string): { trashedTo: string } {
  getProject(id);
  const trash = path.join(DATA_DIR, 'trash');
  fs.mkdirSync(trash, { recursive: true });
  const target = path.join(trash, `${id}_${Date.now().toString(36)}`);
  fs.renameSync(projectDir(id), target);
  events.emit('change', { projectId: id, revision: -1, actor } satisfies ChangeEvent);
  return { trashedTo: target };
}

export function listHistory(id: string): HistoryEntry[] {
  const dir = path.join(projectDir(id), 'history');
  getProject(id);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const { revision, at, actor, note } = readJson<HistoryEntry>(path.join(dir, f));
      return { revision, at, actor, note };
    });
}

/** 過去のリビジョンのシーンを、新しいリビジョンとして復元する（履歴は消さない）。 */
export function revertTo(id: string, toRevision: number, baseRevision: number | null, actor: string) {
  const file = path.join(projectDir(id), 'history', `r${String(toRevision).padStart(6, '0')}.json`);
  if (!fs.existsSync(file)) throw new HttpError(404, `リビジョン ${toRevision} の控えがありません`);
  const old = readJson<{ scene: Scene }>(file).scene;
  return commit(id, { baseRevision, actor, note: `リビジョン ${toRevision} に戻す`, scene: () => old });
}
