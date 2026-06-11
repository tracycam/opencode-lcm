import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveOptions } from '../dist/options.js';
import { compilePrivacyOptions } from '../dist/privacy.js';
import { SqliteLcmStore } from '../dist/store.js';

import {
  captureMessage,
  cleanupWorkspace,
  createSession,
  makeOptions,
  makeWorkspace,
  textPart,
} from './helpers.mjs';

// RED Test 1: Default options include secret patterns, each compiling to a RegExp.
test('default options include compilable secret redaction patterns', () => {
  const resolved = resolveOptions({});

  assert.ok(
    resolved.privacy.redactPatterns.length > 0,
    'expected default redactPatterns to be non-empty',
  );

  // Every default pattern must compile to a real (non-undefined) RegExp.
  const compiled = compilePrivacyOptions(resolved.privacy);
  assert.equal(
    compiled.redactPatterns.length,
    resolved.privacy.redactPatterns.length,
    'every default redact pattern must compile via compilePattern',
  );
  for (const pattern of compiled.redactPatterns) {
    assert.ok(pattern instanceof RegExp);
  }
});

// RED Test 2: Explicit [] opt-out is honored (no silent fallback to defaults).
test('explicit empty redactPatterns array is honored as opt-out', () => {
  const resolved = resolveOptions({ privacy: { redactPatterns: [] } });
  assert.deepEqual(resolved.privacy.redactPatterns, []);
});

// RED Test 3: End-to-end secret redaction works by default.
test('default privacy redacts common secrets end-to-end', async () => {
  const workspace = makeWorkspace('lcm-privacy-defaults-e2e');
  let store;

  try {
    const defaults = resolveOptions({}).privacy;
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ largeContentThreshold: 40, privacy: defaults }),
    );
    await store.init();

    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const bearer = 'Bearer eyJhbGciOiJIUzI1NiJ9.signature-test';

    await createSession(store, workspace, 's1', 1);
    await captureMessage(store, {
      sessionID: 's1',
      messageID: 'm1',
      created: 2,
      parts: [
        textPart('s1', 'm1', 'm1-p', `credentials ${awsKey} and ${bearer} should not persist`),
      ],
    });

    // Query stored DB content via the store API.
    const describe = await store.describe({ sessionID: 's1' });

    assert.match(describe, /\[REDACTED\]/);
    assert.ok(!describe.includes(awsKey), 'AWS key must not persist in plaintext');
    assert.ok(
      !describe.includes('eyJhbGciOiJIUzI1NiJ9.signature-test'),
      'Bearer token must not persist in plaintext',
    );

    // The redacted secrets must not be searchable from the FTS index either.
    const awsHits = await store.grep({ query: awsKey, sessionID: 's1', limit: 5 });
    assert.equal(awsHits.length, 0);
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

// Regression: undefined / missing privacy still applies defaults.
test('missing redactPatterns falls back to defaults', () => {
  const resolved = resolveOptions({});
  assert.ok(resolved.privacy.redactPatterns.length > 0);

  const partial = resolveOptions({ privacy: {} });
  assert.deepEqual(partial.privacy.redactPatterns, resolved.privacy.redactPatterns);
});

// Regression: explicit user patterns override the defaults.
test('explicit redactPatterns override defaults', () => {
  const resolved = resolveOptions({ privacy: { redactPatterns: ['custom'] } });
  assert.deepEqual(resolved.privacy.redactPatterns, ['custom']);
});

// Regression: every default pattern rejects the empty string and is a valid regex.
test('every default redact pattern is a valid non-empty-matching regex', () => {
  const defaults = resolveOptions({}).privacy.redactPatterns;
  for (const source of defaults) {
    const probe = new RegExp(source, 'u');
    assert.ok(!probe.test(''), `pattern must not match empty string: ${source}`);
  }
  // compilePattern keeps all of them (none dropped for matching empty / invalid).
  const compiled = compilePrivacyOptions({
    excludeToolPrefixes: [],
    excludePathPatterns: [],
    redactPatterns: defaults,
  });
  assert.equal(compiled.redactPatterns.length, defaults.length);
});
