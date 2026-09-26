import { test } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { HELIUS_TIP_ACCOUNTS, chooseHeliusTipAccount, sendHeliusSenderTransaction } from '../src/helius_sender.js';
import { Trader } from '../src/trader.js';

const watch = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const baseEnv = { GRPC_ENDPOINT: 'https://grpc.example.com', HELIUS_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=test', WATCH_WALLET: watch };

test('Sender settings require a Helius RPC, valid tip, and published tip account', () => {
  assert.equal(loadConfig(baseEnv).senderMode, 'swqos');
  assert.equal(loadConfig(baseEnv).tipLamports, 5000n);
  assert.throws(() => loadConfig({ ...baseEnv, HELIUS_SENDER_MODE: 'off' }), /must be swqos/);
  assert.throws(() => loadConfig({ ...baseEnv, HELIUS_SENDER_MODE: 'max' }), /must be swqos/);
  assert.throws(() => loadConfig({ ...baseEnv, HELIUS_SENDER_MODE: 'swqos', HELIUS_TIP_LAMPORTS: '4999' }), /between 5000/);
  assert.equal(loadConfig({ ...baseEnv, HELIUS_SENDER_MODE: 'swqos', HELIUS_TIP_LAMPORTS: '5000' }).tipLamports, 5000n);
  assert.throws(() => loadConfig({ ...baseEnv, HELIUS_TIP_LAMPORTS: '0.000005' }), /whole number/);
  assert.throws(() => loadConfig({ ...baseEnv, HELIUS_TIP_SOL: '0.000005' }), /Replace HELIUS_TIP_SOL/);
  assert.throws(() => loadConfig({ ...baseEnv, HELIUS_SENDER_MODE: 'swqos', HELIUS_TIP_LAMPORTS: '5000',
    HELIUS_TIP_ACCOUNT: Keypair.generate().publicKey.toBase58() }), /HELIUS_TIP_ACCOUNT/);
  assert.throws(() => loadConfig({ ...baseEnv, HELIUS_SENDER_MODE: 'swqos', HELIUS_TIP_LAMPORTS: '5000',
    PRIORITY_FEE_MICROLAMPORTS: '0' }), /positive/);
  assert.equal(chooseHeliusTipAccount({ tipAccount: HELIUS_TIP_ACCOUNTS[0] }).toBase58(), HELIUS_TIP_ACCOUNTS[0]);
  const signer = bs58.encode(Keypair.generate().secretKey);
  assert.throws(() => loadConfig({ GRPC_ENDPOINT: baseEnv.GRPC_ENDPOINT, WATCH_WALLET: watch,
    RPC_URL: 'https://rpc.example.com', DRY_RUN: 'false', PRIVATE_KEY: signer }), /HELIUS_RPC_URL/);
});

test('Sender POST uses base64, skipPreflight, zero retries, and verifies signature', async () => {
  const wire = Buffer.from([1, 2, 3]);
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ result: 'expected' }) };
  };
  assert.equal(await sendHeliusSenderTransaction('swqos', wire, 'expected', fetchImpl), 'expected');
  assert.equal(seen.url, 'https://sender.helius-rpc.com/fast?swqos_only=true');
  assert.equal(seen.body.method, 'sendTransaction');
  assert.deepEqual(seen.body.params, [wire.toString('base64'), { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]);
  await assert.rejects(sendHeliusSenderTransaction('swqos', wire, 'different', fetchImpl), /unexpected signature/);
  await assert.rejects(sendHeliusSenderTransaction('max', wire, 'expected', fetchImpl), /Invalid Helius Sender mode/);
});

test('live Sender trade includes tip in the signed trade transaction and does not use standard broadcast', async () => {
  const keypair = Keypair.generate();
  const tip = HELIUS_TIP_ACCOUNTS[0];
  const rows = new Map();
  const journal = { rows, put(row) { rows.set(row.id, row); } };
  let senderCalls = 0;
  const rpc = {
    async sendRawTransaction() { throw new Error('standard broadcast must not be used'); },
    async confirmTransaction(signature) { assert.ok(signature); return { value: { err: null } }; },
    async getTransaction() { return { meta: { preTokenBalances: [], postTokenBalances: [{ owner: keypair.publicKey.toBase58(),
      mint, uiTokenAmount: { amount: '25' } }] } }; },
  };
  const trader = new Trader(rpc, { dryRun: false, keypair, user: keypair.publicKey,
    priorityFee: 10000, watches: [watch], senderMode: 'swqos', tipLamports: 5000n, tipAccount: tip }, journal);
  trader.sendSenderTransaction = async (mode, wire, signature) => {
    senderCalls++;
    assert.equal(mode, 'swqos');
    const tx = VersionedTransaction.deserialize(wire);
    assert.equal(bs58.encode(tx.signatures[0]), signature);
    const last = tx.message.compiledInstructions.at(-1);
    assert.equal(tx.message.staticAccountKeys[last.programIdIndex].toBase58(), SystemProgram.programId.toBase58());
    assert.equal(tx.message.staticAccountKeys[last.accountKeyIndexes[1]].toBase58(), tip);
    assert.equal(Buffer.from(last.data).readBigUInt64LE(4), 5000n);
    return signature;
  };
  await trader.submitLiveTrade({ id: 'sender-buy', watch, mint, isBuy: true,
    blockhash: Keypair.generate().publicKey.toBase58() }, [SystemProgram.transfer({ fromPubkey: keypair.publicKey,
    toPubkey: Keypair.generate().publicKey, lamports: 1 })]);
  assert.equal(senderCalls, 1);
  assert.equal(rows.get('sender-buy').status, 'confirmed');
  assert.equal(rows.get('sender-buy').tipAccount, tip);
  assert.equal(rows.get('sender-buy').tipLamports, '5000');
});
