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

  // Stdin forwarding is opt-in per prompt, not permanent: the shim
  // emits a "PROMPT\n" marker on stderr just before each input()/
  // getpass() call. We forward a single line of parent stdin into
  // the child, then detach again. This avoids capturing keystrokes
  // the user typed during the pipx boot or other non-prompt windows.
  let promptPending = false;
  const forwardStdin = (d) => {
    if (!promptPending || !child.stdin.writable) return;
    child.stdin.write(d);
    // Detach as soon as we see a line terminator — one prompt, one line.
    if (d.includes('\n')) {
      promptPending = false;
      try { process.stdin.pause(); } catch { /* ignore */ }
    }
  };

  state.readyPromise = new Promise((res, rej) => {
    const onExit = (code) => rej(new Error(`Shim exited before ready (code=${code})`));
    child.on('exit', onExit);

    child.stderr.on('data', (d) => {
      const raw = d.toString();
      const s = filterPipxNoise(raw);
      if (raw.includes('PROMPT')) {
        promptPending = true;
        // off() before on() is idempotent if the listener isn't registered.
        process.stdin.off('data', forwardStdin);
        process.stdin.on('data', forwardStdin);
        process.stdin.resume();
      }
      // Swallow the bare "PROMPT" line from user-visible stderr.
      process.stderr.write(s.split('\n').filter((l) => l !== 'PROMPT').join('\n'));
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
