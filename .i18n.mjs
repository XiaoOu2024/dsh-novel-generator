import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('./client.js', import.meta.url);
const src = readFileSync(file, 'utf8');
const han = /\p{Script=Han}/u;

const MAP = {
  '小说工坊': 'Novel Studio',
  '作品名称不能为空': 'Title cannot be empty.',
  '作品名称最多 60 个字符': 'Title can be at most 60 characters.',
  '作品名称不能以空格或点开头、结尾': 'Title cannot start or end with a space or a dot.',
  '作品名称不能包含 \\\\ / : * ? " < > |': 'Title cannot contain \\\\ / : * ? " < > |.',
  '作品名称不能包含控制字符': 'Title cannot contain control characters.',
  '作品名称不能使用 CON、PRN、NUL、COM1 这类系统保留名': 'Title cannot be a reserved name such as CON, PRN, NUL or COM1.',
  '默认模型': 'Default model',
  '修改作品模型': 'Change work model',
  '模型': 'Model',
  '未发现可用模型': 'No model available',
  '模型实例': 'Model',
  '切换后会同时改到这部作品绑定的会话上。': 'This also switches the model of the session bound to this work.',
  '取消': 'Cancel',
  '保存中…': 'Saving…',
  '保存': 'Save',
  '未命名作品': 'Untitled work',
  '当前界面无法调用目录选择器，这个部署暂时不能创建作品': 'The directory picker is unavailable here, so this deployment cannot create works.',
  '请先点「选择」挑一个工作目录': 'Pick a working directory with "Select" first.',
  '作品名称': 'Title',
  '例如：长夜将尽': 'e.g. The Long Night Ends',
  '会成为工作目录下的文件夹名': 'Becomes a folder name inside the working directory.',
  '工作目录': 'Working directory',
  '只能通过右侧「选择」挑选目录': 'Choose it with "Select" on the right.',
  '点右侧「选择」挑一个目录': 'Pick a directory with "Select" on the right.',
  '选择': 'Select',
  '预设': 'Preset',
  '默认预设': 'Default preset',
  '创建中…': 'Creating…',
  '创建作品并开会话': 'Create work and open its session',
  '还没有作品。填好名称、工作目录和模型后创建一部，界面会自动为它开一个会话。': 'No works yet. Fill in a title, a working directory and a model; creating one also opens its own session.',
  '修改这部作品使用的模型': 'Change the model this work uses',
  '删除': 'Delete',
  '还没有世界快照': 'No world snapshot yet',
  '快照间隔': 'Snapshot interval',
  '每多少天结算一份世界快照，可从 7 / 15 / 30 / 90 / 180 / 365 里选，也可以直接输入': 'How many days per world snapshot — pick 7 / 15 / 30 / 90 / 180 / 365 or type another number.',
  '天': 'days',
  '是否为当前时间生成世界快照？': 'Generate a world snapshot for this point in time?',
  '生成快照': 'Generate snapshot',
  '隐藏统计图': 'Hide chart',
  '显示统计图': 'Show chart',
  '生成中…': 'Generating…',
  '进入故事': 'Enter story',
  '世界观': 'World',
  '还没有落在这一时间点的世界快照。': 'No world snapshot covers this point in time yet.',
  '角色列表': 'Characters',
  '暂无': 'None yet',
  '势力列表': 'Factions',
  '关系': 'Relations',
  '章节天数统计：还没有章节，生成第一章后这里会画出每章的天数。': 'Chapter length chart: no chapters yet. Generate the first one and each chapter\'s day count appears here.',
  '每章天数': 'Days per chapter',
  '← 时间长河': '← Timeline',
  '未命名': 'Untitled',
  '章节故事': 'Chapter',
  '← 上一章': '← Previous',
  '下一章 →': 'Next →',
  '＋ 新建章节': '+ New chapter',
  '章节大纲 →': 'Outline →',
  '还没有章节。点右上角「＋ 新建章节」开始第一章。': 'No chapters yet. Use "+ New chapter" at the top right to start the first one.',
  '这一章还没有保存过章节大纲，可以先回章节大纲里填写并生成。': 'This chapter has no saved outline yet; fill one in under "Outline" and generate from there.',
  '章节正文：生成后可以直接在这里修改，改完点保存。': 'Chapter text: edit it here after generation, then save.',
  '梗概还没有达到最低字数，或字数与时间长度没填完': 'The synopsis is below its minimum length, or the word bounds and the duration are incomplete.',
  '章节大纲已保存': 'Outline saved',
  '第一章没有世界快照和上一章可依据，自动推演不可用': 'Auto-deduction is unavailable for the first chapter: there is no snapshot or previous chapter to build on.',
  '自动推演会覆盖现有内容': 'Auto-deduction overwrites everything',
  '将重新生成故事梗概、章节名称和整章正文，当前的大纲与已写的正文都会被打断覆盖，生成完直接保存。确定继续吗？': 'It regenerates the synopsis, the chapter name and the whole text, replacing the current outline and any written text, then saves. Continue?',
  '覆盖并生成': 'Overwrite and generate',
  '以当前故事梗概生成章节故事？': 'Generate the chapter from the current synopsis?',
  '会用已保存的梗概、字数限制和时间长度重写这一章的正文，现有正文会被覆盖。': 'It rewrites this chapter from the saved synopsis, word bounds and duration, replacing the current text.',
  '开始生成': 'Generate',
  '章节生成成功': 'Chapter generated',
  '已重新推演并保存章节': 'Re-deduced and saved the chapter',
  '任务失败': 'Task failed',
  '← 章节故事': '← Chapter',
  '章节大纲 · 新章节': 'Outline · new chapter',
  '第一章没有世界快照和上一章可依据，自动推演不可用；请自己写梗概后生成': 'No snapshot or previous chapter for the first chapter; write its synopsis yourself and generate.',
  '按当前字数与时间长度，重新推演梗概、章节名称与整章正文': 'Re-deduce the synopsis, the chapter name and the whole text from the current bounds and duration.',
  '推演中…': 'Deducing…',
  '自动推演': 'Auto-deduce',
  '章节标题': 'Chapter title',
  '例如：雨夜来客': 'e.g. A Visitor in the Rain',
  '故事时间长度（天）': 'Story duration (days)',
  '章节最低字数': 'Minimum words',
  '章节最多字数': 'Maximum words',
  '梗概最低字数': 'Minimum synopsis length',
  '这一章要发生什么：起因、经过、转折、结果。': 'What happens in this chapter: setup, events, the turn, the outcome.',
  '设定完整，可以生成章节故事': 'Settings complete — you can generate the chapter.',
  '设定完整，可以保存': 'Settings complete — you can save.',
  '梗概达到最低字数并填完其他项后可以保存': 'Reach the synopsis minimum and fill in the rest to save.',
  '正在自动推演…': 'Deducing…',
  '正在生成章节故事…': 'Generating the chapter…',
  '生成章节故事': 'Generate chapter',
  '第一章没有可依据的世界快照和上一章，自动推演不可用': 'No world snapshot or previous chapter to build on for the first chapter; auto-deduction is unavailable.',
  '章节已生成': 'Chapter generated',
  '自动推演失败': 'Auto-deduction failed',
  '新建章节': 'New chapter',
  '章节名称（可留空，自动推演会补上）': 'Chapter name (optional; auto-deduction fills it)',
  '章节最低字数 *': 'Minimum words *',
  '章节最多字数 *': 'Maximum words *',
  '故事时间长度（天）*': 'Story duration (days) *',
  '这是作品的第一章：没有世界快照和上一章可依据，自动推演不可用。先创建空章节，再自己写梗概生成。': 'This is the work\'s first chapter: there is no snapshot or previous chapter, so auto-deduction is unavailable. Create an empty chapter, write its synopsis, then generate.',
  '创建空章节': 'Create empty chapter',
  '第一章没有可依据的快照与上一章，自动推演不可用': 'No snapshot or previous chapter to build on; auto-deduction is unavailable.',
  '自动推演中…': 'Deducing…',
  '确定': 'OK',
  '这一章': 'This chapter',
  '离开这个界面会丢掉刚才的修改。要先保存吗？': 'Leaving this screen discards your edits. Save first?',
  '不保存离开': 'Leave without saving',
  '保存并离开': 'Save and leave',
  '章节已保存': 'Chapter saved',
  '正在结算世界快照…': 'Settling the world snapshot…',
  '世界快照已更新，时间线向前延伸': 'World snapshot updated; the timeline moved forward.',
  '世界快照更新失败': 'World snapshot update failed',
  '这份章节大纲': 'This outline',
  '这一章的正文': 'this chapter\'s text',
  '← 作品列表': '← Projects',
  '关闭': 'Close',
  '正在载入…': 'Loading…',
  '正在载入作品…': 'Loading the work…',
};

const missing = new Set();
let out = '';
let last = 0;
for (const match of src.matchAll(/'([^'\n]*)'/g)) {
  const raw = match[0];
  const text = match[1];
  if (!han.test(text)) continue;
  const before = src.slice(0, match.index);
  if (/t\(\s*$/.test(before)) continue;
  const english = MAP[text];
  if (english === undefined) {
    missing.add(text);
    continue;
  }
  out += src.slice(last, match.index) + `t(${raw}, ${JSON.stringify(english)})`;
  last = match.index + raw.length;
}
out += src.slice(last);

if (missing.size > 0) {
  console.error('missing translations:', [...missing]);
  process.exit(1);
}
writeFileSync(file, out, 'utf8');
console.log('rewritten, bytes', src.length, '->', out.length);
