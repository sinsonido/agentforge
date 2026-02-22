import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DependencyGraph } from '../../src/core/dependency-graph.js';

describe('DependencyGraph', () => {
  let graph;

  beforeEach(() => {
    graph = new DependencyGraph();
  });

  describe('addTask()', () => {
    it('creates a node for a new task', () => {
      graph.addTask('t1');
      assert.ok(graph.nodes.has('t1'));
    });

    it('creates the task with empty deps and dependents', () => {
      graph.addTask('t1');
      const node = graph.nodes.get('t1');
      assert.equal(node.deps.size, 0);
      assert.equal(node.dependents.size, 0);
      assert.equal(node.completed, false);
    });

    it('creates dependency nodes automatically', () => {
      graph.addTask('t2', ['t1']);
      // t1 should be auto-created even though it was not explicitly added
      assert.ok(graph.nodes.has('t1'));
    });

    it('sets up bidirectional relationship between task and its deps', () => {
      graph.addTask('t1');
      graph.addTask('t2', ['t1']);

      const t1Node = graph.nodes.get('t1');
      const t2Node = graph.nodes.get('t2');

      assert.ok(t2Node.deps.has('t1'), 't2 should depend on t1');
      assert.ok(t1Node.dependents.has('t2'), 't1 should list t2 as a dependent');
    });

    it('is idempotent: adding an existing task does not overwrite it', () => {
      graph.addTask('t1');
      graph.addTask('t2', ['t1']);
      // Adding t1 again should not reset its dependents
      graph.addTask('t1');
      const t1Node = graph.nodes.get('t1');
      assert.ok(t1Node.dependents.has('t2'));
    });

    it('returns this for chaining', () => {
      const result = graph.addTask('t1');
      assert.equal(result, graph);
    });
  });

  describe('complete()', () => {
    it('marks the task as completed', () => {
      graph.addTask('t1');
      graph.complete('t1');
      assert.equal(graph.nodes.get('t1').completed, true);
    });

    it('returns newly unblocked task ids', () => {
      graph.addTask('t1');
      graph.addTask('t2', ['t1']);

      const unblocked = graph.complete('t1');
      assert.deepEqual(unblocked, ['t2']);
    });

    it('does not list a task as unblocked if it has remaining dependencies', () => {
      graph.addTask('t1');
      graph.addTask('t2');
      graph.addTask('t3', ['t1', 't2']);

      const unblocked = graph.complete('t1');
      assert.deepEqual(unblocked, []);
    });

    it('returns multiple newly unblocked tasks', () => {
      graph.addTask('t1');
      graph.addTask('t2', ['t1']);
      graph.addTask('t3', ['t1']);

      const unblocked = graph.complete('t1');
      assert.equal(unblocked.length, 2);
      assert.ok(unblocked.includes('t2'));
      assert.ok(unblocked.includes('t3'));
    });

    it('returns empty array for an unknown task id', () => {
      const result = graph.complete('nonexistent');
      assert.deepEqual(result, []);
    });

    it('does not include already-completed dependents in unblocked list', () => {
      graph.addTask('t1');
      graph.addTask('t2', ['t1']);
      // Manually mark t2 as completed
      graph.nodes.get('t2').completed = true;

      const unblocked = graph.complete('t1');
      assert.deepEqual(unblocked, []);
    });
  });

  describe('getReady()', () => {
    it('returns tasks with no pending dependencies', () => {
      graph.addTask('t1');
      graph.addTask('t2');
      graph.addTask('t3', ['t1']);

      const ready = graph.getReady();
      assert.ok(ready.includes('t1'));
      assert.ok(ready.includes('t2'));
      assert.ok(!ready.includes('t3'));
    });

    it('does not include tasks that have unmet dependencies', () => {
      graph.addTask('t2', ['t1']);
      graph.addTask('t3', ['t2']);
      // t1 was auto-created with no deps → it is ready
      // t2 depends on t1 (not completed) → blocked
      // t3 depends on t2 (not completed) → blocked
      const ready = graph.getReady();
      assert.ok(ready.includes('t1'));
      assert.ok(!ready.includes('t2'));
      assert.ok(!ready.includes('t3'));
    });

    it('does not include completed tasks', () => {
      graph.addTask('t1');
      graph.complete('t1');

      const ready = graph.getReady();
      assert.ok(!ready.includes('t1'));
    });

    it('returns dependent tasks after their deps are completed', () => {
      graph.addTask('t1');
      graph.addTask('t2', ['t1']);

      graph.complete('t1');

      const ready = graph.getReady();
      assert.ok(ready.includes('t2'));
      assert.ok(!ready.includes('t1'));
    });
  });

  describe('topologicalSort()', () => {
    it('returns all tasks in a valid topological order', () => {
      graph.addTask('t1');
      graph.addTask('t2', ['t1']);
      graph.addTask('t3', ['t2']);

      const order = graph.topologicalSort();

      // t1 must come before t2, t2 before t3
      assert.ok(order.indexOf('t1') < order.indexOf('t2'));
      assert.ok(order.indexOf('t2') < order.indexOf('t3'));
    });

    it('handles a diamond dependency pattern', () => {
      //      t1
      //     /  \
      //    t2  t3
      //     \  /
      //      t4
      graph.addTask('t1');
      graph.addTask('t2', ['t1']);
      graph.addTask('t3', ['t1']);
      graph.addTask('t4', ['t2', 't3']);

      const order = graph.topologicalSort();

      assert.ok(order.indexOf('t1') < order.indexOf('t2'));
      assert.ok(order.indexOf('t1') < order.indexOf('t3'));
      assert.ok(order.indexOf('t2') < order.indexOf('t4'));
      assert.ok(order.indexOf('t3') < order.indexOf('t4'));
    });

    it('returns the single task when there is only one', () => {
      graph.addTask('solo');
      const order = graph.topologicalSort();
      assert.deepEqual(order, ['solo']);
    });

    it('includes all nodes in the result', () => {
      graph.addTask('a');
      graph.addTask('b', ['a']);
      graph.addTask('c', ['b']);

      const order = graph.topologicalSort();
      assert.equal(order.length, 3);
      assert.ok(order.includes('a'));
      assert.ok(order.includes('b'));
      assert.ok(order.includes('c'));
    });
  });

  describe('hasCycle()', () => {
    it('returns false for a graph with no cycles', () => {
      graph.addTask('t1');
      graph.addTask('t2', ['t1']);
      assert.equal(graph.hasCycle(), false);
    });

    it('returns false for an empty graph', () => {
      assert.equal(graph.hasCycle(), false);
    });

    it('detects a direct two-node cycle', () => {
      // t1 depends on t2, t2 depends on t1
      graph.addTask('t1', ['t2']);
      graph.addTask('t2', ['t1']);
      assert.equal(graph.hasCycle(), true);
    });

    it('detects a three-node cycle', () => {
      graph.addTask('t1', ['t3']);
      graph.addTask('t2', ['t1']);
      graph.addTask('t3', ['t2']);
      assert.equal(graph.hasCycle(), true);
    });
  });

  describe('detectCycles()', () => {
    it('does not throw when there are no cycles', () => {
      graph.addTask('t1');
      graph.addTask('t2', ['t1']);
      assert.doesNotThrow(() => graph.detectCycles());
    });

    it('throws with a helpful message when a cycle is detected', () => {
      graph.addTask('t1', ['t2']);
      graph.addTask('t2', ['t1']);

      assert.throws(
        () => graph.detectCycles(),
        /DependencyGraph: cycle detected involving task/
      );
    });

    it('includes the task ids in the error message', () => {
      graph.addTask('task-a', ['task-b']);
      graph.addTask('task-b', ['task-a']);

      let errorMessage = '';
      try {
        graph.detectCycles();
      } catch (e) {
        errorMessage = e.message;
      }

      assert.ok(errorMessage.includes('task-a') || errorMessage.includes('task-b'));
    });
  });

  describe('getStats()', () => {
    it('returns correct counts for total, completed, ready and blocked', () => {
      graph.addTask('t1');
      graph.addTask('t2', ['t1']);
      graph.addTask('t3', ['t1']);

      graph.complete('t1');

      const stats = graph.getStats();
      assert.equal(stats.total, 3);
      assert.equal(stats.completed, 1);
      assert.equal(stats.ready, 2); // t2 and t3 are now ready
      assert.equal(stats.blocked, 0);
    });
  });
});
