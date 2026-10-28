import { execFile } from 'node:child_process';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const BASE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SLUG = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`git ${args.join(' ')} failed: ${(err.stderr || err.message).trim()}`, { cause: err });
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function succeeds(args, cwd) {
  try {
    await git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-task git workspaces under one state directory:
 *
 *   <stateDir>/mirrors/<owner>__<name>.git   bare mirror, fetched before each prepare
 *   <stateDir>/tasks/<taskId>/repo           self-contained clone, origin = the mirror
 *   <stateDir>/tasks/<taskId>/home           empty HOME for the harness
 *
 * Every step derives what to do from what is on disk, so a rerun after a crash converges.
 */
export function createWorkspaceManager({ stateDir }) {
  const mirrorLocks = new Map();

  const taskDir = (taskId) => join(stateDir, 'tasks', taskId);

  function withMirrorLock(mirror, fn) {
    const next = (mirrorLocks.get(mirror) ?? Promise.resolve()).then(fn, fn);
    mirrorLocks.set(mirror, next.catch(() => {}));
    return next;
  }

  async function syncMirror(repo) {
    const [, owner, name] = SLUG.exec(repo.slug);
    const mirror = join(stateDir, 'mirrors', `${owner}__${name}.git`);
    const url = repo.url ?? `https://github.com/${repo.slug}.git`;
    await withMirrorLock(mirror, async () => {
      if (await succeeds(['rev-parse', '--git-dir'], mirror)) {
        await git(['fetch', '--prune', 'origin'], mirror);
        return;
      }
      const partial = `${mirror}.partial`;
      await rm(partial, { recursive: true, force: true });
      await rm(mirror, { recursive: true, force: true });
      await mkdir(join(stateDir, 'mirrors'), { recursive: true });
      await git(['clone', '--mirror', url, partial]);
      await rename(partial, mirror);
    });
    return mirror;
  }

  /**
   * @param {{ taskId: string, repo: { slug: string, url?: string }, base: string }} opts
   * @returns {Promise<{ dir: string, home: string, branch: string }>}
   */
  async function prepare({ taskId, repo, base }) {
    if (!TASK_ID.test(taskId)) throw new Error(`invalid taskId: ${taskId}`);
    if (!SLUG.test(repo?.slug ?? '')) throw new Error(`invalid repo slug: ${repo?.slug}`);
    if (!BASE.test(base)) throw new Error(`invalid base: ${base}`);

    const root = taskDir(taskId);
    const dir = join(root, 'repo');
    const home = join(root, 'home');
    const branch = `agentforge/${taskId}`;
    await mkdir(home, { recursive: true });

    const mirror = await syncMirror(repo);

    const resumable = (await exists(join(dir, '.git')))
      && (await succeeds(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], dir));
    if (resumable) {
      await git(['checkout', branch], dir);
      return { dir, home, branch };
    }

    const partial = join(root, 'repo.partial');
    await rm(partial, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    await git(['clone', '--no-hardlinks', '--no-checkout', mirror, partial]);
    await git(['checkout', '-b', branch, `origin/${base}`], partial);
    await rename(partial, dir);
    return { dir, home, branch };
  }

  /**
   * Commits on HEAD that are not on origin/<base>, oldest first.
   * @returns {Promise<Array<{ sha: string, subject: string }>>}
   */
  async function evidence(dir, base) {
    const out = await git(['log', '--reverse', '--format=%H%x1f%s', `origin/${base}..HEAD`], dir);
    if (!out) return [];
    return out.split('\n').map((line) => {
      const [sha, subject] = line.split('\x1f');
      return { sha, subject };
    });
  }

  async function cleanup(taskId) {
    if (!TASK_ID.test(taskId)) throw new Error(`invalid taskId: ${taskId}`);
    await rm(taskDir(taskId), { recursive: true, force: true });
  }

  return { prepare, evidence, cleanup };
}
