#!/usr/bin/env node
// clevr-codex-prompt.mjs — Codex (UserPromptSubmit) hook.
//
// Codex hooks (GA May 2026; the ChatGPT desktop app runs the same Codex) read
// the same stdin and answer with the same JSON as Claude Code's, so the Claude
// Code hook is the implementation. This file only says which harness it runs
// in, then hands over. One implementation, two harnesses, no drift.
process.env.CLEVR_SOURCE ||= 'codex';
process.env.CLEVR_AGENT ||= 'codex';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
// Installed: ~/.clevr/tools/codex next to ~/.clevr/tools/claude-code. In the
// monorepo: integrations/codex/hooks next to integrations/claude-code/hooks.
const candidates = [join(here, '..', 'claude-code', 'clevr-prompt.mjs'), join(here, '..', '..', 'claude-code', 'hooks', 'clevr-prompt.mjs')];
const impl = candidates.find((p) => existsSync(p));
if (!impl) { process.stderr.write('[clevr] the Claude Code hooks are not installed beside this shim; allowing.\n'); process.exit(0); }
await import(pathToFileURL(impl).href);
