/**
 * Template token replacement for `devbox init`.
 *
 * Replaces {{REPO_NAME}}-style tokens in template files with the target
 * repo's name (basename of the current working directory).
 */

export interface TokenValues {
  /** The target repo name (basename of cwd). */
  repoName: string;
}

export function replaceTokens(template: string, values: TokenValues): string {
  return template.replaceAll('{{REPO_NAME}}', values.repoName);
}
