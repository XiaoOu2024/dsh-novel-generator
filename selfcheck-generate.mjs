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

(async () => {
  const cwd = process.argv[2];
  const created = await call('/project/create', {
    title: '生成自检',
    cwd,
    model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  });
  const projectId = created.project.projectId;
  console.log('project', projectId, 'session', created.project.sessionId);

  const chapter = await call('/chapter/create', { projectId, startDay: 0 });
  await call('/outline/save', {
    projectId,
    chapterId: chapter.chapterId,
    title: '灯下',
    outline: {
      durationDays: 3,
      minWords: 200,
      maxWords: 600,
      synopsisMinChars: 20,
      synopsis: '深夜的书房里，主角发现灯下多了一封没有署名的信，信上只有一句话。',
    },
  });

  const started = await call('/generate', { projectId, chapterId: chapter.chapterId });
  console.log('job', started.jobId, started.state);

  let job = started;
  const deadline = Date.now() + 8 * 60 * 1000;
  while (job.state === 'running' && Date.now() < deadline) {
    await sleep(4000);
    job = await call(`/job?id=${encodeURIComponent(job.jobId)}`);
    process.stdout.write(`  ${job.state} ${job.message || ''}\n`);
  }
  console.log('final', job.state, job.error || '');
  if (job.state === 'done') {
    console.log('words', job.result.wordCount, 'snapshotJobId', job.result.snapshotJobId);
    const detail = await call(`/project?projectId=${projectId}`);
    const saved = detail.chapters[0];
    console.log('chapter', JSON.stringify({ status: saved.status, words: saved.wordCount }));
    console.log('preview:', String(saved.content || '').slice(0, 160).replace(/\n/g, ' '));
  }
  await call('/project/delete', { projectId });
  console.log('deleted project', projectId);
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
