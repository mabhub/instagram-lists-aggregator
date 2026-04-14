import { listCollections } from './shim.js';

export function sanitizeDirName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

export async function resolveLists(_username, { filterNames, configLists }) {
  const all = await listCollections();
  const wanted = filterNames?.length ? filterNames : configLists;
  const selected = wanted
    ? (() => {
        const byName = new Map(all.map((c) => [c.name, c]));
        const missing = wanted.filter((n) => !byName.has(n));
        if (missing.length) throw new Error(`Unknown list(s): ${missing.join(', ')}`);
        return wanted.map((n) => byName.get(n));
      })()
    : all;

  const seen = new Map();
  for (const c of selected) {
    const dir = sanitizeDirName(c.name);
    if (seen.has(dir)) {
      throw new Error(
        `List directory collision after sanitization: "${c.name}" and "${seen.get(dir)}" both -> "${dir}"`,
      );
    }
    seen.set(dir, c.name);
  }
  return selected;
}
