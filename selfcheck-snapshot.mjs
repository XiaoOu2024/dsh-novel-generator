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

const CHAPTER_ONE = `黄昏时，青石镇的最后一班渡船靠了岸。沈砚提着一只旧木箱下船，箱角磕在跳板上，露出里面卷起的图纸。
镇口的茶棚里坐着三个人：穿灰袍的账房先生、腰间别刀的捕快，还有一个始终低头剥花生的女子。
沈砚要去找他的师父——镇上唯一的铁匠顾长川。可铁匠铺的门板上贴着封条，落款是“漕帮”。
捕快拦住他，说顾长川三天前死在炉边，尸首不见了。账房先生却悄悄塞给他一枚铜钱，铜钱背面刻着“守拙”二字。`;

const CHAPTER_TWO = `夜里，沈砚住在镇东的客栈。他翻开图纸，那是一张水道图，标着从青石镇到临安府的七处暗桩。
女子推门进来，自称阿罗，是顾长川的养女。她说漕帮要的是图纸上的第七处暗桩，那里藏着师父替朝廷铸的一批兵器。
窗外忽然响起三声梆子。阿罗吹灭油灯，把一枚同样的铜钱按在桌上：“守拙的人还活着，就在漕帮的船上。”
沈砚决定天亮后随渡船回江心，查那条船。`;

(async () => {
  const cwd = process.argv[2];
  const created = await call('/project/create', {
    title: '快照自检',
    cwd,
    model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  });
  const projectId = created.project.projectId;
  console.log('project', projectId);

  const one = await call('/chapter/create', { projectId, startDay: 0 });
  await call('/outline/save', {
    projectId,
    chapterId: one.chapterId,
    title: '渡口',
    outline: { durationDays: 30, minWords: 300, maxWords: 900, synopsisMinChars: 10, synopsis: '沈砚回到青石镇，发现师父顾长川已死，漕帮封了铁匠铺。' },
  });
  await call('/chapter/save', { projectId, chapterId: one.chapterId, content: CHAPTER_ONE });

  const two = await call('/chapter/create', { projectId, startDay: 30 });
  await call('/outline/save', {
    projectId,
    chapterId: two.chapterId,
    title: '暗桩',
    outline: { durationDays: 20, minWords: 300, maxWords: 900, synopsisMinChars: 10, synopsis: '阿罗告知图纸与第七处暗桩的秘密，两人决定夜探漕帮的船。' },
  });
  await call('/chapter/save', { projectId, chapterId: two.chapterId, content: CHAPTER_TWO });

  const started = await call('/snapshot/refresh', { projectId, day: 50 });
  console.log('job', started.jobId, started.state);

  let job = started;
  const deadline = Date.now() + 6 * 60 * 1000;
  while (job.state === 'running' && Date.now() < deadline) {
    await sleep(4000);
    job = await call(`/job?id=${encodeURIComponent(job.jobId)}`);
    process.stdout.write(`  ${job.state} ${job.message || ''}\n`);
  }
  console.log('final', job.state, job.error || '');
  if (job.state === 'done') {
    const detail = await call(`/project?projectId=${projectId}`);
    const snapshot = detail.snapshots[0];
    console.log('snapshot:', JSON.stringify({
      day: snapshot.day,
      worldChars: (snapshot.world || '').length,
      characters: snapshot.characters.map((entry) => entry.name),
      factions: snapshot.factions.map((entry) => entry.name),
      relations: snapshot.relations.slice(0, 6),
      summaryChars: (snapshot.summary || '').length,
    }, null, 2));
  }
  await call('/project/delete', { projectId });
  console.log('deleted project', projectId);
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
