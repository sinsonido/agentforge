# Self-hosting

AgentForge edits its own repository. The instance that does the work must not run from the tree it edits, or a task could change the code under the running process. `scripts/self-host.sh` runs AgentForge from an immutable release directory, built from a tag or SHA of `sinsonido/agentforge`, in a Docker container.

Requirements on the host: `bash`, `git`, `curl`, Docker, `gh` logged in to GitHub, the `claude` binary with a login, and the pinned pstack plugin. Node is not needed. The build and the server run in the `node:24` image.

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
- `start` does nothing when the container already runs the `current` SHA. Otherwise it replaces the container. It returns after `/api/status` answers, or fails with the `docker logs` command to run.
- `upgrade` to the SHA that is already running does not restart anything.
- `stop` does nothing when no container exists.

`stop` sends `SIGINT`, so AgentForge closes its database before it exits. Tasks that were executing come back as failed (interrupted) on the next boot, because the queue is persisted in SQLite (#240).

## Layout

Everything lives under `AGENTFORGE_HOME`, default `~/.agentforge-self`:

```
repo.git/          bare clone, the export source for releases
releases/<sha>/    source from git archive, node_modules, ui/dist
current            symlink to releases/<sha>
data/              agentforge.db (the container's working directory)
config/            agentforge.yml
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
| `gh auth token` of the host | `GH_TOKEN`, by name | Intake comments, `git push` and `gh pr create`. Only AgentForge holds it. Task containers never get it. |
| `tools/gh-<ver>/gh` | `/usr/local/bin/gh`, read-only | A static `gh`. A host `gh` from Homebrew needs the Homebrew loader, which the image lacks. |

`git push` uses `gh auth git-credential` as its credential helper, set through `GIT_CONFIG_*` variables. Secrets reach the container by name (`-e GH_TOKEN`), so they never appear in the host process list. `docker inspect` still shows them to anyone who can reach the Docker socket.

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

## The dogfood loop

1. Label an issue on `sinsonido/agentforge` with `agentforge`. Intake turns it into exactly one task and comments on the issue. The issue's `bug`, `enhancement` or `refactor` label picks the playbook.
2. The executor clones the repository for the task and runs the coding harness in its own `node:24` container. The agent commits, but it never pushes and holds no GitHub credentials.
3. AgentForge checks the evidence: commits ahead of the base branch, a clean tree, and a passing test run after the last edit. It then pushes `agentforge/<task>` and opens the PR. The task ends `pr-opened` with its `pr_url`, or `failed` with the reasons, or `cancelled` (aborted or timed out, never published). `docker logs agentforge-self` shows the harness stream as `[coding]` lines.
4. You review and merge the PR.
5. `scripts/self-host.sh upgrade <new-sha>` puts the merged change into the running instance.
