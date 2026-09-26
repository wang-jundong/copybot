import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { PUMP, TRADE_TAG, decodeTrades, sellAmount } from '../src/events.js';
import { loadConfig } from '../src/config.js';
import { positionsFromJournal, positionKey } from '../src/trader.js';
const user = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const event = { user, mint, isBuy: false, timestamp: 123, tokenAmount: 25 };
const data = `Program data: ${Buffer.concat([TRADE_TAG, Buffer.alloc(1)]).toString('base64')}`;
const balance = amount => [{ owner: user.toBase58(), mint: mint.toBase58(), uiTokenAmount: { amount } }];
const update = logs => ({ transaction: { transaction: { signature: Buffer.alloc(64, 1), meta: {
  logMessages: logs, preTokenBalances: balance('100'), postTokenBalances: balance('75'),
} } } });
test('decodes Pump trade and source balance using raw integers', () => {
  const trades = decodeTrades(update([`Program ${PUMP} invoke [1]`, data, `Program ${PUMP} success`]), user.toBase58(), () => event);
  assert.equal(trades.length, 1);
  assert.equal(sellAmount(1000n, trades[0]), 250n);
});
test('rejects spoofed logs from nested foreign programs', () => {
  assert.deepEqual(decodeTrades(update([`Program ${PUMP} invoke [1]`, `Program ${mint} invoke [2]`, data]), user.toBase58(), () => event), []);
});
test('ignores failed transactions, other users, and repeated mint trades', () => {
  const u = update([`Program ${PUMP} invoke [1]`, data]);
  u.transaction.transaction.meta.err = { err: Buffer.from([1]) };
  assert.deepEqual(decodeTrades(u, user.toBase58(), () => event), []);
  assert.deepEqual(decodeTrades(update([`Program ${PUMP} invoke [1]`, data]), mint.toBase58(), () => event), []);
  assert.deepEqual(decodeTrades(update([`Program ${PUMP} invoke [1]`, data, data]), user.toBase58(), () => event), []);
});
test('partial/full sells and missing or transfer-affected balances', () => {
  assert.equal(sellAmount(999n, { preBalance: 100n, postBalance: 0n, tokens: 100n }), 999n);
  assert.equal(sellAmount(999n, { preBalance: 100n, postBalance: 50n, tokens: 50n }), 499n);
  assert.equal(sellAmount(999n, { preBalance: 0n, postBalance: 0n, tokens: 5n }), 0n);
  assert.equal(sellAmount(999n, { preBalance: 100n, postBalance: 25n, tokens: 50n }), 0n);
  assert.equal(sellAmount(9007199254740993000n, { preBalance: 100n, postBalance: 50n, tokens: 50n }), 4503599627370496500n);
});
test('configuration defaults to dry-run and rejects invalid values', () => {
  const env = { GRPC_ENDPOINT: 'https://example.com', RPC_URL: 'https://example.com', WATCH_WALLET: user.toBase58() };
  assert.equal(loadConfig(env).dryRun, true);
  assert.equal(loadConfig({ ...env, HELIUS_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=test' }).rpc, 'https://mainnet.helius-rpc.com/?api-key=test');
  const noKey = { ...env };
  assert.equal(loadConfig(noKey).dryRun, true);
  assert.equal(loadConfig(noKey).keypair, null);
  assert.notEqual(loadConfig(noKey).user.toBase58(), user.toBase58());
  assert.throws(() => loadConfig({ ...noKey, DRY_RUN: 'false' }), /PRIVATE_KEY/);
  assert.equal(loadConfig(env).buyLamports, 10000000n);
  assert.equal(loadConfig(env).buySlippage, 12);
  assert.equal(loadConfig(env).sellSlippage, 50);
  const customSlippage = loadConfig({ ...env, BUY_SLIPPAGE_PERCENT: '8', SELL_SLIPPAGE_PERCENT: '25' });
  assert.equal(customSlippage.buySlippage, 8);
  assert.equal(customSlippage.sellSlippage, 25);
  assert.throws(() => loadConfig({ ...env, BUY_SLIPPAGE_PERCENT: '51' }), /BUY_SLIPPAGE_PERCENT/);
  assert.throws(() => loadConfig({ ...env, SELL_SLIPPAGE_PERCENT: '51' }), /SELL_SLIPPAGE_PERCENT/);
  assert.deepEqual(loadConfig(env).watches, [user.toBase58()]);
  const another = Keypair.generate().publicKey.toBase58();
  assert.deepEqual(loadConfig({ ...env, WATCH_WALLETS: `${user}, ${another}, ${user}` }).watches, [user.toBase58(), another]);
  assert.throws(() => loadConfig({ ...env, DRY_RUN: 'no' }), /true or false/);
  assert.throws(() => loadConfig({ ...env, BUY_SOL: '-1' }), /BUY_SOL/);
});

test('live config accepts a direct base58 or JSON secret key without leaking bad input', () => {
  const signer = Keypair.generate();
  const env = { GRPC_ENDPOINT: 'https://example.com', HELIUS_RPC_URL: 'https://example.com',
    WATCH_WALLET: user.toBase58(), DRY_RUN: 'false' };
  const base58 = bs58.encode(signer.secretKey);
  const direct = loadConfig({ ...env, PRIVATE_KEY: base58 });
  assert.equal(direct.keypair.publicKey.toBase58(), signer.publicKey.toBase58());
  assert.equal(direct.user.toBase58(), signer.publicKey.toBase58());
  assert.throws(() => loadConfig({ ...env, WATCH_WALLET: signer.publicKey.toBase58(), PRIVATE_KEY: base58 }), /differ/);
  assert.equal(loadConfig({ ...env, PRIVATE_KEY: JSON.stringify([...signer.secretKey]) })
    .user.toBase58(), signer.publicKey.toBase58());
  assert.throws(() => loadConfig({ ...env, PRIVATE_KEY: 'invalid-secret-value' }), error =>
    error.message.includes('Invalid PRIVATE_KEY') && !error.message.includes('invalid-secret-value'));
  assert.throws(() => loadConfig({ ...env, PRIVATE_KEY: JSON.stringify(Array(64).fill(256)) }), /Invalid PRIVATE_KEY/);
  assert.equal(loadConfig({ ...env, DRY_RUN: 'true', PRIVATE_KEY: 'invalid-secret-value' }).keypair, null);
});

test('one filtered update routes separate watched wallets', () => {
  const second = Keypair.generate().publicKey;
  const logs = [`Program ${PUMP} invoke [1]`, data, data, `Program ${PUMP} success`];
  let decoded = 0;
  const trades = decodeTrades(update(logs), new Set([user.toBase58(), second.toBase58()]), () => ({ ...event, user: decoded++ ? second : user }));
  assert.equal(trades.length, 2);
  assert.deepEqual(trades.map(t => t.watch), [user.toBase58(), second.toBase58()]);
  assert.notEqual(trades[0].id, trades[1].id);
});
test('journal positions stay separate for each source wallet', () => {
  const second = Keypair.generate().publicKey.toBase58();
  const rows = new Map([
    ['a', { status: 'confirmed', watch: user.toBase58(), mint: mint.toBase58(), delta: '500' }],
    ['b', { status: 'confirmed', watch: second, mint: mint.toBase58(), delta: '300' }],
    ['c', { status: 'confirmed', watch: user.toBase58(), mint: mint.toBase58(), delta: '-200' }],
  ]);
  const positions = positionsFromJournal({ rows });
  assert.equal(positions.get(positionKey(user.toBase58(), mint.toBase58())), 300n);
  assert.equal(positions.get(positionKey(second, mint.toBase58())), 300n);
  assert.throws(() => positionsFromJournal({ rows: new Map([['old', { status: 'confirmed' }]]) }), /position data/);
});
