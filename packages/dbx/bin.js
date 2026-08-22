#!/usr/bin/env node
// Alias shim: delegate every argument to the real devbox CLI.
// Spawned as a child process because the CLI only runs when it is the
// process entry point (see isMainEntry in @gannonh/devbox).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const cli = createRequire(import.meta.url).resolve('@gannonh/devbox/dist/cli.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
