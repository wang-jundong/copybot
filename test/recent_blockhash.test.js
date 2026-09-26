import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecentBlockhash } from '../src/recent_blockhash.js';

test('background blockhash refresh is shared and stale hashes are never used', async () => {
  let calls = 0;
  let release;
  const rpc = { getLatestBlockhash(commitment) {
    assert.equal(commitment, 'confirmed');
    calls++;
    return new Promise(resolve => { release = resolve; });
  } };
  const cache = new RecentBlockhash(rpc, 1000);
  const a = cache.refresh();
  const b = cache.refresh();
  assert.equal(a, b);
  assert.equal(calls, 1);
  release({ blockhash: 'hash', lastValidBlockHeight: 123 });
  await a;
  assert.deepEqual(cache.current(), { blockhash: 'hash', lastValidBlockHeight: 123 });
  cache.loadedAt -= 1001;
  assert.equal(cache.current(), null);
});
