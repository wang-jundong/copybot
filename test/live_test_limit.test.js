import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { Trader } from '../src/trader.js';
import { liveTestAttempts, liveTestSellAmount } from '../src/live_test_limit.js';
import { HELIUS_TIP_ACCOUNTS } from '../src/helius_sender.js';

const tokenRow = (owner, mint, amount) => ({ owner, mint, uiTokenAmount: { amount: String(amount) } });

test('live-test counter counts one migration signature and failed submissions', () => {
  const rows = new Map([
    ['a', { status: 'confirmed', tradeKind: 'sell', signature: 'same' }],
    ['b', { status: 'confirmed', tradeKind: 'sell', signature: 'same' }],
    ['c', { status: 'failed', tradeKind: 'buy', signature: 'other' }],
    ['d', { status: 'skipped' }],
  ]);
  assert.equal(liveTestAttempts({ rows }, 'sell'), 1);
  assert.equal(liveTestAttempts({ rows }, 'buy'), 1);
  rows.set('legacy', { status: 'confirmed', signature: 'old' });
  assert.throws(() => liveTestAttempts({ rows }, 'buy'), /legacy live trade/);
});

test('live test permits only one buy and one sell across Trader restarts', async () => {
  const keypair = Keypair.generate();
  const watch = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const owner = keypair.publicKey.toBase58();
  const rows = new Map();
  const journal = { rows, put: row => rows.set(row.id, row) };
  let sends = 0;
  const rpc = {
    async confirmTransaction() { return { value: { err: null } }; },
    async getTransaction() {
      return { meta: sends === 1
        ? { preTokenBalances: [], postTokenBalances: [tokenRow(owner, mint, 25)] }
        : { preTokenBalances: [tokenRow(owner, mint, 25)], postTokenBalances: [] } };
    },
  };
  const config = { dryRun: false, liveTestMode: true, keypair, user: keypair.publicKey,
    watches: [watch], priorityFee: 1000, tipLamports: 5000n, tipAccount: HELIUS_TIP_ACCOUNTS[0] };
  const ix = SystemProgram.transfer({ fromPubkey: keypair.publicKey,
    toPubkey: Keypair.generate().publicKey, lamports: 1 });
  const trade = (id, isBuy) => ({ id, watch, mint, isBuy,
    blockhash: Keypair.generate().publicKey.toBase58() });
  const start = () => {
    const trader = new Trader(rpc, config, journal);
    trader.blockhashCache.current = () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 999 });
    trader.sendSenderTransaction = async (_mode, _raw, signature) => { sends++; return signature; };
    return trader;
  };
  assert.equal(await start().submitLiveTrade(trade('buy-1', true), [ix]), true);
  assert.equal(await start().submitLiveTrade(trade('buy-2', true), [ix]), null);
  assert.equal(await start().submitLiveTrade(trade('sell-1', false), [ix]), true);
  assert.equal(await start().submitLiveTrade(trade('sell-2', false), [ix]), null);
  assert.equal(sends, 2);
  assert.equal(rows.get('buy-2').reason, 'live test buy limit reached');
  assert.equal(rows.get('sell-2').reason, 'live test sell limit reached');
});

test('live-test sell exits full allocation only for a valid source sell', () => {
  const partial = { preBalance: 100n, postBalance: 50n, tokens: 50n };
  assert.equal(liveTestSellAmount(1000n, partial, true), 1000n);
  assert.equal(liveTestSellAmount(1000n, partial, false), 500n);
  assert.equal(liveTestSellAmount(1000n, { preBalance: 0n, postBalance: 0n, tokens: 50n }, true), 0n);
});
