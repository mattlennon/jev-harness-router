import { copyFileSync, constants, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh');
mkdirSync(join(home, 'jev-router'), { recursive: true });
for (const [source, target] of [
  [new URL('../config/router.reasoning.example.json', import.meta.url), join(home, 'jev-router/router.json')],
  [new URL('../.env.example', import.meta.url), join(home, '.env')],
]) {
  try { copyFileSync(source, target, constants.COPYFILE_EXCL); console.log(`Created: ${target}`); }
  catch (error) { if (error.code !== 'EEXIST') throw error; console.log(`Preserved existing file: ${target}`); }
}
console.log('Fill model capabilities, prices and local keys before enabling a route.');
