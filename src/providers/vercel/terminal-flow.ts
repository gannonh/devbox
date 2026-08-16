export const DEFAULT_MAX_PENDING_INPUT_BYTES = 64 * 1024;
export const DEFAULT_MAX_PENDING_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_BACKPRESSURE_TIMEOUT_MS = 30_000;
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
export const MAX_BUFFER_LIMIT_BYTES = 16 * 1024 * 1024;

export interface RestorableReadable {
  readonly readableFlowing?: boolean | null;
  pause(): unknown;
  resume(): unknown;
}

export interface PausableSocket {
  pause?: () => void;
  resume?: () => void;
}

export class BoundedBufferQueue {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly limitBytes: number) {}

  get length(): number {
    return this.chunks.length;
  }

  get byteLength(): number {
    return this.bytes;
  }

  peek(): Buffer | undefined {
    return this.chunks[0];
  }

  enqueue(chunk: Buffer): boolean {
    if (this.bytes + chunk.length > this.limitBytes) return false;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    return true;
  }

  shift(): Buffer | undefined {
    const chunk = this.chunks.shift();
    if (chunk) this.bytes -= chunk.length;
    return chunk;
  }

  clear(): void {
    this.chunks.length = 0;
    this.bytes = 0;
  }
}

export function validateByteLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BUFFER_LIMIT_BYTES) {
    throw new Error(`Terminal ${label} must be a positive safe integer no larger than ${MAX_BUFFER_LIMIT_BYTES}`);
  }
  return value;
}

export function validateTimeoutLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Terminal backpressure timeout must be finite and positive');
  }
  return Math.min(value, MAX_TIMER_DELAY_MS);
}

export function pauseSocket(socket: PausableSocket): void {
  try {
    socket.pause?.();
  } catch {
    // The socket may already be closing.
  }
}

export function resumeSocket(socket: PausableSocket): void {
  try {
    socket.resume?.();
  } catch {
    // The socket may already be closed.
  }
}

export function restoreReadableState(
  input: RestorableReadable,
  flowing: boolean | null | undefined,
  wasPaused: boolean,
): void {
  const readableState = (input as RestorableReadable & {
    _readableState?: { flowing?: boolean | null };
  })._readableState;
  try {
    // Reset Node's public paused flag before restoring the exact flowing value.
    if (wasPaused) input.pause();
    else input.resume();
  } catch {
    // Continue with the guarded internal restoration when available.
  }
  if (readableState && (flowing === null || flowing === false || flowing === true)) {
    try {
      // Node has no public neutral-flow setter; keep this guarded and isolated.
      readableState.flowing = flowing;
      return;
    } catch {
      // Fall through to the public approximation when internals are unavailable.
    }
  }
  try {
    if (wasPaused) input.pause();
    else if (flowing === true) input.resume();
  } catch {
    // Ignore errors restoring stream flow.
  }
}
