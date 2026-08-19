import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUN_COUNT,
  DEFAULT_THRESHOLD_MS,
  STAGE_NAMES,
  evaluateReport,
  parseReport,
  renderMarkdown,
} from '../scripts/vercel/benchmark.mjs';

const digest = `sha256:${'a'.repeat(64)}`;

function record(commandToReadyMs = 900) {
  return {
    index: 1,
    name: 'devbox-benchmark-1-test',
    failed: false,
    cleanRun: true,
    commandToReadyMs,
    timings: Object.fromEntries(STAGE_NAMES.map((name) => [name, {
      outcome: 'passed',
      durationMs: 1,
    }])),
    environment: {
      vcpus: 2,
      imageDigest: digest,
      sourceCommit: 'b'.repeat(40),
      region: 'iad1',
    },
    residualResources: {
      sandboxes: [],
      snapshots: [],
      sessions: [],
    },
  };
}

function report(values = Array(DEFAULT_RUN_COUNT).fill(900)) {
  return parseReport(JSON.stringify({
    runs: values.map((value, index) => ({ ...record(value), index: index + 1 })),
  }));
}

describe('Vercel benchmark public boundary', () => {
  it('parses exactly five records with every required stage', () => {
    const parsed = report();

    expect(parsed.runs).toHaveLength(DEFAULT_RUN_COUNT);
    expect(Object.keys(parsed.runs[0].timings)).toEqual([...STAGE_NAMES]);
    expect(evaluateReport(parsed)).toMatchObject({
      passed: true,
      medianCommandToReadyMs: 900,
      thresholdMs: DEFAULT_THRESHOLD_MS,
    });
  });

  it('fails the threshold gate when the median exceeds ten seconds', () => {
    const result = evaluateReport(report([10001, 10002, 10003, 10004, 10005]));

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('median command-to-ready exceeds 10000ms');
  });

  it('fails the gate for a failed run or residual resource', () => {
    const failed = report();
    failed.runs[0].failed = true;
    const residual = report();
    residual.runs[1].residualResources.sandboxes.push({ name: 'orphaned-sandbox', status: 'running' });

    expect(evaluateReport(failed).passed).toBe(false);
    expect(evaluateReport(residual).passed).toBe(false);
    expect(evaluateReport(residual).reasons).toContain('residual resources remain');
  });

  it('rejects a report with the wrong run count, missing stage, or malformed residuals', () => {
    const short = report();
    short.runs = short.runs.slice(0, DEFAULT_RUN_COUNT - 1);
    expect(() => parseReport(JSON.stringify(short))).toThrow(/exactly 5 run records/);

    const missingStage = report();
    delete missingStage.runs[0].timings['port ready'];
    expect(() => parseReport(JSON.stringify(missingStage))).toThrow(/missing required stage timings/);

    const malformed = report();
    malformed.runs[0].residualResources.sandboxes = 'not-an-array';
    expect(() => parseReport(JSON.stringify(malformed))).toThrow(/malformed residual-resource/);

    const noTiming = report();
    noTiming.runs[0].commandToReadyMs = null;
    noTiming.runs[0].failed = false;
    expect(() => parseReport(JSON.stringify(noTiming))).toThrow(/no command-to-ready timing/);
  });

  it('renders a secret-free Markdown artifact and exposes help without credentials', () => {
    const parsed = report();
    const markdown = renderMarkdown(parsed, evaluateReport(parsed));

    expect(markdown).toContain('Vercel benchmark');
    for (const stage of STAGE_NAMES) expect(markdown).toContain(stage);
    expect(markdown).not.toContain('VERCEL_TOKEN');
    expect(markdown).not.toContain('password');

    const help = execFileSync(process.execPath, ['scripts/vercel/benchmark.mjs', '--help'], {
      encoding: 'utf8',
    });
    expect(help).toContain('--help');
    expect(help).toContain('five clean');
  });

  it('detaches the benchmark terminal and probes every configured public domain', async () => {
    const source = await readFile('scripts/vercel/benchmark.mjs', 'utf8');

    expect(source).toContain('stdin.write(Buffer.from([0x1d]))');
    expect(source).toContain("result.reason !== 'escape'");
    expect(source).toContain('await checkPorts(run.ports, signal)');
    expect(source).not.toContain("}).catch(() => []);");
  });
});
