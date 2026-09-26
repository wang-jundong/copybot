import { closeSync, existsSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

// Run only while the bot is stopped. The original file remains intact until
// every retained line has been validated and the replacement has been synced.
function pruneUnlocked(path) {
  const temporary = `${path}.prune-${process.pid}-${randomUUID()}`;
  const input = openSync(path, 'r');
  let output;
  let removed = 0;
  try {
    output = openSync(temporary, 'wx', 0o600);
    const chunk = Buffer.alloc(64 * 1024);
    let carry = Buffer.alloc(0);
    const keep = bytes => {
      if (!bytes.length) return;
      const line = bytes.at(-1) === 10 ? bytes.subarray(0, -1) : bytes;
      if (!line.length) { writeAll(output, bytes); return; }
      if (JSON.parse(line.toString('utf8')).status === 'skipped') removed++;
      else writeAll(output, bytes);
    };
    while (true) {
      const length = readSync(input, chunk, 0, chunk.length, null);
      if (!length) break;
      const data = Buffer.concat([carry, chunk.subarray(0, length)]);
      let start = 0, end;
      while ((end = data.indexOf(10, start)) !== -1) {
        keep(data.subarray(start, end + 1));
        start = end + 1;
      }
      carry = data.subarray(start);
      if (carry.length > 10 * 1024 * 1024) throw new Error(`Journal row too large in ${path}`);
    }
    keep(carry);
    fsyncSync(output);
  } catch (error) {
    if (output !== undefined) closeSync(output);
    closeSync(input);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  closeSync(output);
  closeSync(input);
  if (!removed) { unlinkSync(temporary); return 0; }
  try { renameSync(temporary, path); }
  catch (error) { unlinkSync(temporary); throw error; }
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return removed;
}


export function pruneSkippedJournal(path) {
  if (!existsSync(path)) return 0;
  const lock = `${path}.lock`;
  let lockFd;
  try { lockFd = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Stop the bot before pruning ${path}`);
    throw error;
  }
  try { return pruneUnlocked(path); }
  finally { closeSync(lockFd); unlinkSync(lock); }
}
