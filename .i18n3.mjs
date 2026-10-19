import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('./client.js', import.meta.url);
let src = readFileSync(file, 'utf8');

const pairs = [
  [
    '`第 ${chapter.index + 1} 章 · ${chapter.title || t(\'未命名\', "Untitled")}`',
    "t('第 {n} 章 · {title}', 'Chapter {n} · {title}', { n: chapter.index + 1, title: chapter.title || t('未命名', 'Untitled') })",
  ],
  [
    '`第 ${previous.index + 1} 章 · ${previous.title || t(\'未命名\', "Untitled")}`',
    "t('第 {n} 章 · {title}', 'Chapter {n} · {title}', { n: previous.index + 1, title: previous.title || t('未命名', 'Untitled') })",
  ],
  [
    '`第 ${next.index + 1} 章 · ${next.title || t(\'未命名\', "Untitled")}`',
    "t('第 {n} 章 · {title}', 'Chapter {n} · {title}', { n: next.index + 1, title: next.title || t('未命名', 'Untitled') })",
  ],
  [
    '`${what || t(\'这一章\', "This chapter")}还没有保存`',
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
