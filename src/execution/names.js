/**
 * Names a coding task holds where other instances live too: its branch on the
 * GitHub repo and its container on the Docker daemon. They come from
 * `task.handle`, never from `task.id`, which restarts at t1 in every database.
 */

/** Docker label naming the AgentForge instance that started a task container. */
export const INSTANCE_LABEL = 'agentforge.instance';

const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function handleOf(task) {
  if (!HANDLE.test(task?.handle ?? '')) throw new Error(`task ${task?.id}: invalid handle: ${task?.handle}`);
  return task.handle;
}

export const branchFor = (task) => `agentforge/${handleOf(task)}`;

export const containerFor = (task) => `af-task-${handleOf(task)}`;
