// discover — what AI tooling is on this machine, and is any of it governed.
//
// The scan itself is the endpoint agent; this wraps it so one CLI does
// discovery, wiring and the schedule.
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:process';
import * as cfgs from '../config.mjs';
import { c, ok, fail, warn, hint, info, head, die, table } from '../ui.mjs';

const PLIST = join(cfgs.HOME, 'Library', 'LaunchAgents', 'com.clevr.discover.plist');
const LOG = join(cfgs.DIR, 'discover.log');

// The agent prints its JSON first and its post result after, so take the object
// and ignore the tail.
function firstJson (out) {
  const lines = String(out).split('\n');
  const end = lines.lastIndexOf('}');
  if (end < 0) return null;
  try { return JSON.parse(lines.slice(0, end + 1).join('\n')); } catch { return null; }
}

export async function scan ({ report = false } = {}) {
  const bin = cfgs.endpointAgent();
  if (!bin) return null;
  const cfg = cfgs.load();
  const args = [bin, '--json'];
  if (report) args.push('--report');
  try {
    const out = execFileSync('node', args, {
      encoding: 'utf8',
      env: { ...process.env, CLEVR_URL: cfg.url || process.env.CLEVR_URL, CLEVR_API_KEY: cfg.key || process.env.CLEVR_API_KEY },
    });
    return firstJson(out);
  } catch { return null; }
}

export async function discover (args) {
  if (args.schedule) return schedule(args);
  if (args.unschedule) return unschedule();
  if (args.status) return scheduleStatus();

  const bin = cfgs.endpointAgent();
  if (!bin) die('The endpoint scanner is not in this install.');
  const cfg = cfgs.load();
  if (args.report && !cfg.key) die('--report needs an agent key. Run: clevr login');

  const report = await scan({ report: args.report });
  if (!report) die('The scan failed. Run it directly to see why:  node ' + bin);

  if (args.json) { console.log(JSON.stringify(report, null, 2)); return; }

  head('AI tooling running on ' + (report.host || 'this machine'));
  const clients = report.clients || [];
  if (!clients.length) {
    warn('No known AI client is running.');
    hint('Discovery reads running processes: start your tools, then run it again.');
    return;
  }
  table(clients, [
    { label: 'client', get: (x) => x.label || x.id, max: 26 },
    { label: 'kind', get: (x) => x.kind || '', max: 18, color: c.dim },
    { label: 'governed', get: (x) => (x.monitored ? 'yes' : 'no'), max: 9, color: (s) => (s.trim() === 'yes' ? c.green(s) : c.red(s)) },
    { label: 'how', get: (x) => x.via || '', max: 22, color: c.dim },
  ]);

  const s = report.summary || {};
  console.log('');
  info(String(s.running ?? clients.length) + ' running, ' + c.green(String(s.monitored ?? 0) + ' governed') + ', ' + c.red(String((s.running ?? clients.length) - (s.monitored ?? 0)) + ' not'));
  if (args.report) ok('Reported to the console.');
  else hint('Send it to the console:  clevr discover --report');
  const ungoverned = clients.filter((x) => !x.monitored).map((x) => x.id);
  if (ungoverned.length) hint('Wire what is missing:  clevr onboard');
  console.log('');
}

// A daily scan, so the fleet view does not go stale the moment someone installs
// a new tool. launchd on macOS, cron elsewhere; Windows is not covered.
function schedule (args) {
  const bin = cfgs.endpointAgent();
  const cfg = cfgs.load();
  if (!bin) die('The endpoint scanner is not in this install.');
  if (!cfg.key) die('A scheduled scan reports to the console, so it needs a key. Run: clevr login');
  const at = String(args.schedule === true ? '09:00' : args.schedule);
  const [hh, mm] = at.split(':').map((n) => parseInt(n, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) die('Usage: clevr discover --schedule 09:00');

  if (platform === 'darwin') {
    mkdirSync(join(cfgs.HOME, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(PLIST, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '  <key>Label</key><string>com.clevr.discover</string>',
      '  <key>ProgramArguments</key><array>',
      '    <string>' + process.execPath + '</string><string>' + bin + '</string><string>--report</string>',
      '  </array>',
      '  <key>EnvironmentVariables</key><dict>',
      '    <key>CLEVR_URL</key><string>' + cfg.url + '</string>',
      '    <key>CLEVR_API_KEY</key><string>' + cfg.key + '</string>',
      '  </dict>',
      '  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>' + hh + '</integer><key>Minute</key><integer>' + mm + '</integer></dict>',
      '  <key>StandardOutPath</key><string>' + LOG + '</string>',
      '  <key>StandardErrorPath</key><string>' + LOG + '</string>',
      '</dict></plist>',
    ].join('\n') + '\n', { mode: 0o600 });
    try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'pipe' }); } catch { /* not loaded */ }
    try { execFileSync('launchctl', ['load', PLIST], { stdio: 'pipe' }); } catch (e) { return fail('launchctl refused the job: ' + e.message); }
    ok('Daily scan at ' + at + ' (' + PLIST + ')');
    hint('Log: ' + LOG);
    return;
  }
  if (platform === 'win32') return fail('Scheduling is not implemented on Windows. Use Task Scheduler on: node ' + bin + ' --report');

  const line = mm + ' ' + hh + ' * * * CLEVR_URL=' + cfg.url + ' CLEVR_API_KEY=' + cfg.key + ' ' + process.execPath + ' ' + bin + ' --report >> ' + LOG + ' 2>&1 # clevr-discover';
  let current;
  try { current = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); } catch { current = ''; }
  const next = current.split('\n').filter((l) => !l.includes('# clevr-discover')).concat(line, '').join('\n');
  try { execFileSync('crontab', ['-'], { input: next, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return fail('crontab refused the entry: ' + e.message); }
  ok('Daily scan at ' + at + ' in your crontab');
  hint('Log: ' + LOG);
}

function unschedule () {
  if (platform === 'darwin') {
    if (!existsSync(PLIST)) return hint('No scheduled scan.');
    try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'pipe' }); } catch { /* already unloaded */ }
    rmSync(PLIST, { force: true });
    return ok('Scheduled scan removed.');
  }
  let current;
  try { current = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); } catch { return hint('No crontab.'); }
  if (!current.includes('# clevr-discover')) return hint('No scheduled scan.');
  execFileSync('crontab', ['-'], { input: current.split('\n').filter((l) => !l.includes('# clevr-discover')).join('\n'), stdio: ['pipe', 'pipe', 'pipe'] });
  ok('Scheduled scan removed.');
}

function scheduleStatus () {
  if (platform === 'darwin') {
    existsSync(PLIST) ? ok('Scheduled: ' + PLIST) : hint('No scheduled scan. Add one:  clevr discover --schedule 09:00');
  } else {
    let current;
    try { current = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); } catch { current = ''; }
    current.includes('# clevr-discover') ? ok('Scheduled in your crontab') : hint('No scheduled scan. Add one:  clevr discover --schedule 09:00');
  }
  if (existsSync(LOG)) hint('Log: ' + LOG);
}
