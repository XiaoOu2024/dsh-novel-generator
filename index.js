/**
 * dsh-novel-studio — Host half.
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
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-novel-studio';
export const inject = ['webServer'];

/** Exact API prefix; the Client half fetches below it. */
const ROUTE_PREFIX = '/dsh-novel-studio/api';
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
  return migrateProject(JSON.parse(text));
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
    await writeJson(projectFile(root, projectId), project);
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
  return {
    world,
    characters,
    factions,
    relations,
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
  return lines.join('\n');
}

/** Snapshot in force at one story day: the newest one at or before it. */
function snapshotAt(project, day) {
  const snapshots = (project.snapshots || []).filter((snapshot) => snapshot.day <= day);
  if (snapshots.length === 0) return null;
  return snapshots[snapshots.length - 1];
}

function chapterPrompt(project, chapter, previous) {
  const window = chapterWindow(project, chapter);
  const outline = chapter.outline || {};
  const snapshot = snapshotAt(project, window.start);
  const lines = [];
  lines.push('你现在是这部小说的执笔作者。只输出本章正文，不要解释、不要标题、不要分点提纲。');
  lines.push('');
  lines.push(`【章节】第 ${chapter.index + 1} 章 ${chapter.title || ''}（${dateForDay(project, window.start)} 起，跨度 ${chapter.durationDays} 天）`);
  lines.push('');
  lines.push('【当前世界快照】');
  lines.push(snapshotBlock(snapshot));
  lines.push('');
  if (previous) {
    lines.push('【上一章梗概】');
    lines.push(`${previous.title || ''}：${(previous.outline && previous.outline.synopsis) || '（无）'}`);
    lines.push('');
  }
  lines.push('【本章梗概】');
  lines.push(outline.synopsis || '（无）');
  lines.push('');
  lines.push('【要求】');
  lines.push('- 不要调用任何工具，不要反问，不要输出计划或步骤说明，直接给出最终正文。');
  lines.push(`- 字数控制在 ${outline.minWords || 800} 到 ${outline.maxWords || 3000} 字之间。`);
  lines.push('- 与世界观、角色、势力和人物关系保持一致，不要引入与快照冲突的设定。');
  lines.push('- 有完整的情节推进、场景描写和对话，直接成文。');
  return lines.join('\n');
}

function deducePrompt(project, chapter) {
  const day = chapter ? chapterWindow(project, chapter).start : (Number(project.timeline.cursor) || 0);
  const snapshot = snapshotAt(project, day);
  const chapters = project.chapters || [];
  const previous = chapters.length ? chapters[chapters.length - 1] : null;
  const lines = [];
  lines.push('你是这部小说的剧情推演器。请依据最新世界快照和最近一章，推演下一章的大纲。');
  lines.push('只输出一个 JSON 对象，不要任何额外文字。');
  lines.push('');
  lines.push('【最新世界快照】');
  lines.push(snapshotBlock(snapshot));
  lines.push('');
  if (previous) {
    lines.push('【最近一章】');
    lines.push(`${previous.title || ''}（第 ${previous.startDay} 天起，跨度 ${previous.durationDays} 天）`);
    lines.push(`梗概：${(previous.outline && previous.outline.synopsis) || '（无）'}`);
    lines.push('');
  }
  lines.push('【输出 JSON 结构】');
  lines.push('{"synopsis": "本章梗概，300 字以内，包含起因、经过、转折", "durationDays": 30, "minWords": 1200, "maxWords": 3500, "title": "本章标题"}');
  lines.push('');
  lines.push('durationDays 必须是不小于 1 的整数；maxWords 必须大于 minWords。');
  lines.push('不要调用任何工具，不要反问，只输出这个 JSON。');
  return lines.join('\n');
}

function snapshotPrompt(project, previous, chapters) {
  const lines = [];
  lines.push('你是这部小说的世界观维护者。请阅读以下章节梗概，输出更新后的世界快照。');
  lines.push('只输出一个 JSON 对象，不要任何额外文字。');
  lines.push('');
  if (previous) {
    lines.push('【上一版世界快照】');
    lines.push(snapshotBlock(previous));
    lines.push('');
  }
  lines.push('【这段时间的新章节】');
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
  lines.push('{"world":"世界观，按时间推进更新，500 字以内","characters":[{"name":"","desc":""}],"factions":[{"name":"","desc":""}],"relations":["A B 敌对"],"summary":"这段时期发生的关键变化"}');
  lines.push('');
  lines.push('要求：保留上一版中尚未被推翻的设定；角色、势力要包含新登场者；关系用「甲 乙 关系」三段式。');
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
  // Repair projects created before sessions were placed in the sidebar group.
  for (const project of projects) {
    try {
      await ensureWorkspace(ctx, project);
    } catch {
      // A missing directory or an older harness simply leaves the session as is.
    }
  }
  return {
    revision: '2026-10-20.8',
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
  const title = asText(body.title) || '未命名作品';
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
    projectId: randomUUID(),
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
  return mutateProject(root, projectId, (project) => {
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
    }
    if (title !== '') chapter.title = title;
    chapter.outline = outline;
    chapter.durationDays = outline.durationDays;
    if (chapter.status === 'draft') chapter.status = 'outlined';
    chapter.updatedAt = Date.now();
    return { chapter, project: summarize(project) };
  });
}

