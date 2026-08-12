/**
 * The fail-open harness every hook runs inside.
 *
 * A memory plugin that breaks your session is dead on arrival, so the contract
 * here is absolute: on *any* error, any timeout, any surprise, exit 0 and print
 * nothing. The worst outcome note-tree is allowed to cause is one session
 * without recalled memory.
 */

const MAX_STDIN = 4 * 1024 * 1024;

/** `--agent claude` / `--agent=claude`; returns `fallback` when absent. */
export function arg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const long = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === long) return argv[i + 1] ?? true;
    if (argv[i].startsWith(`${long}=`)) return argv[i].slice(long.length + 1);
  }
  return fallback;
}

export function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

/**
 * Read the hook payload from stdin.
 *
 * Bounded by a timer because a hook must never be the reason a session hangs:
 * if the host doesn't send anything, we carry on with what we can infer from
 * the environment.
 */
export function readStdinJson(timeoutMs = 250) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);

    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      try {
        resolve(data.trim() ? JSON.parse(data) : null);
      } catch {
        resolve(null);
      }
    };

    const timer = setTimeout(finish, timeoutMs);
    if (timer.unref) timer.unref();

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_STDIN) finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', () => {
      data = '';
      finish();
    });
  });
}

/**
 * Run a hook body under the fail-open contract.
 *
 * The watchdog is a real exit, not a rejected promise: if something we call
 * blocks on I/O the host would otherwise wait on us, and a slow memory lookup
 * is never worth a stalled session.
 */
export async function run(fn, { watchdogMs = 400, onTimeout = null } = {}) {
  let finished = false;
  const watchdog = setTimeout(() => {
    if (finished) return;
    if (onTimeout) {
      try {
        onTimeout();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  }, Math.max(50, watchdogMs));
  if (watchdog.unref) watchdog.unref();

  let output = '';
  try {
    output = (await fn()) || '';
  } catch {
    output = ''; // fail open: no memory this session, but the session is fine
  }
  finished = true;
  clearTimeout(watchdog);

  if (output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  // Explicit exit: stdin may still be open, and a hook must not linger.
  process.exit(0);
}

/**
 * Best-effort working directory. The payload is authoritative — agents may run
 * hooks from their own install directory rather than the project.
 */
export function resolveCwd(payload) {
  return (
    payload?.cwd ||
    payload?.workspace_root ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.NOTE_TREE_CWD ||
    process.cwd()
  );
}

export function resolveSession(payload) {
  return payload?.session_id || payload?.sessionId || payload?.conversation_id || null;
}
