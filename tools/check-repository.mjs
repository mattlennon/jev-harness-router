import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = execFileSync('git', ['-c', `safe.directory=${resolve(root).replaceAll('\\', '/')}`, 'ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
assert.ok(files.length, 'No tracked files; stage the intended repository files first.');
const prohibited = /(^|\/)(node_modules|dist|data|\.upgrade-backup|\.git)\/|(^|\/)\.env(?:\.|$)(?!example$)|\.sqlite(?:[-.].*)?$|\.local\.[^/]+$|\.(tgz|zip|log)$/;
const token = /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
for (const file of files) {
  assert.ok(!prohibited.test(file), `Private/generated file tracked: ${file}`);
  assert.ok(!file.startsWith('artifacts/') || file === 'artifacts/README.md', `Local report tracked: ${file}`);
  const content = readFileSync(resolve(root, file), 'utf8');
  assert.ok(!token.test(content), `Credential pattern detected in ${file}; inspect locally.`);
  if (!file.endsWith('.md')) continue;
  assert.equal((content.match(/```/g) ?? []).length % 2, 0, `Unclosed Markdown fence: ${file}`);
  for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]; if (/^(?:https?:\/\/|mailto:|#)/.test(target)) continue;
    const absolute = resolve(dirname(resolve(root, file)), decodeURIComponent(target.split('#')[0]));
    const local = relative(root, absolute);
    assert.ok(!local.startsWith(`..${sep}`) && existsSync(absolute), `Broken/outside local link: ${file}: ${target}`);
    assert.ok(files.includes(local.replaceAll('\\', '/')), `Link targets an untracked file: ${file}: ${target}`);
  }
}
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
assert.equal(pkg.version, lock.version, 'Lockfile version differs');
assert.equal(pkg.version, lock.packages[''].version, 'Lockfile root version differs');
assert.ok(pkg.dsh?.bundle?.patch && existsSync(resolve(root, pkg.dsh.bundle.patch)), 'Bundle patch missing');
console.log(`Repository check passed: ${files.length} tracked files, local links and common credential patterns checked.`);
