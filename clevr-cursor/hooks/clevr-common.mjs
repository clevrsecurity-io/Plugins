// clevr-common.mjs — shared helpers for the Clevr Cursor hooks.
//
// Mirrors the Claude Code plugin's engine call so the two never drift: one
// config surface (CLEVR_* env) and one POST /v1/evaluate. No dependencies —
// Node is already present wherever Cursor runs.
//
// Cursor exposes real pre-execution hooks (cursor.com/docs/hooks): preToolUse,
// beforeShellExecution, beforeMCPExecution. This lets Clevr gate the Cursor
// Agent's (Composer) tool calls IN the agent loop, before they run, even though
// Cursor's model itself is locked to Cursor's backend.

export function trunc (s, n = 300) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '...';
}

// Resolve every CLEVR_* knob once (identical surface to the Claude Code plugin).
//   CLEVR_API_KEY   required. Org key (clevr_sk_...). Unset -> hook INACTIVE
//                   (allows), so an unconfigured install never bricks Cursor.
//   CLEVR_URL       engine base URL. Default http://localhost:8787.
//   CLEVR_AGENT     identity recorded in the audit log. Default 'cursor'.
//   CLEVR_MODE      unset (default) OBEYS the engine verdict — the workspace and
//                   per-agent mode set in the console decide whether an action is
//                   shadowed or blocked (a new agent observes first). Set 'shadow'
//                   to force THIS machine to record-only, regardless of the engine.
//   CLEVR_ESCALATE  what a step-up does: 'deny' (default) HOLDS the action (a
//                   synchronous hook cannot wait for an async console approval);
//                   'ask' prompts the LOCAL operator instead.
//   CLEVR_AUTO_APPROVE '1' to emit permission=allow on a Clevr allow (Clevr
//                   becomes the sole gate). Default off: Clevr only blocks/holds.
//   CLEVR_FAILSAFE  'open' (default) allow on engine error/timeout, 'closed' deny.
//   CLEVR_FORWARD_CONTEXT '1' (default) forward the agent's current message; '0' off.
//   CLEVR_TIMEOUT_MS evaluate timeout. Default 4000.
//   CLEVR_ENV       environment label sent to the engine (prod/staging/dev).
export function loadConfig () {
  return {
    apiKey: process.env.CLEVR_API_KEY || '',
    base: (process.env.CLEVR_URL || 'http://localhost:8787').replace(/\/$/, ''),
    agent: process.env.CLEVR_AGENT || 'cursor',
    failsafe: (process.env.CLEVR_FAILSAFE || 'open').toLowerCase(),
    mode: (process.env.CLEVR_MODE || 'enforce').toLowerCase(),
    autoApprove: process.env.CLEVR_AUTO_APPROVE === '1',
    escalate: (process.env.CLEVR_ESCALATE || 'deny').toLowerCase(),
    forwardCtx: process.env.CLEVR_FORWARD_CONTEXT !== '0',
    timeoutMs: Number(process.env.CLEVR_TIMEOUT_MS || 4000),
    env: process.env.CLEVR_ENV || null,
  };
}

// POST an action to the engine and return how it resolved. Never throws; the
// caller applies the failsafe. Shapes:
//   { inactive: true }            no API key — the hook is off
//   { verdict }                   engine answered
//   { failopen: true, reason }    engine unreachable, failsafe=open
//   { failclosed: true, reason }  engine unreachable, failsafe=closed
export async function postEvaluate (cfg, body) {
  if (!cfg.apiKey) return { inactive: true };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    const r = await fetch(`${cfg.base}/v1/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { verdict: await r.json() };
  } catch (e) {
    if (cfg.failsafe === 'closed') return { failclosed: true, reason: `Clevr engine unreachable (${e.message}); fail-closed.` };
    return { failopen: true, reason: e.message };
  }
}
