import { describe, it, expect } from 'vitest';
import { replaceTokens } from '../src/lib/tokens.js';

describe('replaceTokens', () => {
  it('replaces {{REPO_NAME}} with the provided repo name', () => {
    const result = replaceTokens('Hello {{REPO_NAME}}!', { repoName: 'my-app' });
    expect(result).toBe('Hello my-app!');
  });

  it('leaves other content intact', () => {
    const template = 'source=${localEnv:HOME}/.pi,target=/tmp/host-pi,type=bind,readonly\n{{REPO_NAME}}-devbox';
    const result = replaceTokens(template, { repoName: 'sample-app' });
    expect(result).toBe('source=${localEnv:HOME}/.pi,target=/tmp/host-pi,type=bind,readonly\nsample-app-devbox');
  });

  it('handles multiple occurrences', () => {
    const result = replaceTokens('{{REPO_NAME}} and {{REPO_NAME}}', { repoName: 'dev' });
    expect(result).toBe('dev and dev');
  });

  it('handles templates with no tokens (returns unchanged)', () => {
    const result = replaceTokens('no tokens here', { repoName: 'anything' });
    expect(result).toBe('no tokens here');
  });

  it('handles empty repo name', () => {
    const result = replaceTokens('{{REPO_NAME}}-devbox', { repoName: '' });
    expect(result).toBe('-devbox');
  });
});
