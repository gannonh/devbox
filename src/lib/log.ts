/**
 * Colored log output matching the bash devbox.sh functions.
 *
 * info  -> green  [devbox] message   (stderr)
 * warn  -> yellow [devbox] message   (stderr)
 * error -> red    [devbox] message   (stderr)
 * die   -> error + process.exit(1)
 */
import type { Writable } from 'node:stream';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[0;33m';
const NC = '\x1b[0m';

let _stderr: Writable = process.stderr;

export function setLogStreams(streams: { stderr: Writable }): void {
  _stderr = streams.stderr;
}

export function info(msg: string): void {
  _stderr.write(`${GREEN}[devbox]${NC} ${msg}\n`);
}

export function warn(msg: string): void {
  _stderr.write(`${YELLOW}[devbox]${NC} ${msg}\n`);
}

export function error(msg: string): void {
  _stderr.write(`${RED}[devbox]${NC} ${msg}\n`);
}

export function die(msg: string): never {
  error(msg);
  process.exit(1);
}
