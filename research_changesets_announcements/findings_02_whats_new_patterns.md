# Findings: In-App "What's New" / Release Announcement Patterns

Research date: 2026-05-08

## Short answer

Standard product practice is **not** to show raw changelog or Changesets entries directly as an in-app "What's New" prompt. The common pattern is:

1. Use changelog/release inputs as the **source material** or canonical archive.
2. Maintain or generate a **separate customer-facing announcement draft** with product copy, visuals, targeting, and calls to action.
3. Publish that curated announcement through multiple surfaces: in-app widget/modal/resource center, public changelog page, email, Slack, RSS, or push.

For a Changesets-driven workflow, the safest model is: **Changesets -> release/changelog draft -> curated announcement copy -> in-app prompt**. Automation can prefill the announcement, but product/marketing review is still the standard expectation.

## Evidence

- **Changesets is explicitly changelog/versioning infrastructure, not an announcement system.** Its docs say changesets hold semver bump information plus "change information to be added to a changelog," and the CLI combines changesets into releases and updates changelogs. This makes it a good release source, but not enough for user-facing in-app product announcements.  
  Sources: https://github.com/changesets/changesets, https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md

- **Product communication tools treat announcements as authored product content.** LaunchNotes describes Announcements as flexible product-change communications delivered across website, embedded widget, email, and Slack, organized by categories/cohorts/roadmap items. Its AI Announcement Generator turns internal docs, PRDs, Jira/Linear tickets, and changelog-like notes into a "polished, structured product announcement draft," which implies transformation rather than direct reuse.  
  Sources: https://help.launchnotes.com/en/articles/7173266-announcements, https://www.launchnotes.com/features/ai-announcement-generator, https://help.launchnotes.com/en/articles/5905313-announcement-templates

- **In-app announcement products model "What's New" as a separate UX/content object.** Pendo's Announcements module creates announcement guides in a Resource Center, with text, buttons, images, video, scheduling dates, segmentation, and links. Existing "What's New" guides can be added to the module, but the workflow is guide/content creation, not automatic changelog rendering.  
  Source: https://support.pendo.io/hc/en-us/articles/360032206271-Announcements-module

- **Multi-channel changelog tools often use one product-update object across channels, but still expect polished content.** Beamer positions its notification center around product updates, changelog/release notes, in-app notifications, banners, snippets, popups, tooltip modes, scheduling, segmentation, visuals, and AI-generated clear on-brand changelog posts. Olvy similarly markets an embedded changelog widget and AI release writer for bringing announcements in-app.  
  Sources: https://www.getbeamer.com/in-app-notification-center, https://olvy.co/changelogs

- **Best-practice guidance distinguishes technical changelogs from user-benefit release notes.** Appcues summarizes the split directly: changelogs provide technical precision for developers, while release notes highlight value and benefits for end users; smart SaaS teams publish both. This supports separate or transformed copy for in-app prompts.  
  Source: https://www.appcues.com/blog/changelog-vs-release-notes

- **Public changelog examples are curated editorial surfaces, not raw commit logs.** Linear and Slack organize updates into feature headlines, explanatory paragraphs, visuals, "improvements," "fixes," and "other news." That structure resembles product copy/technical writing layered over release facts.  
  Sources: https://linear.app/changelog, https://slack.com/changelog

- **Changelog pages also serve support, marketing, and feedback-loop roles.** Canny frames a changelog as an official place for new features, awareness/adoption, customer notifications when requested features ship, internal alignment, and marketing transparency. This is broader than a generated package changelog.  
  Source: https://canny.io/blog/canny-changelog/

## Pattern taxonomy

### 1. Separate announcement copy, linked to detailed notes

Common for in-app modals, banners, resource centers, and splash prompts.

- Short, benefit-led headline.
- One or two user-facing bullets or paragraphs.
- Screenshot/GIF/video when useful.
- CTA such as "Try it," "Learn more," "View full changelog," or "Start tour."
- Optional segmentation by plan, role, feature usage, beta cohort, or product area.
- Full release notes or changelog remain elsewhere.

This is the strongest fit for interruptive prompts because the content must be brief, contextual, and dismissible.

### 2. Single product-update object republished across channels

Common in LaunchNotes, Beamer, Olvy, Canny-style tools.

- Team authors one polished product update.
- The same update can appear in a public changelog, in-app widget, email, Slack/RSS, and notification center.
- The content is still product copy, not raw development notes.
- Fields/categories/labels/cohorts determine audience and presentation.

This is operationally efficient if the release entry schema includes enough product-facing metadata.

### 3. Generated draft from engineering/project artifacts

Increasingly common with AI tooling.

- Inputs: changesets, commits, PRs, Jira/Linear tickets, internal notes, PRDs.
- Output: draft release notes or announcement copy.
- Human review/editing remains important for accuracy, tone, prioritization, and whether the change is worth interrupting users.

This fits Helmor if Changesets are treated as source material, not the final prompt text.

## Implications for a Changesets-based release process

- Changeset body should stay concise and release-oriented, but it should not be forced to carry all in-app announcement needs.
- Add a separate announcement layer when a change is user-visible enough for a prompt. Minimal fields could be:
  - `title`
  - `summary`
  - `audience`
  - `ctaLabel`
  - `ctaTarget`
  - `severity/importance`
  - `showInApp`
  - optional `image/video`
- For small patch releases, generate only changelog/release notes and skip the prompt.
- For major or workflow-changing releases, create curated announcement copy and link to the full changelog.
- If automation is desired, generate the in-app copy from changesets plus PR/ticket context, then require review before shipping.

## Recommendation

Use Changesets as the **release fact source**, but maintain in-app "What's New" announcements as **separate curated product copy**. The announcement can be generated from the changelog/changesets as a draft, but should have its own reviewed text, targeting, CTA, and display rules.
