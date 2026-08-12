import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The version is written in four places across three files, and `npm version` bumps exactly one
 * of them. The one that hurts when it drifts is server.json's packages[0].version: MCP registries
 * resolve the npm package at that version, so a server.json left behind at 0.1.0 while npm latest
 * is 0.1.1 quietly serves every registry user the old build. Nothing else in the repo would fail.
 */
const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

test('every declared version matches package.json', () => {
  const expected = read('package.json').version;
  const server = read('server.json');

  assert.equal(read('plugin.json').version, expected, 'plugin.json is out of step');
  assert.equal(server.version, expected, 'server.json is out of step');
  assert.equal(
    server.packages[0].version,
    expected,
    'server.json packages[].version is out of step — MCP registries would install a stale build',
  );
});

test('server.json points at the package we actually publish', () => {
  assert.equal(read('server.json').packages[0].identifier, read('package.json').name);
});
