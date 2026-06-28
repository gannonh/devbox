/**
 * OSC 8 terminal hyperlink helper.
 *
 * Renders clickable hyperlinks in terminals that support OSC 8 (Ghostty,
 * iTerm2, etc.). Falls back to displaying the raw URL text on terminals
 * that do not support it.
 */

export const OSC8_PREFIX = '\x1b]8;;';
export const OSC8_SUFFIX = '\x1b]8;;\x1b\\';

/**
 * Generate an OSC 8 hyperlink.
 * @param url The link target.
 * @param text The display text (defaults to the URL itself).
 */
export function hyperlink(url: string, text: string = url): string {
  return `${OSC8_PREFIX}${url}\x1b\\${text}${OSC8_SUFFIX}`;
}
