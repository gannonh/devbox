import { error } from '../../lib/log.js';
import { ProviderOperationError } from '../types.js';

/** Preserve local provider error formatting while returning through the CLI. */
export function localFailure(message: string): never {
  error(message);
  throw new ProviderOperationError(message, 1, true);
}
