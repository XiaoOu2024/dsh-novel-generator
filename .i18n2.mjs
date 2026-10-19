import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('./client.js', import.meta.url);
let src = readFileSync(file, 'utf8');

const pairs = [
  [
    '`请求失败（HTTP ${response.status}）`',
    "t('请求失败（HTTP {code}）', 'Request failed (HTTP {code})', { code: response.status })",
  ],
  [
    '`确定删除作品「${project.title}」？章节与快照会一并删除，作品的会话本身保留。`',
    "t('确定删除作品「{title}」？章节与快照会一并删除，作品的会话本身保留。', 'Delete the work “{title}”? Its chapters and snapshots go with it; the session itself stays.', { title: project.title })",
  ],
  [
    '`${project.chapterCount} 章 · ${project.snapshotCount} 个快照 · 模型：${modelLabel(boot.models, project.model)}`',
    "t('{chapters} 章 · {snapshots} 个快照 · 模型：{model}', '{chapters} chapters · {snapshots} snapshots · model: {model}', { chapters: project.chapterCount, snapshots: project.snapshotCount, model: modelLabel(boot.models, project.model) })",
  ],
  [
    "`${project.cwd} · 更新于 ${formatTime(project.updatedAt)}${project.lastChapterTitle ? ` · 最近：${project.lastChapterTitle}` : ''}`",
    "t('{cwd} · 更新于 {time}{recent}', '{cwd} · updated {time}{recent}', { cwd: project.cwd, time: formatTime(project.updatedAt), recent: project.lastChapterTitle ? t(' · 最近：{title}', ' · latest: {title}', { title: project.lastChapterTitle }) : '' })",
  ],
  ['`第 ${day} 天`', "t('第 {n} 天', 'Day {n}', { n: day })"],
  [
    '`共 ${max} 天 · 每 ${unitDays} 天一份快照 · 已写入 ${snapshots.length} 份${nextDay <= max ? ` · 下一快照点 第 ${nextDay} 天` : \'\'}`',
    "t('共 {total} 天 · 每 {unit} 天一份快照 · 已写入 {count} 份{next}', '{total} days · one snapshot every {unit} days · {count} written{next}', { total: max, unit: unitDays, count: snapshots.length, next: nextDay <= max ? t(' · 下一快照点 第 {day} 天', ' · next snapshot point on day {day}', { day: nextDay }) : '' })",
  ],
  ['`快照 · 第 ${mark} 天`', "t('快照 · 第 {day} 天', 'Snapshot · day {day}', { day: mark })"],
  ['`下一个快照点 · 第 ${nextDay} 天`', "t('下一个快照点 · 第 {day} 天', 'Next snapshot point · day {day}', { day: nextDay })"],
  ['`${tick} 天`', "t('{n} 天', '{n} days', { n: tick })"],
  [
    '`生成章节后，故事时间每走过 ${unitDays} 天就会写入第一份世界快照，时间线随之生长。`',
    "t('生成章节后，故事时间每走过 {unit} 天就会写入第一份世界快照，时间线随之生长。', 'Once you generate a chapter, a first world snapshot is written every {unit} days of story time and the timeline grows with it.', { unit: unitDays })",
  ],
  [
    '`将为第 ${day} 天生成一份世界快照：以上一份快照和这段时间的章节梗概为依据，时间线会延伸到这一天。`',
    "t('将为第 {day} 天生成一份世界快照：以上一份快照和这段时间的章节梗概为依据，时间线会延伸到这一天。', 'A world snapshot will be generated for day {day} from the previous snapshot and the synopses of this stretch; the timeline extends to that day.', { day })",
  ],
  ['`生成世界快照 · 第 ${day} 天`', "t('生成世界快照 · 第 {day} 天', 'Generate snapshot · day {day}', { day })"],
  ['`进入故事 · 第 ${nearest.index + 1} 章`', "t('进入故事 · 第 {n} 章', 'Enter story · chapter {n}', { n: nearest.index + 1 })"],
  [
    '`纵轴：本章天数 · 横轴：第几章 · 共 ${chapters.length} 章`',
    "t('纵轴：本章天数 · 横轴：第几章 · 共 {count} 章', 'Y: days in the chapter · X: chapter · {count} in total', { count: chapters.length })",
  ],
  [
    "`第 ${index + 1} 章 ${chapters[index].title || ''} · 本章 ${entry.days} 天（第 ${entry.start} → ${entry.end} 天）`",
    "t('第 {n} 章 {title} · 本章 {days} 天（第 {start} → {end} 天）', 'Chapter {n} {title} · {days} days (day {start} → {end})', { n: index + 1, title: chapters[index].title || '', days: entry.days, start: entry.start, end: entry.end })",
  ],
  [
    "`第 ${chapter.index + 1} 章 · ${chapter.title || t('未命名', 'Untitled')}`",
    "t('第 {n} 章 · {title}', 'Chapter {n} · {title}', { n: chapter.index + 1, title: chapter.title || t('未命名', 'Untitled') })",
  ],
  [
    '`第 ${window.start} → ${window.end} 天`',
    "t('第 {start} → {end} 天', 'Day {start} → {end}', { start: window.start, end: window.end })",
  ],
  [
    "`第 ${previous.index + 1} 章 · ${previous.title || t('未命名', 'Untitled')}`",
    "t('第 {n} 章 · {title}', 'Chapter {n} · {title}', { n: previous.index + 1, title: previous.title || t('未命名', 'Untitled') })",
  ],
  [
    "`第 ${next.index + 1} 章 · ${next.title || t('未命名', 'Untitled')}`",
    "t('第 {n} 章 · {title}', 'Chapter {n} · {title}', { n: next.index + 1, title: next.title || t('未命名', 'Untitled') })",
  ],
  [
    "`${words} 字${chapter.outline ? ` · 大纲要求 ${chapter.outline.minWords}–${chapter.outline.maxWords} 字` : ''}`",
    "t('{words} 字{req}', '{words} words{req}', { words, req: chapter.outline ? t(' · 大纲要求 {min}–{max} 字', ' · outline asks for {min}–{max} words', { min: chapter.outline.minWords, max: chapter.outline.maxWords }) : '' })",
  ],
  ['`章节大纲 · 第 ${chapter.index + 1} 章`', "t('章节大纲 · 第 {n} 章', 'Outline · chapter {n}', { n: chapter.index + 1 })"],
  [
    '`起始 第 ${chapter ? chapterWindow(detail, chapter).start : (detail.timeline.cursor || 0)} 天`',
    "t('起始 第 {day} 天', 'Starts day {day}', { day: chapter ? chapterWindow(detail, chapter).start : (detail.timeline.cursor || 0) })",
  ],
  ['`起始 第 ${startDay} 天`', "t('起始 第 {day} 天', 'Starts day {day}', { day: startDay })"],
  [
    '`故事梗概（已写 ${synopsisLength} / 至少 ${form.synopsisMinChars} 字）`',
    "t('故事梗概（已写 {written} / 至少 {min} 字）', 'Synopsis ({written} / at least {min} characters)', { written: synopsisLength, min: form.synopsisMinChars })",
  ],
  [
    "`${what || t('这一章', 'This chapter')}还没有保存`",
    "t('{what}还没有保存', '{what} has unsaved changes', { what: what || t('这一章', 'This chapter') })",
  ],
];

const failed = [];
for (const [from, to] of pairs) {
  const count = src.split(from).length - 1;
  if (count === 0) {
    failed.push(from.slice(0, 40));
    continue;
  }
  src = src.split(from).join(to);
}
writeFileSync(file, src, 'utf8');
console.log('unmatched:', failed.length ? failed : 'none');
