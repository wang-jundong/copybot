import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/journal.js';
import { FirstBuyIndex, entryBoundsStatus, entryFilterReason, eventMarketCapLamports, formatSol } from '../src/curve_filter.js';
import { loadConfig } from '../src/config.js';
import { PUMP, TRADE_TAG } from '../src/events.js';

const mint = Keypair.generate().publicKey;
const user = Keypair.generate().publicKey;
const event = (timestamp, isBuy = true) => ({ mint, user, timestamp: { toString: () => String(timestamp) }, isBuy });
const log = `Program data: ${Buffer.concat([TRADE_TAG, Buffer.alloc(1)]).toString('base64')}`;
const logs = [`Program ${PUMP} invoke [1]`, log, `Program ${PUMP} success`];

// Exercise the same log envelope with a controlled decoded event.
test('first buy is searched from oldest mint history and cached with event timestamp', async () => {
  const saved = [];
  const requested = [];
  const journal = { rows: new Map(), put: row => saved.push(row) };
  const rpc = {
    async getSignaturesForAddress(address, options) {
      assert.equal(address.toBase58(), mint.toBase58());
      assert.equal(options.limit, 1000);
      return [{ signature: 'new' }, { signature: 'middle' }, { signature: 'old' }];
    },
    async getTransaction(signature, options) {
      assert.equal(options.maxSupportedTransactionVersion, 1);
      requested.push(signature);
      return { version: signature === 'old' ? 1 : 0, meta: { err: null, logMessages: logs } };
    },
  };
  const decode = (actualLogs, signature) => {
    assert.deepEqual(actualLogs, logs);
    const seen = signature === 'old' ? event(100, false) : signature === 'middle' ? event(120) : event(160);
    return [{ index: 1, event: seen }];
  };
  const index = new FirstBuyIndex(rpc, journal, decode);
  assert.equal(await index.get(mint.toBase58()), 120);
  assert.deepEqual(requested, ['old', 'middle']);
  assert.deepEqual(saved, [{ id: `first-buy:${mint}`, status: 'first-buy', mint: mint.toBase58(), timestamp: 120, firstEventId: 'middle:1' }]);
  assert.equal(index.eventId(mint.toBase58()), 'middle:1');
  assert.equal(await index.get(mint.toBase58()), 120);
  assert.deepEqual(requested, ['old', 'middle']);
  const restored = new FirstBuyIndex(rpc, { rows: new Map([[saved[0].id, saved[0]]]) }, decode);
  assert.equal(await restored.get(mint.toBase58()), 120);
});

test('default historical decoder reads a Pump buy event without passing the signature as a callback', async () => {
  const payload = Buffer.alloc(512);
  mint.toBuffer().copy(payload, 0);
  payload[48] = 1; // isBuy
  payload.writeBigInt64LE(123n, 81); // on-chain event timestamp
  const tradeLog = `Program data: ${Buffer.concat([TRADE_TAG, payload]).toString('base64')}`;
  const rpc = {
    async getSignaturesForAddress() { return [{ signature: 'first-buy' }]; },
    async getTransaction() { return { meta: { err: null, logMessages: [`Program ${PUMP} invoke [1]`, tradeLog, `Program ${PUMP} success`] } }; },
  };
  const saved = [];
  const index = new FirstBuyIndex(rpc, { rows: new Map(), put: row => saved.push(row) });
  assert.equal(await index.get(mint.toBase58()), 123);
  assert.equal(saved[0].timestamp, 123);
  assert.equal(saved[0].firstEventId, 'first-buy:1');
});

test('historical lookup fails closed when history has no proven first buy', async () => {
  const rpc = {
    async getSignaturesForAddress() { return [{ signature: 'only' }]; },
    async getTransaction() { return { meta: { err: null, logMessages: logs } }; },
  };
  const index = new FirstBuyIndex(rpc, { rows: new Map(), put() {} }, () => [{ event: event(100, false) }]);
  assert.equal(await index.get(mint.toBase58()), null);
});

test('market cap uses virtual SOL reserves at the target event', () => {
  const trade = { isBuy: true, timestamp: 160, virtualSolReserves: '30000000000', virtualTokenReserves: '1000000000000000' };
  const supply = 1000000000000000n;
  const cap = eventMarketCapLamports(trade, supply);
  assert.equal(cap, 30000000000n);
  assert.equal(formatSol(cap), '30');
  assert.equal(formatSol(1234567891n), '1.234567891');
  const limits = { minCurveAge: 30, maxCurveAge: 70, minMarketCapLamports: 20000000000n, maxMarketCapLamports: 40000000000n };
  assert.equal(entryFilterReason(trade, 100, cap, limits), null);
  const firstTrade = { ...trade, id: 'first-signature:1', timestamp: 100 };
  assert.match(entryFilterReason(firstTrade, 100, cap, { ...limits, minCurveAge: 0 }, 'first-signature:1'), /first bonding-curve buy event/);
  assert.equal(entryFilterReason({ ...firstTrade, id: 'later-signature:1' }, 100, cap, { ...limits, minCurveAge: 0 }, 'first-signature:1'), null);
  assert.match(entryFilterReason({ ...firstTrade, id: 'unknown-signature:1' }, 100, cap, { ...limits, minCurveAge: 0 }), /identity unavailable/);
  const noBounds = { minCurveAge: null, maxCurveAge: null, minMarketCapLamports: null, maxMarketCapLamports: null };
  assert.equal(entryBoundsStatus(noBounds), 'none');
  assert.match(entryFilterReason(trade, 100, cap, noBounds), /must both be configured/);
  const ageOnly = { ...noBounds, minCurveAge: 10 };
  const capOnly = { ...noBounds, maxMarketCapLamports: 50000000000n };
  assert.equal(entryBoundsStatus(ageOnly), 'partial');
  assert.equal(entryBoundsStatus(capOnly), 'partial');
  assert.match(entryFilterReason(trade, 100, cap, ageOnly), /must both be configured/);
  assert.match(entryFilterReason(trade, 100, cap, capOnly), /must both be configured/);
  assert.equal(entryFilterReason(trade, 100, cap, { ...ageOnly, maxMarketCapLamports: 50000000000n }), null);
  assert.match(entryFilterReason(trade, null, cap, limits), /first bonding-curve buy unavailable/);
  assert.match(entryFilterReason(trade, 100, null, limits), /market cap unavailable/);
  assert.match(entryFilterReason(trade, 140, cap, limits), /below minimum/);
  assert.match(entryFilterReason(trade, 50, cap, limits), /above maximum/);
  assert.match(entryFilterReason(trade, null, cap, limits), /unavailable/);
  assert.match(entryFilterReason(trade, 100, 50000000000n, limits), /above maximum/);
  assert.equal(entryFilterReason({ ...trade, isBuy: false }, null, null, limits), null);
});

