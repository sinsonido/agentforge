import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import eventBus from '../core/event-bus.js';

/**
 * GitManager — Core git operations wrapper using child_process.
 * Implements GitHub issue #27.
 */
export class GitManager {
  constructor(config = {}) {
    this.config = config;
    this.remote = config.remote || 'origin';
    this.baseBranch = config.base_branch || 'main';
    this.repoPath = process.cwd();
  }

  /** Get current branch name */
  getCurrentBranch() {
    return this._run('rev-parse --abbrev-ref HEAD');
  }

  /** Check if inside a git repository */
  isGitRepo() {
    try {
      this._run('rev-parse --git-dir');
      return true;
    } catch {
      return false;
    }
  }

  /** Get the remote URL for origin */
  getRemoteUrl(remote = this.remote) {
    return this._run(`remote get-url ${remote}`);
  }

  /** Check if there are uncommitted changes */
  hasUncommittedChanges() {
    const status = this._run('status --porcelain');
    return status.length > 0;
  }

  /** Get list of modified/untracked files */
  getModifiedFiles() {
    const output = this._run('status --porcelain');
    return output
      .split('\n')
      .filter(Boolean)
      .map(line => line.slice(3).trim());
  }

  /** Stage all changes */
  async stageAll() {
    this._run('add -A');
  }

  /** Stage specific files */
  async stageFiles(files) {
    if (!files?.length) return;
    const quoted = files.map(f => `"${f}"`).join(' ');
    this._run(`add ${quoted}`);
  }

  /**
   * Commit staged changes.
   * @param {string} message - Commit message
   */
  async commit(message) {
    if (!this.hasUncommittedChanges()) return null;
    // Stage everything before commit
    this._run('add -A');
    const escaped = message.replace(/"/g, '\\"');
    this._run(`commit -m "${escaped}"`);
    const sha = this._run('rev-parse --short HEAD');
    eventBus.emit('git.committed', { message, sha, branch: this.getCurrentBranch() });
    return sha;
  }

  /**
   * Create and checkout a new branch from base.
   * @param {string} branchName
   * @param {string} [fromBranch] - Base branch (defaults to this.baseBranch)
   */
  async createBranch(branchName, fromBranch) {
    const base = fromBranch || this.baseBranch;
    try {
      // Try to create from base branch
      this._run(`checkout -b ${branchName} ${this.remote}/${base}`);
    } catch {
      // Fallback: branch from current HEAD
      this._run(`checkout -b ${branchName}`);
    }
    return branchName;
  }

  /** Checkout an existing branch */
  async checkout(branchName) {
    this._run(`checkout ${branchName}`);
  }

  /** Push a branch to remote */
  async push(branchName) {
    this._run(`push -u ${this.remote} ${branchName}`);
  }

  /** Get the short git log */
  getLog(n = 10) {
    return this._run(`log --oneline -${n}`);
  }

  /** Get git status output */
  getStatus() {
    return this._run('status --short');
  }

  /** Get the SHA of HEAD */
  getHeadSha() {
    return this._run('rev-parse HEAD');
  }

  /**
   * Run a git command safely.
   * @param {string} cmd - git subcommand + args
   * @returns {string} stdout trimmed
   */
  _run(cmd) {
    return execSync(`git ${cmd}`, {
      cwd: this.repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }
}

export default GitManager;
