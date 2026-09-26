import { PublicKey } from '@solana/web3.js';
import { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import { canonicalPumpPoolPda } from '@pump-fun/pump-sdk';
import { PUMP } from './events.js';
import { PUMP_AMM } from './migration_events.js';

export function buildSubscriptionRequest(watches, mints) {
  const transactions = { copy: { vote: false, failed: false,
    accountInclude: watches, accountExclude: [], accountRequired: [PUMP] } };
  if (mints.length) transactions.migrations = { vote: false, failed: false,
    accountInclude: mints.map(mint => canonicalPumpPoolPda(new PublicKey(mint)).toBase58()),
    accountExclude: [], accountRequired: [PUMP_AMM] };
  return { accounts: {}, slots: {}, transactions, transactionsStatus: {}, blocks: {},
    blocksMeta: {}, entry: {}, accountsDataSlice: [], commitment: CommitmentLevel.CONFIRMED };
}
