import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM = resolve(__dirname, '../scripts/iga_shim.py');

let active = null;

function filterPipxNoise(chunk) {
  return chunk
    .split('\n')
    .filter((l) => !/^\s*(⚠️.*python is already|\s*Downloading and running anyway)/.test(l))
    .join('\n');
}

export function startShim(username) {
  if (active) return active;

  const child = spawn(
    'pipx',
    ['run', '--spec', 'instagrapi', 'python', SHIM, 'serve', '--username', username],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const state = {
    child,
    ready: false,
    readyPromise: null,
    pending: new Map(),
    buffer: '',
  };

  // Route user prompts (2FA, password) from parent stdin into child stdin.
  // Only active until READY — after that, stdin is the JSON-lines protocol
  // channel. Attaching this listener puts process.stdin in flowing mode and
  // would keep the event loop alive if we forgot to detach it.
  const forwardStdin = (d) => {
    if (!state.ready && child.stdin.writable) child.stdin.write(d);
  };
  process.stdin.on('data', forwardStdin);

  state.readyPromise = new Promise((res, rej) => {
    const onExit = (code) => rej(new Error(`Shim exited before ready (code=${code})`));
    child.on('exit', onExit);

    child.stderr.on('data', (d) => {
      const s = filterPipxNoise(d.toString());
      process.stderr.write(s);
      if (s.includes('READY')) {
        child.off('exit', onExit);
        state.ready = true;
        process.stdin.off('data', forwardStdin);
        try { process.stdin.pause(); } catch { /* ignore */ }
        res();
      }
    });
  });

  child.stdout.on('data', (d) => {
    state.buffer += d.toString();
    let idx;
    while ((idx = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, idx).trim();
      state.buffer = state.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const pending = state.pending.get(msg.id);
      if (!pending) continue;
      state.pending.delete(msg.id);
      if (msg.ok) pending.resolve(msg.data);
      else {
        const err = new Error(msg.error || 'shim error');
        err.errorType = msg.type;
        err.stderr = msg.error || '';
        pending.reject(err);
      }
    }
  });

  child.on('exit', (code) => {
    process.stdin.off('data', forwardStdin);
    try { process.stdin.pause(); } catch { /* ignore */ }
    const err = new Error(`Shim exited unexpectedly (code=${code})`);
    for (const pending of state.pending.values()) pending.reject(err);
    state.pending.clear();
    active = null;
  });

  active = state;
  return state;
}

export async function shimCall(cmd, args = {}, { timeoutMs = 600_000 } = {}) {
  if (!active) throw new Error('Shim not started — call startShim(username) first');
  await active.readyPromise;
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      active.pending.delete(id);
      reject(new Error(`Shim call timeout (${cmd}, ${timeoutMs}ms)`));
    }, timeoutMs);
    active.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    active.child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
  });
}

export function stopShim() {
  if (!active) return;
  const { child } = active;
  try { child.stdin.end(); } catch { /* ignore */ }
  // Unref the child so it no longer keeps the event loop alive.
  try { child.unref(); } catch { /* ignore */ }
  active = null;
  // Release parent stdin (the forwardStdin listener keeps the TTY readable).
  try { process.stdin.pause(); } catch { /* ignore */ }
  try { process.stdin.unref?.(); } catch { /* ignore */ }
}

export function listCollections() { return shimCall('list-collections'); }
export function listShortcodes(collectionId) { return shimCall('list-shortcodes', { collection_id: collectionId }); }
export function fetchPost(shortcode, outputDir, listName) {
  return shimCall('fetch-post', { shortcode, output_dir: outputDir, list_name: listName ?? null });
}
export function refreshMetadata(shortcode, listName) {
  return shimCall('refresh-metadata', { shortcode, list_name: listName ?? null });
}
