import { test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Trader, positionKey } from '../src/trader.js';

const now = () => Math.floor(Date.now() / 1000);

test('cached event state builds dry-run buy and sell without pre-trade RPC reads', async () => {
  const watch = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const recipient = Keypair.generate().publicKey;
  const rows = new Map();
  const journal = { rows, has: id => rows.has(id), put: row => rows.set(row.id, row) };
  const rpc = new Proxy({}, { get(_target, name) { throw new Error(`unexpected RPC read: ${String(name)}`); } });
  const trader = new Trader(rpc, { watches: [watch], user: Keypair.generate().publicKey,
    dryRun: true, maxAge: 30, buyLamports: 10_000_000n, buySlippage: 12, sellSlippage: 50,
    minCurveAge: 0, maxCurveAge: null, minMarketCapLamports: 0n, maxMarketCapLamports: null }, journal);
  trader.firstBuys.times.set(mint, now() - 100);
  trader.firstBuys.eventIds.set(mint, 'first:1');
  trader.mints.set(mint, { tokenProgram: TOKEN_PROGRAM_ID, mintSupply: new BN('1000000000000000') });
  trader.global = { creatorFeeConfigurable: false, feeRecipient: recipient, feeRecipients: [] };
  trader.feeConfig = { feeTiers: [{ marketCapLamportsThreshold: new BN(0), fees: {
    protocolFeeBps: new BN(100), creatorFeeBps: new BN(30), lpFeeBps: new BN(0) } }] };
  const base = { signature: 'source', watch, mint, timestamp: now(), creator,
    virtualSolReserves: '30000000000', virtualTokenReserves: '1000000000000000',
    realTokenReserves: '500000000000000', creatorFeeBasisPoints: '30', mayhemMode: false };
  const buy = { ...base, id: 'buy:1', isBuy: true };
  await trader.execute(buy, trader.inspect(buy));
  assert.equal(rows.get(buy.id).status, 'dry-run');
  assert.ok(trader.positions.get(positionKey(watch, mint)) > 0n);
  const sell = { ...base, id: 'sell:1', isBuy: false, preBalance: 1000n,
    postBalance: 500n, tokens: 500n };
  await trader.execute(sell);
  assert.equal(rows.get(sell.id).status, 'dry-run');
  assert.ok(trader.positions.get(positionKey(watch, mint)) > 0n);
});
