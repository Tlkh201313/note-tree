/**
 * Per-agent hook output shapes.
 *
 * Every agent that supports session hooks wants its context in a slightly
 * different wrapper. The seed is rendered once; this module is the only place
 * that knows how each CLI likes to receive it.
 *
 * Rule that matters: never emit both JSON and plain text. Claude Code adds
 * `SessionStart` stdout to context *and* honours `additionalContext`, so
 * emitting both would inject the memory twice and double the cost.
 */

/** `text` is the documented fallback: SessionStart stdout is added to context. */
export const AGENTS_WITH_HOOKS = ['claude', 'codex', 'opencode'];

/**
 * @param agent  adapter id
 * @param text   rendered seed
 * @param mode   'auto' | 'json' | 'text'
 */
export function sessionStartEnvelope(agent, text, mode = 'auto') {
  if (!text) return '';
  const shape = mode === 'auto' ? defaultShapeFor(agent) : mode;
  if (shape === 'text') return text;

  switch (agent) {
    case 'codex':
      return JSON.stringify({
        continue: true,
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
      });
    case 'claude':
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
      });
    default:
      // opencode plugins and anything generic consume the string directly.
      return text;
  }
}

function defaultShapeFor(agent) {
  return agent === 'claude' || agent === 'codex' ? 'json' : 'text';
}

/**
 * Stop-hook output.
 *
 * `user` shows a line to the human and costs the model nothing — the default,
 * because a memory tool should never hijack a turn you didn't ask it to.
 * `agent` asks the model itself to save a note, and is opt-in.
 *
 * Only Claude Code's Stop contract is verified, so every other agent gets
 * silence rather than a guess at a payload that might break their turn.
 */
export function stopEnvelope(agent, { message, mode = 'user' }) {
  if (!message || agent !== 'claude') return '';
  if (mode === 'agent') return JSON.stringify({ decision: 'block', reason: message });
  return JSON.stringify({ systemMessage: message });
}
