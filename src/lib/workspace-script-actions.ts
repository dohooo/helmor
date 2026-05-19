export type WorkspaceScriptType = "setup" | "run" | "archive";

export const WORKSPACE_SCRIPT_PROMPTS: Record<WorkspaceScriptType, string> = {
	setup: `Please help me initialize the Helmor setup script for this workspace and write the final result into the current workspace's helmor.json.

Context:
- This setup script runs automatically right after a new workspace is created.
- Its job is to prepare this worktree so I can start working.
- It should be used for dependency install, bootstrap, codegen, hooks setup, or filling in local config that the new worktree is missing.
- It should not start a dev server, enter watch mode, or become a long-running process.

Rules:
1. Inspect the repository first before asking questions.
2. Your goal is to actually create or update scripts.setup in helmor.json, not just give advice.
3. This is a worktree-based workspace. Use the environment variables correctly:
   - HELMOR_ROOT_PATH: the original repository root, not this workspace worktree path.
   - HELMOR_WORKSPACE_PATH: the current workspace's worktree path, and the directory where the script runs.
   - HELMOR_WORKSPACE_NAME: the current workspace name.
   - HELMOR_DEFAULT_BRANCH: the repository default branch.
   - HELMOR_PORT: the first port in this workspace's stable, non-overlapping port range.
   - HELMOR_PORT_COUNT: how many ports are reserved starting at HELMOR_PORT.
4. Migration from conductor.json:
   - If helmor.json does not exist but conductor.json exists, copy conductor.json to helmor.json.
   - Rename every CONDUCTOR_* environment variable reference in helmor.json to its Helmor equivalent. Cover both $VAR and \${VAR} forms. Do this whether helmor.json was just copied or an earlier incomplete migration left stale references:
     - CONDUCTOR_WORKSPACE_NAME → HELMOR_WORKSPACE_NAME
     - CONDUCTOR_WORKSPACE_PATH → HELMOR_WORKSPACE_PATH
     - CONDUCTOR_ROOT_PATH → HELMOR_ROOT_PATH
     - CONDUCTOR_DEFAULT_BRANCH → HELMOR_DEFAULT_BRANCH
     - CONDUCTOR_PORT → HELMOR_PORT
   - After this step, only work on helmor.json.
5. If the migrated helmor.json already contains scripts.setup, stop and tell me the migration is complete.
6. Keep setup minimal and idempotent.
7. Do not hardcode absolute local paths.
8. Ask at most 3 rounds of questions, and only when they materially change the script design.

What to inspect:
- helmor.json, conductor.json
- README and developer docs
- package.json, lockfiles, workspace config, Cargo.toml, pyproject.toml, go.mod, Gemfile
- Makefile, justfile
- .env*, .env.example, .env.local*
- .gitignore
- git status --short --ignored

Pay special attention to ignored or untracked local files that a fresh worktree may be missing. If some of them are likely required, identify them clearly before deciding whether setup should copy them from HELMOR_ROOT_PATH into HELMOR_WORKSPACE_PATH.

Your flow:
1. Inspect silently first.
2. Tell me:
   - where you plan to write the setup script
   - what command(s) you plan to use
   - why
   - which local files look like likely migration candidates
3. Only ask concise blocking questions if needed.
4. Then create or update helmor.json.
5. End with a short summary:
   - which file you changed
   - the final scripts.setup
   - any local files that still need confirmation
   - your key assumptions`,
	run: `Please help me initialize the Helmor run script for this workspace and write the final result into the current workspace's helmor.json.

Context:
- This run script executes when I press Cmd+R.
- Its job is to give this workspace a practical default command for daily work.
- There may not be a single obvious answer, so you should inspect first and then let me choose from the best candidates.

Rules:
1. Inspect the repository first before asking questions.
2. Your goal is to actually create or update scripts.run in helmor.json, not just give advice.
3. This is a worktree-based workspace. Use the environment variables correctly:
   - HELMOR_ROOT_PATH: the original repository root.
   - HELMOR_WORKSPACE_PATH: the current workspace's worktree path, and the directory where the script runs.
   - HELMOR_WORKSPACE_NAME: the current workspace name.
   - HELMOR_DEFAULT_BRANCH: the repository default branch.
   - HELMOR_PORT: the first port in this workspace's stable, non-overlapping port range.
   - HELMOR_PORT_COUNT: how many ports are reserved starting at HELMOR_PORT.
4. Migration from conductor.json:
   - If helmor.json does not exist but conductor.json exists, copy conductor.json to helmor.json.
   - Rename every CONDUCTOR_* environment variable reference in helmor.json to its Helmor equivalent. Cover both $VAR and \${VAR} forms. Do this whether helmor.json was just copied or an earlier incomplete migration left stale references:
     - CONDUCTOR_WORKSPACE_NAME → HELMOR_WORKSPACE_NAME
     - CONDUCTOR_WORKSPACE_PATH → HELMOR_WORKSPACE_PATH
     - CONDUCTOR_ROOT_PATH → HELMOR_ROOT_PATH
     - CONDUCTOR_DEFAULT_BRANCH → HELMOR_DEFAULT_BRANCH
     - CONDUCTOR_PORT → HELMOR_PORT
   - After this step, only work on helmor.json.
5. If the migrated helmor.json already contains scripts.run, stop and tell me the migration is complete.
6. Do not overfit this run script to the current task, a single test file, or a one-off command.
7. Do not quietly choose a heavy, destructive, or highly opinionated command when multiple reasonable defaults exist.
8. For dev servers or local services, prefer HELMOR_PORT over hardcoded defaults so parallel workspaces do not collide. If the project needs multiple ports, use the range from HELMOR_PORT through HELMOR_PORT + HELMOR_PORT_COUNT - 1.
9. Ask at most 3 rounds of questions, and only when they materially change the choice.

What to inspect:
- helmor.json, conductor.json
- README and developer docs
- package.json, workspace config, Cargo.toml
- Makefile, justfile
- docker-compose files
- existing dev / start / test / serve / worker commands

Your flow:
1. Inspect silently first.
2. Find the best 2 to 5 run candidates.
3. Show me the candidates in a concise list. For each one, explain:
   - what it likely does
   - who or what workflow it suits
   - why it could be a good Cmd+R default
4. Give me your recommended default.
5. Ask me to choose, ideally so I can answer with A / B / C.
6. After I choose, create or update helmor.json.
7. End with a short summary:
   - which file you changed
   - the final scripts.run
   - why it fits Cmd+R
   - how I can switch to another candidate later`,
	archive: `Please help me initialize the Helmor archive script for this workspace and write the final result into the current workspace's helmor.json.

Context:
- This archive script runs when this workspace is archived.
- Its job is to do light, safe, clearly-scoped cleanup or save a small amount of context before archive.
- It should not perform dangerous deletion or take over workspace lifecycle management.

Rules:
1. Inspect the repository and workspace context first before asking questions.
2. Your goal is to actually create or update scripts.archive in helmor.json, not just give advice.
3. This is a worktree-based workspace. Use the environment variables correctly:
   - HELMOR_ROOT_PATH: the original repository root.
   - HELMOR_WORKSPACE_PATH: the current workspace's worktree path, and the directory where the script runs.
   - HELMOR_WORKSPACE_NAME: the current workspace name.
   - HELMOR_DEFAULT_BRANCH: the repository default branch.
   - HELMOR_PORT: the first port in this workspace's stable, non-overlapping port range.
   - HELMOR_PORT_COUNT: how many ports are reserved starting at HELMOR_PORT.
4. Migration from conductor.json:
   - If helmor.json does not exist but conductor.json exists, copy conductor.json to helmor.json.
   - Rename every CONDUCTOR_* environment variable reference in helmor.json to its Helmor equivalent. Cover both $VAR and \${VAR} forms. Do this whether helmor.json was just copied or an earlier incomplete migration left stale references:
     - CONDUCTOR_WORKSPACE_NAME → HELMOR_WORKSPACE_NAME
     - CONDUCTOR_WORKSPACE_PATH → HELMOR_WORKSPACE_PATH
     - CONDUCTOR_ROOT_PATH → HELMOR_ROOT_PATH
     - CONDUCTOR_DEFAULT_BRANCH → HELMOR_DEFAULT_BRANCH
     - CONDUCTOR_PORT → HELMOR_PORT
   - After this step, only work on helmor.json.
5. If the migrated helmor.json already contains scripts.archive, stop and tell me the migration is complete.
6. Default to conservative behavior.
7. Ask at most 3 rounds of questions, and only when they materially change the script design.
8. Without my explicit confirmation, do not write any destructive action such as deleting databases, volumes, caches, build outputs, secrets, logs, screenshots, files outside the workspace, remote resources, or broad rm -rf / git clean behavior.

What to inspect:
- helmor.json, conductor.json
- README and developer docs
- package.json, Cargo.toml
- Makefile, justfile
- docker-compose files
- .env*
- .gitignore
- anything suggesting local services, containers, exports, or archive context

Your flow:
1. Inspect silently first.
2. Tell me:
   - where you plan to write the archive script
   - which candidate archive actions you found
   - which ones are safe by default
   - which ones need confirmation
   - which ones are too risky to write by default
3. Only ask concise blocking questions if needed.
4. Then create or update helmor.json.
5. End with a short summary:
   - which file you changed
   - the final scripts.archive
   - which higher-risk actions you intentionally left out
   - your key assumptions

If this project does not appear to need an automated archive script, say so clearly and choose the smallest safe result instead of inventing risky behavior.`,
};
