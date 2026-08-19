#!/usr/bin/env node
/**
 * Print the image pin carried by a published nightly package.
 *
 * A run that reuses an already-built image has no smoke evidence of its own and
 * must not invent any, so it inherits the pin the nightly published for that
 * exact digest. Reuse is only safe when that pin is actually recoverable, so
 * both the reuse decision and the reuse itself consult this.
 *
 * Exits non-zero when no usable pin exists; prints the pin JSON on success.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packageName = process.env.DEVBOX_PACKAGE_NAME ?? '@gannonh/devbox';
const distTag = process.argv[2] ?? 'nightly';

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let version;
try {
  version = run('npm', ['view', `${packageName}`, `dist-tags.${distTag}`]);
} catch {
  version = '';
}
if (!version) {
  console.error(`no ${packageName}@${distTag} is published`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'devbox-nightly-pin-'));
try {
  const tarball = run('npm', ['pack', `${packageName}@${version}`, '--silent'], work);
  run('tar', ['-xzf', tarball], work);
  const pin = readFileSync(join(work, 'package', 'dist', 'vercel-image-pin.json'), 'utf8');
  JSON.parse(pin);
  process.stdout.write(pin);
} catch {
  console.error(`${packageName}@${version} carries no usable image pin`);
  process.exit(1);
}
