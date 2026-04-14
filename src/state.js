import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
  await writeFile(path, JSON.stringify(state, null, 2));
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
