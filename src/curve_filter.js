import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { bondingCurveMarketCap } from '@pump-fun/pump-sdk';
import { decodePumpEvents } from './events.js';

const SIGNATURE_PAGE = 1000;
const MAX_HISTORY_SIGNATURES = 10000;

export function eventMarketCapLamports(trade, supply) {
  if (!trade.virtualSolReserves || !trade.virtualTokenReserves) throw new Error('Trade event has no SOL reserve data');
  return BigInt(bondingCurveMarketCap({
    mintSupply: new BN(supply.toString()),
    virtualQuoteReserves: new BN(trade.virtualSolReserves.toString()),
    virtualTokenReserves: new BN(trade.virtualTokenReserves.toString()),
  }).toString());
}

// Search the mint's full available RPC history, oldest transaction first. Never
// infer a first buy from the first event observed after bot startup.
export class FirstBuyIndex {
  constructor(rpc, journal, decodeEvents = logs => decodePumpEvents(logs)) {
    this.rpc = rpc;
    this.decodeEvents = decodeEvents;
    this.journal = journal;
    this.times = new Map();
    this.eventIds = new Map();
    this.pending = new Map();
    this.legacyTried = new Set();
    for (const row of journal.rows.values()) {
      if (row.status !== 'first-buy') continue;
      this.times.set(row.mint, row.timestamp);
      if (row.firstEventId) this.eventIds.set(row.mint, row.firstEventId);
    }
  }

  eventId(mint) { return this.eventIds.get(mint) ?? null; }

  cached(mint) { return this.times.get(mint) ?? null; }

  async get(mint) {
    if (this.times.has(mint) && (this.eventIds.has(mint) || this.legacyTried.has(mint))) return this.times.get(mint);
    if (this.pending.has(mint)) return this.pending.get(mint);
    // Older journals only stored a timestamp. Upgrade them to an exact event ID
    // when history is available, while keeping the cached time if it is not.
    const task = this.lookup(mint).then(found => {
      if (found !== null) return found;
      if (this.times.has(mint)) {
        this.legacyTried.add(mint);
        return this.times.get(mint);
      }
      return null;
    }).catch(error => {
      if (!this.times.has(mint)) throw error;
      this.legacyTried.add(mint);
      return this.times.get(mint);
    }).finally(() => this.pending.delete(mint));
    this.pending.set(mint, task);
    return task;
  }

  async lookup(mint) {
    const signatures = [];
    let examined = 0;
    let before;
    while (true) {
      const page = await this.rpc.getSignaturesForAddress(new PublicKey(mint),
        { limit: SIGNATURE_PAGE, ...(before ? { before } : {}) }, 'confirmed');
      examined += page.length;
      signatures.push(...page.filter(row => !row.err).map(row => row.signature));
      if (page.length < SIGNATURE_PAGE) break;
      if (examined >= MAX_HISTORY_SIGNATURES) return null;
      before = page.at(-1).signature;
    }
    for (const signature of signatures.reverse()) {
      const tx = await this.rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1 });
      if (!tx?.meta || tx.meta.err) continue;
      const first = this.decodeEvents(tx.meta.logMessages, signature)
        .find(({ index, event }) => Number.isSafeInteger(index)
          && event.isBuy && event.mint.toBase58() === mint
          && Number.isSafeInteger(Number(event.timestamp.toString())));
      if (first) {
        const timestamp = Number(first.event.timestamp.toString());
        const firstEventId = `${signature}:${first.index}`;
        this.times.set(mint, timestamp);
        this.eventIds.set(mint, firstEventId);
        this.journal.put({ id: `first-buy:${mint}`, status: 'first-buy', mint, timestamp, firstEventId });
        return timestamp;
      }
    }
    return null;
  }
}

export function formatSol(lamports) {
  if (lamports === null) return 'unknown';
  const whole = lamports / 1000000000n;
  const fraction = (lamports % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function entryBoundsStatus(config) {
  const age = config.minCurveAge != null || config.maxCurveAge != null;
  const cap = config.minMarketCapLamports != null || config.maxMarketCapLamports != null;
  return age && cap ? 'configured' : age || cap ? 'partial' : 'none';
}

export function entryFilterReason(trade, firstBuyTime, marketCapLamports, config, firstBuyEventId = null) {
  if (!trade.isBuy) return null;
  if (!Number.isSafeInteger(firstBuyTime)) return 'first bonding-curve buy unavailable';
  const age = trade.timestamp - firstBuyTime;
  if (!Number.isSafeInteger(age) || age < 0) return 'invalid bonding-curve age';
  if (firstBuyEventId && trade.id === firstBuyEventId) return 'first bonding-curve buy event';
  if (!firstBuyEventId && age === 0) return 'first buy identity unavailable at age 0';
  if (entryBoundsStatus(config) !== 'configured') return 'age and market-cap limits must both be configured';
  if (marketCapLamports === null) return 'event market cap unavailable';
  if (config.minCurveAge !== null && age < config.minCurveAge) return `curve age ${age}s below minimum`;
  if (config.maxCurveAge !== null && age > config.maxCurveAge) return `curve age ${age}s above maximum`;
  if (config.minMarketCapLamports !== null && marketCapLamports < config.minMarketCapLamports) return 'market cap below minimum';
  if (config.maxMarketCapLamports !== null && marketCapLamports > config.maxMarketCapLamports) return 'market cap above maximum';
  return null;
}
