import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { canonicalPumpPoolPda } from '@pump-fun/pump-sdk';
import { PUMP } from '../src/events.js';
import { PUMP_AMM } from '../src/migration_events.js';
import { buildSubscriptionRequest } from '../src/subscriptions.js';

test('one stream filters watched Pump trades and held canonical PumpSwap pools', () => {
  const watch = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const request = buildSubscriptionRequest([watch], [mint]);
  assert.deepEqual(request.transactions.copy.accountInclude, [watch]);
  assert.deepEqual(request.transactions.copy.accountRequired, [PUMP]);
  assert.deepEqual(request.transactions.migrations.accountInclude,
    [canonicalPumpPoolPda(new PublicKey(mint)).toBase58()]);
  assert.deepEqual(request.transactions.migrations.accountRequired, [PUMP_AMM]);
  assert.equal(buildSubscriptionRequest([watch], []).transactions.migrations, undefined);
});
