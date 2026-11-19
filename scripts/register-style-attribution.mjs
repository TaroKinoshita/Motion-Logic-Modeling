import assert from 'node:assert/strict';
import {copyFile, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {emptyScene} from '@mlm/core';
import {mediaTarget, probe} from '../apps/server/src/media.ts';
import {saveGeneratedProject} from '../apps/server/src/modeling.ts';
import {commit, createProject, getDocuments, getProject, listProjects, trashProject} from '../apps/server/src/store.ts';
import {saveStyleStudy, StyleStudyRequest} from '../apps/server/src/style-study.ts';

const [reportFile, priorFile] = process.argv.slice(2);
if (!reportFile || !priorFile) throw new Error('Supply attribution report and prior app corpus report');
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const {works, comparisons, robustness, protocol} = await read(reportFile);
const {hostProjectId} = await read(priorFile);
const original = getProject(hostProjectId);
const originalDocs = getDocuments(hostProjectId);
const registry = listProjects();
const actor = 'style-attribution';
const primary = comparisons[0];
const controls = [];
const byHash = new Map(works.map(work => [work.sourceSha256, work]));
const {works: referenceWorks, claims} = originalDocs.style_study;
assert.equal(referenceWorks.length, 7);
assert.ok(referenceWorks.every(work => work.group === 'author' && byHash.get(work.sourceSha256)?.group === 'reference'));

for (const work of works.filter(work => work.group === 'control')) {
  const name = `${work.id} · 作家判定の対照`;
  const match = registry.find(project => project.name === name && project.source?.sha256 === work.sourceSha256);
  if (match) {
    controls.push({work, project: match});
    continue;
  }

  const created = createProject(name, emptyScene(), actor);
  try {
    const media = mediaTarget(created.project.id, work.path);
    await copyFile(work.path, media.file);
    const source = await probe(media.file, media.fileName);
    assert.equal(source.sha256, work.sourceSha256);
    const {project} = commit(created.project.id, {
      baseRevision: created.project.revision, actor, note: '別担当の対照素材を登録',
      meta: draft => { draft.source = source; },
      scene: scene => ({...scene, width: source.width, height: source.height, fps: source.fps, duration: source.duration}),
    });
    controls.push({work, project});
  } catch (error) {
    trashProject(created.project.id, actor);
    throw error;
  }
}

const inputWorks = [
  ...referenceWorks.map(({projectId, revision, group, credit, creditBasis}) => ({projectId, revision, group, credit, creditBasis})),
  ...controls.map(({work, project}) => ({projectId: project.id, revision: project.revision, group: 'control',
    credit: `別担当 ${work.id.slice('LyricOther'.length)}（氏名未提供）`, creditBasis: 'ユーザー申告'})),
];
const name = 'Lyricsample · 対照6本の作家判定';
const match = registry.find(project => project.name === name && project.source?.sha256 === original.project.source.sha256);
const host = match ?? saveGeneratedProject(name, original.scene, hostProjectId, actor, originalDocs).project;
const saved = saveStyleStudy(host.id, StyleStudyRequest.parse({
  baseRevision: host.revision, actor, works: inputWorks,
  claims: claims.map(({id, axis, label, condition, evidence, exceptions, generation}) =>
    ({id, axis, label, condition, evidence, exceptions, generation})),
}));
assert.equal(saved.study.works.length, 13);
assert.equal(saved.study.works.filter(work => work.group === 'control').length, 6);
const output = path.join(path.dirname(reportFile), 'app-study.json');
await writeFile(output, JSON.stringify({hostProjectId: saved.project.id, hostRevision: saved.project.revision,
  study: saved.study, protocol, primary, robustness}, null, 2));
console.log(output, saved.project.id, saved.project.revision, saved.study.works.length);
