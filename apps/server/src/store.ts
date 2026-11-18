// プロジェクトのディスク保存。リビジョン付きで、UIとMCPの両方がここを通って読み書きする。
//
//   data/projects/<id>/project.json   メタ情報・現在のリビジョン・入力メディア情報
//   data/projects/<id>/scene.json     現在のシーン
//   data/projects/<id>/history/       リビジョンごとのシーンの控え（巻き戻し用）
//   data/projects/<id>/media/         取り込んだ元動画
//   data/projects/<id>/cache/         抽出フレームなど再生成できるもの
import { checkFonts } from './fonts.ts';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { SCHEMA_VERSION, migrateScene, validateScene } from '@mlm/core';
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
  replaceFile(tmp,file);
}

const fileRetry=new Int32Array(new SharedArrayBuffer(4));
function replaceFile(tmp:string,file:string) {
  for(let i=0;;i++) {
    try {fs.renameSync(tmp,file);return;}
    catch(error) {
      if(i>=7||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')) throw error;
      Atomics.wait(fileRetry,0,0,10*(i+1));
    }
  }
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export const DOCUMENT_NAMES = ['observations', 'hypotheses', 'motion_rules', 'simplification', 'adaptation', 'blocks', 'events', 'appearance', 'style_study'] as const;
export type ProjectDocuments = Partial<Record<typeof DOCUMENT_NAMES[number], unknown>>;
type RevisionSnapshot=HistoryEntry & {scene:Scene;documents?:ProjectDocuments;media?:{source?:ProjectMeta['source'];audioAnalysis?:ProjectMeta['audioAnalysis']}};
const revisionFile=(dir:string,revision:number)=>path.join(dir,'history',`r${String(revision).padStart(6,'0')}.json`);
function readRevision(file:string):RevisionSnapshot {
  if(fs.existsSync(file)) return readJson<RevisionSnapshot>(file);
  return JSON.parse(gunzipSync(fs.readFileSync(`${file}.gz`)).toString('utf8')) as RevisionSnapshot;
}
/** History is authoritative, so documents and scene are read at the same revision. */
export function getDocuments(id: string): ProjectDocuments {
  const dir=projectDir(id);
  const project=readProjectMeta(dir,id);
  return readRevision(revisionFile(dir,project.revision)).documents??{};
}

export function getEvidenceSnapshot(id:string,revision:number) {
  const {project,snapshot}=getRevisionSnapshot(id,revision);
  return {title:project.name,sourceSha256:snapshot.media?.source?.sha256,observations:snapshot.documents?.observations as Record<string,unknown>??{}};
}

export function getRevisionSnapshot(id:string,revision:number) {
  const dir=projectDir(id);
  const project=readProjectMeta(dir,id);
  const file=revisionFile(dir,revision);
  if(revision>project.revision||(!fs.existsSync(file)&&!fs.existsSync(`${file}.gz`))) throw new HttpError(422,`参照するリビジョンがありません: ${id} r${revision}`);
  const snapshot=readRevision(file);
  return {project,snapshot};
}

/** スキーマ検査と整合性検査を通ったシーンだけを返す。 */
export function checkScene(input: unknown): Scene {
  let scene: Scene;
  try { scene = migrateScene(input); }
  catch (err) { throw new HttpError(422, 'シーンがスキーマに合いません', String(err)); }
  try { checkFonts(scene); } catch (err) { throw new HttpError(422, String(err)); }
  const issues = validateScene(scene);
  if (issues.length) throw new HttpError(422, 'シーンの整合性に問題があります', issues);
  return scene;
}

export function listProjects(): ProjectMeta[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((id) => fs.existsSync(path.join(PROJECTS_DIR, id, 'project.json')))
    .map((id) => readJson<ProjectMeta>(path.join(PROJECTS_DIR, id, 'project.json')))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function readProjectMeta(dir:string,id:string):ProjectMeta {
  if (!fs.existsSync(path.join(dir, 'project.json'))) throw new HttpError(404, `プロジェクト ${id} がありません`);
  return readJson<ProjectMeta>(path.join(dir,'project.json'));
}
export function getProject(id: string): { project: ProjectMeta; scene: Scene } {
  const dir=projectDir(id);
  const project=readProjectMeta(dir,id);
  return {project,scene:checkScene(readRevision(revisionFile(dir,project.revision)).scene)};
}

function writeRevision(dir: string, project: ProjectMeta, scene: Scene, actor: string, note: string, documents: ProjectDocuments = {}): void {
  const entry: HistoryEntry = { revision: project.revision, at: project.updatedAt, actor, note };
  const snapshot:RevisionSnapshot={...entry,scene,documents,media:{source:project.source,audioAnalysis:project.audioAnalysis}};
  const archive=revisionFile(dir,project.revision);
  const encoded=JSON.stringify(snapshot);
  if(Buffer.byteLength(encoded)>128*1024) {
    fs.writeFileSync(`${archive}.gz.tmp`,gzipSync(encoded,{level:3}));
    replaceFile(`${archive}.gz.tmp`,`${archive}.gz`);
    fs.rmSync(archive,{force:true});
  } else {
    writeJson(archive,snapshot);
    fs.rmSync(`${archive}.gz`,{force:true});
  }
  // Human-readable mirrors; readers use the revision snapshot above, not these files.
  for (const name of DOCUMENT_NAMES) {
    const file=path.join(dir, `${name}.json`);
    if(documents[name]!==undefined) writeJson(file,documents[name]);
    else fs.rmSync(file,{force:true});
  }
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
  documents?: (current: ProjectDocuments) => ProjectDocuments;
}

/** 変更を1リビジョンとして確定する。ファイル操作は同期なので他の変更と混ざらない。 */
export function commit(id: string, input: CommitInput): { project: ProjectMeta; scene: Scene } {
  const { project, scene } = getProject(id);
  const documents = getDocuments(id);
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
  project.schemaVersion = SCHEMA_VERSION;
  project.revision += 1;
  project.updatedAt = new Date().toISOString();
  const nextDocuments = input.documents ? input.documents(documents) : documents;
  writeRevision(projectDir(id), project, next, input.actor, input.note, nextDocuments);
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
  const project=readProjectMeta(projectDir(id),id);
  return fs
    .readdirSync(dir)
    .filter(f=>/^r\d+\.json(?:\.gz)?$/.test(f)&&Number(/^r(\d+)/.exec(f)?.[1])<=project.revision)
    .sort()
    .map((f) => {
      const { revision, at, actor, note } = readRevision(path.join(dir, f.replace(/\.gz$/,'')));
      return { revision, at, actor, note };
    });
}

/** 過去のリビジョンのシーンを、新しいリビジョンとして復元する（履歴は消さない）。 */
export function revertTo(id: string, toRevision: number, baseRevision: number | null, actor: string) {
  const file=revisionFile(projectDir(id),toRevision);
  if(toRevision>readProjectMeta(projectDir(id),id).revision||(!fs.existsSync(file)&&!fs.existsSync(`${file}.gz`))) throw new HttpError(404,`リビジョン ${toRevision} の控えがありません`);
  const old=readRevision(file);
  return commit(id,{baseRevision,actor,note:`リビジョン ${toRevision} に戻す`,scene:()=>old.scene,documents:()=>old.documents??{},
    meta:old.media?project=>{project.source=old.media!.source;project.audioAnalysis=old.media!.audioAnalysis;}:undefined});
}
