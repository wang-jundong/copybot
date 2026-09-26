import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MintTradeQueue } from '../src/mint_queue.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

test('different mints progress concurrently, but one mint stays ordered', async () => {
  const queue = new MintTradeQueue(2);
  const a = deferred();
  const b = deferred();
  const started = [];
  const firstA = queue.run('mint-a', async () => { started.push('a1'); await a.promise; });
  const secondA = queue.run('mint-a', async () => { started.push('a2'); });
  const firstB = queue.run('mint-b', async () => { started.push('b1'); await b.promise; });
  await flush();
  assert.deepEqual(started, ['a1', 'b1']);
  a.resolve();
  await firstA;
  await flush();
  assert.deepEqual(started, ['a1', 'b1', 'a2']);
  b.resolve();
  await Promise.all([secondA, firstB]);
  assert.equal(queue.active, 0);
  assert.equal(queue.tails.size, 0);
});

test('concurrency cap holds and a failed mint releases its next trade', async () => {
  const queue = new MintTradeQueue(2);
  const gateA = deferred();
  const gateB = deferred();
  const started = [];
  const a = queue.run('a', async () => { started.push('a1'); await gateA.promise; throw new Error('failed'); });
  const b = queue.run('b', async () => { started.push('b1'); await gateB.promise; });
  const c = queue.run('c', async () => { started.push('c1'); });
  const nextA = queue.run('a', async () => { started.push('a2'); });
  await flush();
  assert.deepEqual(started, ['a1', 'b1']);
  gateA.resolve();
  await assert.rejects(a, /failed/);
  await flush();
  assert.deepEqual(started, ['a1', 'b1', 'c1', 'a2']);
  gateB.resolve();
  await Promise.all([b, c, nextA]);
  assert.equal(queue.active, 0);
  assert.equal(queue.tails.size, 0);
});
