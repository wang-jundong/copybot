import { mkdirSync, readFileSync, appendFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { pruneJournalRows } from './prune_skipped.js';

export class Journal {
  constructor(path, { allowPending = false } = {}) {
    this.path = path;
    this.rows = new Map();
    mkdirSync('data', { recursive: true });
    this.lock = `${path}.lock`;
    this.fd = openSync(this.lock, 'wx', 0o600);
    try {
      let content = '';
      try { content = readFileSync(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      for (const line of content.split('\n').filter(Boolean)) {
        const row = JSON.parse(line);
        if (row.status !== 'skipped') this.rows.set(row.id, row);
      }
      if (!allowPending && [...this.rows.values()].some(r => r.status === 'pending')) {
        throw new Error(`Unresolved transaction in ${path}; reconcile its signature before changing pending to confirmed or failed`);
      }
    } catch (e) { this.close(); throw e; }
  }
  has(id) {
    const row = this.rows.get(id);
    return !!row && (row.status !== 'pruned-event' || row.expiresAt > Date.now());
  }
  put(row) {
    if (row.status === 'skipped') return;
    appendFileSync(this.path, JSON.stringify(row) + '\n', { mode: 0o600, flush: true });
    this.rows.set(row.id, row);
  }
  removeClosedMints(mints) {
    const now = Date.now();
    if (!mints.size && ![...this.rows.values()].some(row =>
      row.status === 'pruned-event' && row.expiresAt <= now)) return;
    const summaryId = 'pruned-trade-counts';
    const prior = this.rows.get(summaryId);
    const summary = { id: summaryId, status: summaryId,
      buy: prior?.buy || 0, sell: prior?.sell || 0, legacy: prior?.legacy || false };
    const removed = [];
    const signatures = { buy: new Set(), sell: new Set() };
    const retained = { buy: new Set(), sell: new Set() };
    for (const row of this.rows.values()) {
      if (mints.has(row.mint) && row.status === 'pending')
        throw new Error('Cannot prune an unresolved transaction');
      const discard = mints.has(row.mint)
        && ['first-buy', 'confirmed', 'failed', 'dry-run'].includes(row.status);
      if (discard) removed.push(row);
      if (['pending', 'confirmed', 'failed'].includes(row.status)) {
        if (!['buy', 'sell'].includes(row.tradeKind)) {
          if (discard) summary.legacy = true;
        } else {
          (discard ? signatures : retained)[row.tradeKind].add(row.signature || row.id);
        }
      }
    }
    for (const kind of ['buy', 'sell']) {
      for (const signature of signatures[kind]) {
        if (!retained[kind].has(signature)) summary[kind]++;
      }
    }
    const ids = new Set(removed.map(row => row.id));
    for (const row of this.rows.values()) {
      if (row.status === 'pruned-event' && row.expiresAt <= now) ids.add(row.id);
    }
    // Keep only event IDs briefly: MAX_EVENT_AGE_SECONDS is capped at 300,
    // and events may be up to five seconds ahead of local time.
    const replacements = removed.filter(row => row.status !== 'first-buy')
      .map(row => ({ id: row.id, status: 'pruned-event', expiresAt: now + 305000 }));
    if (summary.buy || summary.sell || summary.legacy) replacements.push(summary);
    const shouldRemove = row => ids.has(row.id) || row.id === summaryId
      || (row.status === 'pruned-event' && row.expiresAt <= now);
    // Delete every historical version (including old pending rows), and write
    // counters/replay markers in the same atomic replacement under our lock.
    pruneJournalRows(this.path, shouldRemove, replacements);
    for (const [id, row] of this.rows) {
      if (shouldRemove(row)) this.rows.delete(id);
    }
    for (const row of replacements) this.rows.set(row.id, row);
  }
  close() { closeSync(this.fd); unlinkSync(this.lock); }
}
