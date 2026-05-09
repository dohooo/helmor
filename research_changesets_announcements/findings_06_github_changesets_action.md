# Findings 06: GitHub Releases + Changesets Action for In-App Announcements

Date: 2026-05-08

## Question

Can GitHub Releases or `changesets/action` release PR / release notes artifacts be reused directly for in-app announcements, or are they unsuitable for product prompts?

## Short Answer

They are useful as release-management artifacts and as source material, but they are unsuitable as the direct source of in-app product prompts.

The main reason: both GitHub-generated release notes and Changesets action output are developer/release artifacts. They produce Markdown summaries tied to tags, pull requests, packages, and changelog sections. They do not carry the fields an app prompt needs: audience, priority, placement, expiry, dismiss state, CTA, screenshots, localization, or "show once after upgrade" semantics.

## What Changesets Action Produces

- `changesets/action` creates or updates a release PR with package versions and changelogs updated when changesets exist on the base branch.
- With publishing configured, it can publish packages and optionally create GitHub Releases.
- Public action outputs are workflow-centric: `published`, `publishedPackages`, `hasChangesets`, and `pullRequestNumber`.
- Its release PR body is assembled from each changed package's `CHANGELOG.md` entry.
- Its GitHub Release body is also extracted from the matching `CHANGELOG.md` version section.
- The PR body has a max-size fallback that can omit changelog details when too large, so it is not a stable product-copy source.

Sources:
- Changesets action README: https://github.com/changesets/action
- Changesets main README / CI integration: https://github.com/changesets/changesets
- `changesets/action` source, `src/index.ts`: https://github.com/changesets/action/blob/main/src/index.ts
- `changesets/action` source, `src/run.ts`: https://github.com/changesets/action/blob/main/src/run.ts
- `changesets/action` source, changelog extraction helpers: https://github.com/changesets/action/blob/main/src/utils.ts

## What GitHub Release Notes Produce

- GitHub can automatically generate release notes for a GitHub Release.
- Generated notes include merged pull requests, contributors, and a full changelog link.
- Configuration is limited to PR label/author filtering and categories in `.github/release.yml`.
- GitHub REST exposes Releases and a `generate-notes` endpoint; `gh release create --generate-notes` uses that API.
- A release `body` is plain Markdown, not structured announcement metadata.

Sources:
- Automatically generated release notes: https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes
- GitHub Releases REST API: https://docs.github.com/en/rest/releases/releases
- `gh release create --generate-notes`: https://cli.github.com/manual/gh_release_create

## Reuse Assessment

Viable reuse:
- Use the release PR as the human review point for release wording.
- Use the changelog / GitHub Release Markdown as raw input for drafting announcements.
- Link from an in-app announcement to the GitHub Release or changelog for full details.
- In CI, fetch the latest GitHub Release body as a fallback "details" page or debug/reference artifact.

Poor direct reuse:
- Do not show the release PR body directly in-app. It includes action boilerplate and package headings, and may be truncated.
- Do not show GitHub auto-generated notes directly as a modal/banner. They are PR-centric and often include contributor/changelog noise.
- Do not treat GitHub Release publication as sufficient targeting logic. It says what shipped, not who should see it, where, when, or for how long.
- Do not rely on version tags alone for prompts. Users can skip versions, receive delayed updates, or install after multiple releases.

## Product Prompt Gap

In-app announcement systems usually need:

- `id`
- `title`
- concise user-facing body
- CTA label/link
- target app versions or release window
- audience/eligibility
- priority
- placement
- expiry
- dismiss/read tracking
- optional image/video
- localization-ready copy

GitHub Releases and Changesets action artifacts provide only a subset: version/tag, date, Markdown body, package/version list, and URLs.

## Recommendation for Helmor

Use Changesets and GitHub Releases as release-record inputs, not as the announcement source of truth.

Minimal workflow:

1. Keep writing concise Changesets entries for changelog/release notes.
2. During release PR review, optionally add or update a separate app-facing announcement artifact, e.g. `announcements/<id>.json` or a compact Markdown frontmatter file.
3. CI can publish both:
   - GitHub Release from changelog/Changesets.
   - In-app announcement feed from the dedicated announcement artifact.
4. The app should decide display from announcement metadata plus local state, not from raw GitHub Release bodies.

If zero extra authoring is required, the safest compromise is to generate a draft announcement from the release notes, then require review before publishing it to the app feed. Direct automatic reuse is likely to produce noisy, poorly timed, or overly technical prompts.
