---
"helmor": patch
---

Fix the chat-view table "Download as CSV / Markdown" buttons doing nothing — the download now goes through a native Save dialog and writes the file via the Tauri host, since the webview was silently swallowing streamdown's built-in `<a download>` click.
