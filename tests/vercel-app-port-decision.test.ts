import { describe, expect, it } from 'vitest';
import { decideAppPortSelection } from '../src/providers/vercel/app-port-decision.js';
import type { AppPortCandidate } from '../src/providers/vercel/app-ports.js';

const vite: AppPortCandidate = {
  port: 5173,
  framework: 'vite',
  source: 'default',
  workspace: '.',
};

describe('decideAppPortSelection', () => {
  it('prefers --expose-ports over reuse and prompting', () => {
    expect(decideAppPortSelection({
      branch: 'feature/ui',
      exposePorts: [3000],
      reusable: true,
      previousSelected: [5173],
      candidates: [vite],
      configured: [],
      tty: true,
    })).toMatchObject({ kind: 'selected', selected: [3000] });
  });

  it('asks on a TTY when nothing is reusable', () => {
    expect(decideAppPortSelection({
      branch: 'feature/ui',
      reusable: false,
      previousSelected: [],
      candidates: [vite],
      configured: [],
      tty: true,
    })).toEqual({ kind: 'prompt' });
  });

  it('stays conservative when non-interactive', () => {
    const decision = decideAppPortSelection({
      branch: 'feature/ui',
      reusable: false,
      previousSelected: [],
      candidates: [vite],
      configured: [],
      tty: false,
    });
    expect(decision.kind).toBe('non-interactive');
    if (decision.kind !== 'non-interactive') return;
    expect(decision.selected).toEqual([]);
    expect(decision.notice).toContain('--expose-ports');
  });
});
