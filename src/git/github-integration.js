import { Octokit } from 'octokit';

/**
 * GitHubIntegration — GitHub API integration via Octokit.
 * Implements GitHub issue #32.
 */
export class GitHubIntegration {
  constructor(config = {}) {
    this.token = config.github_token || process.env.GITHUB_TOKEN;
    this.owner = config.github_owner || null;
    this.repo = config.github_repo || null;
    this.octokit = this.token ? new Octokit({ auth: this.token }) : null;
  }

  isConfigured() {
    return !!(this.octokit && this.owner && this.repo);
  }

  _check() {
    if (!this.isConfigured()) throw new Error('GitHubIntegration: not configured (missing token, owner, or repo)');
  }

  /**
   * Get open issues for the repository.
   * @param {string} state - 'open' | 'closed' | 'all'
   * @param {string[]} labels - Filter by labels
   * @returns {Promise<Object[]>}
   */
  async getIssues(state = 'open', labels = []) {
    this._check();
    const params = { owner: this.owner, repo: this.repo, state, per_page: 100 };
    if (labels.length) params.labels = labels.join(',');
    const res = await this.octokit.rest.issues.listForRepo(params);
    return res.data;
  }

  /**
   * Create a new issue.
   * @param {string} title
   * @param {string} body
   * @param {string[]} labels
   * @returns {Promise<Object>}
   */
  async createIssue(title, body, labels = []) {
    this._check();
    const res = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
      labels,
    });
    return res.data;
  }

  /**
   * Get the status of a specific PR.
   * @param {number} prNumber
   * @returns {Promise<Object>}
   */
  async getPRStatus(prNumber) {
    this._check();
    const res = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });
    return res.data;
  }

  /**
   * List pull requests.
   * @param {string} state - 'open' | 'closed' | 'all'
   * @returns {Promise<Object[]>}
   */
  async listPRs(state = 'open') {
    this._check();
    const res = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      state,
      per_page: 50,
    });
    return res.data;
  }

  /**
   * Get CI/check-run status for a commit ref.
   * @param {string} ref - Branch, tag, or SHA
   * @returns {Promise<Object>}
   */
  async getCIStatus(ref) {
    this._check();
    const res = await this.octokit.rest.repos.getCombinedStatusForRef({
      owner: this.owner,
      repo: this.repo,
      ref,
    });
    return res.data;
  }

  /**
   * Post a comment on a PR.
   * @param {number} prNumber
   * @param {string} body
   * @returns {Promise<Object>}
   */
  async commentOnPR(prNumber, body) {
    this._check();
    const res = await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      body,
    });
    return res.data;
  }

  /**
   * Merge a pull request.
   * @param {number} prNumber
   * @param {'merge'|'squash'|'rebase'} method
   * @returns {Promise<Object>}
   */
  async mergePR(prNumber, method = 'squash') {
    this._check();
    const res = await this.octokit.rest.pulls.merge({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      merge_method: method,
    });
    return res.data;
  }

  /**
   * Close an issue.
   * @param {number} issueNumber
   * @returns {Promise<Object>}
   */
  async closeIssue(issueNumber) {
    this._check();
    const res = await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      state: 'closed',
    });
    return res.data;
  }
}

export default GitHubIntegration;
