# Changesets official lifecycle/APIs for app-facing release announcement metadata

Date checked: 2026-05-08

## Short answer

Changesets does **not** appear to provide an official, purpose-built package or extension point that directly emits app-facing release announcement metadata.

It **does** provide official lower-level APIs that avoid manually binding changeset summaries to versions:

- `@changesets/get-release-plan` computes a `ReleasePlan` from repository state.
- `ReleasePlan.releases[]` includes package `name`, `type`, `oldVersion`, `newVersion`, and contributing `changesets` IDs.
- `ReleasePlan.changesets[]` includes each changeset `id`, `summary`, and package release intents.

So the official route is: compute the release plan, then generate your own announcement JSON/metadata from that structure. That is official data, but the app-facing metadata format would be custom.

## Official lifecycle

Official docs describe the normal loop as:

1. Add changesets with each change.
2. Run `changeset version` when release-ready.
3. Run `changeset publish` afterward.

The `version` command consumes changesets, updates package versions, and writes changelog entries. The `publish` command publishes packages with versions newer than npm.

Sources:

- Intro workflow: https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md
- Automation workflow: https://github.com/changesets/changesets/blob/main/docs/automating-changesets.md
- Root README overview: https://github.com/changesets/changesets

## Official extension points

### Changelog generator

The `changelog` config option is the main official formatting extension point. It can point to an installed npm package or local module that exports:

- `getReleaseLine`
- `getDependencyReleaseLine`

Those functions run during `changeset version` and are expected to return strings for changelog generation. Official packages include `@changesets/changelog-git` and `@changesets/changelog-github`.

This is useful for formatting release text, but it is not documented as a structured metadata export hook. The API contract is string-returning changelog content.

Sources:

- Config option docs: https://github.com/changesets/changesets/blob/main/docs/config-file-options.md
- Changelog format docs: https://github.com/changesets/changesets/blob/main/docs/modifying-changelog-format.md
- Type definitions for changelog functions: https://github.com/changesets/changesets/blob/main/packages/types/src/index.ts
- `apply-release-plan` source loading and invoking changelog functions: https://github.com/changesets/changesets/blob/main/packages/apply-release-plan/src/index.ts

### Commit message generator

The `commit` config option can load functions such as `getVersionMessage`. In the official type definitions, `getVersionMessage` receives a `ReleasePlan`, so it is another official extension point that sees release metadata. Its purpose is commit-message generation, not app announcement metadata.

Sources:

- Config option docs: https://github.com/changesets/changesets/blob/main/docs/config-file-options.md
- Type definitions: https://github.com/changesets/changesets/blob/main/packages/types/src/index.ts

## Official packages/APIs exposing release metadata

### `@changesets/get-release-plan`

This is the strongest official API for this use case. Its README says it reads repository information:

```ts
import getReleasePlan from "@changesets/get-release-plan";

const releasePlan = await getReleasePlan(cwd, since, passedConfig);
```

The source reads packages/config/changesets and returns `assembleReleasePlan(...)`.

`ReleasePlan` is typed to contain:

- `changesets: NewChangeset[]`
- `releases: ComprehensiveRelease[]`
- `preState`

`ComprehensiveRelease` contains:

- `name`
- `type`
- `oldVersion`
- `newVersion`
- `changesets`

This means a script can map each computed `newVersion` to the changeset summaries that caused it, without hand-maintaining version bindings.

Sources:

- README: https://github.com/changesets/changesets/blob/main/packages/get-release-plan/README.md
- Source: https://github.com/changesets/changesets/blob/main/packages/get-release-plan/src/index.ts
- Types: https://github.com/changesets/changesets/blob/main/packages/types/src/index.ts
- Release-plan assembly source: https://github.com/changesets/changesets/blob/main/packages/assemble-release-plan/src/index.ts

### `@changesets/read`

`@changesets/read` reads formatted changesets from a repo. This gives summaries and release intents, but not final computed versions by itself.

Source:

- README: https://github.com/changesets/changesets/blob/main/packages/read/README.md

### `@changesets/apply-release-plan`

`@changesets/apply-release-plan` applies a `ReleasePlan` by updating package versions and changelogs. It is not a metadata exporter, but confirms the official internal boundary: get a release plan, then apply it.

Source:

- README: https://github.com/changesets/changesets/blob/main/packages/apply-release-plan/README.md
- Source: https://github.com/changesets/changesets/blob/main/packages/apply-release-plan/src/index.ts

## GitHub Action behavior

`changesets/action` can create/update a version PR and optionally publish. Its documented outputs include:

- `published`
- `publishedPackages`, a JSON array of `{ name, version }`

It can also create GitHub Releases after publish. Source shows release bodies are derived from package `CHANGELOG.md` entries, not from a structured app-facing metadata artifact.

Sources:

- Action README: https://github.com/changesets/action
- Action source: https://github.com/changesets/action/blob/main/src/run.ts
- Action entrypoint: https://github.com/changesets/action/blob/main/src/index.ts

## Apps/non-npm packages

Official docs say Changesets can manage application or non-npm package versions if the project has a `package.json`. For private app packages, set:

```json
{
  "privatePackages": { "version": true, "tag": true }
}
```

The docs also state Changesets only versions npm `package.json` files; other release formats should be triggered by workflows on tags/releases.

Source:

- Versioning apps/non-npm packages: https://github.com/changesets/changesets/blob/main/docs/versioning-apps.md

## Practical conclusion

There is no official "release announcement metadata" exporter found in the docs or source reviewed.

Recommended official-data approach:

1. Use `@changesets/get-release-plan` before `changeset version`.
2. Build custom announcement metadata from `releasePlan.releases` plus `releasePlan.changesets`.
3. Persist that JSON beside the app release artifacts or feed it into the app's announcement system.
4. Let `changeset version` / `apply-release-plan` continue owning package versions and changelogs.

This avoids manual version binding because Changesets computes `newVersion` and the contributing changeset IDs. The only custom part is the app-facing metadata schema and writer.
