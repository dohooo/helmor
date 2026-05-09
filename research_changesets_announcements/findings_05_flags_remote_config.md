# Feature flags / remote config for release announcements

Research date: 2026-05-08

## Bottom line

Feature flag and remote config platforms can handle **time-windowed display** and **version-targeted display**, but they do **not** remove the core need to know the real release boundary. They solve "show between `start_at` and `end_at`" once those timestamps are known, and they solve "show only on app version `x.y.z`" once the app reports that version. They do not infer "the release that this changeset eventually shipped in" unless the release pipeline or the app writes that fact back into the flag/config system.

For Helmor release announcements, the strongest pattern is still:

1. CI computes the final release version after Changesets versioning.
2. CI publishes/updates an announcement config record with `{ version, start_at, end_at, content }`.
3. The app fetches that config and locally checks `current_version == version` plus the time window, or sends `current_version` as a targeting attribute if using a vendor.

Use a vendor only if we also want rollout dashboards, kill switches, analytics, approvals, or non-engineer editing. For the narrow release-announcement problem, a small first-party remote JSON/config endpoint is likely simpler and avoids an extra runtime dependency.

## Platform notes

### LaunchDarkly

- Supports scheduled flag changes: targeting rules can be scheduled for future points in time, including turning access on/off, progressive rollout steps, temporary access, and cleanup. Source: https://launchdarkly.com/docs/home/releases/scheduled-changes
- Scheduled changes are an Enterprise feature in the API docs. Source: https://launchdarkly.com/docs/api/scheduled-changes
- Supports mobile/application targeting. LD can automatically create application versions when supported SDKs evaluate flags with application version information, and mobile targeting can use application/version/device attributes. Sources: https://launchdarkly.com/docs/home/releases/app-versions/ and https://launchdarkly.com/docs/home/flags/mobile-targeting
- Fit for release announcements: good if already using LD and willing to automate flag updates from CI. It still needs the release version or a CI-provided release timestamp. "Application version support status" helps lifecycle targeting, not automatic "new release announcement window" discovery.

### PostHog

- Supports feature flags, remote config payloads, percentage rollouts, user/group targeting, and scheduled flag changes. Source: https://posthog.com/docs/feature-flags
- Scheduled flag changes can enable/disable flags, add conditions, update variants/payloads, recur, and create paired enable/disable schedules. Source: https://posthog.com/docs/feature-flags/scheduled-flag-changes
- Supports release conditions and semantic-version targeting on properties such as `$app_version`; mobile SDKs automatically include `$app_version`. Source: https://posthog.com/docs/feature-flags/creating-feature-flags
- Caveat: PostHog remote config flags do not use release conditions according to the creation docs, so version/time targeting belongs on feature flags with payloads rather than pure static remote config.
- Fit: probably the best vendor shape if Helmor already wants product analytics. But it still needs CI/app instrumentation to set `$app_version` and schedule/publish the flag once the final version is known.

### Statsig

- Supports Scheduled Rollouts for Feature Gates; phases execute automatically on configured schedules. Source: https://docs.statsig.com/feature-flags/scheduled-rollouts
- Feature Gates evaluate ordered rules, criteria, split percentages, and SDK checks. Source: https://docs.statsig.com/feature-flags/create
- Criteria include App Version (`>=`, `>`, `<`, `<=`, any/none), Time (`after time`, `before time`), Custom Field date/version comparisons, and mobile SDKs can automatically pass app version and locale. Source: https://docs.statsig.com/feature-flags/conditions
- Fit: can express "current time is inside window" and "app version is this/range" cleanly. It does not know a Changesets-generated release version unless CI updates the gate/config or the app reports version metadata.

### Firebase Remote Config

- Supports remote parameter changes without app updates, targeted segments, app-version targeting, real-time config fetch after publish, and rollouts. Source: https://firebase.google.com/docs/remote-config
- Conditions support `app.version`, `app.build`, `device.dateTime`, `app.firstOpenTimestamp`, user properties, custom signals, and percentage targeting. Source: https://firebase.google.com/docs/remote-config/condition-reference
- Parameter conditions include Date/Time before/after, app version, random percentage, and priority ordering. Source: https://firebase.google.com/docs/remote-config/parameters
- Fit: good for mobile apps already on Firebase. For a Tauri desktop app, the native `app.version` condition is less directly applicable; we would likely need custom signals/user properties or a server-side config fetch. It also still needs a published template/config update after the final release version is known.

### Other tools

- Unleash documents date-based constraints using `currentTime`, so it can schedule a release from a fixed timestamp. Source: https://docs.getunleash.io/guides/how-to-schedule-feature-releases
- ConfigCat exposes APIs to update flag/setting values and targeting rules. Source: https://configcat.com/docs/api/reference/feature-flag-setting-values/
- These are in the same category: useful operational consoles, but not automatic release-version discovery.

## Answer to the key question

Do these tools solve "show this announcement only for a release window" without manual version prediction?

**Partially, but not by themselves.**

- If "release window" means fixed calendar time, yes: LD/PostHog/Statsig can schedule enable/disable; Firebase can evaluate date/time conditions.
- If "release window" means "the first N days after version `x.y.z` is actually released," no: the system must know `x.y.z` and its release timestamp. A vendor can store/evaluate that data, but CI or an internal release service must provide it.
- If "without manual version prediction" means "do not guess the next semver before Changesets decides it," the solution is release-pipeline automation, not a specific flag vendor.

## Recommended Helmor approach

Start first-party and automate it from the release pipeline:

- Add a small hosted JSON/config document such as `announcements.json`.
- Each announcement carries `releaseVersion`, `windowStart`, `windowEnd`, `id`, `title`, `body`, and optional `minVersion`/`maxVersion`.
- The app fetches it opportunistically, caches it, and uses local deterministic checks against `getVersion()` and wall-clock time.
- Generate/update the record after Changesets has produced the final version, so no one predicts the version manually.

Consider PostHog/Statsig/LaunchDarkly only if we already want their broader product-management features. For this single release-announcement use case, a vendor would mainly replace a small JSON file with a dashboard and SDK dependency, while the hard requirement remains the same: CI must publish the real release version/window.