test('filter configuration is exact and validates bounds', () => {
  const env = { GRPC_ENDPOINT: 'https://example.com', RPC_URL: 'https://example.com', WATCH_WALLET: user.toBase58() };
  const empty = loadConfig(env);
  assert.equal(empty.maxCurveAge, null);
  assert.equal(empty.liveTestMode, false);
  assert.equal(loadConfig({ ...env, LIVE_TEST_MODE: 'true' }).liveTestMode, true);
  assert.throws(() => loadConfig({ ...env, LIVE_TEST_MODE: 'yes' }), /LIVE_TEST_MODE/);
  assert.equal(empty.minMarketCapLamports, null);
  const configured = loadConfig({ ...env, MIN_CURVE_AGE_SECONDS: '10', MAX_CURVE_AGE_SECONDS: '180', MIN_MARKETCAP_SOL: '0.000000001', MAX_MARKETCAP_SOL: '50' });
  assert.equal(configured.minCurveAge, 10);
  assert.equal(configured.maxCurveAge, 180);
  assert.equal(configured.minMarketCapLamports, 1n);
  assert.equal(configured.maxMarketCapLamports, 50000000000n);
  assert.throws(() => loadConfig({ ...env, MIN_CURVE_AGE_SECONDS: '20', MAX_CURVE_AGE_SECONDS: '10' }), /exceeds/);
  assert.throws(() => loadConfig({ ...env, MIN_MARKETCAP_SOL: '1.0000000001' }), /Invalid/);
});

test('concurrent age checks for one mint share one historical lookup', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const rpc = {
    async getSignaturesForAddress() { calls++; await gate; return []; },
  };
  const index = new FirstBuyIndex(rpc, { rows: new Map(), put() {} });
  const first = index.get(mint.toBase58());
  const second = index.get(mint.toBase58());
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
});

test('first-buy time found on a sell is persisted and reused after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'copybot-first-buy-'));
  const path = join(dir, 'cache.jsonl');
  try {
    const journal = new Journal(path);
    let historyCalls = 0;
    const rpc = {
      async getSignaturesForAddress() { historyCalls++; return [{ signature: 'source-first-buy' }]; },
      async getTransaction() { return { meta: { err: null, logMessages: logs } }; },
    };
    const decoder = () => [{ index: 1, event: event(123, true) }];
    const index = new FirstBuyIndex(rpc, journal, decoder);
    assert.equal(await index.get(mint.toBase58()), 123);
    assert.equal(historyCalls, 1);
    journal.close();

    const reopened = new Journal(path);
    const afterRestart = new FirstBuyIndex({ getSignaturesForAddress() { throw new Error('history should not be read'); } }, reopened);
    assert.equal(await afterRestart.get(mint.toBase58()), 123);
    assert.equal(afterRestart.eventId(mint.toBase58()), 'source-first-buy:1');
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('timestamp-only cache is upgraded to an exact first-buy event ID', async () => {
  const legacy = { id: `first-buy:${mint}`, status: 'first-buy', mint: mint.toBase58(), timestamp: 123 };
  const rows = new Map([[legacy.id, legacy]]);
  let historyCalls = 0;
  const journal = { rows, put: row => rows.set(row.id, row) };
  const rpc = {
    async getSignaturesForAddress() { historyCalls++; return [{ signature: 'oldest' }]; },
    async getTransaction() { return { meta: { err: null, logMessages: logs } }; },
  };
  const index = new FirstBuyIndex(rpc, journal, () => [{ index: 1, event: event(123, true) }]);
  assert.equal(await index.get(mint.toBase58()), 123);
  assert.equal(index.eventId(mint.toBase58()), 'oldest:1');
  assert.equal(rows.get(legacy.id).firstEventId, 'oldest:1');
  assert.equal(await index.get(mint.toBase58()), 123);
  assert.equal(historyCalls, 1);
});

test('legacy timestamp still protects the first second when historical ID is unavailable', async () => {
  const legacy = { id: `first-buy:${mint}`, status: 'first-buy', mint: mint.toBase58(), timestamp: 123 };
  const index = new FirstBuyIndex({ async getSignaturesForAddress() { return []; } },
    { rows: new Map([[legacy.id, legacy]]), put() {} });
  assert.equal(await index.get(mint.toBase58()), 123);
  assert.equal(index.eventId(mint.toBase58()), null);
});
