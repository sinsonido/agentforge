/**
 * The autonomy policy: poteto-mode's Autonomy section, enforced on the host.
 * Reversible work proceeds. Merge waits for the operator.
 *
 * ACTIONS lists the host actions AgentForge performs for a coding task, in the
 * order a run reaches them. The agent performs none of them: it has no push or
 * `gh` credentials. The policy (`autonomy:` in agentforge.yml) gives each action
 * a rule:
 *   allow    run it
 *   approve  park the task in `needs-approval` until the operator decides
 *   deny     never run it
 * An action that does not run, denied by policy or rejected by the operator,
 * ends the task where the previous action left it (`stopsAt`). With no previous
 * action, a denial fails the task and a rejection cancels it.
 *
 * Force-push, deploys, data deletion and customer messages are on poteto-mode's
 * Always-pause list but are not actions AgentForge performs, so the policy
 * cannot name them.
 *
 * @typedef {'allow'|'approve'|'deny'} Rule
 * @typedef {'publish'|'merge'} Action
 * @typedef {Record<Action, Rule>} Policy
 * @typedef {{
 *   action: Action, summary: string, payload: object, requested_at: number,
 *   decision: 'approved'|'rejected'|null, decided_by: string|null, decided_at: number|null,
 *   reason: string|null, error?: string,
 * }} Approval
 */

export const RULES = Object.freeze(['allow', 'approve', 'deny']);

const commits = (n) => `${n} commit${n === 1 ? '' : 's'}`;

export const ACTIONS = Object.freeze({
  publish: {
    rules: RULES,
    default: 'allow',
    stopsAt: null,
    next: 'merge',
    summary: (task, { verdict }) =>
      `push agentforge/${task.id} and open a PR into ${task.base} (${commits(verdict.commits.length)})`,
  },
  merge: {
    rules: ['approve', 'deny'],
    default: 'approve',
    stopsAt: 'pr-opened',
    next: null,
    summary: (task, { pr_url }) => `merge ${pr_url} into ${task.base}`,
  },
});

/** The first host action of a coding run that passed the evidence gate. */
export const FIRST_ACTION = 'publish';

/** @type {Readonly<Policy>} */
export const DEFAULT_POLICY = Object.freeze(Object.fromEntries(Object.entries(ACTIONS).map(([a, s]) => [a, s.default])));

/**
 * Parse the `autonomy:` block. Missing actions take their default.
 * @param {unknown} raw
 * @returns {{ ok: true, value: Policy } | { ok: false, error: string }}
 */
export function parseAutonomy(raw) {
  if (raw == null) return { ok: true, value: { ...DEFAULT_POLICY } };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'autonomy must be a mapping of action: rule' };
  const errors = [];
  for (const [action, rule] of Object.entries(raw)) {
    const spec = ACTIONS[action];
    if (!spec) errors.push(`unknown action "${action}"; AgentForge performs: ${Object.keys(ACTIONS).join(', ')}`);
    else if (!spec.rules.includes(rule)) errors.push(`${action} must be one of: ${spec.rules.join(', ')}`);
  }
  if (errors.length) return { ok: false, error: errors.join('; ') };
  return { ok: true, value: { ...DEFAULT_POLICY, ...raw } };
}

/** @returns {Approval} */
export function pendingApproval(task, action, payload, now = Date.now()) {
  return {
    action, summary: ACTIONS[action].summary(task, payload), payload, requested_at: now,
    decision: null, decided_by: null, decided_at: null, reason: null,
  };
}

/** @returns {Approval} */
export function decide(approval, decision, { by, reason = null }, now = Date.now()) {
  return { ...approval, error: undefined, decision, decided_by: by, decided_at: now, reason };
}

/** @returns {import('./trail.js').TrailInput} what the policy decided for one action */
export function policyEntry(action, rule) {
  const said = { allow: 'allowed', approve: 'needs approval', deny: 'denied' }[rule];
  return { kind: 'decision', summary: `${action} ${said} by policy`, evidence: { source: 'policy', action, rule } };
}

/** @returns {import('./trail.js').TrailInput} what the operator decided */
export function operatorEntry({ action, decision, decided_by, reason }) {
  return {
    kind: 'decision',
    summary: `${decided_by} ${decision} ${action}${reason ? `: ${reason}` : ''}`,
    evidence: { source: 'operator', by: decided_by, action, decision, ...(reason && { reason }) },
  };
}
