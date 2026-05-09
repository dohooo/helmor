Main question: Is there a standard, low-custom-logic workflow for in-app "what's new" / release announcement prompts in a Changesets-based desktop app release process, without manually binding announcements to versions or changeset IDs?

Subtopics:
- Changesets official lifecycle, APIs, and whether it has a standard extension point for app-facing release metadata.
- Release notes/changelog standards and whether product announcements should be generated from changelog entries.
- Desktop app upgrade detection patterns: previous version vs current version, first-run-after-update hooks, Tauri/Electron conventions.
- In-app announcement/onboarding tools: Appcues, Pendo, Intercom, LaunchDarkly, PostHog, Userflow, Chameleon and their targeting models.
- Feature flag/remote config approaches for release announcements and how they avoid app rebuild/version binding.
- GitHub Releases / Changesets action workflows and whether release metadata can be reused.
- Semantic-release / release-please / Changesets comparison for release metadata automation.
- Practical schema patterns used in apps: validFrom/validUntil, release windows, audience targeting, expiry.
- Failure modes: delayed releases, grouped patch/minor changes, skipped versions, users jumping many versions.
- Recommendation for Helmor: minimal implementation using existing tooling first, external service optional.

Synthesis:
- Identify what official tooling can own.
- Identify whether a true standard exists.
- Prefer workflows that avoid manual version prediction and reduce duplicated release bookkeeping.
- Provide a concise operational workflow for each viable option.
