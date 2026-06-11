---
"helmor": patch
---

Polish Terminal Mode rendering and the start-page flow:
- The agent TUI now boots at the panel's real size, so its bottom rows no longer render garbled.
- Opening a terminal from the start page no longer gets stuck on a loading screen until you switch tabs.
- New terminal sessions get a generated title from your prompt instead of staying named "Terminal".
- The composer's terminal-mode icon no longer flashes white for a frame while toggling.
- The terminal cursor stays aligned with the TUI input instead of stranding at the top.
