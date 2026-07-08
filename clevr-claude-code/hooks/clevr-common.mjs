// clevr-common.mjs — shared helpers for the Clevr Claude Code hooks.
//
// Two hooks gate Claude Code through one engine:
//   clevr-gate.mjs    PreToolUse      — every tool call (Bash / Edit / WebFetch / MCP ...)
//   clevr-prompt.mjs  UserPromptSubmit — every user prompt, including tool-less turns
//
// They share one configuration, one transcript reader, and one evaluate call so
// the two never drift. No dependencies — Node is already present wherever Claude
// Code runs.

import { readFileSync } from 'node:fs';

export function trunc (s, n = 300) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '...';
}

// Resolve every CLEVR_* knob once. Both hooks read the SAME config, so a single
// environment set governs the whole plugin.
//
//   CLEVR_API_KEY          required. Org key (clevr_sk_...). If unset, the hooks
//                          are INACTIVE (allow) so an unconfigured install never
//                          bricks Claude Code.
//   CLEVR_URL              engine base URL. Default http://localhost:8787.
//   CLEVR_AGENT            identity recorded in the audit log. Default 'claude-code'.
//   CLEVR_MODE             'shadow' (default) observes and records every verdict
//                          but NEVER blocks; 'enforce' actually blocks / asks.
//   CLEVR_FORWARD_CONTEXT  '1' (default) forward recent transcript turns; '0' off.
//   CLEVR_CONTEXT_TURNS    how many recent turns to forward. Default 6. Raise it to
//                          widen the window the engine scans (catches an injection
//                          planted earlier in the session), at a larger payload.
//   CLEVR_AUTO_APPROVE     '1' to also emit allow on a Clevr 'allow' (skips Claude
//                          Code's own prompt). Default off: Clevr only blocks/asks.
//   CLEVR_FAILSAFE         'open' (default) allow on engine error/timeout, or
//                          'closed' to deny. Unset key always allows.
//   CLEVR_TIMEOUT_MS       evaluate timeout. Default 4000.
//   CLEVR_ENV              environment label sent to the engine (prod/staging/dev).
export function loadConfig () {
  return {
    apiKey: process.env.CLEVR_API_KEY || '',
    base: (process.env.CLEVR_URL || 'http://localhost:8787').replace(/\/$/, ''),
    agent: process.env.CLEVR_AGENT || 'claude-code',
    failsafe: (process.env.CLEVR_FAILSAFE || 'open').toLowerCase(),
    mode: (process.env.CLEVR_MODE || 'shadow').toLowerCase(),
    autoApprove: process.env.CLEVR_AUTO_APPROVE === '1',
    // What a step-up (escalate) does on the tool gate. 'deny' (default) HOLDS the
    // action — a step-up that no one has approved does not run. A Claude Code hook
    // is synchronous (must answer in seconds), so it cannot wait for an async
    // console approval; 'deny' is the honest hard gate. 'ask' instead prompts the
    // LOCAL operator (single-operator setups) — note that is a local approval, not
    // the console one. True approve-in-console-then-resume is the gateway's job.
    escalate: (process.env.CLEVR_ESCALATE || 'deny').toLowerCase(),
    forwardCtx: process.env.CLEVR_FORWARD_CONTEXT !== '0',
    contextTurns: Math.max(1, Number(process.env.CLEVR_CONTEXT_TURNS) || 6),
    timeoutMs: Number(process.env.CLEVR_TIMEOUT_MS || 4000),
    env: process.env.CLEVR_ENV || null,
  };
}

// Best-effort read of the Claude Code transcript (JSONL). Never throws: a bad
// transcript must not break a hook. Returns the last `max` REAL user/assistant
// turns, each truncated.
//
// Claude Code writes many INTERNAL entries alongside the conversation: `system`
// "informational" notes (including our own hook block-echoes), auto-recaps,
// `ai-title`, `queue-operation`, `last-prompt`, `attachment`, and meta/sidechain
// records. Those are UI chrome, not conversation — forwarding them polluted the
// Clevr transcript (Claude Code's English recap turned up as a SYSTEM turn, and
// our block message got echoed back into the next scan). A genuine chat turn is
// the only kind that carries `message.role` = 'user' | 'assistant'; everything
// else is skipped.
export function readConversation (path, max = 6) {
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const msgs = [];
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.isMeta === true || e.isSidechain === true) continue;
      const m = e.message;
      const role = m && m.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const content = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((c) => typeof c === 'string' || c.type === 'text')
              .map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n')
          : '';
      if (content.trim()) msgs.push({ role, content: trunc(content, 1000) });
    }
    return msgs.slice(-max);
  } catch { return []; }
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
