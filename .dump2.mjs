import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const han = /\p{Script=Han}/u;
const templates = new Set();
for (const match of src.matchAll(/`([^`]*)`/g)) {
  if (han.test(match[1])) templates.add(match[1]);
}
console.log(JSON.stringify([...templates], null, 1));
