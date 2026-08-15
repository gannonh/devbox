#!/usr/bin/env node
/** Extract and validate the immutable VCR tag manifest digest from JSON. */
let input = '';
for await (const chunk of process.stdin) input += chunk;
let value;
try {
  value = JSON.parse(input);
} catch {
  throw new Error('candidate tag response is not valid JSON');
}
const tag = value?.tag ?? value;
const digest = tag?.manifestDigest ?? tag?.digest;
if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
  throw new Error('candidate tag response did not contain a full manifestDigest');
}
process.stdout.write(`${digest}\n`);
