## Main Research Question

In a Tauri desktop application, what is the best technical approach to implement update checking and background download behavior where:
- the app checks for updates on app launch, on window activation, and optionally every minute
- the app looks for eligible new releases from the project's open source repository releases
- if an applicable update exists, it is downloaded silently in the background
- the user sees no prompt until the download has finished
- after download completion, the app shows a bottom-right in-app notification with actions:
  - View Change Log -> open the release page
  - Update and Restart -> install the update and restart

## Subtopics

1. Tauri v2 updater architecture and official supported flow
Expected information:
- official updater plugins/APIs for desktop apps
- event model for checking, downloading, and installing updates
- whether silent background download is supported

2. Update source options, especially GitHub Releases integration
Expected information:
- how Tauri resolves update manifests/endpoints
- whether GitHub Releases can be used directly or via generated manifests
- release signing, packaging, channels, and version compatibility requirements

3. Triggering strategy and runtime integration
Expected information:
- where to trigger checks in a Tauri app: startup, interval, window focus/activation, app resume
- frontend vs Rust-side orchestration tradeoffs
- deduplication, throttling, and concurrency handling

4. UX implementation for silent download and delayed prompt
Expected information:
- how to suppress early prompts and only notify after download completion
- how to wire a custom in-app toast to updater events
- how to open changelog URLs and perform restart/install safely

5. Constraints, platform caveats, and alternatives
Expected information:
- macOS/Windows/Linux caveats
- Tauri v2 limitations with updater flow and install timing
- security, signing, rollback, and release process implications

## Synthesis Plan

Compare official Tauri updater capabilities against the requested UX. Then recommend a concrete architecture for Helmor with:
- preferred packages/plugins
- release pipeline requirements
- runtime event flow
- user interaction flow
- implementation notes and risk areas
