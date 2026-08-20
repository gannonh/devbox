/**
 * CLI-facing port parsing for `--expose-ports`.
 *
 * Kept at the providers boundary so the CLI does not import a Vercel
 * implementation path directly.
 */
export {
  parseExposePortsList,
  VercelPortsError,
} from './vercel/ports.js';
