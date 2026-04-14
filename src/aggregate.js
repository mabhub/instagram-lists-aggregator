import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { fetchPost, refreshMetadata, listShortcodes } from './shim.js';
import { loadState, saveState, diffShortcodes } from './state.js';
import { readMetadata, writeMetadata, mergeMetadata, markRemoved } from './metadata.js';
import { createLogger } from './logger.js';
import { sanitizeDirName } from './lists.js';
import { sleep } from './util.js';
import { createProgress } from './progress.js';

function jitter([min, max]) {
  return (min + Math.random() * (max - min)) * 1000;
}

async function postHasMedia(postDir) {
  try {
    const entries = await readdir(postDir);
    return entries.some((e) => /^media_\d+\.(jpg|jpeg|png|webp|mp4|mov)$/i.test(e));
  } catch {
    return false;
  }
}

async function withRetry(fn, { logger, label, maxAttempts = 4 }) {
  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const stderr = String(err.stderr || err.message || '');
      const type = err.errorType || '';
      if (/challenge_required|login_required|checkpoint/i.test(stderr) || type === 'LoginRequired') {
        logger.error(`Auth/challenge detected on ${label} — aborting run`, err);
        throw Object.assign(new Error('AUTH_CHALLENGE'), { fatal: true });
      }
      const waitMs = Math.min(60_000, 2 ** attempt * 3_000) + Math.random() * 2_000;
      await logger.error(`Attempt ${attempt + 1} failed for ${label}, retrying in ${Math.round(waitMs)}ms`, err);
      await sleep(waitMs);
      attempt += 1;
    }
  }
  throw lastErr;
}

export async function aggregateList(list, { outputRoot, maxPostsPerRun, requestDelayRange }) {
  const nowIso = new Date().toISOString();
  const listDir = join(outputRoot, sanitizeDirName(list.name));
  const statePath = join(listDir, '.state.json');
  const logger = createLogger(listDir);

  logger.info(`List "${list.name}": discovering shortcodes...`);
  const current = await listShortcodes(list.id);

  const prev = await loadState(statePath);
  const prevShortcodes = new Set(prev.shortcodes);
  const { added, existing, removed } = diffShortcodes(prev.shortcodes, current);
  logger.info(`${list.name}: ${current.length} posts (diff +${added.length} ~${existing.length} -${removed.length})`);
  const progress = createProgress(added.length + existing.length + removed.length, list.name);

  // Persist state incrementally as a set of successfully-seen shortcodes.
  // Starts from previous state; we add shortcodes as they are processed so that
  // an interruption doesn't lose the progress already made this run.
  const seen = new Set(prev.shortcodes);

  async function persist() {
    await saveState(statePath, { shortcodes: [...seen], last_run: nowIso });
  }

  let processed = 0;
  const stopIfLimit = () => maxPostsPerRun && processed >= maxPostsPerRun;

  for (const sc of added) {
    if (stopIfLimit()) { logger.warn('maxPostsPerRun reached'); break; }
    const postDir = join(listDir, sc);
    const metaPath = join(postDir, 'metadata.json');
    try {
      const fresh = await withRetry(() => fetchPost(sc, postDir, list.name),
        { logger, label: `fetch ${sc}` });
      const meta = mergeMetadata(null, fresh, { nowIso });
      await writeMetadata(metaPath, meta);
      seen.add(sc);
      progress.tick('added', `${sc} (${meta.media.length} media)`);
    } catch (err) {
      if (err.fatal) throw err;
      await logger.error(`fetch ${sc} failed permanently`, err);
      progress.tick('error', `${sc} — ${err.message}`);
    }
    processed += 1;
    await persist();
    await sleep(jitter(requestDelayRange));
  }

  for (const sc of existing) {
    if (stopIfLimit()) { logger.warn('maxPostsPerRun reached'); break; }
    const postDir = join(listDir, sc);
    const metaPath = join(postDir, 'metadata.json');
    try {
      const previous = await readMetadata(metaPath);
      const hasMedia = await postHasMedia(postDir);
      let meta;
      let eventKind = 'existing';
      if (!hasMedia) {
        const fresh = await withRetry(() => fetchPost(sc, postDir, list.name),
          { logger, label: `refetch ${sc}` });
        meta = mergeMetadata(previous, fresh, { nowIso });
      } else {
        const fresh = await withRetry(() => refreshMetadata(sc, list.name),
          { logger, label: `refresh ${sc}` });
        meta = mergeMetadata(previous, fresh, { nowIso });
        eventKind = 'skipped';
      }
      await writeMetadata(metaPath, meta);
      seen.add(sc);
      progress.tick(eventKind, sc);
    } catch (err) {
      if (err.fatal) throw err;
      if (prevShortcodes.has(sc)) seen.add(sc);
      await logger.error(`refresh ${sc} failed`, err);
      progress.tick('error', `${sc} — ${err.message}`);
    }
    processed += 1;
    await persist();
    await sleep(jitter(requestDelayRange));
  }

  for (const sc of removed) {
    const metaPath = join(listDir, sc, 'metadata.json');
    const previous = await readMetadata(metaPath);
    const updated = markRemoved(previous, { nowIso });
    if (updated && updated !== previous) {
      await writeMetadata(metaPath, updated);
    }
    seen.delete(sc);
    progress.tick('removed', sc);
    await persist();
  }

  progress.finish();
  // Final canonical state: what Instagram actually returned.
  await saveState(statePath, { shortcodes: current, last_run: nowIso });
  return { added: added.length, existing: existing.length, removed: removed.length };
}
