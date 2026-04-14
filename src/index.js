#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { resolveLists } from './lists.js';
import { aggregateList } from './aggregate.js';
import { rootLogger } from './logger.js';
import { startShim, stopShim } from './shim.js';
import { sleep } from './util.js';

// Make stdout/stderr line-buffered even when piped (tee, background).
try { process.stdout._handle?.setBlocking?.(true); } catch { /* ignore */ }
try { process.stderr._handle?.setBlocking?.(true); } catch { /* ignore */ }

const HELP = `Usage: iga [options]

Options:
  --config <path>   Path to config.json (default: ./config.json)
  --list <name>     Target a specific list (repeatable). Default: all lists.
  -h, --help        Show help

Environment:
  IGA_PASSWORD      Instagram password (avoids interactive prompt).
  IGA_2FA_CODE      Pre-supply 2FA code (otherwise prompted on stderr).
`;

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'config.json' },
      list: { type: 'string', multiple: true, default: [] },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) { console.log(HELP); return; }

  const cfg = await loadConfig(values.config);
  const filterNames = values.list.length ? values.list : null;

  rootLogger.info(`Starting shim for @${cfg.username}...`);
  startShim(cfg.username);

  rootLogger.info(`Resolving lists...`);
  const lists = await resolveLists(cfg.username, {
    filterNames,
    configLists: cfg.lists,
  });
  rootLogger.info(`${lists.length} list(s) to process`);

  const summary = [];
  for (let i = 0; i < lists.length; i += 1) {
    const list = lists[i];
    rootLogger.info(`[${i + 1}/${lists.length}] === ${list.name} ===`);
    try {
      const result = await aggregateList(list, cfg);
      summary.push({ list: list.name, ok: true, ...result });
    } catch (err) {
      if (err.message === 'AUTH_CHALLENGE') {
        rootLogger.error('Authentication challenge — stopping run cleanly');
        break;
      }
      rootLogger.error(`List "${list.name}" failed`, err);
      summary.push({ list: list.name, ok: false, added: 0, existing: 0, removed: 0 });
    }
    if (i < lists.length - 1 && cfg.interListPauseSeconds > 0) {
      rootLogger.info(`Pausing ${cfg.interListPauseSeconds}s before next list...`);
      await sleep(cfg.interListPauseSeconds * 1000);
    }
  }

  printSummary(summary);
}

function printSummary(summary) {
  process.stdout.write('\n=== Summary ===\n');
  const nameW = Math.max(4, ...summary.map((s) => s.list.length));
  const header = `${'List'.padEnd(nameW)}  ${'added'.padStart(6)}  ${'exist'.padStart(6)}  ${'rmv'.padStart(4)}  status\n`;
  process.stdout.write(header);
  process.stdout.write('-'.repeat(header.length - 1) + '\n');
  for (const s of summary) {
    const status = s.ok ? 'ok' : 'FAILED';
    process.stdout.write(
      `${s.list.padEnd(nameW)}  ${String(s.added).padStart(6)}  ${String(s.existing).padStart(6)}  ${String(s.removed).padStart(4)}  ${status}\n`,
    );
  }
}

main()
  .catch((err) => {
    rootLogger.error('Fatal', err);
    process.exitCode = 1;
  })
  .finally(() => {
    stopShim();
  });
