import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { PUMP_PROGRAM_ID, PUMP_SDK } from '@pump-fun/pump-sdk';

export const PUMP = PUMP_PROGRAM_ID.toBase58();
export const TRADE_TAG = createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8);

export function tokenBalance(rows, owner, mint) {
  return (rows || []).filter(r => r.owner === owner && r.mint === mint)
    .reduce((sum, r) => sum + BigInt(r.uiTokenAmount.amount), 0n);
}

// Track invocation context so nested programs cannot spoof Pump trade logs.
export function decodePumpEvents(logs, decode = bytes => PUMP_SDK.decodeTradeEventBc(bytes)) {
  const stack = [];
  const events = [];
  for (const [index, line] of (logs || []).entries()) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) { stack.push(invoke[1]); continue; }
    if (/^Program \w+ (success|failed:)/.test(line)) { stack.pop(); continue; }
    if (stack.at(-1) !== PUMP || !line.startsWith('Program data: ')) continue;
    const bytes = Buffer.from(line.slice(14), 'base64');
    if (!bytes.subarray(0, 8).equals(TRADE_TAG)) continue;
    events.push({ index, event: decode(bytes.subarray(8)) });
  }
  return events;
}

export function decodeTrades(update, watches, decode = bytes => PUMP_SDK.decodeTradeEventBc(bytes)) {
  const allowed = watches instanceof Set ? watches : new Set(Array.isArray(watches) ? watches : [watches]);
  const tx = update.transaction?.transaction;
  if (!tx?.meta || tx.meta.err || !tx.signature) return [];
  const trades = [];
  const signature = bs58.encode(tx.signature);
  for (const { index, event } of decodePumpEvents(tx.meta.logMessages, decode)) {
    const watch = event.user.toBase58();
    if (!allowed.has(watch)) continue;
    const mint = event.mint.toBase58();
    trades.push({ id: `${signature}:${index}`, signature, watch, mint, isBuy: event.isBuy,
      blockhash: tx.transaction?.message?.recentBlockhash?.length === 32 ? bs58.encode(tx.transaction.message.recentBlockhash) : null,
      timestamp: Number(event.timestamp.toString()), tokens: BigInt(event.tokenAmount.toString()),
      virtualSolReserves: event.virtualSolReserves?.toString(),
      virtualTokenReserves: event.virtualTokenReserves?.toString(),
      realTokenReserves: event.realTokenReserves?.toString(),
      creator: event.creator?.toBase58(),
      creatorFeeBasisPoints: event.creatorFeeBasisPoints?.toString(),
      mayhemMode: event.mayhemMode === true,
      quoteMint: event.quoteMint?.toBase58(),
      preBalance: tokenBalance(tx.meta.preTokenBalances, watch, mint),
      postBalance: tokenBalance(tx.meta.postTokenBalances, watch, mint),
    });
  }
  // Mixed or repeated trades by one watched wallet in one mint are ambiguous.
  return trades.filter(t => trades.filter(other => other.mint === t.mint && other.watch === t.watch).length === 1);
}

export function sellAmount(held, trade) {
  if (trade.preBalance <= 0n || trade.tokens <= 0n || trade.postBalance >= trade.preBalance) return 0n;
  const sold = trade.preBalance - trade.postBalance;
  // Do not treat unrelated token transfers in the same transaction as a sale.
  if (sold !== trade.tokens) return 0n;
  return held * sold / trade.preBalance;
}
