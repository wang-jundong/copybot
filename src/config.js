import 'dotenv/config';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { HELIUS_TIP_ACCOUNTS } from './helius_sender.js';

export function loadConfig(env = process.env) {
  const required = (name) => {
    if (!env[name]?.trim()) throw new Error(`Set ${name} in .env`);
    return env[name].trim();
  };
  const number = (name, fallback, min, max) => {
    const n = Number(env[name] || fallback);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
    return n;
  };
  const optionalAge = name => {
    const value = env[name]?.trim();
    if (!value) return null;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${name}`);
    return Number(value);
  };
  const optionalSol = name => {
    const value = env[name]?.trim();
    if (!value) return null;
    const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(value);
    if (!match) throw new Error(`Invalid ${name}; use at most 9 decimal places`);
    return BigInt(match[1]) * 1000000000n + BigInt((match[2] || '').padEnd(9, '0'));
  };
  const minCurveAge = optionalAge('MIN_CURVE_AGE_SECONDS');
  const maxCurveAge = optionalAge('MAX_CURVE_AGE_SECONDS');
  const minMarketCapLamports = optionalSol('MIN_MARKETCAP_SOL');
  const maxMarketCapLamports = optionalSol('MAX_MARKETCAP_SOL');
  if (minCurveAge !== null && maxCurveAge !== null && minCurveAge > maxCurveAge) throw new Error('Minimum curve age exceeds maximum');
  if (minMarketCapLamports !== null && maxMarketCapLamports !== null && minMarketCapLamports > maxMarketCapLamports) throw new Error('Minimum market cap exceeds maximum');
  const mode = env.DRY_RUN || 'true';
  if (!['true', 'false'].includes(mode)) throw new Error('DRY_RUN must be true or false');
  const dryRun = mode === 'true';
  const liveTestValue = env.LIVE_TEST_MODE?.trim().toLowerCase() || 'false';
  if (!['true', 'false'].includes(liveTestValue)) throw new Error('LIVE_TEST_MODE must be true or false');
  const liveTestMode = liveTestValue === 'true';
  const privateKey = env.PRIVATE_KEY?.trim();
  if (!dryRun && !privateKey) throw new Error('Set PRIVATE_KEY in .env');
  let keypair = null;
  if (!dryRun) {
    try {
      const bytes = privateKey.startsWith('[') ? JSON.parse(privateKey) : bs58.decode(privateKey);
      if (bytes.length !== 64 || !Array.from(bytes).every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255))
        throw new Error('Invalid secret key bytes');
      keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));
    } catch {
      throw new Error('Invalid PRIVATE_KEY: expected a base58 secret key or Solana 64-byte JSON array');
    }
  }
  const user = keypair?.publicKey ?? Keypair.generate().publicKey;
  const rawWatches = (env.WATCH_WALLETS || env.WATCH_WALLET || '').split(/[\s,]+/).filter(Boolean);
  if (!rawWatches.length) throw new Error('Set WATCH_WALLETS or WATCH_WALLET in .env');
  const watches = [...new Set(rawWatches.map(value => new PublicKey(value).toBase58()))];
  if (watches.includes(user.toBase58())) throw new Error('A watched wallet must differ from the bot wallet');
  const grpc = required('GRPC_ENDPOINT');
  const senderMode = env.HELIUS_SENDER_MODE?.trim().toLowerCase() || 'swqos';
  if (senderMode !== 'swqos') throw new Error('HELIUS_SENDER_MODE must be swqos; standard RPC broadcast is disabled');
  if (env.HELIUS_TIP_SOL?.trim()) throw new Error('Replace HELIUS_TIP_SOL with HELIUS_TIP_LAMPORTS');
  const rawTipLamports = env.HELIUS_TIP_LAMPORTS?.trim() || '5000';
  if (!/^\d+$/.test(rawTipLamports)) throw new Error('HELIUS_TIP_LAMPORTS must be a whole number');
  const tipLamports = BigInt(rawTipLamports);
  const tipAccount = env.HELIUS_TIP_ACCOUNT?.trim() || null;
  if (tipAccount && !HELIUS_TIP_ACCOUNTS.includes(tipAccount)) throw new Error('Invalid HELIUS_TIP_ACCOUNT');
  if (tipLamports < 5000n || tipLamports > 18446744073709551615n)
    throw new Error('HELIUS_TIP_LAMPORTS must be between 5000 and the u64 maximum');
  if (!dryRun && !env.HELIUS_RPC_URL?.trim()) throw new Error('Set HELIUS_RPC_URL for live Helius Sender confirmation');
  if (Number(env.PRIORITY_FEE_MICROLAMPORTS || 10000) <= 0) throw new Error('Helius Sender requires a positive PRIORITY_FEE_MICROLAMPORTS');
  const rpc = env.HELIUS_RPC_URL?.trim() || required('RPC_URL');
  for (const url of [grpc, rpc]) if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Endpoints must use http(s)');
  return { grpc, rpc, token: env.GRPC_X_TOKEN || undefined, watches, user, keypair, dryRun, liveTestMode,
    minCurveAge, maxCurveAge, minMarketCapLamports, maxMarketCapLamports,
    senderMode, tipLamports, tipAccount,
    buyLamports: BigInt(Math.floor(number('BUY_SOL', 0.01, 0.000001, 100) * 1e9)),
    buySlippage: number('BUY_SLIPPAGE_PERCENT', 12, 0, 50),
    sellSlippage: number('SELL_SLIPPAGE_PERCENT', 50, 0, 50),
    priorityFee: Math.floor(number('PRIORITY_FEE_MICROLAMPORTS', 10000, 0, 1e9)),
    maxAge: number('MAX_EVENT_AGE_SECONDS', 30, 1, 300),
    maxQueue: Math.floor(number('MAX_QUEUE', 100, 1, 10000)),
  };
}
