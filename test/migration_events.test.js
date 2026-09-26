import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { canonicalPumpPoolPda } from '@pump-fun/pump-sdk';
import { PUMP_AMM, CREATE_POOL_TAG, decodeMigrations } from '../src/migration_events.js';

const data = `Program data: ${Buffer.concat([CREATE_POOL_TAG, Buffer.alloc(1)]).toString('base64')}`;

test('decodes only canonical SOL migration for a held mint', () => {
  const mint = Keypair.generate().publicKey;
  const pool = canonicalPumpPoolPda(mint);
  const event = { baseMint: mint, quoteMint: NATIVE_MINT, pool, timestamp: { toString: () => '100' } };
  const update = { transaction: { transaction: { signature: Buffer.alloc(64, 1),
    transaction: { message: { recentBlockhash: Buffer.alloc(32, 2) } },
    meta: { err: null, logMessages: [`Program ${PUMP_AMM} invoke [1]`, data, `Program ${PUMP_AMM} success`] } } } };
  const found = decodeMigrations(update, new Set([mint.toBase58()]), () => event);
  assert.equal(found.length, 1);
  assert.equal(found[0].mint, mint.toBase58());
  assert.equal(found[0].event.pool.toBase58(), pool.toBase58());
  assert.equal(found[0].timestamp, 100);
  assert.deepEqual(decodeMigrations(update, new Set(), () => event), []);
  assert.deepEqual(decodeMigrations(update, new Set([mint.toBase58()]), () => ({ ...event, pool: Keypair.generate().publicKey })), []);
  assert.deepEqual(decodeMigrations(update, new Set([mint.toBase58()]), () => ({ ...event, quoteMint: Keypair.generate().publicKey })), []);
  update.transaction.transaction.meta.err = { failed: true };
  assert.deepEqual(decodeMigrations(update, new Set([mint.toBase58()]), () => event), []);
});

test('ignores spoofed PumpSwap pool logs from a foreign program', () => {
  const mint = Keypair.generate().publicKey;
  const event = { baseMint: mint, quoteMint: NATIVE_MINT, pool: canonicalPumpPoolPda(mint) };
  const update = { transaction: { transaction: { signature: Buffer.alloc(64, 1),
    meta: { err: null, logMessages: [`Program ${Keypair.generate().publicKey} invoke [1]`, data] } } } };
  assert.deepEqual(decodeMigrations(update, new Set([mint.toBase58()]), () => event), []);
});
