const BASE = 'http://127.0.0.1:3080/dsh-novel-generator/api';
const cwd = 'C:\\Users\\Admin\\AppData\\Local\\Temp\\novel-folder-test';

async function call(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } = await import('node:fs');
rmSync(cwd, { recursive: true, force: true });
mkdirSync(cwd, { recursive: true });

const boot = await (await fetch(BASE + '/bootstrap')).json();
console.log('revision', boot.revision);

// 1. create → folder must exist at once, with the stamp and 作品信息.md
const first = await call('/project/create', { title: '自检作品A', cwd, model: { provider: 'deepseek-official', model: 'deepseek-flash' } });
console.log('create A:', first.status, first.data.project ? first.data.project.projectId : JSON.stringify(first.data).slice(0, 120));
const dirA = `${cwd}\\自检作品A`;
console.log('folder A exists:', existsSync(dirA), '| contents:', existsSync(dirA) ? readdirSync(dirA).join(', ') : '-');

// 2. same title again → refused, and no second project
const second = await call('/project/create', { title: '自检作品A', cwd });
console.log('create A again:', second.status, JSON.stringify(second.data).slice(0, 140));

// 3. a title that collides with a plain user folder
mkdirSync(`${cwd}\\用户自己的文件夹`, { recursive: true });
writeFileSync(`${cwd}\\用户自己的文件夹\\笔记.md`, '我的东西', 'utf8');
const third = await call('/project/create', { title: '用户自己的文件夹', cwd });
console.log('create over user folder:', third.status, JSON.stringify(third.data).slice(0, 140));
console.log('user folder untouched:', readdirSync(`${cwd}\\用户自己的文件夹`).join(', '));

// 4. delete A → its folder goes away
const del = await call('/project/delete', { projectId: first.data.project.projectId });
console.log('delete A:', del.status, JSON.stringify(del.data));
console.log('folder A gone:', !existsSync(dirA));
