import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  createHeartbeatWriter,
  decideIdlePause,
  parseIdlePauseMinutes,
  readRemoteHeartbeat,
  resolveIdlePauseMinutes,
  startIdlePauseMonitor,
  touchRemoteHeartbeat,
  VERCEL_RUNTIME_HEARTBEAT_PATH,
} from '../src/providers/vercel/idle-pause.js';
import type { VercelSandboxClient, VercelSandboxHandle } from '../src/providers/vercel/client.js';

const sandbox = { name: 'box', status: 'running', cwd: '/vercel/sandbox' } as VercelSandboxHandle;

describe('idle pause policy', () => {
  it('defaults to fifteen minutes and accepts zero as disabled', () => {
    expect(resolveIdlePauseMinutes(undefined, undefined)).toBe(15);
    expect(resolveIdlePauseMinutes(undefined, 0)).toBe(0);
    expect(resolveIdlePauseMinutes('0', 15)).toBe(0);
    expect(parseIdlePauseMinutes(' 20 ')).toBe(20);
    expect(() => parseIdlePauseMinutes('15.5')).toThrow();
    expect(() => parseIdlePauseMinutes('1441')).toThrow();
  });

  it('does not pause during setup, the grace window, or a fresh heartbeat', () => {
    expect(decideIdlePause({ nowMs: 10_000, readyAtMs: 0, idlePauseMinutes: 1 })).toBe(false);
    expect(decideIdlePause({
      nowMs: 60_001,
      readyAtMs: 0,
      idlePauseMinutes: 1,
      heartbeatMs: 30_000,
    })).toBe(false);
    expect(decideIdlePause({
      nowMs: 120_000,
      readyAtMs: 0,
      idlePauseMinutes: 1,
      setupStatus: { status: 'running', startedAt: 1, finishedAt: null },
    })).toBe(false);
  });

  it('treats an absent heartbeat as idle only after the full window', () => {
    expect(decideIdlePause({ nowMs: 59_999, readyAtMs: 0, idlePauseMinutes: 1 })).toBe(false);
    expect(decideIdlePause({ nowMs: 60_000, readyAtMs: 0, idlePauseMinutes: 1 })).toBe(true);
    expect(decideIdlePause({ nowMs: 60_000, readyAtMs: 0, idlePauseMinutes: 0 })).toBe(false);
  });
});

describe('remote heartbeat', () => {
  it('writes a private heartbeat and reads Linux stat seconds as milliseconds', async () => {
    const commands: Array<{ cmd: string; args?: readonly string[] }> = [];
    const client = {
      runCommand: vi.fn(async (_box: VercelSandboxHandle, request: { cmd: string; args?: readonly string[] }) => {
        commands.push(request);
        if (request.cmd === 'stat') return { exitCode: 0, stdout: async () => '123\n' };
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;

    await touchRemoteHeartbeat({ sandbox, client });
    await expect(readRemoteHeartbeat({ sandbox, client })).resolves.toBe(123_000);
    expect(commands[0]).toMatchObject({
      cmd: 'sh',
      args: ['-c', expect.stringContaining(`chmod 600 ${VERCEL_RUNTIME_HEARTBEAT_PATH}`)],
    });
    expect(commands[1]).toEqual({ cmd: 'stat', args: ['-c', '%Y', VERCEL_RUNTIME_HEARTBEAT_PATH] });
  });

  it('does not let input activity break when the remote write fails', async () => {
    const client = {
      runCommand: vi.fn(async () => { throw new Error('offline'); }),
    } as unknown as VercelSandboxClient;
    const writer = await createHeartbeatWriter({ sandbox, client });
    expect(client.runCommand).not.toHaveBeenCalled();
    expect(() => writer.onInputActivity()).not.toThrow();
    await writer.touch();
    writer.stop();
  });

  it('writes one bootstrap heartbeat only when snapshot resume requests it', async () => {
    const client = {
      runCommand: vi.fn(async () => ({ exitCode: 0 })),
    } as unknown as VercelSandboxClient;

    await createHeartbeatWriter({ sandbox, client });
    expect(client.runCommand).not.toHaveBeenCalled();

    await createHeartbeatWriter({ sandbox, client, initialTouch: true });
    expect(client.runCommand).toHaveBeenCalledOnce();
  });
});

describe('idle pause monitor', () => {
  it('pauses once when the scheduler observes a stale or missing heartbeat', async () => {
    let callback: (() => void) | undefined;
    const scheduler = {
      setTimeout: vi.fn((next: () => void) => {
        callback = next;
        return 1;
      }),
      clearTimeout: vi.fn(),
    };
    const pause = vi.fn(async () => {});
    const stderr = new PassThrough();
    const output: string[] = [];
    stderr.on('data', (chunk) => output.push(chunk.toString()));
    let nowMs = 0;
    const stop = startIdlePauseMonitor({
      sandbox,
      client: {} as VercelSandboxClient,
      idlePauseMinutes: 1,
      pause,
      stderr,
      readyAtMs: 0,
      now: () => nowMs,
      scheduler,
      pollIntervalMs: 1_000,
      readHeartbeat: async () => undefined,
      readSetup: async () => null,
    });

    nowMs = 60_000;
    callback?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(pause).toHaveBeenCalledOnce();
    expect(output.join('')).toContain('auto-paused');
    stop();
  });
});
