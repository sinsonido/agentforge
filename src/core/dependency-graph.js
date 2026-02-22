/**
 * DependencyGraph — Task DAG with topological sort.
 * Implements GitHub issue #22.
 *
 * Tasks form a directed acyclic graph where edges represent "depends on" relationships.
 * A task is "ready" when all its dependencies have been completed.
 */
export class DependencyGraph {
  constructor() {
    /** @type {Map<string, { id: string, deps: Set<string>, dependents: Set<string>, completed: boolean }>} */
    this.nodes = new Map();
  }

  /**
   * Add a task to the graph.
   * @param {string} taskId
   * @param {string[]} deps - Task IDs this task depends on
   */
  addTask(taskId, deps = []) {
    if (!this.nodes.has(taskId)) {
      this.nodes.set(taskId, {
        id: taskId,
        deps: new Set(),
        dependents: new Set(),
        completed: false,
      });
    }

    const node = this.nodes.get(taskId);

    for (const depId of deps) {
      node.deps.add(depId);

      // Ensure dep node exists
      if (!this.nodes.has(depId)) {
        this.nodes.set(depId, {
          id: depId,
          deps: new Set(),
          dependents: new Set(),
          completed: false,
        });
      }
      this.nodes.get(depId).dependents.add(taskId);
    }

    return this;
  }

  /**
   * Remove a task from the graph (cleans up references).
   * @param {string} taskId
   */
  removeTask(taskId) {
    const node = this.nodes.get(taskId);
    if (!node) return;

    // Remove from dependents of its deps
    for (const depId of node.deps) {
      this.nodes.get(depId)?.dependents.delete(taskId);
    }

    // Remove from deps of its dependents
    for (const depId of node.dependents) {
      this.nodes.get(depId)?.deps.delete(taskId);
    }

    this.nodes.delete(taskId);
  }

  /**
   * Mark a task as completed.
   * @param {string} taskId
   * @returns {string[]} List of newly unblocked task IDs (all deps now met)
   */
  complete(taskId) {
    const node = this.nodes.get(taskId);
    if (!node) return [];
    node.completed = true;

    // Check which dependents are now unblocked
    const unblocked = [];
    for (const depId of node.dependents) {
      const depNode = this.nodes.get(depId);
      if (depNode && !depNode.completed && this._depsComplete(depNode)) {
        unblocked.push(depId);
      }
    }
    return unblocked;
  }

  /**
   * Get all tasks that are ready to execute (no pending dependencies).
   * @returns {string[]}
   */
  getReady() {
    const ready = [];
    for (const [id, node] of this.nodes) {
      if (!node.completed && this._depsComplete(node)) {
        ready.push(id);
      }
    }
    return ready;
  }

  /**
   * Topological sort — returns all tasks in valid execution order.
   * Throws if a cycle is detected.
   * @returns {string[]}
   */
  topologicalSort() {
    this.detectCycles();

    const visited = new Set();
    const order = [];

    const visit = (id) => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = this.nodes.get(id);
      if (node) {
        for (const depId of node.deps) {
          visit(depId);
        }
        order.push(id);
      }
    };

    for (const id of this.nodes.keys()) {
      visit(id);
    }

    return order;
  }

  /**
   * Detect cycles using DFS. Throws on cycle.
   */
  detectCycles() {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();

    const dfs = (id) => {
      color.set(id, GRAY);
      const node = this.nodes.get(id);
      if (node) {
        for (const depId of node.deps) {
          const c = color.get(depId) || WHITE;
          if (c === GRAY) {
            throw new Error(`DependencyGraph: cycle detected involving task "${id}" → "${depId}"`);
          }
          if (c === WHITE) dfs(depId);
        }
      }
      color.set(id, BLACK);
    };

    for (const id of this.nodes.keys()) {
      if ((color.get(id) || WHITE) === WHITE) {
        dfs(id);
      }
    }
  }

  /**
   * Returns true if there is a cycle in the graph.
   */
  hasCycle() {
    try {
      this.detectCycles();
      return false;
    } catch {
      return true;
    }
  }

  getStats() {
    const all = Array.from(this.nodes.values());
    return {
      total: all.length,
      completed: all.filter(n => n.completed).length,
      ready: this.getReady().length,
      blocked: all.filter(n => !n.completed && !this._depsComplete(n)).length,
    };
  }

  _depsComplete(node) {
    for (const depId of node.deps) {
      const dep = this.nodes.get(depId);
      if (!dep || !dep.completed) return false;
    }
    return true;
  }
}

export default DependencyGraph;
