import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readMetadata(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeMetadata(path, meta) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(meta, null, 2));
}

export function mergeMetadata(previous, fresh, { nowIso }) {
  const first_seen_at = previous?.first_seen_at ?? nowIso;
  const media = fresh.media?.length ? fresh.media : (previous?.media ?? []);
  return {
    ...fresh,
    media,
    stats: { ...(fresh.stats ?? {}), fetched_at: nowIso },
    removed_from_list: false,
    removed_at: null,
    first_seen_at,
    last_updated_at: nowIso,
  };
}

export function markRemoved(previous, { nowIso }) {
  if (!previous) return null;
  if (previous.removed_from_list) return previous;
  return {
    ...previous,
    removed_from_list: true,
    removed_at: nowIso,
    last_updated_at: nowIso,
  };
}
