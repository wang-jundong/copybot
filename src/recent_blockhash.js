export class RecentBlockhash {
  constructor(rpc, maxAgeMs = 12000) {
    this.rpc = rpc;
    this.maxAgeMs = maxAgeMs;
    this.latest = null;
    this.loadedAt = 0;
    this.loading = null;
  }

  refresh() {
    if (this.loading) return this.loading;
    this.loading = this.rpc.getLatestBlockhash('confirmed').then(latest => {
      if (!latest?.blockhash || !Number.isSafeInteger(latest.lastValidBlockHeight))
        throw new Error('RPC did not return a valid recent blockhash');
      this.latest = latest;
      this.loadedAt = Date.now();
      return latest;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  current() {
    return this.latest && Date.now() - this.loadedAt <= this.maxAgeMs ? this.latest : null;
  }
}
