/**
 * dsh-novel-generator — Host half.
 *
 * Owns the durable novel-project store (projects, timelines, chapters and world
 * snapshots), the HTTP surface the browser half talks to, and the Agent work
 * that turns an outline into a chapter and a set of chapters into a world
 * snapshot.
 *
 * The Agent work deliberately goes through `sessionController`, so every
 * project owns an ordinary Session: the user can open that Session in the chat
 * UI and watch (or correct) the very same agent the generator drives.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import path from 'node:path';

export const name = 'dsh-novel-generator';
export const inject = ['webServer'];

/** Exact API prefix; the Client half fetches below it. */
const ROUTE_PREFIX = '/dsh-novel-generator/api';
/** Largest accepted JSON body: a long chapter plus its outline. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/**
 * How long one model turn may run. A model that ignores the word limit can
 * stream for many minutes, so the bound keeps the studio responsive; what it
 * did write is still taken when the turn is cut.
 */
const AGENT_TIMEOUT_MS = 6 * 60 * 1000;
/** Finished jobs stay readable this long for a polling Client. */
const JOB_TTL_MS = 30 * 60 * 1000;

/* ------------------------------------------------------------------ store */

/** Root of the plugin's own data: `<DSH_HOME>/novel-studio` unless configured. */
function resolveRoot(config) {
  if (config && typeof config.dataDir === 'string' && config.dataDir.trim() !== '') {
    return config.dataDir.trim();
  }
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
  return join(home, 'novel-studio');
}

function projectsDir(root) {
  return join(root, 'projects');
}

function projectFile(root, projectId) {
  return join(projectsDir(root), projectId, 'project.json');
}

