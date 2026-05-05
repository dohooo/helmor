---
"helmor": patch
---

Poll for the new login after the GitHub/GitLab connect dialog closes so a brief flush delay between `gh auth login` finishing and writing its config no longer leaves the Connect button stuck in the unconnected state.
