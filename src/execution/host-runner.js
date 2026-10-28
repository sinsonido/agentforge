import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run git or gh on the host with an argument array and return its trimmed stdout.
 * Uses the host's credentials, never a task's HOME or container, and never prompts.
 * @typedef {(cmd: 'git'|'gh', args: string[], opts?: { cwd?: string }) => Promise<string>} Runner
 * @type {Runner}
 */
export async function hostRunner(cmd, args, { cwd } = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} failed: ${(err.stderr || err.message).trim()}`, { cause: err });
  }
}
