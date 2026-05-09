# Findings 04: onboarding / announcement tools

Research date: 2026-05-08

Question: Can in-app onboarding / announcement tools such as Appcues, Pendo, Userflow, Chameleon, and Intercom target release announcements by version, feature flag, or audience, and reduce app-side release-announcement logic?

## Summary

These tools can reduce most app-side announcement logic, but they do not remove the need for the app to expose targeting facts. The common pattern is:

1. Install the vendor SDK / snippet.
2. Identify the user and send attributes such as `app_version`, `plan`, `role`, `feature_x_enabled`, `first_seen_at`, or company/account fields.
3. Optionally send events such as `opened_settings`, `used_feature_x`, or `completed_tour`.
4. Configure the announcement, tour, banner, or resource-center item in the vendor UI with audience rules, schedule, frequency, and dismissal tracking.

For Helmor, this means these tools can own authoring, scheduling, segmentation, seen/dismissed state, and some analytics. Helmor would still need a thin integration layer to report app version, release channel, feature-flag state, and relevant user/workspace attributes.

## Tool notes

| Tool | Version targeting | Feature-flag targeting | Audience / behavior targeting | Does it reduce app-side logic? |
| --- | --- | --- | --- | --- |
| Appcues | Native mobile app-version targeting supports one or more versions and comparators such as greater-than / less-than. Web can target by custom user/group properties, so desktop/web apps can send `app_version` as a property. | Appcues documents a LaunchDarkly + Segment pattern where LaunchDarkly feature-gate properties are passed into Appcues and selected as targeting criteria. | Audience rules support user properties, group properties, segments, events, prior flow/banner/checklist interactions, date/recency/count options, and AND/OR logic. | Yes. Appcues can own rule evaluation, scheduling/frequency, and seen state after Helmor sends properties/events. It does not infer desktop release versions unless Helmor reports them. |
| Pendo | Segment rules include mobile data rules such as app version and SDK version. For desktop/web, version targeting would likely be metadata passed through the install script unless using Pendo mobile capture. | No strong native feature-flag announcement workflow found in the reviewed docs. Practically, flags can be mirrored as visitor/account metadata or product-usage segments; LaunchDarkly integration evidence was weaker than Appcues. | Announcements module supports release notes / new feature announcements, unread badges, per-module or per-announcement segments, staging, public status, scheduling, and optional end date. Segment rules support product usage, visitor metadata, account metadata, mobile data, nested AND/OR groups, pages/features/events. | Yes, especially if Helmor only needs resource-center announcements and scheduled guides. App still needs to send version/flag metadata and install Pendo. |
| Userflow | No native release-version field found. It supports attribute-based segments, so Helmor can send `app_version` / `release_channel` as user or company attributes. | No native feature-flag integration found in the reviewed docs. Flags can be sent as attributes or represented by events/segments. | Announcements support scheduled publish time, silent/badge/boosted popout/modal/toast levels, and `Only show announcement if` targeting. Segments can be attribute-based, event-based, manual CSV/UI lists, or integration-powered; event segments update in real time. | Yes. Userflow is a good fit for no-code announcement authoring and targeting once attributes/events are reported. It still needs Helmor to provide release/flag facts. |
| Chameleon | No native release-version targeting found. Custom data from APIs or integrations can be used in segments, so app version can be sent as a custom property. | No direct feature-flag docs found in this pass. Feature-flag state can be sent as custom data or synced from a connected tool if available. | Experiences can target pre-built audiences or custom segments. Segments can use automatic data, custom data, integration data, user/company properties, custom events, experience events, synced audiences, and user tags. Chameleon re-evaluates users as they move in/out of segments. | Yes for targeting and display orchestration. Helmor still has to send version/flag/audience attributes; Chameleon can then manage who sees tours, tooltips, embeddables, microsurveys, launchers, and HelpBar items. |
| Intercom Product Tours / Outbound | No native app-version targeting found. Use custom data attributes such as `app_version` if Helmor sends them. | No native feature-flag targeting found. Send feature flag state as custom attributes or events, then use audience rules. | Product Tours can auto-show when users visit target URLs, with event/date triggers and audience filters. Intercom custom data attributes can be used for filtering, segments, targeted messages, and campaigns. Dynamic audiences match now/future users; Fixed audiences are explicitly recommended for feature/update announcements but are paused after 30 days for tours/surveys/carousels. | Partial. Intercom can reduce message/tour targeting and one-off announcement logic, but Product Tours are page/URL-oriented and may fit a desktop Tauri app less naturally than tools built around in-app resource centers or launchers. |

## Practical implications for Helmor

- Best vendor-supported shape: send a small, stable targeting envelope from Helmor, for example `app_version`, `release_channel`, `platform`, `is_dev_build`, `feature_flags`, `workspace_count`, `has_github_identity`, and maybe `previous_app_version` if available.
- These tools reduce UI/product logic more than release logic. They can prevent building a custom resource center, seen-state table, audience rule engine, and scheduling UI. They do not eliminate the need to know or report the installed version if announcements are version-specific.
- Feature-flag targeting is strongest when a real flag service is already in the loop. Appcues has the clearest documented LaunchDarkly + Segment pattern. For the other tools, flag targeting is mostly "mirror the flag as an attribute/event and segment on it."
- For release announcements, "audience + release window" is usually safer than exact version prediction. Example: show a `2.4` announcement to users with `app_version >= 2.4.0`, `first_seen_before_release_date = true`, `has_seen_announcement_2_4 != true`, and schedule/end-date rules in the tool.
- For a local-first desktop app, evaluate privacy/offline impact carefully. Most tools assume SaaS-style user identification and cloud-side targeting. If Helmor wants fully local/offline behavior, a lightweight built-in announcement manifest may be simpler.

## Sources

- Appcues audience targeting: https://docs.appcues.com/user-experiences-targeting/audience-targeting
- Appcues mobile app-version targeting: https://docs.appcues.com/targeting-and-publishing-mobile-flows
- Appcues + LaunchDarkly + Segment feature adoption: https://docs.appcues.com/integration-use-cases/increase-feature-adoption-launchdarkly-segment
- Pendo Announcements module: https://support.pendo.io/hc/en-us/articles/360032206271-Announcements-module
- Pendo segment rules: https://support.pendo.io/hc/en-us/articles/32271753394203-Segment-rules
- Userflow Announcements: https://help.userflow.com/docs/announcements
- Userflow Users and Segments: https://help.userflow.com/docs/users-and-segments
- Chameleon targeting / segments: https://help.chameleon.io/en/articles/1500422-how-can-i-target-my-experiences-to-the-right-users
- Intercom automatically show Product Tours: https://www.intercom.com/help/en/articles/2900893-automatically-show-your-product-tour-to-the-right-customers
- Intercom custom data attributes: https://www.intercom.com/help/en/articles/179-create-and-track-custom-data-attributes-cdas
- Intercom dynamic and fixed audiences: https://www.intercom.com/help/en/articles/3467924-dynamic-and-fixed-audiences
