const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions } = require('../src/main/version-compare');

test('version ordering', () => {
  assert.equal(compareVersions('2.1.1', '2.1.2'), -1);
  assert.equal(compareVersions('2.1.1', '2.1.1'), 0);
  assert.equal(compareVersions('2.1.2', '2.1.1'), 1);
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1); // numeric, not lexicographic
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
});

test('v-prefix and missing components normalize', () => {
  assert.equal(compareVersions('v2.1.1', '2.1.1'), 0);
  assert.equal(compareVersions('V2.2.0', '2.1.9'), 1);
  assert.equal(compareVersions('2.1', '2.1.0'), 0);
  assert.equal(compareVersions('2.1.0-beta', '2.1.0'), 0);
  assert.equal(compareVersions('', '0.0.1'), -1);
});
