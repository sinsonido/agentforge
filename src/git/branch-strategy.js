/**
 * BranchStrategy — Auto-create branches per agent and task.
 * Implements GitHub issue #28.
 */
export class BranchStrategy {
  constructor(config = {}) {
    // e.g. "agent/{agent_name}/{task_id}"
    this.pattern = config.branch_pattern || 'agent/{agent_name}/{task_id}';
    this.baseBranch = config.base_branch || 'main';
    this.enabled = config.auto_branch !== false;
  }

  /**
   * Generate a branch name for an agent/task combination.
   * @param {Object} agent - Agent config { id, name }
   * @param {Object} task - Task { id, type }
   * @returns {string}
   */
  branchFor(agent, task) {
    const name = (agent.id || agent.name || 'agent')
      .toLowerCase()
      .replace(/\s+/g, '-');

    return this.pattern
      .replace('{agent_name}', name)
      .replace('{agent_id}', agent.id || name)
      .replace('{task_id}', task.id)
      .replace('{task_type}', task.type || 'task')
      .toLowerCase()
      .replace(/[^a-z0-9\-\/]/g, '-')
      .replace(/-+/g, '-')
      .replace(/\/$/, '');
  }

  /**
   * Ensure the branch exists for the given agent/task, creating if needed.
   * Returns the branch name.
   * @param {import('./git-manager.js').GitManager} gitManager
   * @param {Object} agent
   * @param {Object} task
   * @returns {Promise<string>} Branch name
   */
  async ensureBranch(gitManager, agent, task) {
    if (!this.enabled) return gitManager.getCurrentBranch();

    const branchName = this.branchFor(agent, task);
    const current = gitManager.getCurrentBranch();

    if (current === branchName) return branchName;

    // Check if branch already exists locally
    try {
      gitManager._run(`show-ref --verify refs/heads/${branchName}`);
      // Branch exists — checkout
      await gitManager.checkout(branchName);
    } catch {
      // Branch doesn't exist — create it
      await gitManager.createBranch(branchName);
    }

    return branchName;
  }
}

export default BranchStrategy;
