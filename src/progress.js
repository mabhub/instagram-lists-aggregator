import { clearLine, cursorTo } from 'node:readline';

const isTTY = Boolean(process.stdout.isTTY);

function hhmmss(d = new Date()) {
  return d.toTimeString().slice(0, 8);
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m${String(r).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

const EVENT_SYMBOL = {
  added: '+',
  existing: '~',
  refetched: '↻',
  skipped: '·',
  removed: '-',
  error: '!',
};

const RATE_WINDOW = 20;

export function createProgress(total, label) {
  const startedAt = Date.now();
  const counts = { added: 0, existing: 0, refetched: 0, skipped: 0, removed: 0, error: 0 };
  let done = 0;
  // Rolling timestamps of the last N network-hitting events. A short
  // window keeps the rate responsive to real-time conditions and
  // avoids anchoring ETA to a slow/unusual first post.
  const networkTimestamps = [];

  function rate() {
    if (networkTimestamps.length < 2) return 0;
    const span = networkTimestamps[networkTimestamps.length - 1] - networkTimestamps[0];
    if (span <= 0) return 0;
    return ((networkTimestamps.length - 1) / span) * 60_000;
  }

  function eta() {
    const r = rate();
    if (r <= 0) return '—';
    // Extrapolate remaining network work from the observed skip ratio.
    const skippedRatio = done > 0 ? counts.skipped / done : 0;
    const remainingNet = Math.max(0, (total - done) * (1 - skippedRatio));
    const seconds = (remainingNet / r) * 60;
    return fmtDuration(seconds);
  }

  function renderTTY() {
    const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
    const summary = `+${counts.added} ~${counts.existing} ↻${counts.refetched} ·${counts.skipped} !${counts.error}`;
    const line = `[${done}/${total}] ${pct}% ${label}  ${summary}  ${rate().toFixed(1)}/min  ETA ${eta()}`;
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stdout.write(line);
  }

  function renderLine(event, detail) {
    const sym = EVENT_SYMBOL[event] ?? '?';
    const out = `${hhmmss()} [${done}/${total}] ${sym} ${detail ?? ''}\n`;
    process.stdout.write(out);
  }

  return {
    tick(event, detail) {
      if (event in counts) counts[event] += 1;
      done += 1;
      if (event !== 'skipped' && event !== 'removed') {
        networkTimestamps.push(Date.now());
        if (networkTimestamps.length > RATE_WINDOW) networkTimestamps.shift();
      }
      if (isTTY) renderTTY();
      else renderLine(event, detail);
    },
    note(detail) {
      if (isTTY) return;
      process.stdout.write(`${hhmmss()}   ${detail}\n`);
    },
    finish() {
      const elapsed = fmtDuration((Date.now() - startedAt) / 1000);
      if (isTTY) {
        clearLine(process.stdout, 0);
        cursorTo(process.stdout, 0);
      }
      const summary = `+${counts.added} ~${counts.existing} ↻${counts.refetched} ·${counts.skipped} -${counts.removed} !${counts.error}`;
      process.stdout.write(`${hhmmss()} ✓ ${label}: ${summary}  (${done}/${total} in ${elapsed})\n`);
      return { ...counts, done, total, elapsed };
    },
  };
}
