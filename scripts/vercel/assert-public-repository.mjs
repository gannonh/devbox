#!/usr/bin/env node
/** Verify VCR repository visibility without changing it. */
let input = '';
for await (const chunk of process.stdin) input += chunk;
let value;
try {
  value = JSON.parse(input.slice(input.indexOf('{')));
} catch {
  throw new Error('VCR repository inspection did not return JSON');
}

function findVisibility(node) {
  if (!node || typeof node !== 'object') return undefined;
  for (const [key, child] of Object.entries(node)) {
    if (/^(public|visibility)$/i.test(key)) {
      if (typeof child === 'boolean') return child;
      if (typeof child === 'string') return child.toLowerCase() === 'public';
    }
    const nested = findVisibility(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

const isPublic = findVisibility(value);
if (isPublic !== true) {
  throw new Error('VCR repository is not public; perform the one-time operator visibility change, then rerun this workflow');
}
console.log('VCR repository visibility: public');
