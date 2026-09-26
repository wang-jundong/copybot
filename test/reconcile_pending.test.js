import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { Journal } from '../src/journal.js';
import { reconcilePending, reconcilePendingUntilSettled } from '../src/reconcile_pending.js';
import { positionsFromJournal, positionKey } from '../src/trader.js';
import { liveTestAttempts } from '../src/live_test_limit.js';

const absentRpc = height => ({
  async getSignatureStatuses(_signatures, options) {
    assert.equal(options.searchTransactionHistory, true);
    return { value: [null] };
  },
  async getTransaction() { return null; },
  async getBlockHeight(commitment) { assert.equal(commitment, 'finalized'); return height; },
  async isBlockhashValid() { return { value: false }; },
});
const tokenRow = (owner, mint, amount) => ({ owner, mint, uiTokenAmount: { amount: String(amount) } });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'copybot-reconcile-'));
  const path = join(dir, 'live.jsonl');
  const journal = new Journal(path);
  return { dir, path, journal };
};

test('verified expired pending buy is failed and journal reopens without duplicate buy', async () => {
  const { dir, path, journal } = setup();
  const owner = Keypair.generate().publicKey;
  const watch = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  try {
    journal.put({ id: 'buy:1', status: 'pending', tradeKind: 'buy', signature: 'sig',
      watch, mint, venue: 'curve', blockhash: 'hash', lastValidBlockHeight: 100 });
    journal.close();
    assert.throws(() => new Journal(path), /Unresolved/);
    const opened = new Journal(path, { allowPending: true });
    const outcomes = await reconcilePending(opened, absentRpc(200), absentRpc(201), owner);
    assert.equal(outcomes.get('sig'), 'failed');
    opened.close();
    const again = new Journal(path);
    assert.equal(again.rows.get('buy:1').status, 'failed');
    assert.equal(liveTestAttempts(again, 'buy'), 1);
    again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('confirmed pending buy restores actual token balance change', async () => {
  const { dir, journal } = setup();
  const owner = Keypair.generate().publicKey;
  const watch = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  try {
    journal.put({ id: 'buy:1', status: 'pending', tradeKind: 'buy', signature: 'sig', watch, mint, venue: 'curve' });
    const primary = { async getSignatureStatuses() { return { value: [{ err: null, confirmationStatus: 'confirmed' }] }; },
      async getTransaction() { return { meta: { err: null, preTokenBalances: [],
        postTokenBalances: [tokenRow(owner.toBase58(), mint, 75)] } }; } };
    const outcomes = await reconcilePending(journal, primary, {}, owner);
    assert.equal(outcomes.get('sig'), 'confirmed');
    assert.equal(journal.rows.get('buy:1').delta, '75');
    assert.equal(positionsFromJournal(journal).get(positionKey(watch, mint)), 75n);
    journal.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('valid or unverifiable signature stays pending', async () => {
  const { dir, journal } = setup();
  const owner = Keypair.generate().publicKey;
  try {
    journal.put({ id: 'buy:1', status: 'pending', tradeKind: 'buy', signature: 'sig',
      watch: 'watch', mint: 'mint', venue: 'curve', lastValidBlockHeight: 100 });
    assert.equal((await reconcilePending(journal, absentRpc(99), absentRpc(200), owner)).get('sig'), 'unresolved');
    assert.equal(journal.rows.get('buy:1').status, 'pending');
    assert.equal((await reconcilePending(journal, absentRpc(200), { ...absentRpc(200),
      async getSignatureStatuses() { throw new Error('RPC unavailable'); } }, owner)).get('sig'), 'unresolved');
    assert.equal(journal.rows.get('buy:1').status, 'pending');
    journal.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration recovery credits each watched allocation only for exact combined sell fill', async () => {
  const { dir, journal } = setup();
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey.toBase58();
  const watches = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
  try {
    for (const [i, watch] of watches.entries()) {
      journal.put({ id: `old:${watch}`, status: 'confirmed', tradeKind: 'buy', signature: `old${i}`,
        watch, mint, delta: String((i + 1) * 100) });
      journal.put({ id: `exit:${watch}`, status: 'pending', tradeKind: 'sell', signature: 'exit',
        watch, mint, venue: 'pumpswap', expectedDelta: String(-(i + 1) * 100) });
    }
    const primary = { async getSignatureStatuses() { return { value: [{ err: null }] }; },
      async getTransaction() { return { meta: { err: null,
        preTokenBalances: [tokenRow(owner.toBase58(), mint, 300)], postTokenBalances: [] } }; } };
    assert.equal((await reconcilePending(journal, primary, {}, owner)).get('exit'), 'confirmed');
    assert.equal(liveTestAttempts(journal, 'sell'), 1);
    for (const watch of watches) assert.equal(positionsFromJournal(journal).get(positionKey(watch, mint)), 0n);
    journal.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recovery waits for a valid blockhash to expire before failing an absent signature', async () => {
  const { dir, journal } = setup();
  const owner = Keypair.generate().publicKey;
  let heightChecks = 0;
  try {
    journal.put({ id: 'buy:1', status: 'pending', tradeKind: 'buy', signature: 'sig',
      watch: 'watch', mint: 'mint', venue: 'curve', lastValidBlockHeight: 100 });
    const primary = { ...absentRpc(200), async getBlockHeight() { return heightChecks++ === 0 ? 99 : 200; } };
    const outcomes = await reconcilePendingUntilSettled(journal, primary, absentRpc(200), owner,
      null, { maxChecks: 3, intervalMs: 0 });
    assert.equal(outcomes.get('sig'), 'failed');
    assert.equal(heightChecks, 2);
    journal.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('on-chain error is failed, but an inconsistent confirmed fill stays pending', async () => {
  const { dir, journal } = setup();
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey.toBase58();
  try {
    journal.put({ id: 'failed', status: 'pending', tradeKind: 'buy', signature: 'failed-sig',
      watch: 'watch', mint, venue: 'curve' });
    const failedRpc = { async getSignatureStatuses() { return { value: [{ err: { InstructionError: [0, 1] } }] }; },
      async getTransaction() { return null; } };
    assert.equal((await reconcilePending(journal, failedRpc, {}, owner)).get('failed-sig'), 'failed');
    journal.put({ id: 'bad-fill', status: 'pending', tradeKind: 'buy', signature: 'bad-sig',
      watch: 'watch', mint, venue: 'curve' });
    const badFillRpc = { async getSignatureStatuses() { return { value: [{ err: null }] }; },
      async getTransaction() { return { meta: { err: null, preTokenBalances: [], postTokenBalances: [] } }; } };
    assert.equal((await reconcilePending(journal, badFillRpc, {}, owner)).get('bad-sig'), 'unresolved');
    assert.equal(journal.rows.get('bad-fill').status, 'pending');
    journal.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
