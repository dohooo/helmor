---
"helmor": patch
---

Add a Cleanup button next to Rerun in the Run tab that runs the action's configured `stopCommand` standalone — lets you tear down lingering side effects (docker containers, daemons) left by `supabase start` / `docker compose up` style commands after they exit, so the next Rerun isn't sabotaged by "already running" state.
