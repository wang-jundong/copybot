import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.js';
import { liveTestAttempts } from '../src/live_test_limit.js';
import { Trader, positionKey } from '../src/trader.js';

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'copybot-cache-'));
  const path = join(dir, 'journal.jsonl');
  const journal = new Journal(path, { allowPending: true });
  try { run(journal, path); }
  finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
}

function cache(journal, mint, timestamp) {
  journal.put({ id: `first-buy:${mint}`, status: 'first-buy', mint, timestamp, firstEventId: `${mint}:1` });
}

test('cleanup uses mint age, preserves the 10-minute boundary and holdings across all wallets', () => {
  fixture((journal, path) => {
    for (const mint of ['expired', 'held', 'boundary', 'young'])
      cache(journal, mint, { expired: 399, held: 1, boundary: 400, young: 401 }[mint]);
    const history = [
      { id: 'buy', status: 'confirmed', watch: 'removed-wallet', mint: 'held', delta: '10' },
      { id: 'closed-buy', status: 'dry-run', watch: 'watch', mint: 'expired', delta: '10' },
      { id: 'closed-sell', status: 'dry-run', watch: 'watch', mint: 'expired', delta: '-10' },
    ];
    for (const row of history) journal.put(row);
    const trader = new Trader({}, { dryRun: true, watches: ['watch'] }, journal);
    for (const mint of ['expired', 'held', 'boundary', 'young', 'unknown']) trader.mints.set(mint, {});
    trader.firstBuys.legacyTried.add('expired');
    assert.equal(trader.pruneMintCache(1000), 1);
    assert.equal(trader.firstBuys.cached('expired'), null);
    assert.equal(trader.firstBuys.eventId('expired'), null);
    assert.equal(trader.firstBuys.legacyTried.has('expired'), false);
    assert.equal(journal.has('first-buy:expired'), false);
    assert.deepEqual([...trader.mints.keys()], ['held', 'boundary', 'young', 'unknown']);
    assert.equal(trader.pruneMintCache(1000), 0);
    const diskRows = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(diskRows.filter(row => ['confirmed', 'dry-run'].includes(row.status)), [history[0]]);
    assert.equal(diskRows.some(row => row.id === 'first-buy:expired'), false);
    const restored = new Trader({}, { dryRun: true, watches: ['watch'] },
      { rows: new Map(diskRows.map(row => [row.id, row])) });
    assert.equal(restored.firstBuys.cached('expired'), null);
    assert.equal(restored.positions.get(positionKey('removed-wallet', 'held')), 10n);
    assert.equal(trader.positions.has(positionKey('watch', 'expired')), false);
    journal.put({ id: 'held-sell', status: 'confirmed', watch: 'removed-wallet', mint: 'held', delta: '-10' });
    trader.positions.set(positionKey('removed-wallet', 'held'), 0n);
    assert.equal(trader.pruneMintCache(1000), 1);
    assert.equal(trader.mints.has('held'), false);
  });
});

test('cleanup defers queued trades, pending transactions and cache loads until settled', () => {
  fixture(journal => {
    for (const mint of ['queued', 'pending', 'history-load', 'mint-load']) cache(journal, mint, 1);
    journal.put({ id: 'submission', status: 'pending', mint: 'pending' });
    const trader = new Trader({}, { dryRun: true, watches: [] }, journal);
    trader.firstBuys.pending.set('history-load', Promise.resolve());
    trader.mintLoads.set('mint-load', Promise.resolve());
    assert.equal(trader.pruneMintCache(1000, new Set(['queued'])), 0);
    journal.put({ id: 'submission', status: 'failed', mint: 'pending' });
    trader.firstBuys.pending.clear();
    trader.mintLoads.clear();
    assert.equal(trader.pruneMintCache(1000), 4);
    assert.equal(journal.rows.get('submission').status, 'pruned-event');
    assert.equal(journal.rows.get('pruned-trade-counts').legacy, true);
  });
});

