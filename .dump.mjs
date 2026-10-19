import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const han = /\p{Script=Han}/u;
const singles = new Set();
for (const match of src.matchAll(/'([^'\n]*)'/g)) {
  if (han.test(match[1])) singles.add(match[1]);
}
console.log(JSON.stringify([...singles], null, 1));
