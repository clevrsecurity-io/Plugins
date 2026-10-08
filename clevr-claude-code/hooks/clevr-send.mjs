// clevr-send.mjs — deliver one record after the hook that wrote it has exited.
//
// Started detached by postDetached (clevr-common.mjs) with one argument: a file
// holding { url, apiKey, body }. The file is read and deleted first, so a crash
// anywhere below leaves nothing behind. The request then runs to its answer, or
// to a bounded timeout: nobody is waiting on this process, so it can afford to
// wait on the network, which the hook could not.
import { readFileSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const file = process.argv[2];
if (!file) process.exit(0);
let job = null;
try { job = JSON.parse(readFileSync(file, 'utf8')); } catch { /* nothing to send */ }
try { unlinkSync(file); } catch { /* already gone */ }
if (!job || !job.url || !job.apiKey || !job.body) process.exit(0);

let url;
try { url = new URL(job.url); } catch { process.exit(0); }
const mod = url.protocol === 'https:' ? https : http;
const payload = Buffer.from(JSON.stringify(job.body));
const req = mod.request(url, {
  method: 'POST',
  agent: false,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${job.apiKey}`, 'Content-Length': payload.length },
}, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
req.on('error', () => process.exit(0));
req.setTimeout(15000, () => { req.destroy(); process.exit(0); });
req.end(payload);
