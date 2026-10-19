const BASE = 'http://127.0.0.1:3080/dsh-novel-studio/api';

async function call(path, body) {
  const init = body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

(async () => {
  const cwd = process.argv[2] || process.cwd();
  const created = await call('/project/create', {
    title: '自检作品',
    cwd,
    model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  });
  console.log('create:', JSON.stringify({
    projectId: created.project.projectId,
    sessionId: created.project.sessionId,
    preset: created.project.agentPreset,
    model: created.project.model,
    warning: created.warning,
  }));

  const projectId = created.project.projectId;
  const detail = await call(`/project?projectId=${projectId}`);
  console.log('detail:', JSON.stringify({ chapters: detail.chapters.length, snapshots: detail.snapshots.length, timeline: detail.timeline }));

  const timeline = await call('/project/timeline', { projectId, unitDays: 90, cursor: 0 });
  console.log('timeline:', JSON.stringify(timeline.timeline));

  const outlined = await call('/outline/save', {
    projectId,
    chapterId: '',
    title: '雨夜来客',
    startDay: 0,
    outline: {
      durationDays: 12,
      minWords: 900,
      maxWords: 2400,
      synopsisMinChars: 10,
      synopsis: '暴雨之夜，一名自称旧友的陌生人敲开主角家门。',
    },
  });
  console.log('outline:', JSON.stringify({
    chapterId: outlined.chapter.chapterId,
    title: outlined.chapter.title,
    startDay: outlined.chapter.startDay,
    durationDays: outlined.chapter.durationDays,
    status: outlined.chapter.status,
  }));

  const saved = await call('/chapter/save', { projectId, chapterId: outlined.chapter.chapterId, content: '雨下得很大。门被敲响了三下。' });
  console.log('save:', JSON.stringify({ wordCount: saved.chapter.wordCount, status: saved.chapter.status }));

  const bootstrap = await call('/bootstrap');
  console.log('bootstrap:', JSON.stringify({
    projects: bootstrap.projects.length,
    providers: bootstrap.models.groups.map((group) => group.id),
    presets: bootstrap.presets.map((preset) => preset.id),
    defaultModel: bootstrap.models.default,
  }));

  const removed = await call('/project/delete', { projectId });
  console.log('delete:', JSON.stringify(removed));
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
