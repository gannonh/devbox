import { describe, it, expect, vi } from 'vitest';
import { info, warn, error, die, setLogStreams } from '../src/lib/log.js';
import { PassThrough } from 'node:stream';

describe('log', () => {
  it('info writes green [devbox] prefix + message to stderr', () => {
    const stderr = new PassThrough();
    let out = '';
    stderr.on('data', (d) => (out += d.toString()));
    setLogStreams({ stderr });
    info('hello world');
    expect(out).toContain('[devbox]');
    expect(out).toContain('hello world');
    expect(out).toContain('\x1b[0;32m'); // green
  });

  it('warn writes yellow prefix + message to stderr', () => {
    const stderr = new PassThrough();
    let out = '';
    stderr.on('data', (d) => (out += d.toString()));
    setLogStreams({ stderr });
    warn('careful');
    expect(out).toContain('[devbox]');
    expect(out).toContain('careful');
    expect(out).toContain('\x1b[0;33m'); // yellow
  });

  it('error writes red prefix + message to stderr', () => {
    const stderr = new PassThrough();
    let out = '';
    stderr.on('data', (d) => (out += d.toString()));
    setLogStreams({ stderr });
    error('broken');
    expect(out).toContain('[devbox]');
    expect(out).toContain('broken');
    expect(out).toContain('\x1b[0;31m'); // red
  });

  it('die calls error then process.exit(1)', () => {
    const stderr = new PassThrough();
    let out = '';
    stderr.on('data', (d) => (out += d.toString()));
    setLogStreams({ stderr });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    expect(() => die('fatal')).toThrow('exit');
    expect(out).toContain('fatal');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
