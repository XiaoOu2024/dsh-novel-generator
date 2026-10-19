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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function wait(jobId, label) {
  const deadline = Date.now() + 6 * 60 * 1000;
  let job = await call(`/job?id=${encodeURIComponent(jobId)}`);
  while (job.state === 'running' && Date.now() < deadline) {
    await sleep(4000);
    job = await call(`/job?id=${encodeURIComponent(jobId)}`);
    process.stdout.write(`  [${label}] ${job.state} ${job.message || ''}\n`);
  }
  return job;
}

(async () => {
  const cwd = process.argv[2];
  const created = await call('/project/create', {
    title: '大纲推演自检',
    cwd,
    model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  });
  const projectId = created.project.projectId;
  console.log('project', projectId);

  const first = await call('/compose', {
    projectId, startDay: 0, title: '', minWords: 200, maxWords: 600, durationDays: 30,
  });
  const jobOne = await wait(first.jobId, 'compose-new');
  console.log('compose(new):', jobOne.state, jobOne.error || '', JSON.stringify(jobOne.result));

  const chapterId = jobOne.result.chapterId;
  const second = await call('/compose', {
    projectId, chapterId, minWords: 150, maxWords: 400, durationDays: 5,
  });
  const jobTwo = await wait(second.jobId, 'compose-redo');
  console.log('compose(existing):', jobTwo.state, jobTwo.error || '', JSON.stringify(jobTwo.result));

  const detail = await call(`/project?projectId=${projectId}`);
  console.log('detail:', JSON.stringify({
    chapters: detail.chapters.map((c) => ({
      id: c.chapterId, index: c.index, title: c.title, start: c.startDay,
      days: c.durationDays, words: c.wordCount, status: c.status,
      synopsis: (c.outline && c.outline.synopsis || '').slice(0, 40),
    })),
    snapshots: detail.snapshots.map((s) => s.day),
  }, null, 2));

  if (detail.chapters.length !== 1) throw new Error('expected one chapter after regeneration');
  if (detail.chapters[0].chapterId !== chapterId) throw new Error('chapter identity changed');
  if (detail.chapters[0].durationDays !== 5) throw new Error('duration not updated');
  if (!detail.chapters[0].wordCount) throw new Error('no content regenerated');

  await call('/project/delete', { projectId });
  console.log('deleted', projectId);
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
