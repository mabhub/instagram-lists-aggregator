import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function loadState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { shortcodes: [], last_run: null };
    throw err;
  }
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  // Write to a sibling tempfile and rename atomically — guarantees no
  // torn write even on SIGKILL mid-flush.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);
}

export function diffShortcodes(previous, current) {
  const prev = new Set(previous);
  const curr = new Set(current);
  return {
    added: [...curr].filter((s) => !prev.has(s)),
    existing: [...curr].filter((s) => prev.has(s)),
    removed: [...prev].filter((s) => !curr.has(s)),
  };
}
