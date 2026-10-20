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
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const name = 'dsh-novel-generator';
export const inject = ['webServer'];

/** Exact API prefix; the Client half fetches below it. */
const ROUTE_PREFIX = '/dsh-novel-generator/api';
/** Largest accepted JSON body: a long chapter plus its outline. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** A generation can legitimately take minutes on a long chapter. */
const AGENT_TIMEOUT_MS = 20 * 60 * 1000;
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

/** The synopsis body of an outline card (`（还没有写梗概）` reads as empty). */
function parseSynopsis(text) {
  const marker = '## 故事梗概';
  const start = text.indexOf(marker);
  if (start === -1) return '';
  const rest = text.slice(start + marker.length);
  const next = rest.indexOf('\n## ');
  const body = (next === -1 ? rest : rest.slice(0, next)).trim();
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

/** Resolve (or resume) the ordinary Agent that owns one project's Session. */
async function resolveAgent(ctx, project) {
  const controller = ctx.get('sessionController');
  if (controller === undefined) throw httpError(503, '当前部署缺少 sessionController 服务，无法驱动创作会话');
  if (!project.sessionId) throw httpError(409, '这个作品还没有绑定会话');
  let result;
  try {
    result = await controller.resolveAgent(project.sessionId);
  } catch (error) {
    throw httpError(502, `无法恢复作品会话：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!result || !result.agent) {
    const code = result && result.error && result.error.code ? result.error.code : 'unknown';
    throw httpError(502, `无法恢复作品会话（${code}）`);
  }
  return { controller, agent: result.agent };
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

/** Send one prompt into the project's own Session and return the reply text. */
async function askAgent(ctx, project, prompt) {
  const { controller, agent } = await resolveAgent(ctx, project);
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
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    const text = textOfMessage(message);
    if (text !== '') return text;
  }
  throw httpError(502, '模型没有返回任何正文');
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
  const { snapshot } = snapshotDistance(project, chapter);
  const lines = [];
  lines.push('你现在是这部小说的执笔作者。只输出本章正文，不要解释、不要标题、不要分点提纲。');
  lines.push('');
  lines.push(`【本章】第 ${chapter.index + 1} 章 ${chapter.title || ''}（第 ${window.start}→${window.end} 天，跨度 ${chapter.durationDays} 天）`);
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
  lines.push(`- 字数控制在 ${outline.minWords || 800} 到 ${outline.maxWords || 3000} 字之间。`);
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
  for (const project of projects) {
    try {
      await ensureWorkspace(ctx, project);
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
    revision: '2026-10-20.32',
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
    workspace = await ensureWorkspace(ctx, project);
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
 * Put a project's session under a sidebar workspace instead of 未分组: reuse the
 * workspace that owns the project's directory, otherwise create one titled
 * 小说工坊 for it. Idempotent, so bootstrap can repair older projects too.
 */
async function ensureWorkspace(ctx, project) {
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
  if (!workspace) workspace = await registry.create(project.cwd, WORKSPACE_TITLE);
  await workspace.attachSession(project.sessionId);
  ensuredWorkspaces.add(project.projectId);
  return workspace;
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
      const reply = await askAgent(ctx, project, snapshotPrompt(project, base, chapters, point));
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
function startSnapshotReset(ctx, root, registry, body) {
  const projectId = asText(body.projectId);
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
    const content = await askAgent(ctx, project, chapterPrompt(project, chapter, previous));
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
    const deduceReply = await askAgent(ctx, project, deducePrompt(project, draft));
    const deduced = parseJsonReply(deduceReply) || {};
    const synopsis = asText(firstOf(deduced, ['synopsis', '梗概', 'summary']));
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
    const content = await askAgent(ctx, fresh, chapterPrompt(fresh, target, previous));

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
    const reply = await askAgent(ctx, project, deducePrompt(project, chapter));
    const parsed = parseJsonReply(reply);
    if (!parsed) throw httpError(502, '模型没有返回可解析的大纲 JSON');
    const synopsis = asText(firstOf(parsed, ['synopsis', '梗概', 'summary']));
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
