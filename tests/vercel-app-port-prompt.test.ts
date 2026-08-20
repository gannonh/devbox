import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { promptForAppPorts } from '../src/providers/vercel/app-port-prompt.js';
import type { AppPortCandidate } from '../src/providers/vercel/app-ports.js';
import type { ProviderInput } from '../src/providers/types.js';

const VITE: AppPortCandidate = { port: 5173, framework: 'vite', source: 'framework-default', workspace: '.' };
const NEXT_A: AppPortCandidate = { port: 4100, framework: 'next', source: 'dev-script', workspace: '.' };
const NEXT_B: AppPortCandidate = { port: 4200, framework: 'next', source: 'dev-script', workspace: '.' };

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
  overrides: {
    candidates?: AppPortCandidate[];
    configured?: number[];
    conflicting?: boolean;
    retained?: number[];
    keepOnEmptyAnswer?: boolean;
  } = {},
) {
  const stderr = new PassThrough();
  const output: string[] = [];
  stderr.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  const scripted = scriptedAsk(answers);
  const result = await promptForAppPorts({
    stdin: new PassThrough() as unknown as ProviderInput,
    stderr,
    configured: overrides.configured ?? [],
    ...(overrides.retained === undefined ? {} : { retained: overrides.retained }),
    ...(overrides.keepOnEmptyAnswer === undefined ? {} : { keepOnEmptyAnswer: overrides.keepOnEmptyAnswer }),
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

  it('keeps the current set on Enter when resuming, rather than exposing new ports', async () => {
    const { result, questions } = await prompt([''], { retained: [4173], keepOnEmptyAnswer: true });

    // A resume is usually "get me back in"; Enter must not be the key that
    // publishes a port that was not exposed a moment ago.
    expect(questions[0]).toContain('Enter keeps 4173');
    expect(result).toEqual({ decision: 'accepted', selected: [4173] });
  });

  it('exposes nothing on Enter when resuming with nothing previously accepted', async () => {
    const { result, questions } = await prompt([''], { keepOnEmptyAnswer: true });

    expect(questions[0]).toContain('Enter exposes none');
    expect(result).toEqual({ decision: 'accepted', selected: [] });
  });

  it('still accepts the new candidates on an explicit yes while resuming', async () => {
    const { result } = await prompt(['y'], { retained: [4173], keepOnEmptyAnswer: true });

    expect(result).toEqual({ decision: 'accepted', selected: [5173] });
  });

  it('offers manual entry when the detector inferred nothing', async () => {
    const { result, rendered, questions } = await prompt(['5173'], { candidates: [] });

    expect(rendered).toContain('No app ports were inferred from the remote checkout.');
    expect(rendered).toContain('accepted app routes are PUBLIC');
    expect(questions[0]).toContain('Enter for none');
    expect(result).toEqual({ decision: 'edited', selected: [5173] });
  });

  it('defaults to exposing nothing when nothing was inferred', async () => {
    const { result } = await prompt([''], { candidates: [] });

    expect(result).toEqual({ decision: 'rejected', selected: [] });
  });

  it('re-asks an invalid manual entry instead of exposing it', async () => {
    const { result, rendered } = await prompt(['5900', 'not-a-port', '4173'], { candidates: [] });

    expect(rendered).toContain('the VNC port stays private');
    expect(rendered).toContain('is not a decimal port');
    expect(result).toEqual({ decision: 'edited', selected: [4173] });
  });

  it('keeps an earlier confirmed set when the manual answer is empty', async () => {
    const { result, rendered, questions } = await prompt([''], { candidates: [], retained: [5173] });

    expect(rendered).toContain('retained (confirmed earlier): 5173');
    expect(questions[0]).toContain('Enter to keep the current set');
    expect(result).toEqual({ decision: 'accepted', selected: [5173] });
  });

  it('lists configured ports as retained in the manual prompt too', async () => {
    const { rendered } = await prompt([''], { candidates: [], configured: [4000] });

    expect(rendered).toContain('retained (configured): 4000');
  });
});
