import type { Blocking, HistoryEntry, ProjectMeta, Scene, SceneOp } from '@mlm/core';

export interface ProjectData {
  project: ProjectMeta;
  scene: Scene;
}

export interface ExportResult {
  url: string;
  path: string;
  revision: number;
  frameCount: number;
  hasAudio: boolean;
}
export interface BlockJob {
  id:string;
  state:'queued'|'measuring'|'saving'|'exporting'|'done'|'cancelled'|'failed';
  operation:'measure'|'export';
  revision?:number;
  error?:string;
  progress?:number;
  output?:ExportResult;
}

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText, json.detail);
  return json as T;
}

const post = <T>(url: string, body: unknown) =>
  request<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  listProjects: () => request<{ projects: ProjectMeta[] }>('/api/projects'),
  createProject: (name: string, template: 'empty' | 'demo') => post<ProjectData>('/api/projects', { name, template }),
  getProject: (id: string) => request<ProjectData>(`/api/projects/${id}`),
  updateScene: (id: string, baseRevision: number, ops: SceneOp[], note: string) =>
    post<ProjectData>(`/api/projects/${id}/scene`, { baseRevision, ops, note, actor: 'human' }),
  importPath: (id: string, path: string) => post<ProjectData>(`/api/projects/${id}/media`, { path }),
  upload: (id: string, file: File) =>
    request<ProjectData>(`/api/projects/${id}/media/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
    }),
  exportVideo: (id: string, body: { layout: 'render' | 'compare'; from?: number; to?: number }) =>
    post<ExportResult>(`/api/projects/${id}/export`, body),
  deleteProject: (id: string) => request<{ trashedTo: string }>(`/api/projects/${id}`, { method: 'DELETE' }),
  waveform: (id: string) => request<{ duration: number; peaks: number[] }>(`/api/projects/${id}/waveform`),
  detectCuts: (id: string, baseRevision: number, threshold: number) =>
    post<{ cuts: Array<{ t: number; score: number }> }>(`/api/projects/${id}/detect-cuts`, { baseRevision, threshold }),
  history: (id: string) => request<{ history: HistoryEntry[] }>(`/api/projects/${id}/history`),
  revert: (id: string, toRevision: number, baseRevision: number) =>
    post<ProjectData>(`/api/projects/${id}/revert`, { toRevision, baseRevision }),
  analyzeBlocking: (id:string,baseRevision:number,options:Record<string,unknown>)=>
    post<BlockJob>(`/api/projects/${id}/blocking/analyze`,{baseRevision,...options}),
  exportBlocking: (id:string,baseRevision:number)=>post<BlockJob>(`/api/projects/${id}/blocking/export-job`,{baseRevision}),
  blockingJob: (id:string,job:string)=>request<BlockJob>(`/api/projects/${id}/blocking/jobs/${job}`),
  latestBlockingJob: (id:string)=>request<{job:BlockJob|null}>(`/api/projects/${id}/blocking/jobs/latest`),
  cancelBlocking: (id:string,job:string)=>post<BlockJob>(`/api/projects/${id}/blocking/jobs/${job}/cancel`,{}),
  retryBlocking: (id:string,job:string)=>post<BlockJob>(`/api/projects/${id}/blocking/jobs/${job}/retry`,{}),
  editBlocking: (id:string,baseRevision:number,edit:Record<string,unknown>)=>
    post<ProjectData & {design:Blocking}>(`/api/projects/${id}/blocking/edit`,{baseRevision,edit}),
  documents: (id:string)=>request<{observations?:Record<string,unknown>;hypotheses?:unknown;motion_rules?:unknown;adaptation?:unknown}>(`/api/projects/${id}/documents`),
  runModel: (id:string,operation:'measure-events'|'observe-glyphs'|'model'|'variant'|'music'|'adapt'|'adapt-baselines',body:unknown)=>
    post<ProjectData>(`/api/projects/${id}/${operation}`,body),
  generateBaselines: (id:string,body:unknown)=>post<{projects:ProjectData[]}>(`/api/projects/${id}/adapt-baselines`,body),
};
