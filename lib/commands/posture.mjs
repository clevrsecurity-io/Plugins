// posture / why
//
// A posture is one word an organisation can agree to, over settings that were
// always editable and that nobody edited, because choosing seven levers means
// understanding seven levers. `apply` refuses to move anything without showing
// the consequence first, and `diff` exists so the name never hides what it does.
//
// `why` answers the question a developer actually asks when an agent is stopped,
// which is not "what is the policy" but "what did I do". Everything it prints
// comes from the signed decision, so the explanation and the evidence are the
// same object.
import * as cfgs from '../config.mjs';
import { brain, v1 } from '../api.mjs';
import { c, ok, fail, warn, info, head, die, verdict } from '../ui.mjs';

async function mgmt (path, opts) {
  const cfg = cfgs.load();
  if (!cfg.session) die('This needs a console session. Run: clevr login --email <you>');
  const r = await brain(cfg, path, opts);
  if (!r.ok) die('Engine said ' + (r.status || '?') + ': ' + (r.error || ''));
  return r.body;
}

// Same rows and the same words as the console's PostureBar; test_posture_ladder
// fails when the two drift from the engine's ORG_KEYS.
const SETTING_LABEL = {
  hold_unclassified: 'a verb the engine cannot classify',
  strict_agent_declaration: 'an agent that was never declared',
  failsafe_action: 'when the engine itself is unreachable',
  new_agents_observe: 'a new agent, until someone promotes it',
  require_authenticated_actions: 'who may clear a hold or reveal masked content',
  gate_prompts: 'a prompt an in-loop plugin is about to show the model',
  undecided_default: 'an action no rule decided and the Guardian did not judge',
  probation_on_limit: 'an agent whose session crossed the risk limit',
  reach_posture: 'a tool reaching somewhere new',
  out_of_scope_reach: 'a reach outside the mandate',
};
const VALUE_LABEL = {
  hold_unclassified: { true: 'held', false: 'allowed' },
  strict_agent_declaration: { true: 'refused', false: 'added on first call' },
  failsafe_action: { open: 'allowed through', closed: 'refused' },
  new_agents_observe: { true: 'observed', false: 'enforced' },
  require_authenticated_actions: { true: 'a signed-in person', false: 'whoever holds the key, recorded' },
  gate_prompts: { true: 'stopped before the model', false: 'the action is gated, the prompt is not' },
  undecided_default: { allow: 'allowed, and recorded as undecided', deny: 'refused' },
  probation_on_limit: { on: 'put on probation', observe: 'recorded, not applied', off: 'nothing carries over' },
  // Same words as the console: the two reach levers used to print their stored
  // value, which is the one thing every other row here exists not to do.
  reach_posture: { surface: 'allowed, and flagged for review', hold: 'held', block: 'refused' },
  out_of_scope_reach: { allow: 'allowed', surface: 'allowed, and flagged for review', guardian: 'judged by the Guardian Agent against the declared intent', hold: 'held for authorization', block: 'refused' },
};
const label = (s) => SETTING_LABEL[s] || (s.startsWith('verb:') ? s.slice(5).replace(/_/g, ' ') : s);
const shown = (setting, v) => {
  const m = VALUE_LABEL[setting];
  if (m && String(v) in m) return m[String(v)];
  return (v === null || v === undefined) ? c.dim('allowed') : String(v);
};

function printChanges (changes) {
  if (!changes.length) { info(c.dim('nothing would change')); return; }
  for (const ch of changes) {
    console.log('      ' + label(ch.setting).padEnd(48) + c.dim(shown(ch.setting, ch.from) + '  →  ') + shown(ch.setting, ch.to));
  }
}

