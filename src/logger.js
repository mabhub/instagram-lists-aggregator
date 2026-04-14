import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const ts = () => new Date().toTimeString().slice(0, 8);

export function createLogger(listDir) {
  const errPath = `${listDir}/errors.log`;
  return {
    info: (msg) => process.stdout.write(`${ts()} [info] ${msg}\n`),
    warn: (msg) => process.stderr.write(`${ts()} [warn] ${msg}\n`),
    error: async (msg, err) => {
      const line = `${new Date().toISOString()} ${msg}${err ? ` :: ${err.stack || err.message || err}` : ''}\n`;
      process.stderr.write(`${ts()} [error] ${msg}\n`);
      await mkdir(dirname(errPath), { recursive: true });
      await appendFile(errPath, line);
    },
  };
}

export const rootLogger = {
  info: (msg) => process.stdout.write(`${ts()} [info] ${msg}\n`),
  warn: (msg) => process.stderr.write(`${ts()} [warn] ${msg}\n`),
  error: (msg, err) => process.stderr.write(`${ts()} [error] ${msg}${err ? ` :: ${err.stack || err.message || err}` : ''}\n`),
};
