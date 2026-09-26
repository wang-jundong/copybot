import { test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { Keypair } from '@solana/web3.js';
import { MINT_SIZE, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Trader, positionKey } from '../src/trader.js';

const supply = 1000000000000000n;
const makeMintInfo = () => {
  const data = Buffer.alloc(MINT_SIZE);
  data.writeBigUInt64LE(supply, 36);
  data[44] = 6;
  data[45] = 1;
  return { owner: TOKEN_PROGRAM_ID, data };
};

test('restart warms an open position before its first sell, then sells without another state read', async () => {
  const watch = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const rows = new Map([['prior-buy', { id: 'prior-buy', status: 'confirmed', watch, mint, delta: '319369370620' }]]);
  const journal = { rows, has: id => rows.has(id), put: row => rows.set(row.id, row) };
  let mintReads = 0, globalReads = 0, feeReads = 0;
  const rpc = { async getAccountInfo(address) {
    assert.equal(address.toBase58(), mint);
    mintReads++;
    return makeMintInfo();
  } };
  const trader = new Trader(rpc, { dryRun: true, user: Keypair.generate().publicKey, watches: [watch],
    maxAge: 30, buySlippage: 12, sellSlippage: 50 }, journal);
  trader.sdk.fetchGlobal = async () => {
    globalReads++;
    return { creatorFeeConfigurable: false, feeRecipient: Keypair.generate().publicKey, feeRecipients: [] };
  };
  trader.sdk.fetchFeeConfig = async () => {
    feeReads++;
    return { feeTiers: [{ marketCapLamportsThreshold: new BN(0), fees: {
      protocolFeeBps: new BN(100), creatorFeeBps: new BN(30), lpFeeBps: new BN(0) } }] };
  };
  await trader.prepareForStream();
  assert.equal(mintReads, 1);
  assert.equal(globalReads, 1);
  assert.equal(feeReads, 1);
  assert.equal(trader.mints.get(mint).mintSupply.toString(), supply.toString());
  const sell = { id: 'first-sell-after-restart', watch, mint, isBuy: false,
    timestamp: Math.floor(Date.now() / 1000), preBalance: 1000n, postBalance: 500n, tokens: 500n,
    creator, virtualSolReserves: '30000000000', virtualTokenReserves: '1000000000000000',
    realTokenReserves: '500000000000000', mayhemMode: false };
  await trader.execute(sell);
  assert.equal(rows.get(sell.id).status, 'dry-run');
  assert.ok(trader.positions.get(positionKey(watch, mint)) > 0n);
  assert.equal(mintReads, 1);
  assert.equal(globalReads, 1);
  assert.equal(feeReads, 1);
});

test('restart refuses to subscribe when an open position mint cannot be warmed', async () => {
  const watch = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const rows = new Map([['prior-buy', { id: 'prior-buy', status: 'confirmed', watch, mint, delta: '10' }]]);
  const trader = new Trader({ async getAccountInfo() { return null; } }, { watches: [watch] }, { rows });
  trader.warmStatic = async () => {};
  await assert.rejects(trader.prepareForStream(), /Mint state unavailable for open position/);
});
