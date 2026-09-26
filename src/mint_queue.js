// Keep transactions for one mint in order, while unrelated mints can progress independently.
export class MintTradeQueue {
  constructor(maxConcurrent = 4) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('Invalid trade concurrency');
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
    this.waiting = [];
    this.tails = new Map();
  }

  async withSlot(work) {
    if (this.active >= this.maxConcurrent) {
      await new Promise(resolve => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try { return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  run(mint, work) {
    const prior = this.tails.get(mint) || Promise.resolve();
    const task = prior.then(() => this.withSlot(work));
    // A failed trade must not prevent the queue from releasing this mint.
    const tail = task.catch(() => {});
    this.tails.set(mint, tail);
    tail.finally(() => { if (this.tails.get(mint) === tail) this.tails.delete(mint); });
    return task;
  }
}