test('failed persistent cleanup leaves memory cache intact', () => {
  fixture(journal => {
    cache(journal, 'expired', 1);
    const trader = new Trader({}, { dryRun: true, watches: [] }, journal);
    trader.mints.set('expired', {});
    journal.removeClosedMints = () => { throw new Error('disk failure'); };
    assert.throws(() => trader.pruneMintCache(1000), /disk failure/);
    assert.equal(trader.firstBuys.cached('expired'), 1);
    assert.equal(trader.mints.has('expired'), true);
  });
});

test('closed live history is removed across restart without resetting limits or replay protection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copybot-closed-live-'));
  const path = join(dir, 'journal.jsonl');
  let journal = new Journal(path);
  try {
    cache(journal, 'closed', 1);
    const put = (id, status, tradeKind, signature, watch, delta) =>
      journal.put({ id, status, tradeKind, signature, watch, mint: 'closed', delta });
    put('buy-a', 'pending', 'buy', 'buy-sig-a', 'a');
    put('buy-a', 'confirmed', 'buy', 'buy-sig-a', 'a', '10');
    put('buy-b', 'confirmed', 'buy', 'buy-sig-b', 'b', '20');
    put('sell-a', 'confirmed', 'sell', 'migration-sig', 'a', '-10');
    put('sell-b', 'confirmed', 'sell', 'migration-sig', 'b', '-20');
    put('failed-buy', 'failed', 'buy', 'failed-sig', 'a');
    const config = { dryRun: false, liveTestMode: true, watches: ['a', 'b'] };
    const trader = new Trader({}, config, journal);
    assert.equal(trader.pruneMintCache(1000), 1);
    const content = readFileSync(path, 'utf8');
    assert.equal(content.includes('"mint":"closed"'), false);
    assert.equal(content.includes('"signature"'), false);
    assert.equal(content.includes('"pending"'), false);
    assert.equal(trader.positions.size, 0);
    assert.equal(liveTestAttempts(journal, 'buy'), 3);
    assert.equal(liveTestAttempts(journal, 'sell'), 1);
    journal.close();
    journal = new Journal(path);
    const restarted = new Trader({}, config, journal);
    assert.equal(restarted.positions.size, 0);
    assert.equal(restarted.hasLiveTestSlot('buy'), false);
    assert.equal(restarted.hasLiveTestSlot('sell'), false);
    assert.equal(journal.has('buy-a'), true);
    assert.equal(journal.has('sell-a'), true);
    // A new closed mint accumulates counts; repeated cleanup cannot double-count.
    cache(journal, 'next', 1);
    journal.put({ id: 'next-failure', status: 'failed', tradeKind: 'buy', signature: 'next-sig', mint: 'next' });
    const next = new Trader({}, config, journal);
    assert.equal(next.pruneMintCache(1000), 1);
    assert.equal(next.pruneMintCache(1000), 0);
    assert.equal(liveTestAttempts(journal, 'buy'), 4);
    for (const row of [...journal.rows.values()]) {
      if (row.status === 'pruned-event') journal.put({ ...row, expiresAt: Date.now() - 1 });
    }
    assert.equal(journal.has('buy-a'), false);
    next.pruneMintCache(1000);
    assert.equal(journal.rows.size, 1);
    assert.equal(readFileSync(path, 'utf8').includes('pruned-event'), false);
    assert.equal(liveTestAttempts(journal, 'buy'), 4);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('legacy history cleanup keeps live-test validation and pending history stays protected', () => {
  fixture(journal => {
    cache(journal, 'legacy', 1);
    journal.put({ id: 'legacy-failed', status: 'failed', mint: 'legacy' });
    const trader = new Trader({}, { dryRun: true, watches: [] }, journal);
    trader.pruneMintCache(1000);
    assert.throws(() => liveTestAttempts(journal, 'buy'), /legacy live trade/);
    journal.put({ id: 'pending', status: 'pending', mint: 'unsettled' });
    assert.throws(() => journal.removeClosedMints(new Set(['unsettled'])), /unresolved/);
    assert.equal(journal.rows.get('pending').status, 'pending');
  });
});
