# Self-hosting

AgentForge edits its own repository. The instance that does the work must not run from the tree it edits, or a task could change the code under the running process. `scripts/self-host.sh` runs AgentForge from an immutable release directory, built from a tag or SHA of `sinsonido/agentforge`, in a Docker container.

Requirements on the host: `bash`, `git`, `curl`, Docker, a GitHub token for the instance (see [GitHub token](#github-token)), the `claude` binary with a login, and the pinned pstack plugin. Node and `gh` are not needed. The build and the server run in the `node:24` image.

## Commands

```bash
scripts/self-host.sh install <ref>   # build <ref> and point "current" at it
scripts/self-host.sh start           # run "current" on 127.0.0.1:4343
scripts/self-host.sh status          # installed SHA, running SHA, /api/status code
scripts/self-host.sh upgrade <ref>   # install, then restart if the running SHA changed
scripts/self-host.sh stop            # stop and remove the container
```

`<ref>` is a tag, a branch name or a SHA. The script resolves it to a full SHA once, and every later step uses that SHA.

Every command converges to the same end state when you run it again:

- `install` skips the build when `releases/<sha>` exists. A release directory appears only through an atomic rename at the end of a successful build, so a crashed build leaves only a `.staging-*` directory, which the next install deletes.
- `install` switches `current` with an atomic symlink rename.
- `start` does nothing when the container already runs the `current` SHA. Otherwise it checks its inputs and the GitHub token, then replaces the container. A failed check leaves the running container alone, and so does `upgrade`. It returns after `/api/status` answers, or fails with the `docker logs` command to run.
- `upgrade` to the SHA that is already running does not restart anything.
- `stop` does nothing when no container exists.

`stop` sends `SIGINT` and allows 30 seconds before Docker kills the instance. On `SIGINT` or `SIGTERM`, AgentForge cancels every running coding task. It runs `docker stop -t 10` on each of its task containers, records the task as `cancelled` (no PR is opened), and closes its database before it exits. After the instance is gone, `stop` also stops any task container labelled `agentforge.instance=$AGENTFORGE_CONTAINER` that is still running. Other instances' task containers are left alone. `upgrade` uses the same `stop`. A task can still come back as failed (interrupted) on the next boot when the instance dies without that shutdown, for example on a host crash, because the queue is persisted in SQLite (#240).

## Several instances on one repo

Every database numbers its tasks from `t1`, so the task id is not a name AgentForge uses outside its database. Each coding task gets a handle, its id plus 8 random hex digits (`t1-3f9c02ab`). The handle names the branch (`agentforge/t1-3f9c02ab`) and the task container (`af-task-t1-3f9c02ab`). Two instances, or one instance before and after a database reset, can share a GitHub repo and a Docker daemon. `start` passes the container name as `AGENTFORGE_INSTANCE`, and each task container carries it as the `agentforge.instance` label.

Tasks from a database older than this change keep their id as handle when they already ran, so their clone, branch and PR still match. Queued tasks get a fresh handle.

`publish` refuses to push when the remote branch is at a commit the run did not make, and refuses when the branch already had a closed or merged PR. The task fails with that reason, or, when the operator approved the publish, waits in `needs-approval` with the error. It never adopts another task's PR.

## Layout

Everything lives under `AGENTFORGE_HOME`, default `~/.agentforge-self`:

```
repo.git/          bare clone, the export source for releases
releases/<sha>/    source from git archive, node_modules, ui/dist
current            symlink to releases/<sha>
data/              agentforge.db (the container's working directory)
config/            agentforge.yml, gh-token (mode 600)
state/             executor mirrors, per-task clones and per-task HOMEs
tools/gh-<ver>/    static gh binary for the container
```

The container mounts the release read-only at `/app`, `data/` at `/data` and `config/` read-only at `/config`. It runs as your user, so the files in `data/` belong to you.

`start` creates `config/agentforge.yml` from the release's `agentforge.example.yml` on the first run and adds `database.path: /data/agentforge.db` and an `executor:` block. The executor paths in that block are `${AGENTFORGE_*}` references, which `start` sets in the container environment, so a changed path needs no config edit. `start` never overwrites the file. Edit it to add provider keys, then run `stop` and `start`.

## Executor mounts

The executor starts one container per task through the host's Docker daemon. The daemon resolves every `-v` path on the host, so each path the executor hands it is mounted into the AgentForge container at the same absolute path. `start` checks each input and stops with a message when one is missing.

| Mount or variable | Inside the container | What it grants |
|---|---|---|
| `AGENTFORGE_DOCKER_SOCKET` | `/var/run/docker.sock`, plus the socket's group | Starting containers. This is root on the host. Keep the port on `127.0.0.1` or turn on `server.auth`. |
| host `docker` binary | `/usr/local/bin/docker`, read-only | The Docker client the executor runs. |
| `AGENTFORGE_STATE_DIR` | same path, read-write | Mirrors, per-task clones and HOMEs. Task containers mount parts of it by this path. |
| `AGENTFORGE_CLAUDE_BIN` | same path, read-only | The `claude` binary that task containers mount. Default: the target of `~/.local/bin/claude`. |
| `AGENTFORGE_PSTACK_DIR` | same path, read-only | The pinned pstack plugin. AgentForge reads playbooks from it and task containers mount it. |
| `AGENTFORGE_CLAUDE_CREDENTIALS` | same path, read-only | The harness login. Copied into a task HOME for one run, then removed. Not mounted when `CLAUDE_CODE_OAUTH_TOKEN` is set and the file is absent. |
| `CLAUDE_CODE_OAUTH_TOKEN` | environment, by name | The harness login, preferred over the file. |
| the instance's GitHub token | `GH_TOKEN`, by name | Intake comments, `git push` and `gh pr create`. Only AgentForge holds it. Task containers never get it. See [GitHub token](#github-token). |
| `tools/gh-<ver>/gh` | `/usr/local/bin/gh`, read-only | A static `gh`. A host `gh` from Homebrew needs the Homebrew loader, which the image lacks. |

`git push` uses `gh auth git-credential` as its credential helper, set through `GIT_CONFIG_*` variables. Secrets reach the container by name (`-e GH_TOKEN`), so they never appear in the host process list. `docker inspect` still shows them to anyone who can reach the Docker socket.

## GitHub token

The instance uses its own GitHub token, never the operator's `gh auth token`. An operator login usually carries admin scopes such as `delete_repo`, and with it every agent PR looks like the operator opened it.

`start` reads the token from `AGENTFORGE_GH_TOKEN`, or else from `config/gh-token`. The file must not be readable by group or others (mode 600). With neither, `start` stops and prints the steps below, with the intake repos filled in.

Create a fine-grained personal access token at <https://github.com/settings/personal-access-tokens/new>:

1. Resource owner: the owner of the intake repos.
2. Repository access: Only select repositories, and pick each repo under `intake.repos`.
3. Repository permissions: Contents, Issues and Pull requests set to Read and write. Metadata is Read-only, and GitHub adds it. Leave every other permission at No access.

Then store it:

```bash
( umask 077; cat > ~/.agentforge-self/config/gh-token )   # paste the token, Enter, Ctrl-D
scripts/self-host.sh start
```

Before it replaces the container, `start` checks the token once. It logs the account the token acts as and whether the token is fine-grained, and for any other token it logs the token's scopes as a warning. It then reads `intake.repos` with the release's own config loader and checks `GET /repos/<repo>` for each one. It stops when the token does not authenticate or cannot reach an intake repo.

A task whose commits change `.github/workflows/` cannot be pushed, because the token has no Workflows permission. That is on purpose.

`AGENTFORGE_ALLOW_OPERATOR_TOKEN=1` makes `start` fall back to the host's `gh auth token` when no instance token exists. It logs a warning box, and the scope check lists every scope that token has. Use it only to get going, and replace it with a scoped token.

### How agent work shows up on GitHub

- Commits carry the author `agentforge <agentforge@localhost>` (`executor.git_author`).
- The PR body ends with `Opened by AgentForge for task <id>`.
- With a personal access token, GitHub still shows the PR as opened by the token's owner.

A GitHub App gives the instance a bot identity (`<app>[bot]`), so PRs no longer appear under a person's account, and its installation tokens expire after an hour. It needs a token-minting step that `self-host.sh` does not have yet. This is a later step.

## Network

The server binds `0.0.0.0` inside the container (`--host 0.0.0.0`), because a server bound to `127.0.0.1` inside a container is unreachable from the host (#248). Docker publishes the port on `127.0.0.1` of the host only. Set `AGENTFORGE_BIND` to change the host address. Turn on `server.auth` in the config before you expose the port on any other address.

## Environment variables

| Variable | Default | Use |
|---|---|---|
| `AGENTFORGE_HOME` | `~/.agentforge-self` | root of the layout above |
| `AGENTFORGE_REPO_URL` | `https://github.com/sinsonido/agentforge.git` | source of releases |
| `AGENTFORGE_NODE_IMAGE` | `node:24` | image for the build and the server |
| `AGENTFORGE_CONTAINER` | `agentforge-self` | container name |
| `AGENTFORGE_BIND` | `127.0.0.1` | host address of the published port |
| `AGENTFORGE_PORT` | `4343` | host port |
| `AGENTFORGE_DOCKER_SOCKET` | `/var/run/docker.sock` | see Executor mounts |
| `AGENTFORGE_STATE_DIR` | `$AGENTFORGE_HOME/state` | see Executor mounts |
| `AGENTFORGE_CLAUDE_BIN` | target of `~/.local/bin/claude` | see Executor mounts |
| `AGENTFORGE_PSTACK_DIR` | `~/.claude/plugins/cache/cursor-plugins/pstack/0.15.30` | see Executor mounts |
| `AGENTFORGE_CLAUDE_CREDENTIALS` | `~/.claude/.credentials.json` | see Executor mounts |
| `AGENTFORGE_GH_VERSION` | `2.62.0` | `gh` release downloaded into `tools/` |
| `AGENTFORGE_GH_TOKEN` | unset | the instance's GitHub token; else `config/gh-token` |
| `AGENTFORGE_ALLOW_OPERATOR_TOKEN` | unset | `1` falls back to the host's `gh auth token`, with a warning |

## The dogfood loop

1. Label an issue on `sinsonido/agentforge` with `agentforge`. Intake turns it into exactly one task and comments on the issue. The issue's `bug`, `enhancement` or `refactor` label picks the playbook.
2. The executor clones the repository for the task and runs the coding harness in its own `node:24` container. The agent commits, but it never pushes and holds no GitHub credentials.
3. AgentForge checks the evidence: commits ahead of the base branch, a clean tree, and the repository's `test_command` passing after the last edit. It then pushes `agentforge/<task>` and opens the PR, or ends `failed` with the reasons, or `cancelled` (aborted or timed out, never published). `docker logs agentforge-self` shows the harness stream as `[coding]` lines.
4. AgentForge watches the PR's CI (`ci-watch`). When it is red, a fix round runs a fresh harness on the PR branch and pushes the fix (`fixing`), up to `babysit.max_rounds`. When it is green, a fresh read-only run verifies the PR at its exact head (`verifying`), and only a passing verdict lets the merge wait for your approval in the task view. This repository's E2E check is known to fail (#180), so set `babysit.checks: required` here.
5. You review the PR and its verdict, then approve or reject the merge. The merge refuses a head that no passing verdict covers.
6. `scripts/self-host.sh upgrade <new-sha>` puts the merged change into the running instance.

Each `intake.repos[]` entry can set two commands. The task clone starts without dependencies, so the prompt tells the agent to run `setup_command` (default `npm ci`) before any test. `test_command` (default `npm test`) is the only test run the gate accepts. A single test file or a filtered run does not count, even when it passes.