export async function posture (args, rest) {
  const sub = rest[0] || 'show';

  if (sub === 'list') {
    const { tiers } = await mgmt('/posture/tiers');
    head('Postures');
    for (const t of tiers) {
      console.log('  ' + c.bold(t.id.padEnd(10)) + t.summary);
      console.log('  ' + ' '.repeat(10) + c.dim(t.accepts) + '\n');
    }
    return;
  }

  if (sub === 'diff') {
    const from = args.from || 'current';
    const to = args.to || rest[1];
    if (!to) die('Usage: clevr posture diff --to <tier> [--from <tier|current>]');
    const d = await mgmt(`/posture/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    head(from + '  →  ' + to);
    printChanges(d.changes);
    return;
  }

  if (sub === 'apply') {
    const tier = args.tier || rest[1];
    if (!tier) die('Usage: clevr posture apply <tier> [--dry-run]');
    const dry = !!args['dry-run'];
    const r = await mgmt('/posture/apply', { method: 'POST', json: { tier, dry_run: dry } });
    head((dry ? 'Would move to ' : 'Moved to ') + r.tier);
    printChanges(r.changes);
    console.log('');
    warn('You are accepting: ' + r.accepts);
    if (dry) info(c.dim('Nothing was written. Re-run without --dry-run to apply.'));
    else ok('Applied. Every agent in this workspace is judged this way from the next call.');
    return;
  }

  // show
  const d = await mgmt('/posture');
  head('Posture');
  if (d.on_tier) {
    ok('This workspace is on ' + c.bold(d.on_tier) + '.');
  } else {
    warn('This workspace is not on any named posture. Closest is ' + c.bold(d.nearest) + ', ' + d.drift.length + ' setting' + (d.drift.length === 1 ? '' : 's') + ' apart:');
    printChanges(d.drift);
  }
  console.log('');
  for (const t of d.tiers) {
    const mark = t.tier === d.on_tier ? c.green('●') : c.dim('○');
    console.log('  ' + mark + ' ' + t.tier.padEnd(10) + c.dim(t.differences === 0 ? 'where you are' : t.differences + ' settings away'));
  }
}

export async function why (args, rest) {
  const id = rest[0];
  if (!id) die('Usage: clevr why <decision-id>');
  const cfg = cfgs.load();
  if (!cfg.session && !cfg.key) die('Not connected. Run: clevr login');
  // Reading one decision is a /v1 read, which an agent key is allowed to make —
  // `clevr verify` reads the same row that way. Going through /brain/api made
  // `why` the only read command that demanded an account, and it said so with a
  // raw "Engine said 401: Console session required." instead of the guidance
  // every other account-requiring command gives. Prefer the session when there
  // is one (it carries the console's own scoping), fall back to the key.
  const r = cfg.session
    ? await brain(cfg, '/decisions/' + encodeURIComponent(id))
    : await v1(cfg, '/decisions/' + encodeURIComponent(id));
  if (!r.ok) die('Engine said ' + (r.status || '?') + ': ' + (r.error || ''));
  const d = r.body || {};

  head('Decision ' + id);
  info(c.dim('verdict  ') + verdict(d.effect));
  info(c.dim('agent    ') + (d.agent_name || d.agent_id || ''));
  info(c.dim('tool     ') + (d.tool || d.action_type || ''));
  if (d.target) info(c.dim('on       ') + d.target);
  if (d.action) info(c.dim('asked    ') + String(d.action).slice(0, 140));
  console.log('');

  if (d.reason) { console.log('  ' + c.bold('Why')); console.log('  ' + d.reason + '\n'); }
  if (d.matched_policy) info(c.dim('rule     ') + d.matched_policy);
  if (d.would_have_been && d.would_have_been !== d.effect) {
    warn('This workspace is in observe, so it ran anyway. Enforcing, it would have been ' + verdict(d.would_have_been) + '.');
  }

  // The fix, not just the diagnosis. A mandate refusal and a floor refusal are
  // undone in completely different places, and saying which is most of the help.
  const reason = String(d.reason || '');
  console.log('  ' + c.bold('What to do'));
  if (/no mandate bound|outside what this agent is allowed|exceeds its mandate/i.test(reason)) {
    console.log('  This is the mandate, not the safety floor. See what its own history suggests:');
    console.log('    ' + c.dim('clevr agents get ' + (d.agent_name || d.agent_id || '<agent>')));
  } else if (/content-risk|sentinel|forged record|injection/i.test(reason)) {
    console.log('  The content floor stopped this, before any rule of yours ran.');
    console.log('    ' + c.dim('clevr floor') + '   to see the classes and what each one does');
  } else if (/cumulative session risk|repeated/i.test(reason)) {
    console.log('  Nothing in this single action was wrong. The session as a whole crossed a threshold.');
    console.log('    ' + c.dim('clevr activity --agent ' + (d.agent_id || '<agent>')) + '   to see the run it belongs to');
  } else {
    console.log('  ' + c.dim('clevr floor') + '   the classes that run before every rule');
    console.log('  ' + c.dim('clevr policy list') + '   the rules of this workspace');
  }
  console.log('');
  info(c.dim('This decision is signed. Re-check it with: ') + 'clevr verify ' + id);
}
