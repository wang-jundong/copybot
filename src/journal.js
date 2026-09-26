import { mkdirSync, readFileSync, appendFileSync, openSync, closeSync, unlinkSync } from 'node:fs';

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
  has(id) { return this.rows.has(id); }
  put(row) {
    if (row.status === 'skipped') return;
    appendFileSync(this.path, JSON.stringify(row) + '\n', { mode: 0o600, flush: true });
    this.rows.set(row.id, row);
  }
  close() { closeSync(this.fd); unlinkSync(this.lock); }
}
