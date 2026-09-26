import { PublicKey } from '@solana/web3.js';

// Helius-published Sender tip accounts. Update only against the official list.
export const HELIUS_TIP_ACCOUNTS = Object.freeze([
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
]);

export function chooseHeliusTipAccount(config, random = Math.random) {
  const account = config.tipAccount || HELIUS_TIP_ACCOUNTS[Math.floor(random() * HELIUS_TIP_ACCOUNTS.length)];
  if (!HELIUS_TIP_ACCOUNTS.includes(account)) throw new Error('HELIUS_TIP_ACCOUNT is not in the Helius Sender tip list');
  return new PublicKey(account);
}

export function heliusSenderUrl(mode) {
  if (mode === 'swqos') return 'https://sender.helius-rpc.com/fast?swqos_only=true';
  throw new Error('Invalid Helius Sender mode');
}

export async function sendHeliusSenderTransaction(mode, wireBytes, expectedSignature, fetchImpl = fetch) {
  const response = await fetchImpl(heliusSenderUrl(mode), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'copybot', method: 'sendTransaction',
      params: [Buffer.from(wireBytes).toString('base64'),
        { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Helius Sender HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`Helius Sender RPC error ${body.error.code ?? 'unknown'}`);
  if (body.result !== expectedSignature) throw new Error('Helius Sender returned an unexpected signature');
  return body.result;
}
