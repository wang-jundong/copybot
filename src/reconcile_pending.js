import { setTimeout as delay } from 'node:timers/promises';
import { tokenBalance } from './events.js';

const transactionOptions = { commitment: 'confirmed', maxSupportedTransactionVersion: 0 };

function pendingGroups(journal, signatures) {
  const groups = new Map();
  for (const row of journal.rows.values()) {
    if (row.status !== 'pending' || (signatures && !signatures.has(row.signature))) continue;
    if (!row.signature) throw new Error(`Pending journal entry ${row.id} has no signature`);
    if (!groups.has(row.signature)) groups.set(row.signature, []);
    groups.get(row.signature).push(row);
  }
  return groups;
}

async function observation(rpc, signature) {
  const status = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  const transaction = await rpc.getTransaction(signature, transactionOptions);
  return { status, transaction };
}

function settleFailed(journal, rows, reason) {
  for (const row of rows) journal.put({ ...row, status: 'failed', reason });
  return 'failed';
}

function settleConfirmed(journal, rows, transaction, owner) {
  if (!transaction?.meta || transaction.meta.err) return null;
  if (!rows.every(row => row.mint === rows[0].mint && row.tradeKind === rows[0].tradeKind)) return null;
  const delta = tokenBalance(transaction.meta.postTokenBalances, owner, rows[0].mint)
    - tokenBalance(transaction.meta.preTokenBalances, owner, rows[0].mint);
  if (rows[0].tradeKind === 'buy' ? delta <= 0n : rows[0].tradeKind === 'sell' ? delta >= 0n : true)
    return null;
  if (rows.length === 1 && rows[0].venue !== 'pumpswap') {
    journal.put({ ...rows[0], status: 'confirmed', delta: delta.toString() });
    return 'confirmed';
  }
  // A migration exit has one journal row per source-wallet allocation.
  if (!rows.every(row => row.venue === 'pumpswap' && /^-\d+$/.test(row.expectedDelta || '')))
    return null;
  if (rows.reduce((sum, row) => sum + BigInt(row.expectedDelta), 0n) !== delta) return null;
  for (const row of rows) journal.put({ ...row, status: 'confirmed', delta: row.expectedDelta });
  return 'confirmed';
}

async function expiredOnBoth(rows, primary, fallback) {
  const row = rows[0];
  if (Number.isSafeInteger(row.lastValidBlockHeight)) {
    const [primaryHeight, fallbackHeight] = await Promise.all([
      primary.getBlockHeight('finalized'), fallback.getBlockHeight('finalized'),
    ]);
    return primaryHeight > row.lastValidBlockHeight && fallbackHeight > row.lastValidBlockHeight;
  }
  if (!row.blockhash) return false;
  const [primaryValid, fallbackValid] = await Promise.all([
    primary.isBlockhashValid(row.blockhash, 'confirmed'),
    fallback.isBlockhashValid(row.blockhash, 'confirmed'),
  ]);
  return !primaryValid.value && !fallbackValid.value;
}

// Returns an outcome for every pending signature. Unresolved signatures stay pending.
export async function reconcilePending(journal, primary, fallback, user, signatures = null) {
  const outcomes = new Map();
  for (const [signature, rows] of pendingGroups(journal, signatures)) {
    let outcome = 'unresolved';
    try {
      const first = await observation(primary, signature);
      if (first.transaction?.meta?.err || first.status?.err) {
        outcome = settleFailed(journal, rows, 'transaction failed on chain');
      } else if (first.transaction?.meta) {
        outcome = settleConfirmed(journal, rows, first.transaction, user.toBase58()) || 'unresolved';
      } else if (!first.status) {
        const second = await observation(fallback, signature);
        if (second.transaction?.meta?.err || second.status?.err) {
          outcome = settleFailed(journal, rows, 'transaction failed on chain');
        } else if (second.transaction?.meta) {
          outcome = settleConfirmed(journal, rows, second.transaction, user.toBase58()) || 'unresolved';
        } else if (!second.status && await expiredOnBoth(rows, primary, fallback)) {
          outcome = settleFailed(journal, rows, 'signature absent on two RPCs after blockhash expiry');
        }
      }
    } catch { /* RPC uncertainty leaves the journal pending. */ }
    outcomes.set(signature, outcome);
  }
  return outcomes;
}

// A restart shortly after broadcast can find a still-valid blockhash. Wait for
// confirmation or expiry instead of failing immediately on an ordinary pending send.
export async function reconcilePendingUntilSettled(journal, primary, fallback, user,
  signatures = null, { maxChecks = 40, intervalMs = 3000 } = {}) {
  let outcomes = new Map();
  for (let attempt = 0; attempt < maxChecks; attempt++) {
    outcomes = await reconcilePending(journal, primary, fallback, user, signatures);
    if (![...outcomes.values()].includes('unresolved')) return outcomes;
    if (attempt + 1 < maxChecks) await delay(intervalMs);
  }
  return outcomes;
}
