import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const han = /\p{Script=Han}/u;
const unwrapped = new Set();
for (const match of src.matchAll(/'([^'\n]*)'/g)) {
  if (!han.test(match[1])) continue;
  const before = src.slice(0, match.index);
  if (/t\(\s*$/.test(before)) continue;
  unwrapped.add(match[1]);
}
console.log('unwrapped single-quoted:', [...unwrapped]);