async function saveChapter(root, body) {
  const projectId = asText(body.projectId);
  const chapterId = asText(body.chapterId);
  const content = typeof body.content === 'string' ? body.content : '';
  const title = asText(body.title);
  return mutateProject(root, projectId, (project) => {
    const chapter = project.chapters.find((entry) => entry.chapterId === chapterId);
    if (!chapter) throw httpError(404, `章节不存在: ${chapterId}`);
    chapter.content = content;
    chapter.wordCount = wordCount(content);
    if (title !== '') chapter.title = title;
    chapter.status = chapter.generatedAt ? 'edited' : 'edited';
    chapter.updatedAt = Date.now();
    return { chapter: { ...chapter, content: undefined }, project: summarize(project) };
  });
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

/** One snapshot per elapsed timeline threshold, derived from that period's chapters. */
function snapshotDue(project, day) {
  const snapshots = project.snapshots || [];
  const last = snapshots[snapshots.length - 1];
  const unit = Math.max(1, project.timeline.unitDays || 30);
  // Story time starts at day 0, so the first snapshot is due once the story has
  // advanced one full unit from the origin rather than on the first chapter.
  const since = last ? last.day : 0;
  return day - since >= unit;
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
      nextSnapshotDay: latestSnapshotDay + unitDays,
      snapshotDays: snapshots.map((snapshot) => snapshot.day),
    },
  };
}

/** The chapter this one follows, by start day. */
function previousChapter(project, chapter) {
  return (project.chapters || [])
    .filter((entry) => entry.chapterId !== chapter.chapterId && entry.startDay <= chapter.startDay)
    .sort((a, b) => b.startDay - a.startDay)[0] || null;
}

function registerSnapshot(ctx, root, registry, projectId, day) {
  return startJob(registry, { kind: 'snapshot', projectId }, async (job) => {
    const project = await readProject(root, projectId);
    const snapshots = project.snapshots || [];
    const last = snapshots[snapshots.length - 1] || null;
    const since = last ? last.day : 0;
    const chapters = (project.chapters || [])
      .filter((chapter) => chapterWindow(project, chapter).end > since
        && (((chapter.outline && chapter.outline.synopsis) || '').trim() !== '' || String(chapter.content || '').trim() !== ''))
      .sort((a, b) => a.startDay - b.startDay);
    if (chapters.length === 0) throw httpError(409, '自上一版快照以来还没有已生成的章节，无法更新世界快照');
    job.message = `正在阅读 ${chapters.length} 章的梗概并更新世界快照`;
    const reply = await askAgent(ctx, project, snapshotPrompt(project, last, chapters));
    const parsed = parseJsonReply(reply);
    if (!parsed) throw httpError(502, '模型没有返回可解析的快照 JSON');
    const normalized = normalizeSnapshot(parsed);
    if (normalized.world === '' && normalized.characters.length === 0 && normalized.factions.length === 0) {
      throw httpError(502, '模型返回的快照为空');
    }
    const snapshot = {
      snapshotId: randomUUID(),
      day,
      createdAt: Date.now(),
      unitDays: project.timeline.unitDays,
      ...normalized,
    };
    await mutateProject(root, projectId, (draft) => {
      draft.snapshots.push(snapshot);
      return snapshot;
    });
    return { snapshot };
  });
}

function startGenerate(ctx, root, registry, body) {
  const projectId = asText(body.projectId);
  const chapterId = asText(body.chapterId);
  return startJob(registry, { kind: 'generate', projectId, chapterId }, async (job) => {
    const project = await readProject(root, projectId);
    const chapter = project.chapters.find((entry) => entry.chapterId === chapterId);
    if (!chapter) throw httpError(404, `章节不存在: ${chapterId}`);
    if (!chapter.outline) throw httpError(409, '请先在章节大纲里保存设定，再生成正文');
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
    const window = chapterWindow(project, chapter);
    let snapshotJobId = null;
    if (snapshotDue(project, window.end)) {
      const snapshotJob = registerSnapshot(ctx, root, registry, projectId, window.end);
      snapshotJobId = snapshotJob.jobId;
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
function startCompose(ctx, root, registry, body) {
  const projectId = asText(body.projectId);
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
    const window = chapterWindow(after, target);
    let snapshotJobId = null;
    if (snapshotDue(after, window.end)) {
      snapshotJobId = registerSnapshot(ctx, root, registry, projectId, window.end).jobId;
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

function startDeduce(ctx, root, registry, body) {
  const projectId = asText(body.projectId);
  const chapterId = asText(body.chapterId);
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
      await rm(join(projectsDir(root), projectId), { recursive: true, force: true });
      return { removed: projectId };
    }
    case '/project/timeline':
      return updateTimeline(root, body);
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
