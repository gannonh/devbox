import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { promptForAppPorts } from '../src/providers/vercel/app-port-prompt.js';
import type { AppPortCandidate } from '../src/providers/vercel/app-ports.js';
import type { ProviderInput } from '../src/providers/types.js';

const VITE: AppPortCandidate = { port: 5173, framework: 'vite', source: 'framework-default' };
const NEXT_A: AppPortCandidate = { port: 4100, framework: 'next', source: 'dev-script' };
const NEXT_B: AppPortCandidate = { port: 4200, framework: 'next', source: 'dev-script' };

function scriptedAsk(answers: string[]): {
  ask: (question: string) => Promise<string>;
  questions: string[];
} {
  const questions: string[] = [];
  return {
    questions,
    ask: vi.fn(async (question: string) => {
      questions.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
      return answer;
    }),
  };
}

async function prompt(
  answers: string[],
  overrides: { candidates?: AppPortCandidate[]; configured?: number[]; conflicting?: boolean } = {},
) {
  const stderr = new PassThrough();
  const output: string[] = [];
  stderr.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  const scripted = scriptedAsk(answers);
  const result = await promptForAppPorts({
    stdin: new PassThrough() as unknown as ProviderInput,
    stderr,
    configured: overrides.configured ?? [],
    candidates: overrides.candidates ?? [VITE],
    conflicting: overrides.conflicting ?? false,
    ask: scripted.ask,
  });
  return { result, rendered: output.join(''), questions: scripted.questions };
}

describe('public app port prompt', () => {
  it('lists retained configured ports, candidates, and the public warning', async () => {
    const { result, rendered } = await prompt([''], { configured: [4000] });

    expect(rendered).toContain('retained (configured): 4000');
    expect(rendered).toContain('candidate: 5173 (vite default)');
    expect(rendered).toContain('accepted app routes are PUBLIC');
    expect(result).toEqual({ decision: 'accepted', selected: [5173] });
  });

  it('accepts a bare Enter as yes for high-confidence candidates', async () => {
    const { result, questions } = await prompt(['']);

    expect(result).toEqual({ decision: 'accepted', selected: [5173] });
    expect(questions[0]).toContain('[Y/n/e=edit]');
  });

  it.each(['y', 'Y', 'yes'])('accepts an explicit %s', async (answer) => {
    const { result } = await prompt([answer]);

    expect(result).toEqual({ decision: 'accepted', selected: [5173] });
  });

  it.each(['n', 'N', 'no'])('rejects the candidates on %s', async (answer) => {
    const { result } = await prompt([answer]);

    expect(result).toEqual({ decision: 'rejected', selected: [] });
  });

  it('edits only the inferred numeric set', async () => {
    const { result, rendered } = await prompt(['e', ' 4321 , 4322 '], { configured: [4000] });

    expect(result).toEqual({ decision: 'edited', selected: [4321, 4322] });
    expect(rendered).toContain('configured ports stay exposed');
  });

  it('treats an empty edit as exposing no inferred ports', async () => {
    const { result } = await prompt(['e', '']);

    expect(result).toEqual({ decision: 'edited', selected: [] });
  });

  it('re-asks after an invalid edit and reports why', async () => {
    const { result, rendered } = await prompt(['e', '5173,notaport', 'y', '5173']);

    expect(rendered).toContain('is not a decimal port');
    expect(result).toEqual({ decision: 'edited', selected: [5173] });
  });

  it('refuses a private port in the edit prompt', async () => {
    const { rendered, result } = await prompt(['e', '5900', 'y', '5173']);

    expect(rendered).toContain('the VNC port stays private');
    expect(result).toEqual({ decision: 'edited', selected: [5173] });
  });

  it('returns to the main question when an edit is abandoned', async () => {
    const { result } = await prompt(['e', 'nope', 'n', 'n']);

    expect(result).toEqual({ decision: 'rejected', selected: [] });
  });

  it('requires an explicit answer when the dev script names conflicting ports', async () => {
    const { result, rendered, questions } = await prompt(['', 'e', '4200'], {
      candidates: [NEXT_A, NEXT_B],
      conflicting: true,
    });

    expect(rendered).toContain('names more than one port');
    expect(rendered).toContain('conflicting candidates require an explicit answer');
    expect(questions[0]).toContain('[y=all/n=none/e=edit]');
    expect(result).toEqual({ decision: 'edited', selected: [4200] });
  });

  it('re-asks on an unrecognized answer', async () => {
    const { result, rendered } = await prompt(['maybe', 'n']);

    expect(rendered).toContain('answer y, n, or e');
    expect(result).toEqual({ decision: 'rejected', selected: [] });
  });

  it('never prompts when there are no candidates', async () => {
    const scripted = scriptedAsk([]);

    await expect(promptForAppPorts({
      stdin: new PassThrough() as unknown as ProviderInput,
      stderr: new PassThrough(),
      configured: [4000],
      candidates: [],
      conflicting: false,
      ask: scripted.ask,
    })).resolves.toEqual({ decision: 'rejected', selected: [] });
    expect(scripted.questions).toEqual([]);
  });
});
