import yellowstone from '@triton-one/yellowstone-grpc';
import { Connection } from '@solana/web3.js';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { decodeTrades } from './events.js';
import { decodeMigrations } from './migration_events.js';
import { buildSubscriptionRequest } from './subscriptions.js';
import { Trader } from './trader.js';
import { Journal } from './journal.js';
import { MintTradeQueue } from './mint_queue.js';
import { log, logError } from './logger.js';
import { liveTestAttempts } from './live_test_limit.js';

const Client = yellowstone.default ?? yellowstone;
const c = loadConfig();
const journal = new Journal(`data/${c.dryRun ? 'dry-run' : 'live'}.jsonl`);
let trader;
try {
  trader = new Trader(new Connection(c.rpc, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60000 }), c, journal);
} catch (error) {
  journal.close();
  throw error;
}
let stopped = false, stream, queued = 0, fatal, blockhashRefresh;
const tradeQueue = new MintTradeQueue(4);
const pendingTrades = new Set();
const scheduled = new Set();
const pendingCacheWrites = new Set();
const candidateBuys = new Map();
function safeGrpcError(error) {
  const code = error?.code !== undefined ? `code ${error.code}: ` : '';
  let message = String(error?.details || error?.message || error).split('\n')[0];
  for (const secret of [c.token, c.grpc, c.rpc]) {
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  return `${code}${message}`;
}
function stop() { stopped = true; stream?.destroy(); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const watched = new Set(c.watches);
function poolMints() { return [...new Set([...trader.heldMints(), ...candidateBuys.keys()])].sort(); }
let subscribedMints = '';
let activeRequest;
function refreshSubscription() {
  const mints = poolMints();
  const key = mints.join(',');
  if (key === subscribedMints) return Promise.resolve();
  subscribedMints = key;
  activeRequest = buildSubscriptionRequest(c.watches, mints);
  const current = stream;
  if (current && !current.destroyed && !stopped)
    return new Promise((resolve, reject) => current.write(activeRequest, error => {
      if (error) { current.destroy(error); reject(error); }
      else resolve();
    }));
  return Promise.resolve();
}
try {
  await trader.prepareForStream();
  if (!c.dryRun) {
    await trader.blockhashCache.refresh();
    blockhashRefresh = setInterval(() => {
      trader.blockhashCache.refresh().catch(error =>
        logError('Helius blockhash refresh failed:', safeGrpcError(error)));
    }, 5000);
  }
  if (!c.dryRun && c.liveTestMode)
    log('LIVE_TEST', 'submitted buys', liveTestAttempts(journal, 'buy'), '/ 1',
      'submitted sells', liveTestAttempts(journal, 'sell'), '/ 1');
  while (!stopped) {
    let heartbeat;
    let phase = 'connect';
    try {
      const client = new Client(c.grpc, c.token, undefined);
      await client.connect();
      phase = 'subscribe';
      stream = await client.subscribe();
      if (stopped) { stream.destroy(); break; }
      phase = 'stream';
      subscribedMints = poolMints().join(',');
      activeRequest = buildSubscriptionRequest(c.watches, poolMints());
      await new Promise((resolve, reject) => {
        stream.on('error', reject);
        stream.on('end', resolve);
        stream.on('close', resolve);
        stream.on('data', update => {
          if (stopped) return;
          try {
            for (const migration of decodeMigrations(update, new Set(poolMints()))) {
              if (scheduled.has(migration.id)) continue;
              if (queued >= c.maxQueue) throw new Error('Trade queue overflow during migration');
              scheduled.add(migration.id);
              queued++;
              const task = tradeQueue.run(migration.mint, async () => {
                if (!fatal) await trader.executeMigration(migration);
              }).catch(e => { fatal ??= e; stop(); }).finally(() => {
                queued--;
                scheduled.delete(migration.id);
                pendingTrades.delete(task);
                refreshSubscription().catch(e => { fatal ??= e; stop(); });
              });
              pendingTrades.add(task);
            }
            for (const trade of decodeTrades(update, watched)) {
              if (scheduled.has(trade.id) || journal.has(trade.id)) continue;
              if (queued >= c.maxQueue) throw new Error('Trade queue overflow; stopped to avoid silently missing sells');
              scheduled.add(trade.id);
              queued++;
              // The first watched buy or sell starts a shared, persistent mint lookup.
              // A sell must not wait for history before it can close a position.
              {
                const cacheWrite = trader.observe(trade).catch(error => {
                  logError('First-buy cache lookup failed for watched wallet', trade.watch, 'mint', trade.mint, safeGrpcError(error));
                });
                pendingCacheWrites.add(cacheWrite);
                cacheWrite.finally(() => pendingCacheWrites.delete(cacheWrite));
              }
              // Inspect cached data now; serialize execution only for the same mint.
              let candidate = false;
              const inspection = trade.isBuy ? trader.inspect(trade).then(async result => {
                if (!result.reason && !fatal) {
                  candidate = true;
                  candidateBuys.set(trade.mint, (candidateBuys.get(trade.mint) || 0) + 1);
                  await refreshSubscription();
                }
                return result;
              }) : null;
              inspection?.catch(() => {}); // The queue awaits and handles the original rejection.
              const task = tradeQueue.run(trade.mint, async () => {
                if (inspection) await inspection;
                if (!fatal) await trader.execute(trade, inspection);
              }).catch(e => { fatal ??= e; stop(); }).finally(() => {
                queued--;
                scheduled.delete(trade.id);
                pendingTrades.delete(task);
                if (candidate) {
                  const remaining = candidateBuys.get(trade.mint) - 1;
                  if (remaining) candidateBuys.set(trade.mint, remaining);
                  else candidateBuys.delete(trade.mint);
                }
                refreshSubscription().catch(e => { fatal ??= e; stop(); });
              });
              pendingTrades.add(task);
            }
          } catch (e) { fatal = e; stop(); }
        });
        const current = stream;
        current.write(activeRequest, error => { if (error) reject(error); });
        heartbeat = setInterval(() => {
          if (current.destroyed) return;
          current.write({ ...activeRequest, ping: { id: 1 } }, error => {
            if (error) current.destroy(error);
          });
        }, 10000);
      });
    } catch (error) {
      if (!stopped) logError(`gRPC ${phase} failed (${safeGrpcError(error)}); reconnecting in 2 seconds. Events during gaps may be missed.`);
    } finally { clearInterval(heartbeat); stream?.destroy(); stream = null; }
    if (!stopped) await delay(2000);
  }
  await Promise.allSettled([...pendingTrades]);
  if (fatal) throw fatal;
} finally {
  clearInterval(blockhashRefresh);
  await Promise.allSettled([...pendingCacheWrites]);
  journal.close();
}