async function writeJson(file, value) {
  await mkdir(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
}

async function readProject(root, projectId) {
  let text;
  try {
    text = await readFile(projectFile(root, projectId), 'utf8');
  } catch {
    throw httpError(404, `作品不存在: ${projectId}`);
  }
  const project = migrateProject(JSON.parse(text));
  // Prose, synopses and snapshot bodies come from the work folder; a record
  // that still carries them inline is a leftover and is rewritten in the new
  // shape once.
  const legacy = await hydrateChapterFiles(project);
  if (legacy) await persistProject(root, project);
  return project;
}

/* ------------------------------------------------- chapter files on disk */

/** A filename-safe piece of text (Windows forbids \ / : * ? " < > |). */
function safeSegment(value, fallback) {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? fallback : text.slice(0, 80);
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Why a work title cannot become a folder name, or null when it can. The folder
 * is created inside the user's chosen directory, so the title has to be legal
 * as a Windows file name.
 */
function titleProblem(title) {
  const text = String(title === undefined || title === null ? '' : title);
  if (text.trim() === '') return '作品名称不能为空';
  if (text.length > 60) return '作品名称最多 60 个字符';
  if (/^[.\s]/.test(text) || /[.\s]$/.test(text)) return '作品名称不能以空格或点开头、结尾';
  if (/[\\/:*?"<>|]/.test(text)) return '作品名称不能包含 \\ / : * ? " < > |';
  if (/[\u0000-\u001f]/.test(text)) return '作品名称不能包含控制字符';
  if (RESERVED_NAMES.test(text.trim())) return '作品名称不能使用 CON、PRN、NUL、COM1 这类系统保留名';
  return null;
}

/** Folder holding one work's files, inside the chosen working directory. */
function projectContentDir(project) {
  return join(project.cwd, safeSegment(project.title, '未命名作品'));
}

/** Ownership stamp written into the work folder, so delete never eats user data. */
const MARKER_FILE = '.novel-generator.json';

function markerFile(project) {
  return join(projectContentDir(project), MARKER_FILE);
}

async function stampWorkFolder(project) {
  try {
    await mkdir(projectContentDir(project), { recursive: true });
    await writeFile(markerFile(project), JSON.stringify({
      projectId: project.projectId,
      title: project.title,
      createdAt: project.createdAt,
    }, null, 2), 'utf8');
  } catch {
    // A folder that cannot be written simply has no stamp.
  }
}

/** True when this project's folder carries this project's own stamp. */
async function ownsWorkFolder(project) {
  try {
    const data = JSON.parse(await readFile(markerFile(project), 'utf8'));
    return Boolean(data) && data.projectId === project.projectId;
  } catch {
    return false;
  }
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reserve the work folder. An existing folder is reused only when it is empty
 * or already belongs to this plugin for the same project; anything else is a
 * name clash with the user's own files and is reported instead.
 */
async function reserveWorkFolder(project, projectId) {
  const dir = projectContentDir(project);
  await mkdir(dir, { recursive: true });
  const entries = (await readdir(dir)).filter((name) => name !== MARKER_FILE);
  if (entries.length === 0) return dir;
  let owner = null;
  try {
    owner = JSON.parse(await readFile(join(dir, MARKER_FILE), 'utf8'));
  } catch {
    owner = null;
  }
  if (owner && owner.projectId === projectId) return dir;
  throw httpError(409, `工作目录下已经有名为「${safeSegment(project.title, '未命名作品')}」的文件夹，请换一个作品名称`);
}

/** Remove the work folder only when it is provably this project's own. */
async function discardWorkFolder(project) {
  if (!project || !project.cwd) return null;
  const dir = projectContentDir(project);
  if (dir === project.cwd) return null;
  if (!(await ownsWorkFolder(project))) return null;
  try {
    await rm(dir, { recursive: true, force: true });
    return dir;
  } catch {
    return null;
  }
}

/** Where one chapter lives inside the work's own folder. */
function chapterPaths(project, chapter) {
  const number = String((Number(chapter.index) || 0) + 1).padStart(2, '0');
  const base = projectContentDir(project);
  return {
    dir: base,
    file: join(base, `第${number}章 ${safeSegment(chapter.title, '未命名')}.md`),
  };
}

function snapshotPaths(project, snapshot) {
  const day = String(Math.max(0, Math.round(Number(snapshot.day) || 0))).padStart(3, '0');
  const dir = join(projectContentDir(project), '世界快照');
  return {
    dir,
    file: join(dir, `第${day}天.md`),
  };
}

/** Outline card for one chapter: synopsis plus the knobs it was generated with. */
function chapterOutlinePaths(project, chapter) {
  const number = String((Number(chapter.index) || 0) + 1).padStart(2, '0');
  const dir = join(projectContentDir(project), '章节大纲');
  return {
    dir,
    file: join(dir, `第${number}章 ${safeSegment(chapter.title, '未命名')}.md`),
  };
}

function projectInfoFile(project) {
  return join(projectContentDir(project), '作品信息.md');
}

/** Machine-readable snapshot next to its human card. */
function snapshotJsonPaths(project, snapshot) {
  const day = String(Math.max(0, Math.round(Number(snapshot.day) || 0))).padStart(3, '0');
  const dir = join(projectContentDir(project), '世界快照');
  return {
    dir,
    file: join(dir, `第${day}天.json`),
  };
}

/**
 * Before an outline card is overwritten, keep the previous version when the new
 * synopsis is shorter. The card is the only copy of that text, so this is the
 * difference between a recoverable edit and losing thousands of characters.
 * History lives in `章节大纲/.history/` and is pruned to the newest few files.
 */
async function keepOutlineHistory(cardPath, nextSynopsis) {
  let previous = null;
  try {
    previous = await readFile(cardPath, 'utf8');
  } catch {
    return;
  }
  const oldBody = parseSynopsis(previous);
  if (oldBody.length <= nextSynopsis.length) return;
  try {
    const dir = join(join(cardPath, '..'), '.history');
    await mkdir(dir, { recursive: true });
    const stem = basename(cardPath, '.md');
    await writeFile(join(dir, `${stem}.${Date.now()}.md`), previous, 'utf8');
    const kept = (await readdir(dir)).filter((name) => name.startsWith(`${stem}.`)).sort();
    for (const name of kept.slice(0, Math.max(0, kept.length - 5))) {
      await unlink(join(dir, name)).catch(() => {});
    }
  } catch {
    // History is a safety net; failing to keep it must not block the save.
  }
}

/**
 * The synopsis body of an outline card (`（还没有写梗概）` reads as empty).
 *
 * The synopsis is user prose and may itself contain Markdown headings, so it is
 * everything after the marker to the end of the file — the writer always puts it
 * last. Cutting at the next `## ` heading used to truncate any synopsis that had
 * one inside it, and the shortened value then overwrote the file on the next
 * save, which is how a 5000-character synopsis came back as a few lines.
 */
function parseSynopsis(text) {
  const marker = '## 故事梗概';
  const start = text.indexOf(marker);
  if (start === -1) return '';
  const body = text.slice(start + marker.length).trim();
  return body === '（还没有写梗概）' ? '' : body;
}

/** Delete a file an earlier build wrote straight into the working directory. */
async function dropLegacyFile(legacyPath, expected) {
  try {
    const text = await readFile(legacyPath, 'utf8');
    if (text === expected) await unlink(legacyPath);
  } catch {
    // Not there, or not ours: leave it alone.
  }
}

/** Mirror one chapter's prose into the work folder under the chosen directory. */
async function exportChapter(project, chapter, content) {
  if (!project || !project.cwd) return false;
  const body = typeof content === 'string' ? content : (chapter.content || '');
  let ok = true;
  try {
    const target = chapterPaths(project, chapter);
    await mkdir(target.dir, { recursive: true });
    await writeFile(target.file, body, 'utf8');
    // Earlier builds wrote beside the working directory instead of inside the
    // work folder; drop that copy, but only when it is byte-identical.
    await dropLegacyFile(join(project.cwd, basename(target.file)), body);
  } catch {
    // A deleted or read-only directory must not fail the save itself.
    ok = false;
  }
  await exportChapterOutline(project, chapter);
  await exportProjectInfo(project);
  return ok;
}

/** Write the outline card (synopsis and its parameters) for one chapter. */
async function exportChapterOutline(project, chapter) {
  if (!project || !project.cwd) return;
  try {
    const target = chapterOutlinePaths(project, chapter);
    await mkdir(target.dir, { recursive: true });
    const outline = chapter.outline || null;
    const span = chapterWindow(project, chapter);
    // The card is the only copy of the synopsis, so a write that shortens it a
    // lot keeps the previous card aside first: a truncation bug then costs one
    // click to undo instead of the whole text.
    await keepOutlineHistory(target.file, (outline && outline.synopsis) || '');
    const lines = [];
    lines.push(`# 第 ${(Number(chapter.index) || 0) + 1} 章 ${chapter.title || '未命名'}`);
    lines.push('');
    lines.push(`- 故事时间：第 ${span.start} → ${span.end} 天（共 ${span.end - span.start} 天）`);
    if (outline) {
      lines.push(`- 字数要求：${outline.minWords} – ${outline.maxWords} 字`);
      lines.push(`- 梗概最低字数：${outline.synopsisMinChars || 0}`);
      lines.push(`- 大纲保存时间：${new Date(outline.savedAt || Date.now()).toISOString()}`);
    } else {
      lines.push('- 字数要求：尚未设置');
    }
    lines.push(`- 实际字数：${chapter.wordCount || 0}`);
    lines.push(`- 状态：${chapter.status || 'draft'}`);
    lines.push('');
    lines.push('## 故事梗概');
    lines.push('');
    lines.push((outline && outline.synopsis) || '（还没有写梗概）');
    lines.push('');
    await writeFile(target.file, lines.join('\n'), 'utf8');
  } catch {
    // Best effort.
  }
}

/** One readable page describing the work and every chapter's parameters. */
async function exportProjectInfo(project) {
  if (!project || !project.cwd) return;
  try {
    const dir = projectContentDir(project);
    await mkdir(dir, { recursive: true });
    const timeline = project.timeline || {};
    const snapshots = project.snapshots || [];
    const chapters = [...(project.chapters || [])]
      .sort((a, b) => a.startDay - b.startDay || a.index - b.index);
    const lines = [];
    lines.push(`# 作品：${project.title || '未命名作品'}`);
    lines.push('');
    lines.push(`- 工作目录：${project.cwd}`);
    lines.push(`- 绑定会话：${project.sessionId || '（无）'}`);
    lines.push(`- 模型：${project.model ? `${project.model.provider} / ${project.model.model}` : '（默认）'}`);
    lines.push(`- 预设：${project.agentPreset || '（默认）'}`);
    lines.push(`- 快照间隔：每 ${timeline.unitDays || 30} 天一份`);
    lines.push(`- 已写入快照：${snapshots.length ? snapshots.map((snapshot) => `第 ${snapshot.day} 天`).join('、') : '（暂无）'}`);
    lines.push(`- 故事当前：第 ${lastChapterEnd(project)} 天`);
    lines.push(`- 章节数：${chapters.length}`);
    lines.push('');
    lines.push('## 章节一览');
    lines.push('');
    lines.push('| 章 | 标题 | 故事时间 | 天数 | 字数要求 | 实际字数 | 状态 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const chapter of chapters) {
      const span = chapterWindow(project, chapter);
      const outline = chapter.outline || {};
      const cells = [
        String((Number(chapter.index) || 0) + 1),
        (chapter.title || '未命名').replace(/\|/g, '／'),
        `第 ${span.start} → ${span.end} 天`,
        String(span.end - span.start),
        `${outline.minWords || '-'} – ${outline.maxWords || '-'}`,
        String(chapter.wordCount || 0),
        chapter.status || 'draft',
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');
    lines.push('> 章节正文在同目录的「第NN章 标题.md」，各章梗概在「章节大纲」目录，世界快照在「世界快照」目录。');
    lines.push('');
    await writeFile(projectInfoFile(project), lines.join('\n'), 'utf8');
  } catch {
    // Best effort.
  }
}

async function removeChapterFile(project, chapter) {
  if (!project || !project.cwd) return;
  for (const target of [chapterPaths(project, chapter), chapterOutlinePaths(project, chapter)]) {
    try {
      await unlink(target.file);
    } catch {
      // Already gone, or never written.
    }
  }
}

/** Write one world snapshot as a readable markdown card. */
async function exportSnapshot(project, snapshot) {
  if (!project || !project.cwd) return false;
  try {
    const target = snapshotPaths(project, snapshot);
    await mkdir(target.dir, { recursive: true });
    const lines = [];
    lines.push(`# 世界快照 · 第 ${snapshot.day} 天`);
    lines.push('');
    lines.push(`时间：第 0 天起算的第 ${snapshot.day} 天`);
    lines.push('');
    lines.push('## 世界观');
    lines.push('');
    lines.push(snapshot.world || '（无）');
    lines.push('');
    lines.push('## 角色');
    lines.push('');
    for (const character of snapshot.characters || []) {
      lines.push(`- ${character.name}${character.desc ? `：${character.desc}` : ''}`);
    }
    lines.push('');
    lines.push('## 势力');
    lines.push('');
    for (const faction of snapshot.factions || []) {
      lines.push(`- ${faction.name}${faction.desc ? `：${faction.desc}` : ''}`);
    }
    lines.push('');
    lines.push('## 关系');
    lines.push('');
    for (const relation of snapshot.relations || []) lines.push(`- ${relation}`);
    lines.push('');
    lines.push('## 物品');
    lines.push('');
    for (const item of snapshot.items || []) {
      lines.push(`- ${item.name}${item.desc ? `：${item.desc}` : ''}`);
    }
    lines.push('');
    lines.push('## 事件');
    lines.push('');
    for (const event of snapshot.events || []) {
      lines.push(`- ${event.day === null || event.day === undefined ? '时间不详' : `第 ${event.day} 天`} ${event.title}${event.desc ? `：${event.desc}` : ''}`);
    }
    lines.push('');
    if (snapshot.summary) {
      lines.push('## 这段时间的变化');
      lines.push('');
      lines.push(snapshot.summary);
      lines.push('');
    }
    await writeFile(target.file, lines.join('\n'), 'utf8');
    // The machine-readable body the Client renders from.
    const data = snapshotJsonPaths(project, snapshot);
    await writeFile(data.file, JSON.stringify({
      unitDays: snapshot.unitDays,
      world: snapshot.world || '',
      characters: snapshot.characters || [],
      factions: snapshot.factions || [],
      relations: snapshot.relations || [],
      items: snapshot.items || [],
      events: snapshot.events || [],
      summary: snapshot.summary || '',
    }, null, 2), 'utf8');
    // Same one-time move for the snapshot folder the earlier build created
    // beside the working directory.
    const body = lines.join('\n');
    await dropLegacyFile(join(project.cwd, '世界快照', basename(target.file)), body);
    try {
      await rmdir(join(project.cwd, '世界快照'));
    } catch {
      // Not empty or already gone.
    }
    return true;
  } catch {
    // Best effort: the index keeps an inline copy when the folder refuses.
    return false;
  }
}

/**
 * The store keeps parameters only: chapter prose, synopses and snapshot bodies
 * live in the work folder. This is the shape written to `project.json`, with an
 * inline copy kept only for a file the work folder refused to take.
 */
function strippedProject(project, unwritten) {
  const index = {
    ...project,
    chapters: (project.chapters || []).map((chapter) => {
      const outline = chapter.outline || null;
      const record = {
        chapterId: chapter.chapterId,
        index: chapter.index,
        title: chapter.title,
        startDay: chapter.startDay,
        durationDays: chapter.durationDays,
        wordCount: chapter.wordCount || 0,
        status: chapter.status || 'draft',
        createdAt: chapter.createdAt,
        updatedAt: chapter.updatedAt,
        generatedAt: chapter.generatedAt === undefined ? null : chapter.generatedAt,
        outlineParams: outline
          ? {
            minWords: outline.minWords,
            maxWords: outline.maxWords,
            synopsisMinChars: outline.synopsisMinChars,
            savedAt: outline.savedAt,
          }
          : null,
      };
      if (unwritten && unwritten.has(chapter.chapterId)) {
        record.content = chapter.content || '';
        record.synopsis = outline ? outline.synopsis || '' : '';
      }
      return record;
    }),
    snapshots: (project.snapshots || []).map((snapshot) => {
      const record = {
        snapshotId: snapshot.snapshotId,
        day: snapshot.day,
        createdAt: snapshot.createdAt,
      };
      if (unwritten && unwritten.has(snapshot.snapshotId)) {
        Object.assign(record, {
          unitDays: snapshot.unitDays,
          world: snapshot.world,
          characters: snapshot.characters,
          factions: snapshot.factions,
          relations: snapshot.relations,
          summary: snapshot.summary,
        });
      }
      return record;
    }),
  };
  if (project.timelineFacts !== undefined) delete index.timelineFacts;
  return index;
}

/** Write every content file, then the parameter-only index. */
async function persistProject(root, project) {
  const unwritten = new Set();
  await stampWorkFolder(project);
  for (const chapter of project.chapters || []) {
    const ok = await exportChapter(project, chapter, chapter.content);
    if (!ok) unwritten.add(chapter.chapterId);
  }
  for (const snapshot of project.snapshots || []) {
    const ok = await exportSnapshot(project, snapshot);
    if (!ok) unwritten.add(snapshot.snapshotId);
  }
  await exportProjectInfo(project);
  await writeJson(projectFile(root, project.projectId), strippedProject(project, unwritten));
}

/** Read one chapter's prose and synopsis back from the work folder. */
async function hydrateChapterFiles(project) {
  let legacy = false;
  for (const chapter of project.chapters || []) {
    let content = null;
    let card = null;
    try {
      content = await readFile(chapterPaths(project, chapter).file, 'utf8');
    } catch {
      content = null;
    }
    try {
      card = await readFile(chapterOutlinePaths(project, chapter).file, 'utf8');
    } catch {
      card = null;
    }
    if (content === null && typeof chapter.content === 'string') {
      content = chapter.content;
      legacy = true;
    }
    let synopsis = card === null ? null : parseSynopsis(card);
    if (synopsis === null && typeof chapter.synopsis === 'string') synopsis = chapter.synopsis;
    const params = chapter.outlineParams
      || (chapter.outline
        ? {
          minWords: chapter.outline.minWords,
          maxWords: chapter.outline.maxWords,
          synopsisMinChars: chapter.outline.synopsisMinChars,
          savedAt: chapter.outline.savedAt,
        }
        : null);
    if (chapter.outline || chapter.synopsis !== undefined || chapter.content !== undefined) legacy = true;
    chapter.content = content === null ? '' : content;
    chapter.outline = params || (synopsis || '') !== ''
      ? {
        ...(params || {}),
        durationDays: chapter.durationDays,
        synopsis: synopsis || '',
        savedAt: (params && params.savedAt) || 0,
      }
      : null;
    delete chapter.outlineParams;
    delete chapter.synopsis;
  }
  for (const snapshot of project.snapshots || []) {
    if (snapshot.world !== undefined) {
      legacy = true;
      continue;
    }
    try {
      Object.assign(snapshot, JSON.parse(await readFile(snapshotJsonPaths(project, snapshot).file, 'utf8')));
    } catch {
      // A snapshot whose sidecar is gone simply has no body to show.
    }
  }
  return legacy;
}

/**
 * The timeline cursor used to count grid cells and now counts story days.
 * A record written by the old build is converted once, on read, so a project
 * created before the change keeps pointing at the same story day.
 */
function migrateProject(project) {
  if (!project.timeline || typeof project.timeline !== 'object') {
    project.timeline = { unitDays: 30, cursor: 0, origin: '2026-01-01', cursorUnit: 'day' };
    return project;
  }
  if (project.timeline.cursorUnit !== 'day') {
    const unit = Math.max(1, Number(project.timeline.unitDays) || 30);
    project.timeline.cursor = Math.max(0, Math.round((Number(project.timeline.cursor) || 0) * unit));
    project.timeline.cursorUnit = 'day';
  }
  return project;
}

async function listProjects(root) {
  let entries;
  try {
    entries = await readdir(projectsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const project = JSON.parse(await readFile(join(projectsDir(root), entry.name, 'project.json'), 'utf8'));
      projects.push(summarize(project));
    } catch {
      // A half-written or foreign directory is not a project; skip it.
    }
  }
  projects.sort((a, b) => b.updatedAt - a.updatedAt);
  return projects;
}

function summarize(project) {
  const snapshots = project.snapshots || [];
  const chapters = project.chapters || [];
  const last = snapshots[snapshots.length - 1];
  return {
    projectId: project.projectId,
    title: project.title,
    cwd: project.cwd,
    sessionId: project.sessionId,
    agentPreset: project.agentPreset,
    model: project.model,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    chapterCount: chapters.length,
    snapshotCount: snapshots.length,
    timeline: project.timeline,
    latestSnapshotDay: last ? last.day : null,
    lastChapterTitle: chapters.length ? chapters[chapters.length - 1].title : null,
  };
}

/**
 * Serialize every store mutation: one process owns the files, and two
 * concurrent read-modify-write cycles would otherwise lose a chapter.
 */
let storeChain = Promise.resolve();
function withStore(operation) {
  const next = storeChain.then(operation, operation);
  storeChain = next.then(() => undefined, () => undefined);
  return next;
}

async function mutateProject(root, projectId, mutate) {
  return withStore(async () => {
    const project = await readProject(root, projectId);
    const result = await mutate(project);
    project.updatedAt = Date.now();
    await persistProject(root, project);
    return result === undefined ? project : result;
  });
}

/* -------------------------------------------------------------- utilities */

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isLoopback(host) {
  if (!host) return false;
  const lower = String(host).toLowerCase();
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/** Refuse cross-site callers: the Host header is the one a rebinding page cannot forge. */
function sameOrigin(request) {
  if (!isLoopback(request.headers.host)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, '请求体过大');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, '请求体不是合法 JSON');
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar date of one timeline day (day 0 is the origin date). */
function dateForDay(project, day) {
  const origin = /^\d{4}-\d{2}-\d{2}$/.test(project.timeline.origin || '')
    ? project.timeline.origin
    : '2026-01-01';
  const base = Date.parse(`${origin}T00:00:00Z`);
  return new Date(base + Math.round(day) * DAY_MS).toISOString().slice(0, 10);
}

/** Story window, in days from the origin, for one chapter. */
function chapterWindow(project, chapter) {
  const start = Number(chapter.startDay) || 0;
  const duration = Math.max(1, Number(chapter.durationDays) || Math.max(1, project.timeline.unitDays || 30));
  return { start, end: start + duration };
}

function wordCount(text) {
  return String(text || '').replace(/\s+/gu, '').length;
}

/**
 * Bring a runaway reply back inside the requested length.
 *
 * Models that ignore the word range keep streaming until their token cap (one
 * real reply was 50k characters for a 1200–3500 字 request), which also repeats
 * itself. The reply is cut at the first sign of a loop and trimmed at a sentence
 * boundary near the upper bound, so what lands in the chapter is a chapter.
 */
function fitChapterText(text, maxWords) {
  let body = String(text || '').replace(/\r\n/gu, '\n').trim();
  const limit = Math.max(200, Math.round(Number(maxWords) || 3000));
  // Drop a leading Markdown title line the prompt asked not to add.
  body = body.replace(/^#{1,6}\s*[^\n]*\n+/u, '');
  // A phrase repeated back-to-back is a degenerate loop: stop at the first one.
  const loop = body.match(/([\s\S]{12,80}?)\1{3,}/u);
  if (loop) body = body.slice(0, loop.index).trim();
  if (wordCount(body) <= limit * 1.15) return { text: body, trimmed: false };
  // Cut on a sentence end as close to the limit as possible.
  const sentences = body.split(/(?<=[。！？…”』\n])/u);
  let kept = '';
  for (const sentence of sentences) {
    if (wordCount(kept + sentence) > limit) break;
    kept += sentence;
  }
  if (kept.trim() === '') kept = body.slice(0, Math.round(limit * 1.2));
  return { text: kept.trim(), trimmed: true };
}

function textOfMessage(message) {
  const blocks = Array.isArray(message && message.content) ? message.content : [];
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** First JSON object in a model reply, tolerating a fenced block and prose. */
function parseJsonReply(text) {
  const raw = String(text || '').trim();
  if (raw === '') return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asText(value, fallback = '') {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function firstOf(object, keys, fallback = '') {
  if (!object || typeof object !== 'object') return fallback;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== '') {
      return object[key];
    }
  }
  return fallback;
}

/**
 * Normalize one snapshot the model produced into the shape the Client renders.
 * Field names are accepted in English and Chinese because a prompt cannot pin
 * a model's vocabulary as tightly as a schema can.
 */
function normalizeSnapshot(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const list = (value) => (Array.isArray(value) ? value : []);
  const world = asText(firstOf(source, ['world', '世界观', 'worldview', 'setting']));
  const characters = list(firstOf(source, ['characters', '角色', '角色列表']))
    .map((entry) => {
      if (typeof entry === 'string') return { name: entry.trim(), desc: '' };
      const name = asText(firstOf(entry, ['name', '姓名', '名字']));
      const desc = asText(firstOf(entry, ['desc', 'description', '描述', '简介', '介绍']));
      return { name, desc };
    })
    .filter((entry) => entry.name !== '');
  const factions = list(firstOf(source, ['factions', '势力', '势力列表']))
    .map((entry) => {
      if (typeof entry === 'string') return { name: entry.trim(), desc: '' };
      const name = asText(firstOf(entry, ['name', '名称', '名字']));
      const desc = asText(firstOf(entry, ['desc', 'description', '描述', '简介']));
      return { name, desc };
    })
    .filter((entry) => entry.name !== '');
  const relations = list(firstOf(source, ['relations', '关系', '关系列表']))
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      const from = asText(firstOf(entry, ['from', 'a', '甲', 'source']));
      const to = asText(firstOf(entry, ['to', 'b', '乙', 'target']));
      const type = asText(firstOf(entry, ['type', 'relation', '关系', 'kind']));
      return [from, to, type].filter((part) => part !== '').join(' ');
    })
    .filter((entry) => entry !== '');
  const items = list(firstOf(source, ['items', '物品', '道具', '物品列表']))
    .map((entry) => {
      if (typeof entry === 'string') return { name: entry.trim(), desc: '' };
      return {
        name: asText(firstOf(entry, ['name', '名称', '名字', '物品'])),
        desc: asText(firstOf(entry, ['desc', 'description', '描述', '简介', '用途'])),
      };
    })
    .filter((entry) => entry.name !== '');
  const events = list(firstOf(source, ['events', '事件', '事件列表']))
    .map((entry) => {
      if (typeof entry === 'string') return { day: null, title: entry.trim(), desc: '' };
      const rawDay = firstOf(entry, ['day', 'time', '时间', '天数', 'at'], null);
      const parsed = Number.isFinite(Number(rawDay)) ? Math.round(Number(rawDay)) : null;
      const fallback = typeof rawDay === 'string' ? (rawDay.match(/\d+/g) || []).map(Number).pop() : undefined;
      return {
        day: parsed === null ? (Number.isFinite(fallback) ? fallback : null) : parsed,
        title: asText(firstOf(entry, ['title', 'name', '事件', '标题', '名称'])),
        desc: asText(firstOf(entry, ['desc', 'description', '描述', '内容', '简介'])),
      };
    })
    .filter((entry) => entry.title !== '')
    // Newest first: the list reads like the story's own clock.
    .sort((a, b) => (b.day === null ? -1 : b.day) - (a.day === null ? -1 : a.day));
  return {
    world,
    characters,
    factions,
    relations,
    items,
    events,
    summary: asText(firstOf(source, ['summary', '梗概', '概述'])),
  };
}

/* ------------------------------------------------------------ agent work */

/**
 * Bind a fresh session to a work whose old one disappeared (deleted in the
 * sidebar, or gone from the session store). The work's memory — snapshots,
 * chapters, outlines — lives in files, so a new session loses only chat
 * history, not the novel itself.
 */
async function rebindSession(ctx, root, project) {
  const controller = ctx.get('sessionController');
  if (controller === undefined) throw httpError(503, '当前部署缺少 sessionController 服务，无法为作品重建会话');
  const created = await controller.create(project.agentPreset ? { cwd: project.cwd, agentPreset: project.agentPreset } : { cwd: project.cwd });
  const sessionId = created && created.sessionId ? created.sessionId : null;
  if (!sessionId) throw httpError(502, '没能为作品重建会话');
  if (project.model) {
    try {
      await controller.selectModel({ sessionId, ...project.model });
    } catch {
      // The rebuilt session still works with the profile's default model.
    }
  }
  project.sessionId = sessionId;
  await mutateProject(root, project.projectId, (draft) => {
    draft.sessionId = sessionId;
  });
  try {
    // The memo skips projects already grouped; a rebind starts a new session
    // that has never been grouped, so the entry has to go.
    ensuredWorkspaces.delete(project.projectId);
    await ensureWorkspace(ctx, root, project);
  } catch {
    // Grouping is cosmetic; the session works either way.
  }
  const result = await controller.resolveAgent(sessionId);
  if (!result || !result.agent) throw httpError(502, '重建的会话无法启动');
  return { controller, agent: result.agent };
}

/**
 * Keep the work's Session on the work's model.
 *
 * A session remembers the model it was last given, so a rebuilt session — or a
 * switch that quietly failed on an archived one — can leave it on a different
 * model than the work records. The pairing is re-applied whenever they differ.
 */
const syncedSessionModels = new Map();

async function syncSessionModel(controller, project) {
  if (!project || !project.sessionId || !project.model || !project.model.provider || !project.model.model) return;
  const key = `${project.model.provider}/${project.model.model}`;
  if (syncedSessionModels.get(project.sessionId) === key) return;
  try {
    await controller.selectModel({ sessionId: project.sessionId, ...project.model });
    syncedSessionModels.set(project.sessionId, key);
  } catch {
    // The work still records the model; the next job tries again.
  }
}

/** Resolve (or resume) the ordinary Agent that owns one project's Session. */
async function resolveAgent(ctx, root, project, onNote) {
  const controller = ctx.get('sessionController');
  if (controller === undefined) throw httpError(503, '当前部署缺少 sessionController 服务，无法驱动创作会话');
  if (!project.sessionId) {
    const rebuilt = await rebindSession(ctx, root, project);
    if (onNote) onNote('作品没有绑定会话，已新建一个会话');
    return rebuilt;
  }
  // Archived sessions still resolve, so visibility decides instead: a session
  // the user archived is no longer one of the plugin's working sessions.
  let archived = false;
  try {
    const list = await controller.list({}, new AbortController().signal);
    const items = list && Array.isArray(list.items) ? list.items : null;
    if (items) archived = !items.some((entry) => entry.sessionId === project.sessionId);
  } catch {
    archived = false;
  }
  if (archived) {
    const rebuilt = await rebindSession(ctx, root, project);
    if (onNote) onNote('作品的会话已被归档，已自动新建一个会话继续');
    return rebuilt;
  }
  let result = null;
  try {
    result = await controller.resolveAgent(project.sessionId);
  } catch {
    result = null;
  }
  if (result && result.agent) {
    await syncSessionModel(controller, project);
    return { controller, agent: result.agent };
  }
  // The old session is gone: rebuild instead of failing every later call.
  const rebuilt = await rebindSession(ctx, root, project);
  if (onNote) onNote('原作品会话已不存在，已自动新建一个会话继续');
  return rebuilt;
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout();
      } catch {
        // The timeout result is the answer either way.
      }
      reject(httpError(504, `模型调用超时（${Math.round(ms / 60000)} 分钟）`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Send one prompt into the project's own Session and return the reply text.
 * A freshly rebuilt session occasionally answers nothing on its first turn, so
 * one silent reply earns a single retry before the job fails.
 */
async function askAgent(ctx, root, project, prompt, onNote) {
  let rebuilt = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = project.sessionId;
    const { controller, agent } = await resolveAgent(ctx, root, project, attempt === 0 ? onNote : undefined);
    if (project.sessionId !== before) rebuilt = true;
    // Only messages added by THIS prompt are eligible: reading further back
    // would hand back the previous turn's reply (a snapshot JSON, for one) when
    // the model stays silent.
    let seen = 0;
    try {
      seen = agent.session.deriveMessages().length;
    } catch {
      seen = 0;
    }
    const admission = new AbortController();
    await withTimeout(controller.prompt({
      sessionId: project.sessionId,
      requestId: `novel-${randomUUID()}`,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
      clientTimeZone: 'Asia/Shanghai',
    }, admission.signal), 60 * 1000, () => admission.abort());
    await withTimeout(agent.whenIdle(), AGENT_TIMEOUT_MS, () => {
      try {
        agent.cancel({ kind: 'hook', reason: 'novel-studio generation timeout' });
      } catch {
        // Cancellation is best effort on the failure path.
      }
    });
    const messages = agent.session.deriveMessages();
    for (let index = messages.length - 1; index >= seen; index -= 1) {
      const message = messages[index];
      if (!message || message.role !== 'assistant') continue;
      const text = textOfMessage(message);
      if (text !== '') return text;
    }
    if (attempt === 0) {
      if (onNote) onNote('模型这一轮没有回复，重试一次');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw rebuilt
    ? httpError(502, '作品的旧会话已不存在，已为它新建一个会话，但模型没有回复；请先打开这部作品的会话（「小说工坊」分组里），或在作品列表点「重建会话」后再试')
    : httpError(502, '模型没有返回任何正文');
}

/** True when a reply is structured data rather than prose (a snapshot JSON). */
function looksStructured(text) {
  const head = String(text || '').trim();
  if (head === '') return false;
  if (!head.startsWith('{') && !head.startsWith('[')) {
    return head.startsWith('```') && (head.includes('"world"') || head.includes('"characters"'));
  }
  try {
    JSON.parse(head);
    return true;
  } catch {
    return head.includes('"world"') || head.includes('"characters"') || head.includes('"synopsis"');
  }
}

/**
 * Ask for prose. A model that answers a writing prompt with JSON (it just
 * produced a snapshot, say) gets one firm reminder instead of having structured
 * text saved as the chapter body.
 */
async function askStory(ctx, root, project, prompt, onNote) {
  const first = await askAgent(ctx, root, project, prompt, onNote);
  if (!looksStructured(first)) return first;
  if (onNote) onNote('模型返回了结构化数据，正在要求它改写为正文');
  const retryPrompt = `${prompt}\n\n【纠正】上一轮你返回的是 JSON/结构化数据，那是错的。现在只输出这一章的小说正文（中文散文），不要 JSON、不要字段名、不要标题行。`;
  const second = await askAgent(ctx, root, project, retryPrompt, onNote);
  if (looksStructured(second)) throw httpError(502, '模型反复返回结构化数据而不是正文，请稍后重试或换一个模型');
  return second;
}

function snapshotBlock(snapshot) {
  if (!snapshot) return '（暂无世界快照，请依据本章梗概自行建立最基本的设定）';
  const lines = [];
  lines.push(`【时间】第 ${snapshot.day} 天`);
  if (snapshot.world) lines.push(`【世界观】${snapshot.world}`);
  if (snapshot.characters.length) {
    lines.push('【角色】');
    for (const character of snapshot.characters) {
      lines.push(`- ${character.name}${character.desc ? `：${character.desc}` : ''}`);
    }
  }
  if (snapshot.factions.length) {
    lines.push('【势力】');
    for (const faction of snapshot.factions) {
      lines.push(`- ${faction.name}${faction.desc ? `：${faction.desc}` : ''}`);
    }
  }
  if (snapshot.relations.length) {
    lines.push('【关系】');
    for (const relation of snapshot.relations) lines.push(`- ${relation}`);
  }
  if (snapshot.items && snapshot.items.length) {
    lines.push('【物品】');
    for (const item of snapshot.items) {
      lines.push(`- ${item.name}${item.desc ? `：${item.desc}` : ''}`);
    }
  }
  if (snapshot.events && snapshot.events.length) {
    lines.push('【事件】');
    for (const event of snapshot.events) {
      lines.push(`- ${event.day === null || event.day === undefined ? '时间不详' : `第 ${event.day} 天`} ${event.title}${event.desc ? `：${event.desc}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** Snapshot in force at one story day: the newest one at or before it. */
function snapshotAt(project, day) {
  const snapshots = (project.snapshots || []).filter((snapshot) => snapshot.day <= day);
  if (snapshots.length === 0) return null;
  return snapshots[snapshots.length - 1];
}

/**
 * How far the nearest snapshot sits behind a chapter's start.
 *
 * The rule both prompts share: the nearest snapshot node at or before the
 * chapter wins. If the chapter starts more than one interval after that node,
 * the snapshot is too stale to write from and the Client is told to update it
 * first — the same rule for 自动推演 and for writing the chapter body.
 */
function snapshotDistance(project, chapter) {
  const span = chapterWindow(project, chapter);
  const unit = Math.max(1, project.timeline.unitDays || 30);
  const snapshot = snapshotAt(project, span.start) || null;
  const base = snapshot ? snapshot.day : 0;
  const gap = Math.max(0, span.start - base);
  return { snapshot, unit, base, gap, tooFar: gap > unit, startDay: span.start };
}

/** Chapters from the snapshot node up to (not including) the target chapter. */
function stretchBefore(project, chapter, snapshot) {
  const base = snapshot ? snapshot.day : 0;
  return (project.chapters || [])
    .filter((entry) => entry.chapterId !== chapter.chapterId
      && entry.startDay < chapter.startDay
      && chapterWindow(project, entry).end > base
      && ((entry.outline && entry.outline.synopsis) || '').trim() !== '')
    .sort((a, b) => a.startDay - b.startDay);
}

/**
 * Refuse to write from a snapshot that has drifted more than one interval
 * behind the chapter, and say what the user has to do about it.
 */
function assertSnapshotFresh(project, chapter) {
  const distance = snapshotDistance(project, chapter);
  if (!distance.tooFar) return distance;
  const from = distance.base > 0 ? `第 ${distance.base} 天` : '故事开篇（还没有任何快照）';
  throw httpError(409, `最近的世界快照停在${from}，本章从第 ${distance.startDay} 天开始，间隔 ${distance.gap} 天已超过当前快照间隔（${distance.unit} 天）；请先在时间长河点「更新世界快照」再来生成`);
}

function stretchLines(project, chapter, snapshot) {
  const lines = [];
  const stretch = stretchBefore(project, chapter, snapshot);
  if (stretch.length === 0) return lines;
  lines.push(snapshot
    ? `【已发生的章节梗概 · 第 ${snapshot.day} 天之后到上一章】`
    : '【已发生的章节梗概 · 开篇到上一章】');
  for (const entry of stretch) {
    lines.push(`- 第 ${entry.index + 1} 章 ${entry.title || ''}（第 ${entry.startDay}→${entry.startDay + entry.durationDays} 天）：${entry.outline.synopsis}`);
  }
  lines.push('');
  return lines;
}

function chapterPrompt(project, chapter, previous) {
  const window = chapterWindow(project, chapter);
  const outline = chapter.outline || {};
  const minWords = outline.minWords || 800;
  const maxWords = outline.maxWords || 3000;
  const { snapshot } = snapshotDistance(project, chapter);
  const lines = [];
  lines.push('你现在是这部小说的执笔作者。只输出本章正文，不要解释、不要标题、不要分点提纲。');
  lines.push(`【篇幅】本章正文必须控制在 ${minWords}～${maxWords} 字之间，写够 ${maxWords} 字附近就收尾，超过 ${maxWords} 字视为不合格。`);
  lines.push('');
  const shownTitle = chapter.title && !/^第\s*\d+\s*章$/u.test(chapter.title) ? ` ${chapter.title}` : '';
  lines.push(`【本章】第 ${chapter.index + 1} 章${shownTitle}（第 ${window.start}→${window.end} 天，跨度 ${chapter.durationDays} 天）`);
  lines.push('');
  lines.push('【最近的世界快照】');
  lines.push(snapshotBlock(snapshot));
  lines.push('');
  const stretch = stretchLines(project, chapter, snapshot);
  if (stretch.length) {
    lines.push(...stretch);
  } else if (previous) {
    lines.push('【上一章梗概】');
    lines.push(`${previous.title || ''}：${(previous.outline && previous.outline.synopsis) || '（无）'}`);
    lines.push('');
  }
  lines.push('【本章梗概 · 待生成的部分】');
  lines.push(outline.synopsis || '（无）');
  lines.push('');
  lines.push('【要求】');
  lines.push('- 以上"已发生的章节梗概"是既定事实，不得改写；本章正文要接着它往下写。');
  lines.push('- 按"本章梗概"把这一章的内容写出来，情节推进、场景与对话要完整。');
  lines.push('- 不要调用任何工具，不要反问，不要输出计划或步骤说明，直接给出最终正文。');
  lines.push(`- 再说一次篇幅：正文 ${minWords}～${maxWords} 字，到 ${maxWords} 字就停笔，不要用重复段落凑字。`);
  lines.push('- 与世界观、角色、势力、物品、事件和人物关系保持一致，不要引入与快照冲突的设定。');
  return lines.join('\n');
}

function deducePrompt(project, chapter) {
  const target = chapter
    ? chapter
    : { chapterId: '', startDay: Number(project.timeline.cursor) || 0, durationDays: 0, index: (project.chapters || []).length };
  const { snapshot } = snapshotDistance(project, target);
  const lines = [];
  lines.push('你是这部小说的剧情推演器。请依据最近的世界快照，以及从该快照之后已经写过的各章梗概，推演下一章的大纲。');
  lines.push('只输出一个 JSON 对象，不要任何额外文字。');
  lines.push('');
  lines.push('【最近的世界快照】');
  lines.push(snapshotBlock(snapshot));
  lines.push('');
  const stretch = stretchLines(project, target, snapshot);
  if (stretch.length) lines.push(...stretch);
  lines.push('【输出 JSON 结构】');
  lines.push('{"synopsis": "本章梗概，300 字以内，包含起因、经过、转折", "durationDays": 30, "minWords": 1200, "maxWords": 3500, "title": "本章标题"}');
  lines.push('');
  lines.push('durationDays 必须是不小于 1 的整数；maxWords 必须大于 minWords。');
  lines.push('不要调用任何工具，不要反问，只输出这个 JSON。');
  return lines.join('\n');
}

function snapshotPrompt(project, previous, chapters, pointDay) {
  const lines = [];
  lines.push(`你是这部小说的世界观维护者。当前要产出第 ${pointDay} 天的世界快照。`);
  lines.push('请阅读以下章节梗概，输出更新后的世界快照。只输出一个 JSON 对象，不要任何额外文字。');
  lines.push('');
  if (previous) {
    lines.push('【上一版世界快照】');
    lines.push(snapshotBlock(previous));
    lines.push('');
  }
  lines.push('【这段时间的新章节】');
  if (chapters.length === 0) {
    lines.push('（这段时间没有已完成的章节：沿用上一版设定，只按时间推进做必要的细微更新。）');
    lines.push('');
  }
  for (const chapter of chapters) {
    const window = chapterWindow(project, chapter);
    lines.push(`--- 第 ${chapter.index + 1} 章 ${chapter.title || ''}（第 ${window.start} → ${window.end} 天，${dateForDay(project, window.start)} 至 ${dateForDay(project, window.end)}）---`);
    const synopsis = ((chapter.outline && chapter.outline.synopsis) || '').trim();
    if (synopsis !== '') {
      lines.push(`梗概：${synopsis}`);
    } else {
      const body = String(chapter.content || '');
      lines.push('梗概：（无，以下为正文节选）');
      lines.push(body.length > 2000 ? `${body.slice(0, 2000)}\n（后文省略）` : body);
    }
    lines.push('');
  }
  lines.push('【输出 JSON 结构】');
  lines.push('{"world":"世界观，按时间推进更新，500 字以内","characters":[{"name":"","desc":""}],"factions":[{"name":"","desc":""}],"relations":["A B 敌对"],"items":[{"name":"","desc":""}],"events":[{"day":30,"title":"","desc":""}],"summary":"这段时期发生的关键变化"}');
  lines.push('');
  lines.push('要求：');
  lines.push('- 保留上一版中尚未被推翻的设定；角色、势力要包含新登场者；关系用「甲 乙 关系」三段式。');
  lines.push('- items 必填：列出这段时间出现、易手或状态变化的关键物品（法宝、信物、丹药、线索等），每项 name + desc（下落/归属/用途）。');
  lines.push(`- events 必填：这段时间每发生一件值得记录的事就写一条，day 为故事天数（整数，0~${pointDay}），title 一行，desc 一两句，按 day 从大到小排列。只要这段时间有章节内容，就至少写 1 条。`);
  lines.push('- 只有这段时间确实没有任何可记录的物品或事件时，才给空数组。');
  lines.push('注意：输出的 JSON 必须同时包含 items 与 events 两个键，缺任何一个都算不合格（没有内容就写 []）。');
  lines.push('不要调用任何工具，不要反问，只输出这个 JSON。');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ jobs */

function createJobRegistry() {
  const jobs = new Map();
  const put = (job) => {
    jobs.set(job.jobId, job);
    return job;
  };
  const sweep = () => {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of jobs) {
      if ((job.finishedAt || job.startedAt) < cutoff) jobs.delete(id);
    }
  };
  return { jobs, put, sweep, get: (id) => jobs.get(id) };
}

/**
 * Stop a running job: cancel the work's agent turn, and mark the job so the
 * Client stops polling it.
 */
async function cancelJob(ctx, root, registry, body) {
  const jobId = asText(body.jobId);
  const job = registry.get(jobId);
  if (!job) throw httpError(404, '任务不存在或已过期');
  const controller = ctx.get('sessionController');
  let cancelled = false;
  if (controller && job.projectId) {
    try {
      const project = await readProject(root, job.projectId);
      if (project.sessionId) {
        controller.cancel({ sessionId: project.sessionId });
        cancelled = true;
      }
    } catch {
      cancelled = false;
    }
  }
  if (job.state === 'running') {
    job.state = 'error';
    job.error = '已手动停止';
    job.message = '已手动停止';
    job.finishedAt = Date.now();
  }
  return { cancelled, jobId };
}

function startJob(registry, spec, run) {
  const job = registry.put({
    jobId: randomUUID(),
    kind: spec.kind,
    projectId: spec.projectId,
    chapterId: spec.chapterId || null,
    state: 'running',
    message: '开始',
    result: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  });
  Promise.resolve()
    .then(() => run(job))
    .then((result) => {
      job.state = 'done';
      job.message = '完成';
      job.result = result === undefined ? null : result;
      job.finishedAt = Date.now();
    })
    .catch((error) => {
      job.state = 'error';
      job.error = error instanceof Error ? error.message : String(error);
      job.message = job.error;
      job.finishedAt = Date.now();
    });
  return job;
}

/* ------------------------------------------------------------- endpoints */

async function bootstrap(ctx, root) {
  const controller = ctx.get('sessionController');
  const presets = ctx.get('agentPresets');
  let modelCatalog = { default: null, groups: [], failures: [] };
  if (controller && typeof controller.modelCatalog === 'function') {
    try {
      modelCatalog = await controller.modelCatalog();
    } catch (error) {
      modelCatalog = { default: null, groups: [], failures: [{ id: 'novel', name: '模型目录', message: String(error) }] };
    }
  }
  let presetList = [];
  if (presets && typeof presets.list === 'function') {
    try {
      const list = await presets.list();
      presetList = (Array.isArray(list) ? list : []).map((preset) => ({
        id: preset.id,
        name: preset.name || preset.id,
        description: preset.description || '',
      }));
    } catch {
      presetList = [];
    }
  }
  const projects = await listProjects(root);
  // Repair projects created before sessions were placed in the sidebar group,
  // and stamp works made before folders carried an ownership mark.
  const workspaceRegistry = ctx.get('workspaceRegistry');
  if (workspaceRegistry) tidyWorkspaceGroups(workspaceRegistry).catch(() => {});
  for (const project of projects) {
    try {
      await ensureWorkspace(ctx, root, project);
    } catch {
      // A missing directory or an older harness simply leaves the session as is.
    }
    try {
      // Stamp a folder that already exists; a work whose folder was never
      // written (or was deleted on purpose) is left alone.
      await stat(projectContentDir(project));
      if (!(await ownsWorkFolder(project))) await stampWorkFolder(project);
    } catch {
      // An unreachable folder simply stays unstamped.
    }
    try {
      if (!(await ownsWorkFolder(project)) && !(await pathExists(projectContentDir(project)))) {
        // A work created before folders were materialised gets one now.
        await persistProject(root, await readProject(root, project.projectId));
      }
    } catch {
      // Best effort; the next save materialises it anyway.
    }
  }
  return {
    revision: '2026-10-27.5',
    projects,
    models: {
      default: modelCatalog.default || null,
      groups: (modelCatalog.groups || []).map((group) => ({
        id: group.id,
        name: group.name || group.id,
        models: (group.models || []).map((model) => ({
          id: model.id,
          name: model.name || model.id,
          description: model.description || '',
          reasoning: model.reasoning || null,
        })),
      })),
      failures: modelCatalog.failures || [],
    },
    presets: presetList,
  };
}

async function createProject(ctx, root, body) {
  const controller = ctx.get('sessionController');
  if (controller === undefined) throw httpError(503, '当前部署缺少 sessionController 服务，无法创建会话');
  // The title is required and becomes a folder name inside the chosen
  // directory, so an empty or illegal one is refused rather than defaulted.
  const title = asText(body.title);
  const titleIssue = titleProblem(title);
  if (titleIssue !== null) throw httpError(400, titleIssue);
  const cwd = asText(body.cwd);
  if (cwd === '') throw httpError(400, '请先选择作品的工作目录');
  const agentPreset = asText(body.agentPreset) || undefined;
  const model = body.model && asText(body.model.provider) && asText(body.model.model)
    ? {
      provider: asText(body.model.provider),
      model: asText(body.model.model),
      ...(asText(body.model.reasoningEffort) ? { reasoningEffort: asText(body.model.reasoningEffort) } : {}),
    }
    : null;

  // Claim the work folder before anything else, so a name clash costs neither a
  // session nor a half-written project.
  const projectId = randomUUID();
  try {
    await reserveWorkFolder({ projectId, title, cwd }, projectId);
  } catch (error) {
    if (error && error.status) throw error;
    throw httpError(400, `无法在工作目录下创建作品文件夹：${error instanceof Error ? error.message : String(error)}`);
  }

  const created = await controller.create(agentPreset === undefined ? { cwd } : { cwd, agentPreset });
  const sessionId = created && created.sessionId ? created.sessionId : null;
  let warning = null;
  if (sessionId && model) {
    try {
      await controller.selectModel({ sessionId, ...model });
    } catch (error) {
      warning = `会话已创建，但模型选择没有生效：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const today = new Date();
  const origin = today.toISOString().slice(0, 10);
  const project = {
    projectId,
    title,
    cwd,
    agentPreset: agentPreset || created.agentPreset || null,
    model,
    sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    timeline: { unitDays: 30, cursor: 0, origin },
    snapshots: [],
    chapters: [],
  };
  await writeJson(projectFile(root, project.projectId), project);
  // Write the stamp and 作品信息.md right away: the folder exists the moment the
  // work does, instead of appearing on the first chapter.
  await persistProject(root, project);

  // Put the session in a sidebar workspace instead of leaving it ungrouped.
  let workspace = null;
  try {
    workspace = await ensureWorkspace(ctx, root, project);
  } catch (error) {
    const message = `会话已创建，但没能放进「${WORKSPACE_TITLE}」分组：${error instanceof Error ? error.message : String(error)}`;
    warning = warning === null ? message : `${warning} ${message}`;
  }
  return {
    project: summarize(project),
    detail: project,
    warning,
    workspace: workspace ? { workspaceId: workspace.id, title: workspace.title, path: workspace.path } : null,
  };
}

/**
 * Give the work a brand-new Session on demand.
 *
 * Archiving leaves a session resolvable but unusable for new turns, and the
 * registry exposes no "is archived" query, so the user gets an explicit button
 * instead of the plugin guessing.
 */
async function rebindProject(ctx, root, body) {
  const projectId = asText(body.projectId);
  if (projectId === '') throw httpError(400, '缺少 projectId');
  const project = await readProject(root, projectId);
  const previous = project.sessionId;
  const { controller } = await rebindSession(ctx, root, project);
  let agentReady = true;
  try {
    const result = await controller.resolveAgent(project.sessionId);
    agentReady = Boolean(result && result.agent);
  } catch {
    agentReady = false;
  }
  return {
    sessionId: project.sessionId,
    previousSessionId: previous,
    agentReady,
    project: summarize(await readProject(root, projectId)),
  };
}

/**
 * Change a project's model and carry it into the project's own Session, the
 * same switch the chat UI's model picker performs.
 */
async function updateModel(ctx, root, body) {
  const projectId = asText(body.projectId);
  const provider = asText(body.model && body.model.provider);
  const model = asText(body.model && body.model.model);
  const reasoningEffort = asText(body.model && body.model.reasoningEffort);
  if (provider === '' || model === '') throw httpError(400, '请选择要切换的模型');
  const next = { provider, model, ...(reasoningEffort === '' ? {} : { reasoningEffort }) };

  const project = await readProject(root, projectId);
  let warning = null;
  if (project.sessionId) {
    const controller = ctx.get('sessionController');
    if (controller && typeof controller.selectModel === 'function') {
      try {
        await controller.selectModel({ sessionId: project.sessionId, ...next });
      } catch (error) {
        warning = `作品已记录该模型，但会话切换失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  const projectSummary = await mutateProject(root, projectId, (draft) => {
    draft.model = next;
    return summarize(draft);
  });
  return { project: projectSummary, warning };
}

/**
 * Move one work's folder to another directory and repoint the work at it.
 *
 * The folder is the work: chapter text, outlines and snapshots travel with it.
 * A destination that already holds someone else's files is refused, exactly as
 * creation refuses it.
 */
async function moveProject(ctx, root, body) {
  const projectId = asText(body.projectId);
  if (projectId === '') throw httpError(400, '缺少 projectId');
  const cwd = asText(body.cwd);
  if (cwd === '') throw httpError(400, '请选择新的工作目录');
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch {
    throw httpError(400, '新的工作目录不存在或不是文件夹');
  }
  const project = await readProject(root, projectId);
  if (path.resolve(cwd) === path.resolve(project.cwd)) {
    throw httpError(409, '新旧工作目录相同，无需移动');
  }
  const from = projectContentDir(project);
  const to = join(cwd, safeSegment(project.title, '未命名作品'));
  const claimed = await reserveWorkFolder({ projectId, title: project.title, cwd }, projectId);
  if (path.resolve(claimed) !== path.resolve(to)) {
    throw httpError(409, `目标目录下已经有名为「${basename(to)}」的文件夹，请先在那边清空或删掉`);
  }
  if (await pathExists(from)) {
    await moveTree(from, to);
  }
  const moved = await mutateProject(root, projectId, (draft) => {
    draft.cwd = cwd;
    draft.updatedAt = Date.now();
    return summarize(draft);
  });
  await persistProject(root, await readProject(root, projectId));
  return { project: moved, from, to };
}

/** Copy-then-delete move that also works across drives. */
async function moveTree(from, to) {
  try {
    await rename(from, to);
    return;
  } catch {
    // Cross-device rename fails; fall through to a copy.
  }
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await moveTree(source, target);
    else await rename(source, target).catch(async () => {
      await writeFile(target, await readFile(source));
      await unlink(source);
    });
  }
  await rm(from, { recursive: true, force: true });
}

/**
 * Adopt a work folder that lives outside the plugin's index — the manual
 * migration path, and the way back from a lost `.dsh/novel-studio` data
 * directory. Chapters, outlines and snapshots are read back from the files.
 */
async function importProject(ctx, root, body) {
  const cwd = asText(body.cwd);
  const folder = asText(body.folder);
  if (cwd === '' || folder === '') throw httpError(400, '请填写工作目录与作品文件夹名');
  const dir = join(cwd, folder);
  let info;
  try {
    info = await stat(dir);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch {
    throw httpError(400, `找不到作品文件夹：${dir}`);
  }
  const title = folder;
  const titleIssue = titleProblem(title);
  if (titleIssue !== null) throw httpError(400, titleIssue);

  const existing = (await listProjects(root)).find((entry) => path.resolve(entry.cwd) === path.resolve(cwd) && entry.title === title);
  if (existing) throw httpError(409, '这部作品已经导入过了');

  const files = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.md'));
  let subtitle = '';
  try {
    const infoText = await readFile(join(dir, '作品信息.md'), 'utf8');
    const match = infoText.match(/#\s*作品[：:]\s*(.+)/u);
    if (match) subtitle = match[1].trim();
  } catch {
    // No 作品信息.md: the folder name is the title.
  }

  const chapters = [];
  const outlineDir = join(dir, '章节大纲');
  let outlineNames = [];
  try {
    outlineNames = (await readdir(outlineDir)).filter((name) => name.endsWith('.md'));
  } catch {
    outlineNames = [];
  }
  let runningStart = 0;
  const sorted = outlineNames
    .map((name) => ({ name, index: Number((name.match(/第(\d+)章/u) || [])[1] || 0) }))
    .filter((entry) => entry.index > 0)
    .sort((a, b) => a.index - b.index);
  for (const entry of sorted) {
    let text = '';
    try {
      text = await readFile(join(outlineDir, entry.name), 'utf8');
    } catch {
      continue;
    }
    const heading = (text.match(/^#\s*第\s*\d+\s*章\s*(.*)$/mu) || [])[1] || '';
    const span = text.match(/故事时间：第\s*(\d+)\s*→\s*(\d+)\s*天/u);
    const words = text.match(/字数要求：\s*(\d+)\s*[–-]\s*(\d+)/u);
    const synopsisMin = text.match(/梗概最低字数：\s*(\d+)/u);
    const synopsis = (text.split('## 故事梗概')[1] || '').trim();
    const startDay = span ? Number(span[1]) : runningStart;
    const endDay = span ? Number(span[2]) : startDay + 30;
    runningStart = endDay;
    const chapterTitle = heading.trim() || `第 ${entry.index} 章`;
    let content = '';
    const bodyName = files.find((name) => name.startsWith(`第${String(entry.index).padStart(2, '0')}章`));
    if (bodyName) {
      try {
        content = await readFile(join(dir, bodyName), 'utf8');
      } catch {
        content = '';
      }
    }
    chapters.push({
      chapterId: randomUUID(),
      index: entry.index - 1,
      title: chapterTitle,
      startDay,
      durationDays: Math.max(1, endDay - startDay),
      outline: {
        synopsis,
        synopsisMinChars: synopsisMin ? Number(synopsisMin[1]) : 100,
        durationDays: Math.max(1, endDay - startDay),
        minWords: words ? Number(words[1]) : 1200,
        maxWords: words ? Number(words[2]) : 3500,
        savedAt: Date.now(),
      },
      content,
      wordCount: wordCount(content),
      status: content.trim() === '' ? 'outlined' : 'generated',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      generatedAt: content.trim() === '' ? null : Date.now(),
    });
  }

  const snapshots = [];
  const snapshotDir = join(dir, '世界快照');
  let snapshotNames = [];
  try {
    snapshotNames = (await readdir(snapshotDir)).filter((name) => name.endsWith('.json'));
  } catch {
    snapshotNames = [];
  }
  for (const name of snapshotNames.sort()) {
    try {
      const data = JSON.parse(await readFile(join(snapshotDir, name), 'utf8'));
      const day = Number((name.match(/第(\d+)天/u) || [])[1] || 0);
      const normalized = normalizeSnapshot(data);
      snapshots.push({
        snapshotId: randomUUID(),
        day,
        createdAt: Date.now(),
        unitDays: Number(data.unitDays) || 30,
        ...normalized,
      });
    } catch {
      // A malformed sidecar is skipped, not fatal.
    }
  }
  snapshots.sort((a, b) => a.day - b.day);

  const unitDays = snapshots.length ? snapshots[snapshots.length - 1].unitDays : 30;
  const project = {
    projectId: randomUUID(),
    title,
    cwd,
    agentPreset: null,
    model: null,
    sessionId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    timeline: {
      unitDays,
      cursor: Math.max(lastChapterEnd({ chapters }), snapshots.length ? snapshots[snapshots.length - 1].day : 0),
      origin: new Date().toISOString().slice(0, 10),
      cursorUnit: 'day',
    },
    chapters,
    snapshots,
  };
  await writeJson(projectFile(root, project.projectId), project);
  await persistProject(root, project);
  const created = await createSessionFor(ctx, root, project);
  return {
    project: summarize(await readProject(root, project.projectId)),
    imported: { chapters: chapters.length, snapshots: snapshots.length, subtitle },
    sessionId: created,
  };
}

/** Give a freshly imported work its own session (best effort). */
async function createSessionFor(ctx, root, project) {
  const controller = ctx.get('sessionController');
  if (!controller) return null;
  try {
    const created = await controller.create({ cwd: project.cwd });
    const sessionId = created && created.sessionId ? created.sessionId : null;
    if (!sessionId) return null;
    project.sessionId = sessionId;
    await mutateProject(root, project.projectId, (draft) => {
      draft.sessionId = sessionId;
    });
    await ensureWorkspace(ctx, root, project);
    return sessionId;
  } catch {
    return null;
  }
}

/**
 * Record the preset a work's session should run under.
 *
 * A session fixes its preset when it is created, so this only changes the record
 * the next session is built from — the Client says so after saving.
 */
async function updatePreset(ctx, root, body) {
  const projectId = asText(body.projectId);
  const requested = asText(body.agentPreset);
  if (requested !== '') {
    const presets = ctx.get('agentPresets');
    if (presets && typeof presets.list === 'function') {
      const list = await presets.list().catch(() => null);
      const known = Array.isArray(list) ? list.map((entry) => entry.id) : [];
      if (known.length && !known.includes(requested)) {
        throw httpError(400, `没有这个预设：${requested}`);
      }
    }
  }
  const project = await mutateProject(root, projectId, (draft) => {
    draft.agentPreset = requested === '' ? null : requested;
    draft.updatedAt = Date.now();
    return summarize(draft);
  });
  await exportProjectInfo(await readProject(root, projectId));
  return { project, appliesAfterRebuild: true };
}

async function updateTimeline(root, body) {
  const projectId = asText(body.projectId);
  const unitDays = Number(body.unitDays);
  const cursor = Number(body.cursor);
  const origin = asText(body.origin);
  return mutateProject(root, projectId, (project) => {
    if (Number.isFinite(unitDays) && unitDays >= 1) project.timeline.unitDays = Math.round(unitDays);
    if (Number.isFinite(cursor) && cursor >= 0) project.timeline.cursor = Math.round(cursor);
    if (/^\d{4}-\d{2}-\d{2}$/.test(origin)) project.timeline.origin = origin;
    project.timeline.cursorUnit = 'day';
    return summarize(project);
  });
}

function normalizeOutline(input) {
  const source = input && typeof input === 'object' ? input : {};
  const minWords = Math.max(1, Math.round(Number(source.minWords) || 800));
  const maxWords = Math.max(minWords, Math.round(Number(source.maxWords) || Math.max(minWords, 3000)));
  const durationDays = Math.max(1, Math.round(Number(source.durationDays) || 30));
  return {
    synopsis: asText(source.synopsis),
    minWords,
    maxWords,
    durationDays,
    synopsisMinChars: Math.max(1, Math.round(Number(source.synopsisMinChars) || 100)),
    savedAt: Date.now(),
  };
}

function nextChapterIndex(project) {
  let max = -1;
  for (const chapter of project.chapters) {
    if (Number.isFinite(chapter.index) && chapter.index > max) max = chapter.index;
  }
  return max + 1;
}

async function saveOutline(root, body) {
  const projectId = asText(body.projectId);
  const chapterId = asText(body.chapterId);
  const outline = normalizeOutline(body.outline);
  const title = asText(body.title);
  const startDay = Number.isFinite(Number(body.startDay))
    ? Math.max(0, Math.round(Number(body.startDay)))
    : null;
  let savedProject = null;
  let savedChapter = null;
  let renamedFrom = null;
  const result = await mutateProject(root, projectId, (project) => {
    let chapter = chapterId === '' ? null : project.chapters.find((entry) => entry.chapterId === chapterId);
    if (!chapter) {
      chapter = {
        chapterId: randomUUID(),
        index: nextChapterIndex(project),
        title: title || `第 ${nextChapterIndex(project) + 1} 章`,
        startDay: startDay === null ? lastChapterEnd(project) : startDay,
        durationDays: outline.durationDays,
        outline: null,
        content: '',
        wordCount: 0,
        status: 'draft',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        generatedAt: null,
      };
      project.chapters.push(chapter);
    } else {
      renamedFrom = { index: chapter.index, title: chapter.title };
    }
    if (title !== '') chapter.title = title;
    chapter.outline = outline;
    chapter.durationDays = outline.durationDays;
    if (chapter.status === 'draft') chapter.status = 'outlined';
    chapter.updatedAt = Date.now();
    savedProject = project;
    savedChapter = chapter;
    return { chapter, project: summarize(project) };
  });
  // A renamed chapter gets its file renamed too, so the folder is not littered
  // with the previous title.
  if (savedChapter && (renamedFrom === null
    ? false
    : renamedFrom.title !== savedChapter.title || renamedFrom.index !== savedChapter.index)) {
    await removeChapterFile(savedProject, renamedFrom);
  }
  if (savedChapter && String(savedChapter.content || '').trim() !== '') {
    await exportChapter(savedProject, savedChapter, savedChapter.content);
  } else if (savedChapter) {
    await exportChapterOutline(savedProject, savedChapter);
    await exportProjectInfo(savedProject);
  }
  return result;
}

async function saveChapter(root, body) {
  const projectId = asText(body.projectId);
  const chapterId = asText(body.chapterId);
  const content = typeof body.content === 'string' ? body.content : '';
  const title = asText(body.title);
  let savedProject = null;
  let savedChapter = null;
  const result = await mutateProject(root, projectId, (project) => {
    const chapter = project.chapters.find((entry) => entry.chapterId === chapterId);
    if (!chapter) throw httpError(404, `章节不存在: ${chapterId}`);
    chapter.content = content;
    chapter.wordCount = wordCount(content);
    if (title !== '') chapter.title = title;
    chapter.status = chapter.generatedAt ? 'edited' : 'edited';
    chapter.updatedAt = Date.now();
    savedProject = project;
    savedChapter = chapter;
    return { chapter: { ...chapter, content: undefined }, project: summarize(project) };
  });
  await exportChapter(savedProject, savedChapter, content);
  return result;
}

/** Display name the plugin gives the sidebar workspace that holds its sessions. */
const WORKSPACE_TITLE = '小说工坊';
/** Projects whose session is already accounted for in this process. */
const ensuredWorkspaces = new Set();

/**
 * Put a project's session under a sidebar workspace titled 小说工坊.
 *
 * DSH groups sessions by directory: a workspace owns one canonical path, and a
 * session only shows under the workspace matching its cwd. Works in different
 * directories therefore need different groups, so each group is titled with its
 * directory to keep them apart.
 */
async function ensureWorkspace(ctx, root, project) {
  const registry = ctx.get('workspaceRegistry');
  if (!registry || !project || !project.sessionId || !project.cwd) return null;
  if (ensuredWorkspaces.has(project.projectId)) return null;

  const attached = registry.list()
    .some((workspace) => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(project.sessionId));
  if (attached) {
    ensuredWorkspaces.add(project.projectId);
    return null;
  }
  let workspace;
  try {
    workspace = await registry.resolveByPath(project.cwd);
  } catch {
    workspace = undefined;
  }
  if (!workspace) {
    const label = project.cwd.split(/[\\/]/).filter(Boolean).pop() || '根目录';
    workspace = await registry.create(project.cwd, `${WORKSPACE_TITLE} · ${label}`);
  }
  await workspace.attachSession(project.sessionId);
  ensuredWorkspaces.add(project.projectId);
  return workspace;
}

/** Remove empty groups this plugin leaves behind; never touches a used one. */
async function tidyWorkspaceGroups(registry) {
  for (const workspace of registry.list()) {
    if (!workspace.title.startsWith(WORKSPACE_TITLE)) continue;
    const sessions = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
    if (sessions.length === 0) {
      try {
        await registry.delete(workspace.id);
      } catch {
        // Leaving one empty group is harmless.
      }
      continue;
    }
    // A group rooted in the OS temp directory can only be a leftover from a
    // throwaway test work: archive what it holds, then drop the group.
    if (!workspace.path.toLowerCase().startsWith(tmpdir().toLowerCase())) continue;
    for (const sessionId of sessions) {
      try {
        await registry.archiveSession(sessionId, { stopActivity: true });
      } catch {
        // An active session stays; the group stays with it.
      }
    }
    try {
      await registry.delete(workspace.id);
    } catch {
      // The group stays visible if it could not be removed.
    }
  }
}

/**
 * The grid point a new chapter brings the story to, or null when nothing new is
 * due. A chapter spanning several points targets the last point it covers; the
 * cascade then fills each point in between from the previous snapshot, so the
 * unfinished chapter that straddles them never becomes its own material.
 */
function autoSnapshotTarget(project, chapterEndDay) {
  const unit = Math.max(1, project.timeline.unitDays || 30);
  const point = Math.floor(Math.max(0, chapterEndDay) / unit) * unit;
  if (point < unit) return null;
  const latest = (project.snapshots || []).reduce((max, snapshot) => Math.max(max, snapshot.day), 0);
  return point > latest ? point : null;
}

/** Story day where the next chapter continues: the end of the last chapter. */
function lastChapterEnd(project) {
  let end = 0;
  for (const chapter of project.chapters || []) {
    end = Math.max(end, chapterWindow(project, chapter).end);
  }
  return end;
}

/**
 * Story-time facts the Client renders the timeline from: where the last snapshot
 * sits, how far the story has been written, and the day the next snapshot falls
 * due under the project's own unit.
 */
function withTimelineFacts(project) {
  const snapshots = project.snapshots || [];
  const last = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const unitDays = Math.max(1, project.timeline.unitDays || 30);
  const latestSnapshotDay = last ? last.day : 0;
  return {
    ...project,
    timelineFacts: {
      unitDays,
      latestSnapshotDay,
      storyEnd: lastChapterEnd(project),
      // The next point on the *current* interval's grid, not "last + unit":
      // after an interval change the grid moves under the existing snapshots.
      nextSnapshotDay: Math.floor(latestSnapshotDay / unitDays) * unitDays + unitDays,
      snapshotDays: snapshots.map((snapshot) => snapshot.day),
      // Every grid point up to the story's end, so the Client can mark them.
      gridDays: Array.from(
        { length: Math.max(0, Math.floor(lastChapterEnd(project) / unitDays)) },
        (_, index) => (index + 1) * unitDays,
      ),
    },
  };
}

/** The chapter this one follows, by start day. */
function previousChapter(project, chapter) {
  return (project.chapters || [])
    .filter((entry) => entry.chapterId !== chapter.chapterId && entry.startDay <= chapter.startDay)
    .sort((a, b) => b.startDay - a.startDay)[0] || null;
}

/**
 * Chapters that belong to the stretch `(fromDay, point]`: fully written up to
 * the point, so a chapter that straddles it (the one still being written) is
 * left out. The chapter starting exactly at `fromDay` is included.
 */
function chaptersForPoint(project, fromDay, point) {
  return (project.chapters || [])
    .filter((chapter) => {
      const span = chapterWindow(project, chapter);
      if (span.end > point || span.end <= fromDay) return false;
      return ((chapter.outline && chapter.outline.synopsis) || '').trim() !== ''
        || String(chapter.content || '').trim() !== '';
    })
    .sort((a, b) => a.startDay - b.startDay);
}

/**
 * Fill every interval point from the newest existing snapshot up to `targetDay`,
 * one snapshot per point, each built from the snapshot before it plus the
 * chapters of that stretch. Long gaps (a jump of several points) therefore fill
 * in order instead of skipping to the end.
 */
function registerSnapshot(ctx, root, registry, projectId, targetDay) {
  return startJob(registry, { kind: 'snapshot', projectId }, async (job) => {
    // The sequence is fixed from the state at the start of the job: recomputing
    // it every round would regenerate the last point forever once it exists.
    const initial = await readProject(root, projectId);
    const unit = Math.max(1, initial.timeline.unitDays || 30);
    const target = Math.floor(Math.max(1, Math.round(Number(targetDay) || 0)) / unit) * unit;
    if (target < unit) throw httpError(409, '目标时间还不到一个快照间隔，无法生成世界快照');
    const startBase = (initial.snapshots || []).filter((snapshot) => snapshot.day < target).pop() || null;
    let first = (startBase ? startBase.day : 0) + unit;
    // Nothing new below the target means "redo the target point itself".
    if (first > target) first = target;
    const points = [];
    for (let point = first; point <= target; point += unit) points.push(point);

    const made = [];
    for (const point of points) {
      const project = await readProject(root, projectId);
      const base = (project.snapshots || []).filter((snapshot) => snapshot.day < point).pop() || null;
      const chapters = chaptersForPoint(project, base ? base.day : 0, point);
      job.message = `正在生成第 ${point} 天的世界快照（第 ${made.length + 1}/${points.length} 份，目标第 ${target} 天）`;
      const reply = await askAgent(ctx, root, project, snapshotPrompt(project, base, chapters, point), (note) => {
        job.message = note;
      });
      const parsed = parseJsonReply(reply);
      if (!parsed) throw httpError(502, '模型没有返回可解析的快照 JSON');
      const normalized = normalizeSnapshot(parsed);
      if (normalized.world === '' && normalized.characters.length === 0 && normalized.factions.length === 0) {
        throw httpError(502, '模型返回的快照为空');
      }
      // A chapter boundary is a fact of the work itself, so it seeds the event
      // list even when the model leaves `events` empty; model-written events win
      // by title and anything else is added.
      const seeded = chapters.map((chapter) => {
        const span = chapterWindow(project, chapter);
        return {
          day: span.end,
          title: chapter.title || `第 ${chapter.index + 1} 章`,
          desc: ((chapter.outline && chapter.outline.synopsis) || '').slice(0, 120),
        };
      });
      const known = new Set(normalized.events.map((event) => event.title));
      for (const event of seeded) {
        if (!known.has(event.title)) {
          normalized.events.push(event);
          known.add(event.title);
        }
      }
      normalized.events.sort((a, b) => (b.day === null ? -1 : b.day) - (a.day === null ? -1 : a.day));
      const snapshot = {
        snapshotId: randomUUID(),
        day: point,
        createdAt: Date.now(),
        unitDays: unit,
        ...normalized,
      };
      await mutateProject(root, projectId, (draft) => {
        // One snapshot per day: regenerating replaces the one already there.
        draft.snapshots = (draft.snapshots || []).filter((entry) => entry.day !== point);
        draft.snapshots.push(snapshot);
        draft.snapshots.sort((a, b) => a.day - b.day);
        return snapshot;
      });
      await exportSnapshot(project, snapshot);
      made.push(point);
    }
    await exportProjectInfo(await readProject(root, projectId));
    return { made, target };
  });
}

/** Wipe every snapshot (and its files) so the work can be rebuilt from day 1. */
async function startSnapshotReset(ctx, root, registry, body) {
  const projectId = asText(body.projectId);
  // Validate before queueing, like the other job routes: an unknown work must
  // come back as a plain 404 instead of a job that fails a second later.
  const preview = await readProject(root, projectId);
  const previewUnit = Math.max(1, preview.timeline.unitDays || 30);
  if (Math.floor(lastChapterEnd(preview) / previewUnit) * previewUnit < previewUnit) {
    throw httpError(409, '故事还不到一个快照间隔，没有可重建的快照');
  }
  return startJob(registry, { kind: 'snapshot-reset', projectId }, async (job) => {
    const project = await readProject(root, projectId);
    const unit = Math.max(1, project.timeline.unitDays || 30);
    const storyEnd = lastChapterEnd(project);
    const target = Math.floor(storyEnd / unit) * unit;
    if (target < unit) throw httpError(409, '故事还不到一个快照间隔，没有可重建的快照');
    if (target / unit > 120) {
      throw httpError(409, `当前间隔只有 ${unit} 天，重建到第 ${target} 天需要 ${Math.floor(target / unit)} 次模型调用；请先把快照间隔调大一些再重置`);
    }
    job.message = '正在清除全部世界快照';
    await mutateProject(root, projectId, (draft) => {
      draft.snapshots = [];
    });
    try {
      await rm(join(projectContentDir(project), '世界快照'), { recursive: true, force: true });
    } catch {
      // Nothing to remove.
    }
    // Run the rebuild inside this same job so the Client polls one thing.
    const cascade = registerSnapshot(ctx, root, registry, projectId, target);
    while (cascade.state === 'running') {
      job.message = cascade.message || '正在重建世界快照';
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (cascade.state === 'error') throw httpError(502, cascade.error || '重建世界快照失败');
    return { target, made: (cascade.result && cascade.result.made) || [] };
  });
}

async function startGenerate(ctx, root, registry, body) {
  const projectId = asText(body.projectId);
  const chapterId = asText(body.chapterId);
  // Refuse before the job is queued, so the Client sees a plain 409 instead of
  // a job that fails a second later.
  const preview = await readProject(root, projectId);
  const claimed = preview.chapters.find((entry) => entry.chapterId === chapterId);
  if (!claimed) throw httpError(404, `章节不存在: ${chapterId}`);
  if (!claimed.outline) throw httpError(409, '请先在章节大纲里保存设定，再生成正文');
  assertSnapshotFresh(preview, claimed);
  return startJob(registry, { kind: 'generate', projectId, chapterId }, async (job) => {
    const project = await readProject(root, projectId);
    const chapter = project.chapters.find((entry) => entry.chapterId === chapterId);
    if (!chapter) throw httpError(404, `章节不存在: ${chapterId}`);
    if (!chapter.outline) throw httpError(409, '请先在章节大纲里保存设定，再生成正文');
    assertSnapshotFresh(project, chapter);
    const previous = project.chapters
      .filter((entry) => entry.chapterId !== chapter.chapterId && entry.startDay <= chapter.startDay)
      .sort((a, b) => b.startDay - a.startDay)[0] || null;
    job.message = '正在生成章节正文';
    const raw = await askStory(ctx, root, project, chapterPrompt(project, chapter, previous), (note) => {
      job.message = note;
    });
    const fitted = fitChapterText(raw, (chapter.outline && chapter.outline.maxWords) || 3000);
    const content = fitted.text;
    if (fitted.trimmed) job.message = '模型写超了字数，已按上限截断';
    const saved = await mutateProject(root, projectId, (draft) => {
      const target = draft.chapters.find((entry) => entry.chapterId === chapterId);
      if (!target) throw httpError(404, `章节不存在: ${chapterId}`);
      target.content = content;
      target.wordCount = wordCount(content);
      target.status = 'generated';
      target.generatedAt = Date.now();
      target.updatedAt = Date.now();
      return { ...target, content: undefined };
    });
    await exportChapter(project, saved, content);
    const window = chapterWindow(project, chapter);
    let snapshotJobId = null;
    const autoTarget = autoSnapshotTarget(project, window.end);
    if (autoTarget !== null) {
      snapshotJobId = registerSnapshot(ctx, root, registry, projectId, autoTarget).jobId;
    }
    return { chapter: saved, wordCount: wordCount(content), snapshotJobId };
  });
}

/**
 * Deduce the synopsis and the title, write the chapter, then run the same
 * snapshot check a generated chapter does. With `chapterId` it regenerates that
 * chapter in place (the outline page's 自动推演, which overwrites everything);
 * without it the job appends a new one (the new-chapter dialog).
 */
async function startCompose(ctx, root, registry, body) {
  const projectId = asText(body.projectId);
  // Same early refusal as writing: a stale snapshot stops the job from being
  // queued at all.
  const preview = await readProject(root, projectId);
  const claimedId = asText(body.chapterId);
  const claimed = claimedId === ''
    ? null
    : (preview.chapters || []).find((entry) => entry.chapterId === claimedId) || null;
  if (claimedId !== '' && !claimed) throw httpError(404, `章节不存在: ${claimedId}`);
  const claimedStart = claimed
    ? claimed.startDay
    : (Number.isFinite(Number(body.startDay)) ? Math.max(0, Math.round(Number(body.startDay))) : lastChapterEnd(preview));
  assertSnapshotFresh(preview, claimed || {
    chapterId: '',
    startDay: claimedStart,
    durationDays: Math.round(Number(body.durationDays) || 0) || 1,
    index: (preview.chapters || []).length,
  });
  return startJob(registry, { kind: 'compose', projectId }, async (job) => {
    const minWords = Math.round(Number(body.minWords) || 0);
    const maxWords = Math.round(Number(body.maxWords) || 0);
    const durationDays = Math.round(Number(body.durationDays) || 0);
    if (minWords < 1 || maxWords < 1 || durationDays < 1) {
      throw httpError(400, '请先填写章节最低字数、最多字数和时间长度');
    }
    if (maxWords < minWords) throw httpError(400, '最多字数不能小于最低字数');

    const project = await readProject(root, projectId);
    const existingId = asText(body.chapterId);
    const existing = existingId === ''
      ? null
      : (project.chapters || []).find((entry) => entry.chapterId === existingId) || null;
    if (existingId !== '' && !existing) throw httpError(404, `章节不存在: ${existingId}`);

    // The first chapter of a work has no snapshot and no previous chapter, so
    // there is nothing to deduce from: this stays refused, not just hidden.
    const firstChapter = [...(project.chapters || [])]
      .sort((a, b) => a.startDay - b.startDay || a.index - b.index)[0] || null;
    if (existing ? existing.chapterId === (firstChapter && firstChapter.chapterId) : firstChapter === null) {
      throw httpError(409, '第一章没有可依据的世界快照和上一章，自动推演不可用');
    }

    const startDay = existing
      ? existing.startDay
      : (Number.isFinite(Number(body.startDay))
        ? Math.max(0, Math.round(Number(body.startDay)))
        : lastChapterEnd(project));
    const draft = {
      chapterId: existing ? existing.chapterId : randomUUID(),
      index: existing ? existing.index : nextChapterIndex(project),
      title: asText(body.title),
      startDay,
      durationDays,
      outline: null,
    };
    const previous = previousChapter(project, draft);
    assertSnapshotFresh(project, draft);

    job.message = '正在推演本章梗概与名称';
    const deduceReply = await askAgent(ctx, root, project, deducePrompt(project, draft), (note) => {
      job.message = note;
    });
    const deduced = parseJsonReply(deduceReply) || {};
    const synopsis = asText(firstOf(deduced, ['synopsis', '梗概', '本章梗概']));
    if (synopsis === '') throw httpError(502, '模型没有给出章节梗概');
    const title = draft.title
      || asText(firstOf(deduced, ['title', '标题']))
      || (existing && existing.title)
      || `第 ${draft.index + 1} 章`;
    const outline = {
      synopsis,
      minWords,
      maxWords,
      durationDays,
      synopsisMinChars: Math.min(100, Math.max(20, synopsis.length)),
      savedAt: Date.now(),
    };

    const chapterId = await mutateProject(root, projectId, (current) => {
      const target = current.chapters.find((entry) => entry.chapterId === draft.chapterId);
      if (target) {
        target.title = title;
        target.durationDays = durationDays;
        target.outline = outline;
        target.updatedAt = Date.now();
      } else {
        current.chapters.push({
          ...draft,
          title,
          outline,
          content: '',
          wordCount: 0,
          status: 'outlined',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          generatedAt: null,
        });
      }
      return draft.chapterId;
    });

    job.message = '正在生成章节正文';
    const fresh = await readProject(root, projectId);
    const target = fresh.chapters.find((entry) => entry.chapterId === chapterId);
    if (!target) throw httpError(500, '章节写入失败');
    const raw = await askStory(ctx, root, fresh, chapterPrompt(fresh, target, previous), (note) => {
      job.message = note;
    });
    const fitted = fitChapterText(raw, (target.outline && target.outline.maxWords) || 3000);
    const content = fitted.text;
    if (fitted.trimmed) job.message = '模型写超了字数，已按上限截断';

    await mutateProject(root, projectId, (current) => {
      const entry = current.chapters.find((item) => item.chapterId === chapterId);
      if (!entry) throw httpError(500, '章节写入失败');
      entry.content = content;
      entry.wordCount = wordCount(content);
      entry.status = 'generated';
      entry.generatedAt = Date.now();
      entry.updatedAt = Date.now();
    });

    const after = await readProject(root, projectId);
    const written = after.chapters.find((item) => item.chapterId === chapterId);
    if (written) await exportChapter(after, written, content);
    const window = chapterWindow(after, target);
    let snapshotJobId = null;
    const autoTarget = autoSnapshotTarget(after, window.end);
    if (autoTarget !== null) {
      snapshotJobId = registerSnapshot(ctx, root, registry, projectId, autoTarget).jobId;
    }
    return {
      chapterId,
      title,
      synopsis,
      wordCount: wordCount(content),
      snapshotJobId,
    };
  });
}

async function startDeduce(ctx, root, registry, body) {
  const projectId = asText(body.projectId);
  const chapterId = asText(body.chapterId);
  // The outline page's 自动推演 follows the same freshness rule as writing, and
  // refuses before queuing as well.
  const preview = await readProject(root, projectId);
  const claimed = chapterId === '' ? null : preview.chapters.find((entry) => entry.chapterId === chapterId) || null;
  assertSnapshotFresh(preview, claimed || {
    chapterId: '',
    startDay: Number(preview.timeline.cursor) || lastChapterEnd(preview),
    durationDays: 0,
    index: (preview.chapters || []).length,
  });
  return startJob(registry, { kind: 'deduce', projectId, chapterId }, async (job) => {
    const project = await readProject(root, projectId);
    const chapter = chapterId === '' ? null : project.chapters.find((entry) => entry.chapterId === chapterId) || null;
    job.message = '正在推演下一章大纲';
    const reply = await askAgent(ctx, root, project, deducePrompt(project, chapter), (note) => {
      job.message = note;
    });
    const parsed = parseJsonReply(reply);
    if (!parsed) throw httpError(502, '模型没有返回可解析的大纲 JSON');
    const synopsis = asText(firstOf(parsed, ['synopsis', '梗概', '本章梗概']));
    const durationDays = Math.max(1, Math.round(Number(firstOf(parsed, ['durationDays', 'duration', '时间长度', 'days'])) || project.timeline.unitDays));
    const minWords = Math.max(1, Math.round(Number(firstOf(parsed, ['minWords', '最低字数'])) || 1200));
    const maxWords = Math.max(minWords + 1, Math.round(Number(firstOf(parsed, ['maxWords', '最多字数'])) || 3500));
    const title = asText(firstOf(parsed, ['title', '标题']));
    if (synopsis === '') throw httpError(502, '模型没有给出章节梗概');
    return { synopsis, durationDays, minWords, maxWords, title };
  });
}

/* --------------------------------------------------------------- routing */

function registerRoutes(ctx, root, registry) {
  const route = {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: '拒绝来自非本机页面的请求' });
        return;
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const path = url.pathname.slice(ROUTE_PREFIX.length) || '/';
      const method = request.method || 'GET';
      try {
        registry.sweep();
        const body = method === 'POST' ? await readJsonBody(request) : {};
        const data = await dispatch(ctx, root, registry, method, path, url, body);
        sendJson(response, 200, data);
      } catch (error) {
        const status = Number.isFinite(error && error.status) ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, status, { error: message });
      }
    },
  };
  return [ctx.webServer.register(route)];
}

async function dispatch(ctx, root, registry, method, path, url, body) {
  if (method === 'GET') {
    if (path === '/bootstrap') return bootstrap(ctx, root);
    if (path === '/project') {
      // Reading already hydrates prose/synopses/snapshots from the work folder.
      return withTimelineFacts(await readProject(root, String(url.searchParams.get('projectId') || '')));
    }
    if (path === '/job') {
      const job = registry.get(String(url.searchParams.get('id') || ''));
      if (!job) throw httpError(404, '任务不存在或已过期');
      return job;
    }
    throw httpError(404, `未知接口: ${path}`);
  }
  if (method !== 'POST') throw httpError(405, '只支持 GET 与 POST');
  switch (path) {
    case '/job/cancel':
      return cancelJob(ctx, root, registry, body);
    case '/project/create':
      return createProject(ctx, root, body);
    case '/project/delete': {
      const projectId = asText(body.projectId);
      if (projectId === '') throw httpError(400, '缺少 projectId');
      // Only a folder carrying this project's own stamp is removed: a folder
      // the user already had under the same name is never touched.
      let workDir = null;
      try {
        const project = await readProject(root, projectId);
        workDir = await discardWorkFolder(project);
      } catch {
        // A work whose folder is already gone still gets its record removed.
      }
      await rm(join(projectsDir(root), projectId), { recursive: true, force: true });
      return { removed: projectId, removedDir: workDir, folderKept: workDir === null };
    }
    case '/project/timeline':
      return updateTimeline(root, body);
    case '/project/model':
      return updateModel(ctx, root, body);
    case '/project/preset':
      return updatePreset(ctx, root, body);
    case '/project/rebind':
      return rebindProject(ctx, root, body);
    case '/project/move':
      return moveProject(ctx, root, body);
    case '/project/import':
      return importProject(ctx, root, body);
    case '/outline/save':
      return saveOutline(root, body);
    case '/chapter/save':
      return saveChapter(root, body);
    case '/generate':
      return startGenerate(ctx, root, registry, body);
    case '/compose':
      return startCompose(ctx, root, registry, body);
    case '/deduce':
      return startDeduce(ctx, root, registry, body);
    case '/snapshot/refresh': {
      const projectId = asText(body.projectId);
      const project = await readProject(root, projectId);
      const day = Number.isFinite(Number(body.day))
        ? Math.max(0, Math.round(Number(body.day)))
        : lastChapterEnd(project);
      return registerSnapshot(ctx, root, registry, projectId, day);
    }
    case '/snapshot/reset':
      return startSnapshotReset(ctx, root, registry, body);
    default:
      throw httpError(404, `未知接口: ${path}`);
  }
}

/* ------------------------------------------------------------------ apply */

export function apply(ctx, config) {
  const root = resolveRoot(config || {});
  const registry = createJobRegistry();
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = registerRoutes(host, root, registry);
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // A route already removed by its owner needs no second removal.
          }
        }
      };
    });
  });
}
