const BASE = 'http://127.0.0.1:3080/dsh-novel-generator/api';

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

async function wait(jobId, label, limitMs) {
  const deadline = Date.now() + (limitMs || 6 * 60 * 1000);
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
    title: '组合流程自检',
    cwd,
    model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  });
  const projectId = created.project.projectId;
  console.log('project', projectId);

  // 自动推演：名称留空，交给模型；40 天 > 30 天阈值 → 应触发快照
  const compose = await call('/compose', {
    projectId,
    startDay: 0,
    title: '',
    minWords: 200,
    maxWords: 600,
    durationDays: 40,
  });
  const composed = await wait(compose.jobId, 'compose');
  console.log('compose:', composed.state, composed.error || '');
  if (composed.state !== 'done') { await call('/project/delete', { projectId }); process.exitCode = 1; return; }
  console.log('  chapter:', JSON.stringify(composed.result));

  if (composed.result.snapshotJobId) {
    const snap = await wait(composed.result.snapshotJobId, 'snapshot');
    console.log('snapshot job:', snap.state, snap.error || '');
  } else {
    console.log('  no snapshot job queued');
  }

  const detail = await call(`/project?projectId=${projectId}`);
  console.log('detail:', JSON.stringify({
    chapters: detail.chapters.map((c) => ({ index: c.index, title: c.title, start: c.startDay, days: c.durationDays, words: c.wordCount, status: c.status })),
    snapshots: detail.snapshots.map((s) => ({ day: s.day, world: (s.world || '').length, characters: s.characters.length, factions: s.factions.length, relations: s.relations.length })),
    timeline: detail.timeline,
  }, null, 2));

  const second = await call('/compose', {
    projectId,
    startDay: detail.chapters[0].startDay + detail.chapters[0].durationDays,
    title: '第二章',
    minWords: 200,
    maxWords: 500,
    durationDays: 10,
  });
  const secondJob = await wait(second.jobId, 'compose-2');
  console.log('second compose:', secondJob.state, secondJob.error || '');
  const after = await call(`/project?projectId=${projectId}`);
  console.log('after:', JSON.stringify({
    chapters: after.chapters.length,
    snapshots: after.snapshots.map((s) => s.day),
  }));

  await call('/project/delete', { projectId });
  console.log('deleted', projectId);
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
