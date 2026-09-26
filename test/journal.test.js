import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.js';

test('journal persists deduplication, excludes concurrent writers, and blocks unresolved submissions', () => {
  const previous = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'copybot-test-'));
  process.chdir(dir);
  try {
    const first = new Journal('data/live.jsonl');
    first.put({ id: 'source:1', status: 'confirmed' });
    assert.throws(() => new Journal('data/live.jsonl'), /EEXIST/);
    first.close();
    const reopened = new Journal('data/live.jsonl');
    assert.equal(reopened.has('source:1'), true);
    reopened.put({ id: 'source:2', status: 'pending', signature: 'unknown' });
    reopened.close();
    assert.throws(() => new Journal('data/live.jsonl'), /Unresolved/);
    assert.equal(existsSync('data/live.jsonl.lock'), false);
  } finally { process.chdir(previous); rmSync(dir, { recursive: true, force: true }); }
});
