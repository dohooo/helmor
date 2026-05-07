---
"helmor": patch
---

Fix two issues with workspace working-directory handling:
- Stop the first message in a newly-created workspace from running with the wrong directory, which caused the second turn to fail with "The provider returned an empty response."
- Refuse to start an agent turn when the working directory is missing, instead of silently falling back to the app's process cwd.
