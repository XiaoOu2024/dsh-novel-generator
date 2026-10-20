const BASE = 'http://127.0.0.1:3080/dsh-novel-generator/api';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const boot = await (await fetch(BASE + '/bootstrap')).json();
  const project = boot.projects[0];
  const before = await (await fetch(BASE + '/project?projectId=' + project.projectId)).json();
  console.log('revision', boot.revision, '| unit', before.timeline.unitDays, '| snapshots before:', before.snapshots.map((s) => s.day).join(','));

  const res = await fetch(BASE + '/snapshot/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: project.projectId }),
  });
  const started = await res.json();
  if (!started.jobId) { console.log('start failed:', JSON.stringify(started)); return; }
  console.log('reset job', started.jobId);

  let job = started;
  const deadline = Date.now() + 6 * 60 * 1000;
  while (job.state === 'running' && Date.now() < deadline) {
    await sleep(5000);
    job = await (await fetch(BASE + '/job?id=' + encodeURIComponent(started.jobId))).json();
    console.log('  ', job.state, job.message || '');
  }
  console.log('final', job.state, job.error || JSON.stringify(job.result || {}).slice(0, 200));

  const after = await (await fetch(BASE + '/project?projectId=' + project.projectId)).json();
  console.log('snapshots after:', after.snapshots.map((s) => s.day).join(','));
  for (const snapshot of after.snapshots) {
    console.log(`  day ${snapshot.day}: world ${(snapshot.world || '').length}字, 角色 ${(snapshot.characters || []).length}, 势力 ${(snapshot.factions || []).length}, 物品 ${(snapshot.items || []).length}, 事件 ${(snapshot.events || []).length}`);
    if ((snapshot.events || []).length) console.log('     events:', snapshot.events.map((e) => `${e.day}:${e.title}`).join(' | '));
  }
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
