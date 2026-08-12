/**
 * Secret redaction.
 *
 * Notes are written by an agent that has just been reading source files, and
 * they get shared across tools and sometimes committed. Anything that looks like
 * a credential is replaced before it ever reaches disk.
 *
 * The bias is deliberate: a false positive costs a `[redacted]` in a note, a
 * false negative costs a leaked key. We accept the former to avoid the latter,
 * but every pattern still requires real entropy or a known prefix so ordinary
 * prose survives intact.
 */

const PLACEHOLDER = '[redacted]';

/** Values that are obviously examples, not secrets. */
const BENIGN = /^(x{3,}|y{3,}|\.{3,}|\*{3,}|<[^>]*>|\$\{[^}]*\}|your[-_ ]?\w+|example|changeme|placeholder|todo|null|undefined|true|false)$/i;

const RULES = [
  // Whole private-key / certificate blocks.
  {
    name: 'private-key',
    re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
    replace: () => '-----BEGIN PRIVATE KEY-----[redacted]-----END PRIVATE KEY-----',
  },
  // Vendor tokens with unmistakable prefixes.
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'openai', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'github-fine', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'slack', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'stripe', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'google', re: /\bAIza[A-Za-z0-9_-]{30,}/g },
  { name: 'aws-key-id', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/g },
  { name: 'npm', re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Credentials embedded in a URL: scheme://user:secret@host
  {
    name: 'url-credentials',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):([^\s/@]{3,})@/gi,
    replace: (_m, head) => `${head}:${PLACEHOLDER}@`,
  },
  // Authorization: Bearer <token>
  {
    name: 'bearer',
    re: /\b(Authorization\s*[:=]\s*(?:"|')?\s*(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
    replace: (_m, head) => head + PLACEHOLDER,
  },
  // key = "value" / "key": "value" — only when the value has secret-like entropy.
  {
    name: 'assignment',
    re: /((?:api[_-]?key|secret|password|passwd|pwd|token|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|credential)s?\s*["']?\s*[:=]\s*)(["'`]?)([^\s"'`,;)}\]]{8,})\2/gi,
    replace: (m, head, quote, value) => {
      if (BENIGN.test(value) || !looksSecret(value)) return m;
      return `${head}${quote}${PLACEHOLDER}${quote}`;
    },
  },
  // Bare KEY=value lines, the shape you get from pasting a .env file.
  {
    name: 'env-line',
    re: /^([A-Z][A-Z0-9_]{2,}(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|DSN|CREDENTIALS)\s*=\s*)(.+)$/gm,
    replace: (m, head, value) => {
      const v = value.trim().replace(/^["']|["']$/g, '');
      if (BENIGN.test(v) || v.length < 8) return m;
      return head + PLACEHOLDER;
    },
  },
];

/** Rough entropy check — mixed classes or long random-looking runs. */
function looksSecret(v) {
  if (v.length >= 32) return true;
  const classes =
    Number(/[a-z]/.test(v)) + Number(/[A-Z]/.test(v)) + Number(/\d/.test(v)) + Number(/[^A-Za-z0-9]/.test(v));
  return classes >= 3 || (classes >= 2 && v.length >= 12);
}

/**
 * Redact secrets in `text`.
 * Returns `{ text, hits }` where `hits` names the rules that fired — the CLI and
 * MCP surface report these so the author knows something was scrubbed.
 */
export function redact(text, enabled = true) {
  const src = String(text ?? '');
  if (!enabled || !src) return { text: src, hits: [] };

  let out = src;
  const hits = [];
  for (const rule of RULES) {
    const before = out;
    out = out.replace(rule.re, rule.replace || PLACEHOLDER);
    if (out !== before) hits.push(rule.name);
  }
  return { text: out, hits };
}

/** Redact every string field of a note in place-ish (returns a new object). */
export function redactNote(note, enabled = true) {
  if (!enabled) return { note, hits: [] };
  const all = new Set();
  const out = { ...note };
  for (const field of ['title', 'desc', 'body']) {
    const { text, hits } = redact(out[field], true);
    out[field] = text;
    hits.forEach((h) => all.add(h));
  }
  return { note: out, hits: [...all] };
}

/* ------------------------------------------------------------------ *
 * Path deny-list
 * ------------------------------------------------------------------ */

/** Minimal glob -> RegExp: supports `**`, `*`, `?`, and character classes. */
export function globToRegExp(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` may match zero directories, so the slash is part of the group.
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else { re += g.slice(i, end + 1); i = end; }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** True if `filePath` matches any deny pattern. Separators are normalised. */
export function isDeniedPath(filePath, patterns = []) {
  if (!filePath || !patterns.length) return false;
  const p = String(filePath).replace(/\\/g, '/');
  return patterns.some((pat) => {
    const re = globToRegExp(pat);
    // Match the full path and also each trailing segment, so `**/.env*` catches
    // both `.env` and `/abs/path/.env.local`.
    if (re.test(p)) return true;
    const idx = p.indexOf('/');
    return idx !== -1 && re.test(p.slice(idx + 1));
  });
}
