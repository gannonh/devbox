import { describe, it, expect } from 'vitest';
import { hyperlink, OSC8_PREFIX, OSC8_SUFFIX } from '../src/lib/display.js';

describe('hyperlink', () => {
  it('wraps text in an OSC 8 sequence with the URL', () => {
    const result = hyperlink('https://example.com', 'click here');
    expect(result).toBe('\x1b]8;;https://example.com\x1b\\click here\x1b]8;;\x1b\\');
  });

  it('defaults text to the URL when omitted', () => {
    const result = hyperlink('http://box.orb.local:6080/vnc.html');
    expect(result).toContain('http://box.orb.local:6080/vnc.html');
    // The URL appears as both the link target and the display text
    expect(result).toBe(`\x1b]8;;http://box.orb.local:6080/vnc.html\x1b\\http://box.orb.local:6080/vnc.html\x1b]8;;\x1b\\`);
  });

  it('contains the OSC 8 prefix and suffix', () => {
    const result = hyperlink('https://a.com', 'a');
    expect(result).toContain(OSC8_PREFIX);
    expect(result).toContain(OSC8_SUFFIX);
  });
});
