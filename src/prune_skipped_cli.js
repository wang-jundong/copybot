import { pruneSkippedJournal } from './prune_skipped.js';

for (const name of ['dry-run', 'live']) {
  const path = `data/${name}.jsonl`;
  console.log(`${path}: removed ${pruneSkippedJournal(path)} skipped rows`);
}
