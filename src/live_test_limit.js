import { sellAmount } from './events.js';

const ATTEMPTED = new Set(['pending', 'confirmed', 'failed']);

// Each migration exit can have several allocation rows sharing one signature.
export function liveTestAttempts(journal, kind) {
  const signatures = new Set();
  for (const row of journal.rows.values()) {
    if (!ATTEMPTED.has(row.status)) continue;
    if (!['buy', 'sell'].includes(row.tradeKind)) {
      throw new Error('Live test mode cannot count a legacy live trade without tradeKind; reconcile the journal first');
    }
    if (row.tradeKind === kind) signatures.add(row.signature || row.id);
  }
  return signatures.size;
}

export function liveTestSellAmount(held, trade, fullExit) {
  const mirrored = sellAmount(held, trade);
  return fullExit && mirrored > 0n ? held : mirrored;
}
