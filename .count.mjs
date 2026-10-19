import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const han = /\p{Script=Han}/u;
const singles = new Set();
const templates = new Set();
for (const match of src.matchAll(/'([^'\n]*)'/g)) {
  if (han.test(match[1])) singles.add(match[1]);
}
for (const match of src.matchAll(/`([^`]*)`/g)) {
  if (han.test(match[1])) templates.add(match[1]);
}
console.log('single-quoted unique strings with Han:', singles.size);
console.log('template unique strings with Han:', templates.size);
console.log('total unique:', singles.size + templates.size);
console.log('--- sample singles');
console.log([...singles].slice(0, 15));
console.log('--- sample templates');
console.log([...templates].slice(0, 10));
