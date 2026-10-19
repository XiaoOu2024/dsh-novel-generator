const BASE = 'http://127.0.0.1:3080/dsh-novel-studio/api';

async function call(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

(async () => {
  const cwd = process.argv[2];
  const created = await call('/project/create', { title: '分组自检', cwd });
  console.log('created:', JSON.stringify({
    projectId: created.project.projectId,
    sessionId: created.project.sessionId,
    workspace: created.workspace,
    warning: created.warning,
  }));
  const removed = await call('/project/delete', { projectId: created.project.projectId });
  console.log('deleted:', JSON.stringify(removed));
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
