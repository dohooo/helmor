---
"helmor": patch
---

Eliminate the chat-thread "shake" when you scroll up fast and stop: measured row heights now settle into place within each scroll frame (the way react-virtuoso and TanStack Virtual measure as rows render) instead of popping in a deferred batch after the scroll stops, and the row-height estimates are aligned to the real measured DOM so any in-scroll correction is sub-pixel.
