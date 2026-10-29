#!/usr/bin/env node
// Stands in for the docker CLI in coding-executor tests. Reads its behaviour
// from fake-docker.json next to the copied script and appends each call to calls.jsonl.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = dirname(process.argv[1]);
const config = JSON.parse(readFileSync(join(here, 'fake-docker.json'), 'utf8'));
const args = process.argv.slice(2);
appendFileSync(join(here, 'calls.jsonl'), JSON.stringify({
  args,
  tokenInEnv: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  envKeys: Object.keys(process.env),
}) + '\n');

if (args[0] !== 'run') process.exit(0);

const home = args[args.indexOf('-v') + 1].split(':')[0];
let credentialsPresent = true;
try { readFileSync(join(home, '.claude', '.credentials.json')); } catch { credentialsPresent = false; }
appendFileSync(join(here, 'calls.jsonl'), JSON.stringify({ credentialsPresent }) + '\n');

const lines = readFileSync(config.stream, 'utf8').split('\n').filter(Boolean);

if (config.mode === 'hang') {
  process.on('SIGTERM', () => process.exit(143));
  for (const line of lines.slice(0, config.linesBeforeHang)) process.stdout.write(line + '\n');
  setInterval(() => {}, 1000);
} else {
  const dir = args[args.indexOf('-w') + 1];
  appendFileSync(join(dir, 'fix.txt'), 'fixed\n');
  for (const [file, text] of Object.entries(config.leave ?? {})) writeFileSync(join(dir, file), text);
  execFileSync('git', ['add', 'fix.txt'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '-m', 'fix: the bug'], { cwd: dir });
  for (const line of lines) process.stdout.write(line + '\n');
}
