import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REQUIRED = ['username', 'output_root'];

export async function loadConfig(path = 'config.json') {
  const raw = await readFile(resolve(path), 'utf8');
  const cfg = JSON.parse(raw);
  for (const key of REQUIRED) {
    if (!cfg[key]) throw new Error(`Missing required config: ${key}`);
  }
  return {
    username: cfg.username,
    outputRoot: resolve(cfg.output_root),
    lists: cfg.lists ?? null,
    maxPostsPerRun: cfg.max_posts_per_run ?? 200,
    interListPauseSeconds: cfg.inter_list_pause_seconds ?? 60,
    requestDelayRange: cfg.request_delay_range ?? [2, 6],
  };
}
