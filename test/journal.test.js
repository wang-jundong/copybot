import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.js';
import { pruneSkippedJournal } from '../src/prune_skipped.js';

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


test('skipped events are not cached or written, and old skipped lines can be deleted', () => {
  const previous = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'copybot-prune-'));
  process.chdir(dir);
  try {
    const journal = new Journal('data/live.jsonl', { allowPending: true });
    journal.put({ id: 'skip:new', status: 'skipped', reason: 'no tracked position' });
    assert.equal(journal.has('skip:new'), false);
    assert.equal(existsSync('data/live.jsonl'), false);
    journal.close();
    const rows = [
      { id: 'first-buy:mint', status: 'first-buy', mint: 'mint', timestamp: 100 },
      { id: 'skip:old', status: 'skipped', reason: 'stale event' },
      { id: 'trade', status: 'confirmed', watch: 'watch', mint: 'mint', delta: '10' },
      { id: 'pending', status: 'pending', watch: 'watch', mint: 'mint', tradeKind: 'sell', signature: 'sig' },
    ];
    writeFileSync('data/live.jsonl', rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const before = new Journal('data/live.jsonl', { allowPending: true });
    assert.equal(before.has('skip:old'), false);
    assert.throws(() => pruneSkippedJournal('data/live.jsonl'), /Stop the bot/);
    before.close();
    assert.equal(pruneSkippedJournal('data/live.jsonl'), 1);
    assert.equal(pruneSkippedJournal('data/live.jsonl'), 0);
    assert.deepEqual(readFileSync('data/live.jsonl', 'utf8').trim().split('\n').map(JSON.parse),
      rows.filter(row => row.status !== 'skipped'));
    const reopened = new Journal('data/live.jsonl', { allowPending: true });
    assert.equal(reopened.has('first-buy:mint'), true);
    assert.equal(reopened.has('trade'), true);
    assert.equal(reopened.has('pending'), true);
    assert.equal(reopened.has('skip:old'), false);
    reopened.close();
  } finally { process.chdir(previous); rmSync(dir, { recursive: true, force: true }); }
});
