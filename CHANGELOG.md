# Changelog

## 0.19.1

### Patch Changes

- [#425](https://github.com/dohooo/helmor/pull/425) [`e8674cf`](https://github.com/dohooo/helmor/commit/e8674cf30ef241e0a4a09336f1fa355db06c7e63) Thanks [@natllian](https://github.com/natllian)! - Fix a multi-second UI freeze when starting a new task from the start page.

- [#428](https://github.com/dohooo/helmor/pull/428) [`b6f2e95`](https://github.com/dohooo/helmor/commit/b6f2e95c02bdb1b1508e3f0b202befd1403b950b) Thanks [@natllian](https://github.com/natllian)! - Stop capping Claude session-title generation at one turn so titles no longer fail with `Reached maximum number of turns (1)`.

- [#428](https://github.com/dohooo/helmor/pull/428) [`b6f2e95`](https://github.com/dohooo/helmor/commit/b6f2e95c02bdb1b1508e3f0b202befd1403b950b) Thanks [@natllian](https://github.com/natllian)! - Speed up Codex session title and branch-name generation by using a smaller model and skipping reasoning.

- [#424](https://github.com/dohooo/helmor/pull/424) [`d828bde`](https://github.com/dohooo/helmor/commit/d828bde801ffee80bb2f1bd823a10f3f24898d41) Thanks [@natllian](https://github.com/natllian)! - Fix two related issues in long chat sessions:

  - Stop the empty space below the last message from growing as thinking blocks pile up.
  - Make finished thinking blocks fold up even when you switch away and come back.

- [#417](https://github.com/dohooo/helmor/pull/417) [`53ff1e4`](https://github.com/dohooo/helmor/commit/53ff1e43cffaea73505cbe46c63d88aab864b0aa) Thanks [@dohooo](https://github.com/dohooo)! - Make automatic session title and branch-name generation lighter so new chats spend less time preparing a rename.

- [#431](https://github.com/dohooo/helmor/pull/431) [`7643e9e`](https://github.com/dohooo/helmor/commit/7643e9e48be66a55f9579b8091f2df71f8a94d8c) Thanks [@natllian](https://github.com/natllian)! - Fix two issues with workspace working-directory handling:

  - Stop the first message in a newly-created workspace from running with the wrong directory, which caused the second turn to fail with "The provider returned an empty response."
  - Refuse to start an agent turn when the working directory is missing, instead of silently falling back to the app's process cwd.

- [#421](https://github.com/dohooo/helmor/pull/421) [`55b0a9e`](https://github.com/dohooo/helmor/commit/55b0a9ec26f6ab686545add217cb9a6d6a75cd11) Thanks [@natllian](https://github.com/natllian)! - Fix Settings → PR/MR (and Review) effort: it now actually applies to the new session, and is disabled for models that don't support effort levels (e.g. Haiku).

- [#430](https://github.com/dohooo/helmor/pull/430) [`c85a6cb`](https://github.com/dohooo/helmor/commit/c85a6cb7a766c776cd5710fc2b9504982847d642) Thanks [@natllian](https://github.com/natllian)! - Fix the sidebar bouncing a workspace back to in-review after you merge it: the optimistic move to Done now stays put while the merge round-trip is in flight, even if you switch to another workspace before it finishes.

- [#429](https://github.com/dohooo/helmor/pull/429) [`7fb0116`](https://github.com/dohooo/helmor/commit/7fb0116fc23c37e124d232e940bed4773009c047) Thanks [@natllian](https://github.com/natllian)! - Make cold starts noticeably faster and reduce in-session pauses by shrinking the on-disk cache Helmor reads at launch and rewrites as you work.

- [#427](https://github.com/dohooo/helmor/pull/427) [`2909b4a`](https://github.com/dohooo/helmor/commit/2909b4a236a672ab9345f1e309ded6cfaefff055) Thanks [@natllian](https://github.com/natllian)! - Make sidebar workspace rows feel responsive when sweeping the cursor across a long list — hover highlights and the row action buttons no longer stutter behind the cursor.

## 0.19.0

### Minor Changes

- [#415](https://github.com/dohooo/helmor/pull/415) [`da05eaf`](https://github.com/dohooo/helmor/commit/da05eaff012d9bce14f84726df8f96ed961fcadc) Thanks [@natllian](https://github.com/natllian)! - Two workspace-creation and PR/MR helper improvements:
  - Fix `/add-dir` on the Start page so "Browse folder…" actually opens the directory picker, and apply the picks to the workspace it creates.
  - Add a dedicated model / effort / fast-mode selector for the inspector's Create PR/MR action, so PR / MR generation can use a different setup than the default agent turn.

### Patch Changes

- [#416](https://github.com/dohooo/helmor/pull/416) [`d50177c`](https://github.com/dohooo/helmor/commit/d50177c653c59fed5c86e5b2edb97bd93cfb18cd) Thanks [@natllian](https://github.com/natllian)! - Fix three pause-for-user-input bugs:

  - Claude `AskUserQuestion` answers now reach Claude reliably instead of intermittently failing with an API error or empty user turn.
  - Codex MCP elicitation forms now surface in Bypass Permissions mode instead of being auto-declined.
  - Claude now sees project-scope MCP servers registered for your repo in `~/.claude.json`.

- [#415](https://github.com/dohooo/helmor/pull/415) [`da05eaf`](https://github.com/dohooo/helmor/commit/da05eaff012d9bce14f84726df8f96ed961fcadc) Thanks [@natllian](https://github.com/natllian)! - Two `/add-dir` fixes:

  - Claude turns no longer fail with `Not logged in / Authentication failed` after linking extra directories.
  - The Start page's `/add-dir` popup now lists candidate workspaces, matching the in-workspace behavior instead of only offering "Browse folder…".

- [#413](https://github.com/dohooo/helmor/pull/413) [`47d0dab`](https://github.com/dohooo/helmor/commit/47d0dab90915bbf74dda16bb982f09b9254c6942) Thanks [@natllian](https://github.com/natllian)! - Carry the Start page composer picks (model, effort, plan mode, fast mode) into the new workspace so Start Now and Save for Later no longer fall back to defaults.

- [#411](https://github.com/dohooo/helmor/pull/411) [`dcf009e`](https://github.com/dohooo/helmor/commit/dcf009ef17d3e72d65a54979469ce4ad70d1462b) Thanks [@natllian](https://github.com/natllian)! - Fix account avatars so they fall back to initials instead of going blank, and stop them flickering on workspace switches.

## 0.18.0

### Minor Changes

- [#401](https://github.com/dohooo/helmor/pull/401) [`a3d91f0`](https://github.com/dohooo/helmor/commit/a3d91f0bed7f47dc2c4bf6b5546d00ce6852e942) Thanks [@natllian](https://github.com/natllian)! - Render Markdown files in the in-app editor with a Source/Preview toggle, so AI-generated specs and other `.md` files can be reviewed as formatted documents instead of raw source.

- [#406](https://github.com/dohooo/helmor/pull/406) [`1cfef47`](https://github.com/dohooo/helmor/commit/1cfef47f1f22bda6b4a465f37564e0e8d6839a6b) Thanks [@natllian](https://github.com/natllian)! - Smooth out the add-repo and forge connect flows:

  - Adding a repository now lands on the start page with the new repo selected, instead of auto-creating a workspace.
  - Fix the GitHub / GitLab "Connect" button staying stuck after sign-in for accounts whose token can read the repo but doesn't expose membership in the API response.

- [#405](https://github.com/dohooo/helmor/pull/405) [`7324592`](https://github.com/dohooo/helmor/commit/73245921a48ffada4c9490a3776810be3ee5224b) Thanks [@dohooo](https://github.com/dohooo)! - Add an export-as-image button to the chat panel header that opens a snapshot of the full session with a one-click copy-to-clipboard.

### Patch Changes

- [#394](https://github.com/dohooo/helmor/pull/394) [`b84b070`](https://github.com/dohooo/helmor/commit/b84b0705e842eb91668510e8fadc959e7725c0bb) Thanks [@daniel-mf28](https://github.com/daniel-mf28)! - Fix dragging the empty area of the workspace panel header.

- [#404](https://github.com/dohooo/helmor/pull/404) [`4df8fcd`](https://github.com/dohooo/helmor/commit/4df8fcd77d8a20263c4ba33a2ba10481cb9e7fce) Thanks [@aidxun](https://github.com/aidxun)! - Fix the right inspector sidebar so its panels no longer animate from an initial zero-height state when Helmor first renders or switches back from the Context panel.

- [#407](https://github.com/dohooo/helmor/pull/407) [`a8c7d46`](https://github.com/dohooo/helmor/commit/a8c7d467c873cbae98a09fa985da6ee5e6f2e863) Thanks [@natllian](https://github.com/natllian)! - Fix Claude threads occasionally returning an empty response mid-conversation and losing context on retry.

## 0.17.1

### Patch Changes

- [#388](https://github.com/dohooo/helmor/pull/388) [`3fa1e6e`](https://github.com/dohooo/helmor/commit/3fa1e6e5d217d559f3499bf84e81273e3e6902d6) Thanks [@alantoa](https://github.com/alantoa)! - Fix the chat-view table "Download as CSV / Markdown" buttons doing nothing — the download now goes through a native Save dialog and writes the file via the Tauri host, since the webview was silently swallowing streamdown's built-in `<a download>` click.

- [#400](https://github.com/dohooo/helmor/pull/400) [`212fe13`](https://github.com/dohooo/helmor/commit/212fe13f691a329bc84e10a145b9881acfbd9f5e) Thanks [@dohooo](https://github.com/dohooo)! - Fix model switching on the new workspace welcome page so the selected model stays applied before the workspace and session are created.

- [#400](https://github.com/dohooo/helmor/pull/400) [`212fe13`](https://github.com/dohooo/helmor/commit/212fe13f691a329bc84e10a145b9881acfbd9f5e) Thanks [@dohooo](https://github.com/dohooo)! - Keep context previews clear of the macOS window controls when the left workspace sidebar is collapsed.

- [#399](https://github.com/dohooo/helmor/pull/399) [`7db9114`](https://github.com/dohooo/helmor/commit/7db911406dd9c6c5fa725dd651f9c64d66294b73) Thanks [@natllian](https://github.com/natllian)! - Fix a few rough edges:

  - Custom workspace branch prefixes no longer auto-append a trailing `/`; the prefix you set is the prefix used.
  - Codex sub-agents now render with their real nickname throughout (spawn, wait, etc.) instead of switching names partway through, and no longer flash a no-name "Sub-agent" placeholder while spawning.

- [#389](https://github.com/dohooo/helmor/pull/389) [`c3d0e7f`](https://github.com/dohooo/helmor/commit/c3d0e7fe1bf4bef8651197d5853536c3a893e3ee) Thanks [@alantoa](https://github.com/alantoa)! - Let workspaces opt out of icon auto-detection by committing a `.helmor/icon.svg` (or `.png`) — useful for monorepos where the existing heuristics pick the wrong sub-app's favicon, or none at all. Edits to the icon file are now also picked up without restarting the app, since the in-process icon cache is keyed on the file's mtime instead of being permanent.

- [#400](https://github.com/dohooo/helmor/pull/400) [`212fe13`](https://github.com/dohooo/helmor/commit/212fe13f691a329bc84e10a145b9881acfbd9f5e) Thanks [@dohooo](https://github.com/dohooo)! - Load project slash commands on the start page once a repository is picked, so the `/` popup is populated before the first workspace exists.

- [#400](https://github.com/dohooo/helmor/pull/400) [`212fe13`](https://github.com/dohooo/helmor/commit/212fe13f691a329bc84e10a145b9881acfbd9f5e) Thanks [@dohooo](https://github.com/dohooo)! - Keep workspace and session loading indicators, stop controls, and quit warnings in sync while agent tasks are running or waiting for workspace setup to finish.

- [#400](https://github.com/dohooo/helmor/pull/400) [`212fe13`](https://github.com/dohooo/helmor/commit/212fe13f691a329bc84e10a145b9881acfbd9f5e) Thanks [@dohooo](https://github.com/dohooo)! - Keep the inspector terminal hover preview above the rest of the workspace UI so the expanded terminal is no longer covered by the composer or side panels.

- [#400](https://github.com/dohooo/helmor/pull/400) [`212fe13`](https://github.com/dohooo/helmor/commit/212fe13f691a329bc84e10a145b9881acfbd9f5e) Thanks [@dohooo](https://github.com/dohooo)! - Fix Claude threads getting permanently stuck in the sending state after a sidecar crash or rapid-fire retries.

## 0.17.0

### Minor Changes

- [#367](https://github.com/dohooo/helmor/pull/367) [`359d678`](https://github.com/dohooo/helmor/commit/359d678e57d8d2914b26628154fdaf7ba3f08ebf) Thanks [@dohooo](https://github.com/dohooo)! - Ship the GitHub inbox, redesigned workspace start page, and Local workspaces:
  - Add a GitHub inbox that lists real issues, pull requests, and discussions per linked account, with sub-tab toggles, search and label filters, per-repo scoping, and detail previews you can drop straight into the composer.
  - Redesign the workspace start page around a context sidebar that exposes the inbox and source-detail previews next to a mode picker, branch picker, and Create-and-checkout-new-branch dialog whose checkout is deferred until you submit.
  - Add Local workspace mode — the agent operates directly on your source repo without a worktree — plus a right-click "Move into a new worktree" flow that relocates a Local workspace into its own worktree without touching the source repo.
  - Fix a sidecar zombie-process bug where a closed parent pipe blocked auto title generation and branch rename after the first message.

### Patch Changes

- [#367](https://github.com/dohooo/helmor/pull/367) [`359d678`](https://github.com/dohooo/helmor/commit/359d678e57d8d2914b26628154fdaf7ba3f08ebf) Thanks [@dohooo](https://github.com/dohooo)! - Poll for the new login after the GitHub/GitLab connect dialog closes so a brief flush delay between `gh auth login` finishing and writing its config no longer leaves the Connect button stuck in the unconnected state.

## 0.16.0

### Minor Changes

- [#387](https://github.com/dohooo/helmor/pull/387) [`9ea7823`](https://github.com/dohooo/helmor/commit/9ea7823a3b896a75d7ef96454e5540c5403d9953) Thanks [@natllian](https://github.com/natllian)! - Render Codex multi-agent (sub-agent spawn / wait) messages with a "Spawned N agents" group header, per-agent color-coded identities, and click-to-expand instructions — previously these events were silently dropped.

### Patch Changes

- [#385](https://github.com/dohooo/helmor/pull/385) [`d18414f`](https://github.com/dohooo/helmor/commit/d18414f06c60766f81f6dd490890795acc941875) Thanks [@natllian](https://github.com/natllian)! - Render image and file attachments in queued follow-up messages as hover-preview chips, matching how they appear in the composer and sent chat bubbles instead of showing the raw `@/path/...` text.

## 0.15.0

### Minor Changes

- [#381](https://github.com/dohooo/helmor/pull/381) [`db3ea68`](https://github.com/dohooo/helmor/commit/db3ea68909e649be50433cb2b1b2587485abd699) Thanks [@alantoa](https://github.com/alantoa)! - Right-click a file in the inspector's Changes section to reveal it in Finder, copy its absolute path, copy its relative path, or copy its remote file URL on GitHub/GitLab/Bitbucket.

### Patch Changes

- [#384](https://github.com/dohooo/helmor/pull/384) [`1b99be2`](https://github.com/dohooo/helmor/commit/1b99be2d3521866393687c14256a420a7af5fff4) Thanks [@natllian](https://github.com/natllian)! - Fix `/goal` silently failing when Codex's experimental goals feature is disabled.

## 0.14.3

### Patch Changes

- [#372](https://github.com/dohooo/helmor/pull/372) [`2e345c5`](https://github.com/dohooo/helmor/commit/2e345c514cc8191aa976e7d9441de2d744a642f7) Thanks [@habibyuri](https://github.com/habibyuri)! - Fix workspace header branch renames so spaces are converted to hyphens and invalid branch names show the underlying Git error.

- [#375](https://github.com/dohooo/helmor/pull/375) [`be4dc73`](https://github.com/dohooo/helmor/commit/be4dc735bd5ec26810d8087ba3a4fb1320007c02) Thanks [@natllian](https://github.com/natllian)! - Show a clear "Local-only repositories are not supported." message when adding a Git repository that has no remote configured.

- [#374](https://github.com/dohooo/helmor/pull/374) [`2733f60`](https://github.com/dohooo/helmor/commit/2733f6034fb04da811a54dd9b2ca967469c887c4) Thanks [@natllian](https://github.com/natllian)! - Fix a dev-mode EACCES crash on first sidecar spawn when the upstream Claude Code wrapper's postinstall stub wasn't replaced (Nix sandbox, multi-worktree setups, `--ignore-scripts` installs); release builds were unaffected.

## 0.14.2

### Patch Changes

- [#365](https://github.com/dohooo/helmor/pull/365) [`4af2902`](https://github.com/dohooo/helmor/commit/4af29024ec1d8801e43de2fe6bd72c6dd7a6bb16) Thanks [@natllian](https://github.com/natllian)! - Show a green checkmark next to the currently selected model in the Settings default-model and review-model pickers, so the active choice is obvious even when the model name is truncated.

- [#370](https://github.com/dohooo/helmor/pull/370) [`768174e`](https://github.com/dohooo/helmor/commit/768174ea636d1c350533cdded20851433bc3bfde) Thanks [@natllian](https://github.com/natllian)! - Tighten up the workspace archive flow:

  - Fix archive failing with "Directory not empty" when archiving a workspace that was just restored in the same session, by giving each trash directory a unique name instead of reusing the process-id suffix.
  - Offer "Permanently Delete" as a recovery action whenever archive fails, matching the restore-failure behavior, so a stuck cleanup never leaves the workspace unremovable until app restart.

- [#363](https://github.com/dohooo/helmor/pull/363) [`119fc35`](https://github.com/dohooo/helmor/commit/119fc358718a0a227d098bff34f578158c351245) Thanks [@aidxun](https://github.com/aidxun)! - Keep existing GitHub pull requests and GitLab merge requests linked after a local branch rename by resolving the change-request status from the branch's upstream ref.

- [#369](https://github.com/dohooo/helmor/pull/369) [`681212d`](https://github.com/dohooo/helmor/commit/681212d232bd9c256203e97e5fe701603985af3b) Thanks [@natllian](https://github.com/natllian)! - Rebalance the right inspector sidebar so the Changes/diff section sits at a sensible default height and toggling Actions or the scripts panel animates smoothly without the bottom strip briefly jumping out of place.

## 0.14.1

### Patch Changes

- [#356](https://github.com/dohooo/helmor/pull/356) [`f6062d8`](https://github.com/dohooo/helmor/commit/f6062d8f60da9c0eef737f0079d2b477ddedda6a) Thanks [@natllian](https://github.com/natllian)! - Bump bundled agent CLIs and add Codex `/goal` support:

  - Bump Claude Code from 2.1.111 to 2.1.126 and switch to its new platform-native binary distribution.
  - Bump Codex from 0.124.0 to 0.128.0.
  - Add a Codex `/goal` slash command (set, pause, resume, clear, optional `--tokens` budget) that drives the new `thread/goal/*` JSON-RPC API, plus a thread-header banner showing the active goal's status and token usage.

- [#360](https://github.com/dohooo/helmor/pull/360) [`83138a3`](https://github.com/dohooo/helmor/commit/83138a34fcd1dc26c5717c3dc4ac0422abd8723a) Thanks [@aidxun](https://github.com/aidxun)! - Fix the right inspector sidebar so Actions and Terminal resize, collapse, and expand cleanly without losing their headers or leaving visual gaps.

- [#362](https://github.com/dohooo/helmor/pull/362) [`0355c77`](https://github.com/dohooo/helmor/commit/0355c77841092c287bccfa8a7e91fef487039000) Thanks [@natllian](https://github.com/natllian)! - Quiet down the inspector's commit button in non-actionable PR states — while mergeability is still being computed and after a PR is merged or closed — so they all share a muted ghost look instead of a faded-out solid CTA.

## 0.14.0

### Minor Changes

- [#326](https://github.com/dohooo/helmor/pull/326) [`f28eb7f`](https://github.com/dohooo/helmor/commit/f28eb7f134b8bb33c23b433e0a92cc57241ee53e) Thanks [@lucasbastianik](https://github.com/lucasbastianik)! - Replace the PR-only "Review PR" header button with a general "Review changes" helper in the inspector — appears whenever the workspace has uncommitted changes or local commits ahead of the target branch (works before the first push), and Review now has its own model, effort level, and fast-mode controls in Settings (each falls back to the default when unset).

### Patch Changes

- [#347](https://github.com/dohooo/helmor/pull/347) [`3304785`](https://github.com/dohooo/helmor/commit/3304785a2451d4ee2b47b962d395e664bb32e56c) Thanks [@MartinRybergLaude](https://github.com/MartinRybergLaude)! - Add a per-repo Exclusive toggle on the run script that makes starting a new run stop any other live run in the same repository first — useful when the script binds a fixed port.

- [#355](https://github.com/dohooo/helmor/pull/355) [`95e4b89`](https://github.com/dohooo/helmor/commit/95e4b8940aa7e32015fbf5001a8fc809e60cc38b) Thanks [@aidxun](https://github.com/aidxun)! - Fix GitHub connection state so workspaces stop showing Connect GitHub after a successful authorization or restart.

- [#354](https://github.com/dohooo/helmor/pull/354) [`9ca6136`](https://github.com/dohooo/helmor/commit/9ca6136176d1fa10f1701080a0d75bd47647885a) Thanks [@habibyuri](https://github.com/habibyuri)! - Fix Codex sessions so the stream ends cleanly instead of hanging when the app-server exits during an active turn.

## 0.13.1

### Patch Changes

- [#316](https://github.com/dohooo/helmor/pull/316) [`1e1bc30`](https://github.com/dohooo/helmor/commit/1e1bc303fdc9628702378e2ebcdc30f9d84de6ab) Thanks [@davidparys](https://github.com/davidparys)! - Add a Color Theme picker in Settings with four accent palettes — Midnight, Forest, Ember, and Aurora — each tuned for both light and dark mode.

- [#351](https://github.com/dohooo/helmor/pull/351) [`6812cb8`](https://github.com/dohooo/helmor/commit/6812cb889000081827938e129572596601f1b803) Thanks [@habibyuri](https://github.com/habibyuri)! - Fix a UI sync subscription leak where unmounted components left stale Tauri Channel subscribers on the backend, slowly accumulating during long sessions and dev hot-reloads.

- [#352](https://github.com/dohooo/helmor/pull/352) [`8174a03`](https://github.com/dohooo/helmor/commit/8174a030ebdc958ada28dfda4f1d5a04ef588d4e) Thanks [@natllian](https://github.com/natllian)! - Small UI polish:
  - Auto-bind existing repos when you connect a GitHub or GitLab account during onboarding.
  - Show a spinner on the local-project onboarding card while a folder picker is open.
  - Cleaner selected-state ring on the color theme picker so it stays visible across themes.
  - Fix styling and behavior issues on the Terminal tab right-click menu.

## 0.13.0

### Minor Changes

- [#342](https://github.com/dohooo/helmor/pull/342) [`939eb0e`](https://github.com/dohooo/helmor/commit/939eb0e5079159f6de1cee82115163c79365911f) Thanks [@natllian](https://github.com/natllian)! - Replace the single GitHub OAuth identity with multi-account support across both forges:
  - Sign in with multiple GitHub and/or GitLab accounts at once via the bundled `gh` / `glab` CLIs; each repository automatically binds to whichever account has access.
  - Remove the GitHub OAuth device-flow sign-in entirely.
  - Workspace branch chips display the bound account's avatar so it's clear which identity is acting on each workspace.
  - Connecting an account from the inspector or repo settings now opens an in-app terminal dialog instead of launching the system Terminal app.
  - Branch prefix moves out of the global Git settings and into each repository's Settings panel, so different repos can use different prefixes.

### Patch Changes

- [#291](https://github.com/dohooo/helmor/pull/291) [`a0015b6`](https://github.com/dohooo/helmor/commit/a0015b6daa7188c8dc73df29eacaeac2f39df2f3) Thanks [@habibyuri](https://github.com/habibyuri)! - Fix in-flight Codex turns being killed by transient upstream provider hiccups (e.g. Azure OpenAI mini-outages) — Helmor now surfaces a brief reconnecting notice and lets Codex's own retry loop recover instead of terminating the turn.

- [#307](https://github.com/dohooo/helmor/pull/307) [`0f9fe7a`](https://github.com/dohooo/helmor/commit/0f9fe7a478aa3994e31707c73007e3665c94d017) Thanks [@baptisteArno](https://github.com/baptisteArno)! - Fix file and image attachments whose absolute paths contain whitespace (a common case for macOS Finder drops like `Application Support/...` or CleanShot screenshots) — they now round-trip end-to-end without being truncated, and steer turns keep their image badges after a reload.

- [#348](https://github.com/dohooo/helmor/pull/348) [`eeeaa81`](https://github.com/dohooo/helmor/commit/eeeaa812eb71d30dc5a73eaaca4bbe7298390687) Thanks [@alantoa](https://github.com/alantoa)! - Fix the sidebar, inspector, and inspector section dividers starting a resize on right-click or middle-click — they now only respond to a primary (left) mouse button press.

- [#323](https://github.com/dohooo/helmor/pull/323) [`f953cc8`](https://github.com/dohooo/helmor/commit/f953cc895f6b48988b64d8e39b661e2afb6eb3a3) Thanks [@lucasbastianik](https://github.com/lucasbastianik)! - Hide "Open in Finder" on archived workspaces and show the real error message instead of "[object Object]" when opening Finder fails.

- [#306](https://github.com/dohooo/helmor/pull/306) [`c344573`](https://github.com/dohooo/helmor/commit/c344573be7459512e103608c30bb1aeb97c89f8a) Thanks [@baptisteArno](https://github.com/baptisteArno)! - Fix the Edit tool-call diff hover popover overflowing past the viewport when the badge sits near the bottom of the chat — it now flips above the trigger or shrinks to scroll within the available space.

- [#346](https://github.com/dohooo/helmor/pull/346) [`4f6ca7c`](https://github.com/dohooo/helmor/commit/4f6ca7cd17850017cb08c9c2567f95b6223de321) Thanks [@natllian](https://github.com/natllian)! - Fix PR / MR merge failing because the merge call wasn't telling the server which method to use, and surface the actual server reason in the toast instead of a generic "merge failed."

  - GitHub: query the repo's allowed merge methods and pass `mergeMethod` (MERGE → SQUASH → REBASE) instead of relying on GitHub's default — fixes "Merge commits are not allowed on this repository."
  - GitLab: read the project's `squash_option` and pass `squash=true` when it's `always` or `default_on` — fixes "Squash commits is required for this project."
  - Toast errors from any Tauri command now include the full anyhow chain (e.g. `mergePullRequest failed: gh api graphql failed: <real reason>`), not just the outermost `.context(...)` label.

- [#341](https://github.com/dohooo/helmor/pull/341) [`12e895c`](https://github.com/dohooo/helmor/commit/12e895ccb8ed71a7eb69b2aebeefa72b1647ea06) Thanks [@natllian](https://github.com/natllian)! - Pull now mechanically stashes uncommitted work, fast-forwards from the target branch, and re-applies the stash — instead of asking the agent to commit and push for you. Only an actual merge conflict (or a stash-pop conflict) hands off to the agent, with a narrower prompt that no longer prescribes commit/push.

- [#302](https://github.com/dohooo/helmor/pull/302) [`f97034c`](https://github.com/dohooo/helmor/commit/f97034c267a7fb2ff67d5a26aea9d09a1b3ebe9b) Thanks [@aidxun](https://github.com/aidxun)! - Fix Quit Helmor from the macOS app menu during onboarding so the app exits normally before the main workspace shell is loaded.

- [#337](https://github.com/dohooo/helmor/pull/337) [`f632d2b`](https://github.com/dohooo/helmor/commit/f632d2b59d124af47f64c0ac716e5a8170762edc) Thanks [@alantoa](https://github.com/alantoa)! - Right-click a terminal tab in the inspector to disable the hover-to-zoom enlargement or close the tab, and middle-click a terminal tab to close it.

- [#315](https://github.com/dohooo/helmor/pull/315) [`cdaaefa`](https://github.com/dohooo/helmor/commit/cdaaefa0c456e2ecd16edddb6f3127fa8536b02d) Thanks [@himanshhhhuv](https://github.com/himanshhhhuv)! - Fix terminal panel collapsing during text selection — the expanded terminal now stays open while selecting text, even when the cursor moves outside the container boundary.

## 0.12.2

### Patch Changes

- [#309](https://github.com/dohooo/helmor/pull/309) [`8a88fdb`](https://github.com/dohooo/helmor/commit/8a88fdbb32b798c9b6c3ceefd42e94d1afec7a58) Thanks [@natllian](https://github.com/natllian)! - Add DeepSeek as a built-in Claude Code custom provider with DeepSeek V4 Pro 1M and DeepSeek V4 Flash model options.

- [#312](https://github.com/dohooo/helmor/pull/312) [`ee123bd`](https://github.com/dohooo/helmor/commit/ee123bd01411e28dfd7a2e69988463b0826f7c34) Thanks [@natllian](https://github.com/natllian)! - Fix chat shortcuts (new session, close session, prev/next session) being misrouted to the terminal after clicking from the terminal into the chat column.

## 0.12.1

### Patch Changes

- [#299](https://github.com/dohooo/helmor/pull/299) [`7025e5a`](https://github.com/dohooo/helmor/commit/7025e5a003d49a0d6aeffa61f57e0fe9531beb5f) Thanks [@natllian](https://github.com/natllian)! - Fix the Intel macOS build shipping arm64 vendor binaries — `gh auth login`, `glab`, `codex`, and `bun` now match the bundle architecture instead of failing with "bad CPU type in executable".

- [#295](https://github.com/dohooo/helmor/pull/295) [`4029ca5`](https://github.com/dohooo/helmor/commit/4029ca58ea5d3aba13120068a9c706169ead981d) Thanks [@dohooo](https://github.com/dohooo)! - Adjust the macOS app icon spacing so Helmor appears at a normal size in Finder, Dock, and Launchpad.

- [#300](https://github.com/dohooo/helmor/pull/300) [`36b2fcf`](https://github.com/dohooo/helmor/commit/36b2fcff1b03051eaa071508df28179dd7c92e41) Thanks [@natllian](https://github.com/natllian)! - Polish the composer in two places:
  - Add a customizable ⌘Enter shortcut that sends one message with the opposite follow-up behavior (queue ↔ steer).
  - Drop the leading `$` from Codex credits in the context-usage ring.
  - Thanks to [@robinebers](https://x.com/robinebers) for the feedback that prompted both.

## 0.12.0

### Minor Changes

- [#288](https://github.com/dohooo/helmor/pull/288) [`0b97558`](https://github.com/dohooo/helmor/commit/0b97558370e3b5ddc01ab63bb5bb5b40580ca41d) Thanks [@natllian](https://github.com/natllian)! - Add Claude Code custom provider support:

  - Configure built-in third-party providers or a custom Claude-compatible endpoint from Settings with API key shortcuts.
  - Use configured third-party models alongside official Claude Code models in the composer and default model picker.
  - Prefer configured Claude-compatible models for automatic session title generation before falling back to official Claude and Codex.

- [#263](https://github.com/dohooo/helmor/pull/263) [`1fb7c6a`](https://github.com/dohooo/helmor/commit/1fb7c6ad8591b6cd6ac94f4f595cd6ec9e66eb59) Thanks [@aidxun](https://github.com/aidxun)! - Add repository-specific branch prefix overrides and clean up the repository settings layout:
  - Let each repository set a custom branch prefix, with empty values inheriting the global default.
  - Use the matching GitHub or GitLab account when Helmor generates provider-based branch prefixes for new workspaces.
  - Show repository settings as divided rows instead of separate cards for a cleaner settings panel.

## 0.11.4

### Patch Changes

- [#284](https://github.com/dohooo/helmor/pull/284) [`8e5b731`](https://github.com/dohooo/helmor/commit/8e5b731c5f1effd79bb548788c9627e8582425dc) Thanks [@natllian](https://github.com/natllian)! - Restore the Conductor migration path during onboarding and keep its import screen matched to the current app theme.

## 0.11.3

### Patch Changes

- [#282](https://github.com/dohooo/helmor/pull/282) [`9f2a514`](https://github.com/dohooo/helmor/commit/9f2a5149936bdf304db178537a9f3ff44d8f0970) Thanks [@natllian](https://github.com/natllian)! - Improve shortcut behavior:
  - Add an optional global hotkey that can show Helmor from anywhere and hide it when focused.
  - Let the Run / Stop script shortcut work app-wide.

## 0.11.2

### Patch Changes

- [#279](https://github.com/dohooo/helmor/pull/279) [`d1f68d5`](https://github.com/dohooo/helmor/commit/d1f68d522ce9fba4069274feb5d16f6071e4890e) Thanks [@natllian](https://github.com/natllian)! - Loosen up keyboard shortcuts and the inspector tabs panel:

  - Make global shortcuts (Cmd+R run script, sidebar/zen toggles, workspace navigation, commit/PR actions) fire from anywhere in the window instead of silently doing nothing when focus is in the file editor.
  - Cmd+T while looking at script output now opens a new terminal instead of a new chat session.
  - Any inspector tab — Setup, Run, a terminal tab, or the "+" button — now opens the tabs panel when clicked, and collapses it when you click the already-active tab.

- [#281](https://github.com/dohooo/helmor/pull/281) [`56a308c`](https://github.com/dohooo/helmor/commit/56a308cd90f56217432ed86a55bc1003166b3179) Thanks [@natllian](https://github.com/natllian)! - A round of CLI auth and UI polish:
  - Pin Settings → Account CLI rows to a fixed height so they stop jumping between Connect / Ready / Error.
  - Edge-detect forge `Unauthenticated` in the backend so the 60s poll stops republishing on every tick, and fan it out to the Account CLI cache so it can't go stale.
  - Reflect external GitHub sign-in / sign-out in Settings → Account via the shared identity hook.
  - Surface CLI command errors (e.g. `gh` not on PATH) immediately during auth instead of waiting out the full poll budget.
  - Make the inspector Connect button actually re-authenticate when the remote disagrees with the local CLI snapshot, instead of toasting a misleading "connected".
  - Replace the editor close-button tooltip with an inline `Esc` shortcut next to the X.
  - Fall back to `logo.svg` / `public/logo.svg` when picking a workspace repo icon.

## 0.11.1

### Patch Changes

- [`5f57067`](https://github.com/dohooo/helmor/commit/5f570673314ef124e126313acabeeedf97d2c0d2) Thanks [@natllian](https://github.com/natllian)! - Fix a regression on macOS 26 (Tahoe) where scrollbar backgrounds stayed permanently visible in the workspace sidebar, conversation thread, and inspector panels.

## 0.11.0

### Minor Changes

- [`378b521`](https://github.com/dohooo/helmor/commit/378b5214fffa5717ee57de0889bee491acd8cfe0) Thanks [@natllian](https://github.com/natllian)! - Add a Terminal tab to each workspace's inspector for running interactive shells

- [#274](https://github.com/dohooo/helmor/pull/274) [`bb5432d`](https://github.com/dohooo/helmor/commit/bb5432da5e955d9088828d0967a67e49eb750b0a) Thanks [@natllian](https://github.com/natllian)! - Add a sidebar workspace hover card that surfaces a workspace's repo, branch, git status, and recent activity at a glance, with a live markdown preview of the AI's current output and an elapsed timer for workspaces that are actively running.

### Patch Changes

- [#269](https://github.com/dohooo/helmor/pull/269) [`f3643b8`](https://github.com/dohooo/helmor/commit/f3643b8293f89bd7ca281051b10e73e997fd90f5) Thanks [@natllian](https://github.com/natllian)! - Fix the experimental Install CLI action on macOS so it pops the standard administrator authorization prompt (password or Touch ID) when `/usr/local/bin` needs root, instead of silently failing with a permission-denied error.

- [#273](https://github.com/dohooo/helmor/pull/273) [`b50af02`](https://github.com/dohooo/helmor/commit/b50af027091a3453d6b5c9869af8f8e05d25c443) Thanks [@natllian](https://github.com/natllian)! - Polish how Helmor sends prompts to the agent on your behalf:

  - Stop showing your "general preferences" preamble inside your own chat bubbles. The preamble is still delivered to the agent on the wire, but it no longer appears in the visible message or gets persisted with the user prompt — so reloading a session shows only what you actually typed.
  - Substitute the workspace's real git remote name into the Create PR / Commit and push / Resolve conflicts prompts (e.g. `git push -u origin HEAD` instead of `git push -u <remote> HEAD`) so the agent gets a concrete command instead of a placeholder.

- [#270](https://github.com/dohooo/helmor/pull/270) [`7d70131`](https://github.com/dohooo/helmor/commit/7d701317b05f5cbfd10716e946ace80eb2996aad) Thanks [@natllian](https://github.com/natllian)! - Collapse all tool calls in the chat thread by default.

- [#271](https://github.com/dohooo/helmor/pull/271) [`2709b07`](https://github.com/dohooo/helmor/commit/2709b07c334a36ad52b729fc0c7b4c343e9e4bdc) Thanks [@natllian](https://github.com/natllian)! - A couple of small polish fixes:
  - Stop the GitHub "Connect" prompt from flickering on flaky networks: the gh / glab status check now tolerates transient blips for up to 10 minutes and no longer mistakes upstream "401 Service Unavailable" / "unauthenticated upstream" responses for a real logout.
  - Slightly darken the composer placeholder and the auto/plan-mode pill at rest so they stay legible instead of fading into the background.

## 0.10.0

### Minor Changes

- [#264](https://github.com/dohooo/helmor/pull/264) [`07c8ce9`](https://github.com/dohooo/helmor/commit/07c8ce998c8df2e10fc112586cb6d996a643dbb8) Thanks [@natllian](https://github.com/natllian)! - Add a guided first-run onboarding flow that walks new users from agent login to a workable workspace:

  - Animated multi-step intro with previews of the Helmor UI, per-step spotlights, and Back / Next navigation between steps.
  - Agent login step that detects active Claude and Codex installations and highlights the provider you're signed into.
  - A "Power up Helmor" step that installs the Helmor CLI and Helmor Skills (Beta) from inside the app, with a live `helmor --help` preview — setup failures don't block onboarding, you can resolve them later from inside Helmor.
  - Repository import step that lets you clone from a URL or add a local path before reaching the main workspace.

- [#261](https://github.com/dohooo/helmor/pull/261) [`24be4a4`](https://github.com/dohooo/helmor/commit/24be4a4876c4a7e56d53b3e49ae85b1dc020976a) Thanks [@natllian](https://github.com/natllian)! - Add three new keyboard shortcuts with matching settings rows and in-app hints:
  - Reopen closed session — `⌘⇧T` (LIFO history of recently hidden sessions)
  - Open PR in browser — `⌘⇧G` (forge-aware: tooltip says "Open pull request" on GitHub, "Open merge request" on GitLab)
  - Open model picker — `⌥P` (opens the composer's model dropdown; tooltip on the trigger shows the binding)

### Patch Changes

- [#262](https://github.com/dohooo/helmor/pull/262) [`dad03a8`](https://github.com/dohooo/helmor/commit/dad03a8ac55da0efd2372b8c977de83edb246f2a) Thanks [@natllian](https://github.com/natllian)! - Fix the Create MR button on GitLab repos so it opens the merge request against the workspace's configured target branch instead of falling back to the repository's default branch.

- [#259](https://github.com/dohooo/helmor/pull/259) [`2c05f79`](https://github.com/dohooo/helmor/commit/2c05f79044f551136ed0a8b49f3072ef5adb5c61) Thanks [@natllian](https://github.com/natllian)! - Keep Helmor's startup cache healthy as your workspace history grows:
  - The on-disk query cache no longer balloons with workspace diff and file-list snapshots — they reload on focus when you actually need them, instead of getting saved on every state change and pushing the cache toward the browser's storage quota.
  - Composer drafts are now cleaned up when their session is deleted, so they don't accumulate over time.
  - Storage write failures (quota exceeded, security errors) now log to the console instead of being silently swallowed, making it easier to diagnose persistence issues.

## 0.9.1

### Patch Changes

- [#257](https://github.com/dohooo/helmor/pull/257) [`33c056b`](https://github.com/dohooo/helmor/commit/33c056b18c943ee01fcf3fea683263b778f75678) Thanks [@natllian](https://github.com/natllian)! - Make the inspector's PR header feel instant on workspace switch:

  - Render the PR badge from the persisted snapshot the moment a workspace opens, before the live forge query returns — no more shimmer flash on cold start.
  - Stop the shimmer from flashing on background PR refreshes; it now only appears on the very first fetch for a workspace.
  - Hover the PR badge to see the PR title in a tooltip.
  - The sidebar workspace name now reflects the live PR title once a PR has been opened.

- [#250](https://github.com/dohooo/helmor/pull/250) [`ddeb6e4`](https://github.com/dohooo/helmor/commit/ddeb6e4ebd82ee35f099312eadbf3d8492a343cd) Thanks [@natllian](https://github.com/natllian)! - Fix a one-frame white flash when toggling the composer's Plan button — the muted off-state now fades smoothly to and from the green on-state instead of briefly brightening at the start of the animation.

- [#255](https://github.com/dohooo/helmor/pull/255) [`1d22cbb`](https://github.com/dohooo/helmor/commit/1d22cbb89bdf4e30a215ae484ceeeed5e0b57986) Thanks [@natllian](https://github.com/natllian)! - Show thinking blocks in full instead of clipping them to an inner scroll container, so scrolling the chat thread no longer gets stuck when the cursor passes over a thinking block.

- [#256](https://github.com/dohooo/helmor/pull/256) [`75993c2`](https://github.com/dohooo/helmor/commit/75993c2548ef90b6fc14352df8a9f6cc7325ee53) Thanks [@natllian](https://github.com/natllian)! - Make switching into large sessions snappier and reduce database contention during heavy streaming.

- [#254](https://github.com/dohooo/helmor/pull/254) [`7a229a8`](https://github.com/dohooo/helmor/commit/7a229a88d49e38237924a2a65b5002f3ab285b38) Thanks [@natllian](https://github.com/natllian)! - Make in-app updates land faster and feel more transparent

- [#253](https://github.com/dohooo/helmor/pull/253) [`a804bb2`](https://github.com/dohooo/helmor/commit/a804bb2ff8a088cdafbbf4ac8b98b649ecd13e7e) Thanks [@natllian](https://github.com/natllian)! - Polish the keyboard shortcut settings:
  - Right-click anywhere on a shortcut row to open its menu, not just the keybinding chip, and the row picks up a subtle border highlight while the menu is open.
  - Customized shortcuts now show a small reset button next to the chip so a single click reverts that shortcut to its default.
  - Change the default Navigation shortcuts to Option+Command+Up/Down for previous/next workspace and Option+Command+Left/Right for previous/next session (replacing Option+H/L and Option+K/J).

## 0.9.0

### Minor Changes

- [#248](https://github.com/dohooo/helmor/pull/248) [`3ecf923`](https://github.com/dohooo/helmor/commit/3ecf923950aba9812713175e2ce66f12825c592b) Thanks [@natllian](https://github.com/natllian)! - Streamline GitHub and GitLab onboarding so users no longer have to install the forge CLIs themselves:

  - Ship `gh` and `glab` bundled inside Helmor so Connect GitHub / Connect GitLab works on a fresh install — no Homebrew step required.
  - Add an Account section in Settings that shows your GitHub identity and the connection status of each forge CLI, with a one-click Connect button that opens a terminal to finish signing in.
  - Update the inspector's Connect button tooltip to clarify that authentication happens locally in a terminal you control.

- [#249](https://github.com/dohooo/helmor/pull/249) [`8253908`](https://github.com/dohooo/helmor/commit/825390811db3acdd40d806e6c50a19d3a727399d) Thanks [@natllian](https://github.com/natllian)! - Ship a customizable shortcut system across the app:
  - Add a Shortcuts settings page where users can search, record, clear, reset, and detect conflicts for supported shortcuts.
  - Show compact shortcut hints in tooltips, buttons, the composer, and editor/diff close controls.
  - Add shortcuts for workspace/session navigation, repository actions, sidebars, zen mode, zoom, theme switching, composer focus, and common Git actions.

### Patch Changes

- [#247](https://github.com/dohooo/helmor/pull/247) [`fb6710b`](https://github.com/dohooo/helmor/commit/fb6710b2920f12189ca8dffa14320694ccee5eb8) Thanks [@natllian](https://github.com/natllian)! - Stop the Claude rate-limit indicator from re-triggering the macOS keychain prompt on every Helmor upgrade, and let Claude CLI handle expired-token refresh so its saved login is no longer invalidated by Anthropic's refresh-token rotation.

- [#243](https://github.com/dohooo/helmor/pull/243) [`7a7d6c4`](https://github.com/dohooo/helmor/commit/7a7d6c48c61ff946ae3549e1ebc547cdb60dd40e) Thanks [@dohooo](https://github.com/dohooo)! - Use a bundled Claude and Codex model catalog so the model picker always has stable options without depending on SDK model-list loading or cached results.

## 0.8.0

### Minor Changes

- [#242](https://github.com/dohooo/helmor/pull/242) [`04c6bb2`](https://github.com/dohooo/helmor/commit/04c6bb23441ef886b19cab107f996cc70fbaa2ff) Thanks [@natllian](https://github.com/natllian)! - Add a Usage Stats indicator next to the composer:

  - Show live 5h and 7d rate-limit windows for the active Claude or Codex account, with a hover popover for the full breakdown (per-model windows, Designs, Daily Routines, plan, credits balance).
  - Pull data directly from each provider's OAuth usage endpoint so usage stays visible even when the agent hasn't run yet, and Codex still surfaces plan and credit balance after the rate limit is exhausted.
  - Turn the Usage Stats indicator and the context-usage ring on by default for new users.

- [#240](https://github.com/dohooo/helmor/pull/240) [`0a458af`](https://github.com/dohooo/helmor/commit/0a458af3ace29a3674cebafb49b995fd5a678e56) Thanks [@natllian](https://github.com/natllian)! - Improve workspace PR lifecycle handling:
  - Move workspaces to review or done only when their PR lifecycle changes, so manual status moves stay in place until the next PR transition.
  - Add Continue for merged PR workspaces to detach from the old PR branch and start fresh from the target branch.
  - Polish the Git header controls so PR, Continue, merge status, and editor actions stay readable in narrow layouts.

### Patch Changes

- [#239](https://github.com/dohooo/helmor/pull/239) [`7522fc5`](https://github.com/dohooo/helmor/commit/7522fc523e6b88d95a08a6b0e872b8f43b54fce0) Thanks [@natllian](https://github.com/natllian)! - Keep GitHub CLI connection status stable when a transient auth check fails, so connected workspaces no longer briefly fall back to Connect before recovering.

## 0.7.0

### Minor Changes

- [#235](https://github.com/dohooo/helmor/pull/235) [`0bca4a5`](https://github.com/dohooo/helmor/commit/0bca4a55ea2aa27c9d6146201d1aa80fa97cf7d2) Thanks [@natllian](https://github.com/natllian)! - Add GitLab support across workspace forge workflows:

  - Detect GitLab remotes and show merge request status, checks, pipelines, reviews, and actions alongside existing GitHub pull request workflows.
  - Add GitLab CLI onboarding for installing and connecting `glab`, including authenticated status refresh after setup.
  - Update commit, inspector, and settings surfaces to use provider-aware GitHub/GitLab labels and actions.

- [#204](https://github.com/dohooo/helmor/pull/204) [`f5c5643`](https://github.com/dohooo/helmor/commit/f5c56436017f4b53cb321392fa43f3664224f6f7) Thanks [@gxxgcn](https://github.com/gxxgcn)! - Surface downloaded app updates as a sidebar/header button so users can install them directly from the app.

- [#213](https://github.com/dohooo/helmor/pull/213) [`a388af8`](https://github.com/dohooo/helmor/commit/a388af8e4d4a7deb8e50999451462aafbfca48e0) Thanks [@gxxgcn](https://github.com/gxxgcn)! - Add Open in Finder actions for workspaces so you can reveal a workspace directly from the sidebar context menu or the workspace header menu.

- [#233](https://github.com/dohooo/helmor/pull/233) [`e43bdde`](https://github.com/dohooo/helmor/commit/e43bdde479d27041868e7848dc669b4e40ce0744) Thanks [@natllian](https://github.com/natllian)! - Add first-class Codex image output support in chat:
  - Render Codex-generated images inline in assistant messages.
  - Store generated images as managed files instead of large base64 payloads in the session database.
  - Add a chat image context menu for copying images and revealing generated image files in Finder.

### Patch Changes

- [#208](https://github.com/dohooo/helmor/pull/208) [`043d5ee`](https://github.com/dohooo/helmor/commit/043d5ee6579d946f25670cab92a334d7e6596d56) Thanks [@gxxgcn](https://github.com/gxxgcn)! - Keep the GitHub identity gate drag region above surrounding content so the window title bar stays draggable.

- [#209](https://github.com/dohooo/helmor/pull/209) [`0f5b56d`](https://github.com/dohooo/helmor/commit/0f5b56d4837b7520a14a478040195e97ed03454d) Thanks [@gxxgcn](https://github.com/gxxgcn)! - Stop Helmor's embedded Codex app-server from inheriting global native notification hooks that can crash new Codex chats on some macOS setups.

- [#207](https://github.com/dohooo/helmor/pull/207) [`a01f0d9`](https://github.com/dohooo/helmor/commit/a01f0d9b389028e686ac089bb8ca9696f3bb6e2c) Thanks [@gxxgcn](https://github.com/gxxgcn)! - Fail workspace archive cleanly when the source repository is missing, instead of leaving the archive flow half-finished.

- [#230](https://github.com/dohooo/helmor/pull/230) [`52a07ce`](https://github.com/dohooo/helmor/commit/52a07ceb4983ebed56c6194d14dd89d681bde21b) Thanks [@natllian](https://github.com/natllian)! - Fix Claude context usage so Helmor uses the latest per-message SDK token totals instead of inflated cumulative usage when updating the composer meter.

- [#234](https://github.com/dohooo/helmor/pull/234) [`b63e1ab`](https://github.com/dohooo/helmor/commit/b63e1ab41bfcf8b3eb4cd6b1d53e1c8ac7f0942a) Thanks [@natllian](https://github.com/natllian)! - Make Create PR and conflict-resolution agent actions use the workspace target branch explicitly instead of relying on repository default branch assumptions.

## 0.6.3

### Patch Changes

- [#220](https://github.com/dohooo/helmor/pull/220) [`46b35ab`](https://github.com/dohooo/helmor/commit/46b35abfa53af6e2e04a8f42076e1a013fa0e166) Thanks [@natllian](https://github.com/natllian)! - Fix session tab closing so Helmor activates the tab to the right, falls back to the left, and keeps the current tab active when closing a background session.

- [#222](https://github.com/dohooo/helmor/pull/222) [`1e2c19c`](https://github.com/dohooo/helmor/commit/1e2c19c938d18b428db069152cd5e776895086a0) Thanks [@natllian](https://github.com/natllian)! - Improve recovery when a workspace directory disappears outside Helmor:

  - Preserve chat history by moving missing workspaces to the archive instead of deleting their records.
  - Let archived workspaces without an archive snapshot restore from their target branch, with an in-app notice explaining the fallback.
  - Reduce repeated git, file, and inspector errors for missing worktrees while still offering an explicit permanent delete action when recovery is needed.

- [#218](https://github.com/dohooo/helmor/pull/218) [`978f979`](https://github.com/dohooo/helmor/commit/978f9793beae7456ca56c124546f9f1d970395eb) Thanks [@natllian](https://github.com/natllian)! - Fix the composer's context-usage ring pinning at 100% after a single tool-heavy turn on Claude — the ring now reflects the actual end-of-turn context fill instead of cumulative per-call token usage.

- [#223](https://github.com/dohooo/helmor/pull/223) [`dedc9ca`](https://github.com/dohooo/helmor/commit/dedc9caf15426fec32935d797493a9d308330aa4) Thanks [@natllian](https://github.com/natllian)! - Make the composer context-usage percentage model-aware so it does not show stale or misleading window percentages after model switches or mixed Claude model usage.

- [#224](https://github.com/dohooo/helmor/pull/224) [`af04884`](https://github.com/dohooo/helmor/commit/af0488427c93f8670c85605afb1eb83f6b57d0a1) Thanks [@natllian](https://github.com/natllian)! - Add Codex context compaction support so Codex chats can run `/compact` from the composer and show a context-compacted notice when the provider finishes.

- [#221](https://github.com/dohooo/helmor/pull/221) [`7fea750`](https://github.com/dohooo/helmor/commit/7fea750f4bec9134b969cfe01dfd3580dfa3de7c) Thanks [@natllian](https://github.com/natllian)! - Hide duplicate Claude local command completion notices so finished shell tasks no longer appear as top-level subagent messages.

- [#226](https://github.com/dohooo/helmor/pull/226) [`20a922e`](https://github.com/dohooo/helmor/commit/20a922e812f1d86a5cf342f2ea73c49aec5d534e) Thanks [@natllian](https://github.com/natllian)! - Show relative timestamps only on the turn-end row in the chat thread so errors and other system notices no longer carry a redundant "N minutes ago".

- [#227](https://github.com/dohooo/helmor/pull/227) [`cfa0ee5`](https://github.com/dohooo/helmor/commit/cfa0ee53a76f6080be67c1d0810e97847672972b) Thanks [@natllian](https://github.com/natllian)! - Tighten up a handful of transient failure paths so they stop surfacing as errors:

  - Retry the slash-command popup once when the Claude SDK tears down its query mid-request, so the `/` menu loads instead of flashing an error.
  - Retry GitHub PR actions (show / merge / close) once on transient TLS and connect errors with a short backoff, so a flaky network doesn't bounce the user out of a commit flow.
  - Stop raising an error when a session is deleted while its title is still being generated in the background.

- [#225](https://github.com/dohooo/helmor/pull/225) [`090c1a0`](https://github.com/dohooo/helmor/commit/090c1a05c02836ffb13102644d9419d0916784b0) Thanks [@natllian](https://github.com/natllian)! - Fix the Create PR button getting stuck on "Creating…" after aborting the PR-creation session; it now returns to idle so the action can be retried.

## 0.6.2

### Patch Changes

- [#215](https://github.com/dohooo/helmor/pull/215) [`561b4de`](https://github.com/dohooo/helmor/commit/561b4de89b9c6e53a3dcbb92a65129af7929437c) Thanks [@natllian](https://github.com/natllian)! - Upgrade the bundled Codex CLI to 0.124.0 so the Codex model picker picks up newer OpenAI models, including GPT-5.5.

- [#210](https://github.com/dohooo/helmor/pull/210) [`d49f63a`](https://github.com/dohooo/helmor/commit/d49f63aee60a8bce61bba7c1ffc501f22c204ef1) Thanks [@natllian](https://github.com/natllian)! - Fix Claude's AskUserQuestion so the answer you pick in the UI actually reaches the assistant when you submit.

- [#211](https://github.com/dohooo/helmor/pull/211) [`92193b5`](https://github.com/dohooo/helmor/commit/92193b5a475dc03b4711bd879c87a3344fbb8076) Thanks [@natllian](https://github.com/natllian)! - Stop rendering mislabeled "Subagent started / completed" rows next to long-running Bash commands — those came from Claude's per-bash lifecycle notices and duplicated the Bash tool call itself.

- [#214](https://github.com/dohooo/helmor/pull/214) [`cebac7b`](https://github.com/dohooo/helmor/commit/cebac7bc3678241ef55d0d9945a4aa3413ca1cbe) Thanks [@natllian](https://github.com/natllian)! - Fix the composer's context-usage ring so it updates immediately after every turn instead of appearing stuck until the user switched sessions or refocused the window.

- [#216](https://github.com/dohooo/helmor/pull/216) [`06e3cdd`](https://github.com/dohooo/helmor/commit/06e3cddd27994511757a90006f88d0219932ed15) Thanks [@natllian](https://github.com/natllian)! - Remove the unused workspace `.context` scaffold and stop preserving it during archive, restore, and import flows.

- [#217](https://github.com/dohooo/helmor/pull/217) [`3f8d37d`](https://github.com/dohooo/helmor/commit/3f8d37d22f2fea497efca0287d5136a8160df45f) Thanks [@natllian](https://github.com/natllian)! - Keep pinned workspaces in the pinned section and place unarchived workspaces directly into their final newest-first position so the sidebar no longer jumps when the list refreshes.

## 0.6.1

### Patch Changes

- [#203](https://github.com/dohooo/helmor/pull/203) [`4b9cf2e`](https://github.com/dohooo/helmor/commit/4b9cf2e454bcac77f083b25a07e666d72a2eae33) Thanks [@dohooo](https://github.com/dohooo)! - Enable the WebView devtools panel in production builds, so you can right-click → Inspect Element inside Helmor to help diagnose rendering issues like scrollbar glitches.

## 0.6.0

### Minor Changes

- [#190](https://github.com/dohooo/helmor/pull/190) [`ba14555`](https://github.com/dohooo/helmor/commit/ba145557e7e30ae2a2f1b065f21d2dcffb83d36f) Thanks [@dohooo](https://github.com/dohooo)! - Ship a sidebar clone flow and a couple of readability polish fixes:

  - Add "Clone from URL" to the Workspaces add-repository menu so you can paste a Git URL, pick a clone location, and have Helmor clone and import the repository as a new workspace in one step.
  - Fix sidebar workspace titles clipping descenders (g / j / p / q / y) at the bottom edge when the app is zoomed out.
  - Restore vertical rhythm around assistant markdown headings and add a touch of horizontal breathing room to inline code in chat messages.

- [#197](https://github.com/dohooo/helmor/pull/197) [`1f0e5e7`](https://github.com/dohooo/helmor/commit/1f0e5e7380a6588a7f3ba56aefe4649f91b0d085) Thanks [@natllian](https://github.com/natllian)! - Add a context-usage ring next to the composer's send button that shows current token usage with a hover popover; the ring auto-reveals once usage crosses 70% of the model context window, or can be set to always show via a new "Always show context usage" toggle in Settings.

- [#200](https://github.com/dohooo/helmor/pull/200) [`4bb9fd6`](https://github.com/dohooo/helmor/commit/4bb9fd6f10beab55417f092ac49b621eb0e1c062) Thanks [@natllian](https://github.com/natllian)! - Add a per-repository Auto-run toggle for setup scripts so new workspaces can either run setup immediately on creation or stay ready for manual setup from the Setup tab.

### Patch Changes

- [#194](https://github.com/dohooo/helmor/pull/194) [`cfe8f67`](https://github.com/dohooo/helmor/commit/cfe8f672dfb27029431372828f136f6cef2688e6) Thanks [@natllian](https://github.com/natllian)! - Drop unused database tables and columns.

- [#195](https://github.com/dohooo/helmor/pull/195) [`25cfefc`](https://github.com/dohooo/helmor/commit/25cfefc2788c3e9bec98f93d500b6c897fe387c7) Thanks [@natllian](https://github.com/natllian)! - Improve error visibility and file navigation in chat responses:

  - Let local file references in assistant messages open directly in Helmor's in-app editor at the referenced line when the file is inside the current workspace.
  - Preserve specific Claude API errors like unexpected socket disconnects instead of collapsing them into a generic "unknown error" notice.

- [#187](https://github.com/dohooo/helmor/pull/187) [`9e41cd7`](https://github.com/dohooo/helmor/commit/9e41cd7dfbf153a9737000f78c04aee0a920d515) Thanks [@natllian](https://github.com/natllian)! - Keep queued follow-up prompts overlaying the composer instead of shrinking the thread, and show a proper icon for streamed Skill entries.

- [#196](https://github.com/dohooo/helmor/pull/196) [`34ce8a4`](https://github.com/dohooo/helmor/commit/34ce8a4e50b0bd198334ae3bd1dc71aebf15f31e) Thanks [@natllian](https://github.com/natllian)! - Fix Codex sessions so sandbox mode changes apply on later turns and Git worktree metadata directories stay writable for commit and push operations.

- [#193](https://github.com/dohooo/helmor/pull/193) [`6e77a94`](https://github.com/dohooo/helmor/commit/6e77a944507511e87c4ab0912d2ff8fe11d50644) Thanks [@natllian](https://github.com/natllian)! - Refresh the inspector's Actions panel immediately after switching target branch, so the sync-with-remote row shows the new ahead/behind numbers right away instead of lagging up to ten seconds behind.

- [#198](https://github.com/dohooo/helmor/pull/198) [`0ce21bb`](https://github.com/dohooo/helmor/commit/0ce21bbcf38229f1d834dfbe2ebf219771c74c9f) Thanks [@natllian](https://github.com/natllian)! - Fix Cmd+Q on macOS so quitting while a task is running now shows the same confirmation dialog as the window close button instead of exiting immediately.

- [#199](https://github.com/dohooo/helmor/pull/199) [`e5abd9c`](https://github.com/dohooo/helmor/commit/e5abd9c8a0dc56ec67685b2b7dd7f3e81c802733) Thanks [@dohooo](https://github.com/dohooo)! - Stop the workspace sidebar and command palette from showing a stray scrollbar in production builds.

- [#199](https://github.com/dohooo/helmor/pull/199) [`0d0050b`](https://github.com/dohooo/helmor/commit/0d0050b7e8a9f5667e9737cbb198affe3c6e053b) Thanks [@dohooo](https://github.com/dohooo)! - Fix multiple chat viewport scrolling glitches during streaming:

  - Eliminate the near-bottom flicker, the mid-stream auto-scroll stall, and the first-chunk overshoot that could leave the view stranded mid-reply.
  - Keep the streaming logo and timer reliably pinned to the end of the assistant output instead of briefly covering text or snapping back into place a moment later.
  - Stop the viewport from bouncing up and down by about one line once a single reply grows taller than the screen on fast models.

- [#191](https://github.com/dohooo/helmor/pull/191) [`c582325`](https://github.com/dohooo/helmor/commit/c5823254ba1a77ff9733cf6d025ad178b6ba49c9) Thanks [@natllian](https://github.com/natllian)! - Fix stuck sessions caused by SQLite contention and unresponsive sidecars:

  - Eliminate the "database is locked" failures that could interrupt session actions (marking read, pinning, renaming) while an AI turn was actively writing to the DB.
  - Detect a frozen or disconnected sidecar via heartbeat and surface a retry-able error instead of leaving the session stuck in a streaming state.

- [#196](https://github.com/dohooo/helmor/pull/196) [`12f3749`](https://github.com/dohooo/helmor/commit/12f374986ddd2f6459859cb05ddcf895f660085b) Thanks [@natllian](https://github.com/natllian)! - Add a hover-only copy button for user chat bubbles and remove the copy button fade animation so message actions appear immediately.

## 0.5.0

### Minor Changes

- [#173](https://github.com/dohooo/helmor/pull/173) [`dc620cd`](https://github.com/dohooo/helmor/commit/dc620cdd446501cd2a3f18c2251d3a321bae3e03) Thanks [@dohooo](https://github.com/dohooo)! - Ship a fuller Helmor companion CLI and keep the desktop app in sync with terminal-driven changes:
  - Expand the CLI with workspace, session, repo, files, settings, GitHub, models, send, MCP, and shell completion commands so you can manage Helmor workflows from the terminal.
  - Bundle the CLI with the desktop app and install it from Settings as `helmor` in release builds or `helmor-dev` in development builds so it stays version-matched with the app.
  - Reflect CLI-triggered workspace, session, files, settings, GitHub, and queued-send changes in the desktop UI immediately instead of waiting for focus-based refreshes.

## 0.4.2

### Patch Changes

- [#180](https://github.com/dohooo/helmor/pull/180) [`b4882cd`](https://github.com/dohooo/helmor/commit/b4882cd803feaf5c74cb0cd0295e10fafc68386a) Thanks [@natllian](https://github.com/natllian)! - Append custom repository preferences after Helmor's built-in prompts, and tighten the preferences editor so placeholders and prompt previews better match what agents actually receive.

## 0.4.1

### Patch Changes

- [#176](https://github.com/dohooo/helmor/pull/176) [`8536c7b`](https://github.com/dohooo/helmor/commit/8536c7b0f62dfa25266427a3d5e8537ca55485ae) Thanks [@natllian](https://github.com/natllian)! - Keep the model picker populated from the last good startup cache and only overwrite that cache after a successful model refresh, so reopening Helmor no longer flashes an empty "Select model" state before the catalog loads.

- [#177](https://github.com/dohooo/helmor/pull/177) [`b7d2de2`](https://github.com/dohooo/helmor/commit/b7d2de22bbf2c06b822ad9ca36e2096f0fcabca0) Thanks [@natllian](https://github.com/natllian)! - Fix fast Claude thinking blocks that were collapsing themselves and showing a generic "Thinking" label — they now stay expanded and show "Thought for Ns" as soon as reasoning finishes, even when the block completes too quickly for the streaming UI to observe it mid-flight.

- [#174](https://github.com/dohooo/helmor/pull/174) [`48bc8b1`](https://github.com/dohooo/helmor/commit/48bc8b1846e0a2e11ba2bc9a86c19c9f897a2d3e) Thanks [@natllian](https://github.com/natllian)! - Make the workspace unread dot behave the way you'd expect:
  - Clicking a workspace you just marked as unread now actually clears the green dot. Previously the click was silently ignored when the workspace was already the currently selected one.
  - "Mark as unread" only flips the workspace flag itself — it no longer flips a random session's unread state as a side effect, and your manual workspace-level mark is preserved as long as any session in that workspace is still unread.

## 0.4.0

### Minor Changes

- [#163](https://github.com/dohooo/helmor/pull/163) [`623c66b`](https://github.com/dohooo/helmor/commit/623c66b9895cc560f97d7ef33b2ddbeba6215629) Thanks [@natllian](https://github.com/natllian)! - Add a follow-up queue for messages sent while the AI is still responding:
  - New Settings toggle (Follow-up behavior) picks between Queue and Steer — Queue stashes the next message and auto-sends it once the current turn finishes; Steer keeps the existing mid-turn interrupt.
  - Queued messages appear as stacked rows above the composer with Steer-now / remove actions, and survive session and workspace switches.
  - Pull-on-conflict and dirty-worktree resolution prompts now queue onto the active chat automatically instead of blocking with a toast when the AI is busy.

### Patch Changes

- [#172](https://github.com/dohooo/helmor/pull/172) [`7120573`](https://github.com/dohooo/helmor/commit/71205737770359e85922850e181be56ddd9542f8) Thanks [@natllian](https://github.com/natllian)! - Fix approval prompts so Allow and Deny stay clickable while the agent is waiting, and remove the unused optional reason field from that approval UI.

- [#171](https://github.com/dohooo/helmor/pull/171) [`e8969e1`](https://github.com/dohooo/helmor/commit/e8969e19db80c03411fa3f145d902e5125c47622) Thanks [@natllian](https://github.com/natllian)! - Warn before closing a session while its chat is still running, and stop the in-flight response if you choose to close it anyway.

- [#168](https://github.com/dohooo/helmor/pull/168) [`bcf68c2`](https://github.com/dohooo/helmor/commit/bcf68c2204483a272af9288ba07d48f04fcae33f) Thanks [@natllian](https://github.com/natllian)! - Polish the Settings UI for clearer navigation:

  - Reorganize app settings into General, Appearance, Model, and Git sections with matching section titles.
  - Remove the empty top-left gap in the Settings dialog so the sidebar aligns cleanly with the header.
  - Remove the placeholder text from General preferences because that field no longer has a built-in prompt.

- [#170](https://github.com/dohooo/helmor/pull/170) [`c8bcd61`](https://github.com/dohooo/helmor/commit/c8bcd619bf652958ce2b37985a170a0b7d94a17f) Thanks [@natllian](https://github.com/natllian)! - Make Claude's `/add-dir` behavior match Codex more closely by reloading slash commands after linked directories change and consistently using linked-directory context for Claude prompts and command discovery.

- [#167](https://github.com/dohooo/helmor/pull/167) [`2b5bd0a`](https://github.com/dohooo/helmor/commit/2b5bd0a8f903db594e098cb5820fdf2dc0b373f3) Thanks [@natllian](https://github.com/natllian)! - Fix the macOS dock badge and sidebar unread indicators so they accurately track per-session unread state: opening a session marks it read, the workspace stays flagged while any of its sessions is still unread, and sessions waiting on a prompt only clear once the interaction is completed.

- [#169](https://github.com/dohooo/helmor/pull/169) [`4ef8640`](https://github.com/dohooo/helmor/commit/4ef8640873e5b8ee80b60eadf016080aab2899be) Thanks [@natllian](https://github.com/natllian)! - Fix the streaming loading/timer footer so it stays below the live assistant output while long tool groups expand, and add a regression test for the overlap case.

## 0.3.0

### Minor Changes

- [#159](https://github.com/dohooo/helmor/pull/159) [`fd8f6cb`](https://github.com/dohooo/helmor/commit/fd8f6cb696bcccd31f8397353370227a1236a802) Thanks [@natllian](https://github.com/natllian)! - Add repo-level AI prompt preferences with markdown preview so each repository can customize create-PR, fix-errors, conflict-resolution, branch-naming, and first-chat instructions.

### Patch Changes

- [#157](https://github.com/dohooo/helmor/pull/157) [`e46889e`](https://github.com/dohooo/helmor/commit/e46889e8f4849c79cee666311dcdbbd8a1e30319) Thanks [@natllian](https://github.com/natllian)! - Keep the inspector's Setup/Run hover-zoom expanded until the pointer actually leaves the zoomed panel, and stop triggering blur pulses when no zoom animation is happening.

- [#160](https://github.com/dohooo/helmor/pull/160) [`adc9c1a`](https://github.com/dohooo/helmor/commit/adc9c1a99dd02a8d057e2a207d1170fc4973049c) Thanks [@natllian](https://github.com/natllian)! - Fix an intermittent flicker where the Chinese IME candidate popup briefly went blank for a frame before closing when switching from a Chinese IME to English mid-composition.

## 0.2.1

### Patch Changes

- [#152](https://github.com/dohooo/helmor/pull/152) [`405c634`](https://github.com/dohooo/helmor/commit/405c6342f79501e1b577d8cdf1ff32d8779ee5a0) Thanks [@natllian](https://github.com/natllian)! - Fix the sidebar workspace row so the green status dot on the avatar no longer gets clipped when you hover the row.

- [#153](https://github.com/dohooo/helmor/pull/153) [`b05d39f`](https://github.com/dohooo/helmor/commit/b05d39f13e01117e7f5dd1ce726bb6176d46ed8b) Thanks [@natllian](https://github.com/natllian)! - Tighten the scripts terminal hover-zoom so it only engages when there's real output to read:
  - The Setup/Run tab header no longer triggers the zoom, so moving the cursor between tabs or to the collapse chevron keeps the panel at its resting size.
  - The empty placeholder states (no script configured, or script configured but not yet run) no longer trigger the zoom — it now only engages once a script has actually produced terminal output.
  - The Stop/Rerun button in the bottom-right corner only appears once the panel has enlarged, so it's no longer clipped and unclickable at the resting size.

## 0.2.0

### Minor Changes

- [#150](https://github.com/dohooo/helmor/pull/150) [`c1116d9`](https://github.com/dohooo/helmor/commit/c1116d93f34dde536daf6f3621819293260d8f34) Thanks [@natllian](https://github.com/natllian)! - Add `/add-dir` to link extra directories into a workspace so agents can read and edit them alongside the main worktree. Linked directories persist per workspace and appear as chips in a new "context" strip inside the composer, above the input.

  - Picker: selecting `/add-dir` inserts a purple pill into the editor and opens a cmdk popup above the composer. The popup suggests every ready workspace across all repos and a "Browse folder…" escape hatch. Type after the pill to filter, Enter to pick, Backspace once to exit.
  - Context bar: chips show each linked directory's name + branch, hover tooltip reveals the full path. Tab / ←/→ / Home / End navigate; Backspace or Delete removes with a collapse animation; Escape blurs.
  - Claude: paths are merged with the workspace's git worktree metadata directories and sent as `additionalDirectories`.
  - Codex: in plan mode the current cwd plus linked paths become `sandboxPolicy.writableRoots` so edits outside cwd aren't rejected.

- [#148](https://github.com/dohooo/helmor/pull/148) [`1e0d07b`](https://github.com/dohooo/helmor/commit/1e0d07b229d50f563eb6d4b2015348341a3cd50b) Thanks [@natllian](https://github.com/natllian)! - Add a mid-turn Steer button to the composer — type a new instruction while the agent is still streaming and click Steer to inject it into the running turn without stopping; works on both Claude and Codex.

- [#137](https://github.com/dohooo/helmor/pull/137) [`d8ed77b`](https://github.com/dohooo/helmor/commit/d8ed77bd9c4a28b483b6222387136ef970c9b172) Thanks [@dohooo](https://github.com/dohooo)! - The macOS Dock icon now shows a red badge with the total number of sessions that have unread activity across your workspaces, clearing as you open each workspace.

- [#125](https://github.com/dohooo/helmor/pull/125) [`fcad25d`](https://github.com/dohooo/helmor/commit/fcad25d4c43b196eb8797aa86235b0d9d6080ea6) Thanks [@dohooo](https://github.com/dohooo)! - Make the Run and Setup inspector terminals behave like a real interactive terminal:

  - Fix the Stop button so it actually terminates the running script — it was previously a silent no-op that left the process running until it completed on its own.
  - Accept keyboard input in the terminal so Ctrl+C now interrupts the foreground process, and interactive tools can prompt you for input the way they would in a normal shell.
  - Propagate inspector panel resizes to the script's PTY so vim, htop, and other full-screen tools re-layout correctly when you change the panel size.

- [#118](https://github.com/dohooo/helmor/pull/118) [`a25c2a8`](https://github.com/dohooo/helmor/commit/a25c2a8b2c0d1734dfa9d11c9135607f3b1215fb) Thanks [@dohooo](https://github.com/dohooo)! - Add a one-click shortcut to open your running dev server from the Run panel:

  - While the Run script is active, a new "Open" button in the Run tab header auto-detects localhost URLs printed by frameworks like Vite and Next.js, showing `Open:PORT` for a single service or a hover picker when the script exposes multiple at once.

- [#136](https://github.com/dohooo/helmor/pull/136) [`469a53f`](https://github.com/dohooo/helmor/commit/469a53fc61d196019fad51e4c5b683ce014e70c5) Thanks [@natllian](https://github.com/natllian)! - Stable part IDs across the streaming pipeline — thinking blocks no longer auto-collapse at block boundaries:

  - Every message part (Text, Reasoning, Image, TodoList, etc.) now carries a stable `id` minted at first sight and preserved through streaming deltas, turn commit, DB persistence, and historical reload. React keys use this id instead of array position, eliminating remounts caused by pipeline reordering (collapse grouping, tool-call folding, message merging).
  - Message-level IDs are pre-assigned as DB UUIDs at turn start instead of using temporary `stream-partial:N` identifiers that flip to a different UUID on commit. The entire `sync_persisted_ids` / `sync_result_id` post-hoc reconciliation machinery is removed.
  - Collapsed read-only tool groups now default to expanded and stop their loading spinner as soon as the last tool returns a result, instead of spinning until the overall message stream ends.
  - Subagent status labels (Subagent started / completed) no longer line-break on narrow viewports.

- [#126](https://github.com/dohooo/helmor/pull/126) [`967ae3d`](https://github.com/dohooo/helmor/commit/967ae3d21ff25444b45b6e3c5c74c2efc0249cd0) Thanks [@dohooo](https://github.com/dohooo)! - Unify inline tags across the composer and sent messages, and let you preview their contents on hover:
  - Every @-file, image, and pasted-text tag now renders with the same size, padding, and baseline alignment whether you are still typing or looking at a past message.
  - Hovering a file tag opens a popover with the file's contents — syntax-highlighted for code — and shows a clear notice for files that are too large or cannot be read.
  - Image tags in sent messages now open the preview directly in a hover popover, replacing the old click-to-open fullscreen overlay.

### Patch Changes

- [#124](https://github.com/dohooo/helmor/pull/124) [`1aa8bfd`](https://github.com/dohooo/helmor/commit/1aa8bfdf24a3555f53008a40761ed927d3bdf569) Thanks [@dohooo](https://github.com/dohooo)! - Fix a visual alignment issue in the Git Actions header:

  - The colored Actions button now sits flush with the PR number button next to it, fixing a small vertical offset.

- [#111](https://github.com/dohooo/helmor/pull/111) [`ed5f351`](https://github.com/dohooo/helmor/commit/ed5f3516c0d0067ce0da9cd93ecbf2fdfb18a4cf) Thanks [@natllian](https://github.com/natllian)! - Make the file diff viewer follow the app theme:

  - Opening a file from the diff tree now renders the Monaco editor and its surrounding chrome in the app's light or dark theme, instead of always using the dark theme.

- [#144](https://github.com/dohooo/helmor/pull/144) [`cf769f0`](https://github.com/dohooo/helmor/commit/cf769f02c2c5d9af3bf3085ee2b2c2c71ae707bc) Thanks [@natllian](https://github.com/natllian)! - Speed up and stabilize archiving workspaces in batches:

  - Archiving runs in parallel instead of serially, and worktree removal returns immediately by renaming the directory into a sibling trash folder that gets cleaned up in the background — archiving 8 workspaces at once now takes under a second instead of ~90 seconds.
  - The archived list no longer reorders itself while a batch of optimistic archives is settling into server data; items stay in click order until reconciliation is complete.
  - Archived workspace directories no longer get resurrected as empty `node_modules/.bun` stubs when a stale slash-command prewarm fires for a workspace that was just archived.

- [#117](https://github.com/dohooo/helmor/pull/117) [`9098a17`](https://github.com/dohooo/helmor/commit/9098a1781be5c2c59f7c8b836d86d44f8cb8b2c2) Thanks [@dohooo](https://github.com/dohooo)! - Fix the Conductor-to-Helmor workspace migration by rewriting `$CONDUCTOR_*` environment variable references in `helmor.json` to their `$HELMOR_*` equivalents, so Cmd+R no longer fails with `exit 127` on freshly migrated or partially-migrated workspaces.

- [#140](https://github.com/dohooo/helmor/pull/140) [`7a68ca6`](https://github.com/dohooo/helmor/commit/7a68ca68ab7bfbc52f7d70cc705be3aa6828ee78) Thanks [@natllian](https://github.com/natllian)! - Fix the default model setting being silently overwritten on app restart:

  - The startup model-validation hook no longer replaces a user-saved default model when the model catalog is still partially loaded or when the saved model belongs to a provider that hasn't responded yet.

- [#145](https://github.com/dohooo/helmor/pull/145) [`83e57da`](https://github.com/dohooo/helmor/commit/83e57da35211c74321643e30a82b41ce5241b32c) Thanks [@natllian](https://github.com/natllian)! - Fix the slash-command popup to stop showing a "Loading more commands…" banner that could linger indefinitely once commands were already visible.

- [#127](https://github.com/dohooo/helmor/pull/127) [`cdf3e17`](https://github.com/dohooo/helmor/commit/cdf3e170824678f1e23bcf5ac08a0e98334bbc54) Thanks [@dohooo](https://github.com/dohooo)! - Fix the composer's slash-command and @-mention popup:

  - Hug the top edge of the input with an 8px gap instead of being clipped behind the composer's rim.
  - Stay above chat messages and code blocks instead of rendering underneath them.
  - Confirm the highlighted option when you press Enter — no more accidentally sending the message while you were picking a command or file.

- [#147](https://github.com/dohooo/helmor/pull/147) [`1b83649`](https://github.com/dohooo/helmor/commit/1b8364902540f9e7af9262c7e9f9d0670f94bf43) Thanks [@natllian](https://github.com/natllian)! - Keep streamed thinking blocks expanded through completion and show a "Thought for Ns" label once reasoning finishes instead of falling back to a collapsed generic "Thinking" state.

- [#120](https://github.com/dohooo/helmor/pull/120) [`348fbba`](https://github.com/dohooo/helmor/commit/348fbba306c91b351b9f454c5af7b2ef27cc7464) Thanks [@natllian](https://github.com/natllian)! - Restore visible reasoning content for Claude Opus 4.7:

  - Opus 4.7 shipped with a new SDK default that hid thinking text from both streaming and the finalized response, leaving the reasoning block empty and DB rows with no text. Helmor now opts back into summarized thinking so the progress is visible during the turn and the full text is persisted with the message.

- [#110](https://github.com/dohooo/helmor/pull/110) [`44944af`](https://github.com/dohooo/helmor/commit/44944afe4f538cbfac40e0cfbb4821a3d0a8a4db) Thanks [@natllian](https://github.com/natllian)! - Make "Open workspace in …" more useful across the board:

  - Expand supported editors, terminals, and Git GUIs to 30 apps (Cursor, VS Code, Windsurf, Zed, the JetBrains suite, Xcode, Android Studio, Sublime Text, MacVim, Neovide, GNU Emacs, iTerm2, Ghostty, Alacritty, WezTerm, Warp, Hyper, Tower, Sourcetree, GitKraken, and more), detect apps installed in non-standard locations via Spotlight, show real brand logos, and surface the button instantly on launch without waiting for detection.

- [#130](https://github.com/dohooo/helmor/pull/130) [`f9d9ca1`](https://github.com/dohooo/helmor/commit/f9d9ca18e74420599e7611689edebe0df787b205) Thanks [@natllian](https://github.com/natllian)! - Replace date-based log rotation with a bounded single-file ring:

  - Both the Rust host and the sidecar now write to `rust.jsonl` / `sidecar.jsonl` with a `.1` backup that is overwritten on rotation, capping each component's log footprint at ~20 MB instead of accumulating a week of daily files.
  - Removes the background cleanup thread and the `tracing-appender` / `flate2` dependencies; no more gzip pass, no UTC/local date races.

- [#128](https://github.com/dohooo/helmor/pull/128) [`407d0c1`](https://github.com/dohooo/helmor/commit/407d0c1a30d86bc444f1aa1890d63c0b5ecf8245) Thanks [@dohooo](https://github.com/dohooo)! - Show a small status icon next to the Setup and Run tabs in the inspector so you can see each script's state — unconfigured, idle, currently running (animated Helmor logo), succeeded, or failed — without opening the tab.

- [#139](https://github.com/dohooo/helmor/pull/139) [`9e4d5e0`](https://github.com/dohooo/helmor/commit/9e4d5e0b1b886d0375030d449624984394a12b65) Thanks [@natllian](https://github.com/natllian)! - Fix sidebar flicker when switching workspace status:

  - Changing status (e.g. backlog → in progress) no longer causes a visible flash. The sidebar now waits for the backend to confirm the change before refreshing, instead of doing an optimistic update that gets immediately overwritten by a cache refetch.

- [#113](https://github.com/dohooo/helmor/pull/113) [`3e86bce`](https://github.com/dohooo/helmor/commit/3e86bcefb2acb1230fff7dfbd19ad8ea5e5b9952) Thanks [@dohooo](https://github.com/dohooo)! - Show a chat-style unread dot on the top-right of the workspace avatar whenever a workspace has unread activity, not just when a session just finished.

- [#134](https://github.com/dohooo/helmor/pull/134) [`ac2abbb`](https://github.com/dohooo/helmor/commit/ac2abbba8d62d7d4394a7775d07e561127ed4313) Thanks [@dohooo](https://github.com/dohooo)! - Unify the permission-approval, deferred-tool approval, and MCP elicitation panels behind one consistent look:

  - Bash command approvals now render with syntax highlighting instead of a raw JSON dump.
  - Multi-step question and elicitation forms get tabs at the top, dimming unanswered steps and marking required fields with `*`.
  - Headers, buttons, inputs, and option rows across all three panels now share the same shadcn-style layout, spacing, and button set.

- [#114](https://github.com/dohooo/helmor/pull/114) [`cf53c37`](https://github.com/dohooo/helmor/commit/cf53c37189b3e2822b3a9c494f8bffd558d48bb7) Thanks [@natllian](https://github.com/natllian)! - Make the Default model setting the single source of truth:

  - The Settings panel now shows a real default instead of "Select model" on first launch, and new chats always use whatever is configured there.

- [#121](https://github.com/dohooo/helmor/pull/121) [`2ac2bf5`](https://github.com/dohooo/helmor/commit/2ac2bf55fd3d06f1be88f3691dba2f07e6b6645a) Thanks [@dohooo](https://github.com/dohooo)! - Match the loading spinner next to batched tool groups (e.g. "Reading 2 files…") to the muted gray used for individual streaming tool calls, so every in-flight indicator in a chat message shares the same color.

- [#115](https://github.com/dohooo/helmor/pull/115) [`f87bfc5`](https://github.com/dohooo/helmor/commit/f87bfc56c288ec293259396a4e48c4adea7ae4bf) Thanks [@dohooo](https://github.com/dohooo)! - Show workspace titles in full in the sidebar:
  - Workspace rows no longer reserve space for the archive button, so long titles are now visible in full instead of being truncated early.
  - Archive, restore, and delete buttons appear on hover and overlay the right end of the row, with the underlying title fading out behind them.

## 0.1.6

### Patch Changes

- [`13e31d6`](https://github.com/dohooo/helmor/commit/13e31d684c3f8b54b2b828ffb441e3be6c2c36dd) Thanks [@natllian](https://github.com/natllian)! - Fix resuming a Claude conversation sometimes failing with "No conversation found".

## 0.1.5

### Patch Changes

- [`fdfbab4`](https://github.com/dohooo/helmor/commit/fdfbab4d5703d1d349f73067555d4c2205d8c1e1) Thanks [@claude](https://github.com/claude)! - Fix the missing change-log link in the app update flow:
  - The "View change log" button now appears in the update-ready toast and in Settings → App Updates, opening the matching GitHub release page.

## 0.1.4

### Patch Changes

- [`dd53716`](https://github.com/dohooo/helmor/commit/dd537165c122e19721dc28064a60f0771a263662) Thanks [@claude](https://github.com/claude)! - - Fix the caret jumping to the start of the paragraph right after a Chinese IME buffer got stripped of its segmentation spaces — the caret now stays at the end of what you just typed.

## 0.1.3

### Patch Changes

- [#94](https://github.com/dohooo/helmor/pull/94) [`0ec4401`](https://github.com/dohooo/helmor/commit/0ec4401ef86172b73cf8498dc4960f073944bfa0) Thanks [@dohooo](https://github.com/dohooo)! - - Fix Chinese / Japanese / Korean IME pressing Enter to confirm a candidate accidentally sending the message.
  - Fix Chinese IME segmentation spaces leaking into the composer when switching input method mid-composition (e.g. typing `helmor` no longer becomes `he lmor`).

## 0.1.2

### Patch Changes

- [#91](https://github.com/dohooo/helmor/pull/91) [`8567d35`](https://github.com/dohooo/helmor/commit/8567d355d2be84fdeea68436c18be31fcd76ef0c) Thanks [@natllian](https://github.com/natllian)! - - Fix the empty model list in signed/notarized macOS release builds.

## 0.1.1

### Patch Changes

- [#89](https://github.com/dohooo/helmor/pull/89) [`e3fc20f`](https://github.com/dohooo/helmor/commit/e3fc20f4451a65c2d9d067c39b9233367d07bdd1) Thanks [@natllian](https://github.com/natllian)!
  - Fix new workspaces occasionally creating a duplicate session on first open.
  - Stop reshuffling the sidebar optimistically when you change a session's status manually.

All notable changes to Helmor will be documented in this file.

## 0.1.0

Hello Helmor.
