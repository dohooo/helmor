---
"helmor": patch
---

Improve Claude model handling:
- The default Claude model is pinned to Opus 4.8 (1M context) so it can't silently switch to a different model when the bundled Claude CLI updates; existing sessions and settings keep the same model.
- Terminal mode is now limited to official Claude models — custom (BYOK) Claude models run in GUI mode instead, since the terminal can't carry their custom provider settings.
