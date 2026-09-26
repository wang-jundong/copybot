import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { NATIVE_MINT } from '@solana/spl-token';
import { PUMP_AMM_PROGRAM_ID, PUMP_SDK, canonicalPumpPoolPda } from '@pump-fun/pump-sdk';

export const PUMP_AMM = PUMP_AMM_PROGRAM_ID.toBase58();
export const CREATE_POOL_TAG = createHash('sha256').update('event:CreatePoolEvent').digest().subarray(0, 8);

export function decodeMigrations(update, heldMints, decode = bytes => PUMP_SDK.decodeCreatePoolEventAmm(bytes)) {
  const tx = update.transaction?.transaction;
  if (!tx?.signature || !tx.meta || tx.meta.err) return [];
  const stack = [];
  const events = [];
  const signature = bs58.encode(tx.signature);
  for (const [index, line] of (tx.meta.logMessages || []).entries()) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) { stack.push(invoke[1]); continue; }
    if (/^Program \w+ (success|failed:)/.test(line)) { stack.pop(); continue; }
    if (stack.at(-1) !== PUMP_AMM || !line.startsWith('Program data: ')) continue;
    const bytes = Buffer.from(line.slice(14), 'base64');
    if (!bytes.subarray(0, 8).equals(CREATE_POOL_TAG)) continue;
    const event = decode(bytes.subarray(8));
    const mint = event.baseMint.toBase58();
    if (!heldMints.has(mint) || !event.quoteMint.equals(NATIVE_MINT)
      || !event.pool.equals(canonicalPumpPoolPda(event.baseMint))) continue;
    const blockhash = tx.transaction?.message?.recentBlockhash;
    events.push({ id: `${signature}:${index}`, signature, mint,
      blockhash: blockhash?.length === 32 ? bs58.encode(blockhash) : null,
      timestamp: Number(event.timestamp.toString()), event });
  }
  return events;
}
