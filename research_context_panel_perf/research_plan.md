Main question: Can React APIs such as Suspense, transitions, or related patterns reduce the perceived lag when opening Helmor's Context sidebar?

Subtopics:
- React concurrency APIs: identify which APIs improve input responsiveness versus which only coordinate loading.
- Lazy mounting and pre-rendering: compare Suspense/lazy loading, hidden warm mounts, and deferred rendering for sidebars.
- Browser rendering costs: identify layout/paint causes that React APIs cannot hide and mitigation tactics.

Synthesis:
- Convert findings into a short action list tailored to the current Context sidebar behavior: no IPC delay, DOM appears around 55ms, first paint is delayed around 130ms, second frame around 350ms.
