import { test } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { Trader, positionKey } from '../src/trader.js';
import { HELIUS_TIP_ACCOUNTS } from '../src/helius_sender.js';

const row = (owner, mint, amount) => ({ owner, mint, uiTokenAmount: { amount: String(amount) } });

test('live buy and sell sign, submit, confirm, and update positions from actual token deltas', async () => {
  const keypair = Keypair.generate();
  const watch = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const rows = new Map();
  const recorded = [];
  const sent = [];
  const journal = {
    rows,
    put(value) { recorded.push(value); rows.set(value.id, value); },
  };
  let fills = 0;
  const rpc = {
    async sendRawTransaction() { throw new Error('standard RPC broadcast must not be used'); },
    async confirmTransaction(details) {
      assert.equal(details.signature, sent.at(-1));
      assert.equal(details.lastValidBlockHeight, 999);
      return { value: { err: null } };
    },
    async getTransaction(signature) {
      assert.equal(signature, sent.at(-1));
      fills++;
      return { meta: fills === 1
        ? { preTokenBalances: [], postTokenBalances: [row(keypair.publicKey.toBase58(), mint, 25)] }
        : { preTokenBalances: [row(keypair.publicKey.toBase58(), mint, 25)], postTokenBalances: [] } };
    },
  };
  const trader = new Trader(rpc, { dryRun: false, keypair, user: keypair.publicKey,
    priorityFee: 1000, watches: [watch], senderMode: 'swqos', tipLamports: 5000n,
    tipAccount: HELIUS_TIP_ACCOUNTS[0] }, journal);
  const freshBlockhash = Keypair.generate().publicKey.toBase58();
  trader.blockhashCache.current = () => ({ blockhash: freshBlockhash, lastValidBlockHeight: 999 });
  trader.sendSenderTransaction = async (mode, raw, signature) => {
    assert.equal(mode, 'swqos');
    const tx = VersionedTransaction.deserialize(raw);
    assert.equal(tx.message.recentBlockhash, freshBlockhash);
    assert.equal(tx.message.compiledInstructions.length, 4);
    assert.notDeepEqual(tx.signatures[0], new Uint8Array(64));
    assert.equal(bs58.encode(tx.signatures[0]), signature);
    sent.push(signature);
    return signature;
  };
  const ix = SystemProgram.transfer({ fromPubkey: keypair.publicKey,
    toPubkey: Keypair.generate().publicKey, lamports: 1 });
  await trader.submitLiveTrade({ id: 'buy', watch, mint, isBuy: true, blockhash: Keypair.generate().publicKey.toBase58() }, [ix]);
  assert.equal(trader.positions.get(positionKey(watch, mint)), 25n);
  await trader.submitLiveTrade({ id: 'sell', watch, mint, isBuy: false, blockhash: Keypair.generate().publicKey.toBase58() }, [ix]);
  assert.equal(trader.positions.get(positionKey(watch, mint)), 0n);
  assert.equal(sent.length, 2);
  assert.deepEqual(recorded.map(value => value.status), ['pending', 'confirmed', 'pending', 'confirmed']);
  assert.deepEqual(recorded.filter(value => value.status === 'pending').map(value => value.lastValidBlockHeight), [999, 999]);
  assert.deepEqual(recorded.filter(value => value.status === 'confirmed').map(value => value.delta), ['25', '-25']);
});

test('live trade refuses to submit without a configured signer', async () => {
  const trader = new Trader({}, { dryRun: false, keypair: null, watches: [] }, { rows: new Map() });
  await assert.rejects(trader.submitLiveTrade({}, []), /PRIVATE_KEY/);
});

test('live trade refuses to sign or journal when the cached Helius blockhash is stale', async () => {
  const keypair = Keypair.generate();
  const rows = new Map();
  const trader = new Trader({}, { dryRun: false, keypair, user: keypair.publicKey, watches: [] },
    { rows, put: row => rows.set(row.id, row) });
  let sent = false;
  trader.sendSenderTransaction = async () => { sent = true; };
  await assert.rejects(trader.submitLiveTrade({ id: 'stale', watch: 'watch', mint: 'mint', isBuy: true }, []),
    /No fresh Helius blockhash cached/);
  assert.equal(sent, false);
  assert.equal(rows.size, 0);
});

test('confirmation error resolves an expired absent transaction without a startup blocker', async () => {
  const keypair = Keypair.generate();
  const watch = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const rows = new Map();
  const journal = { rows, put: row => rows.set(row.id, row) };
  const absent = { async getSignatureStatuses() { return { value: [null] }; },
    async getTransaction() { return null; },
    async getBlockHeight() { return 200; } };
  const rpc = { ...absent, async confirmTransaction() { throw new Error('confirmation expired'); } };
  const trader = new Trader(rpc, { dryRun: false, keypair, user: keypair.publicKey,
    watches: [watch], priorityFee: 1000, tipLamports: 5000n,
    tipAccount: HELIUS_TIP_ACCOUNTS[0] }, journal);
  trader.recoveryRpc = absent;
  trader.blockhashCache.current = () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 });
  trader.sendSenderTransaction = async (_mode, _raw, signature) => signature;
  const ix = SystemProgram.transfer({ fromPubkey: keypair.publicKey,
    toPubkey: Keypair.generate().publicKey, lamports: 1 });
  const result = await trader.submitLiveTrade({ id: 'expired', watch, mint, isBuy: true }, [ix]);
  assert.equal(result, false);
  assert.equal(rows.get('expired').status, 'failed');
});
