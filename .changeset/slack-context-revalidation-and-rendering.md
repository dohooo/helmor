---
"helmor": patch
---

Polish Slack and Forge context details:
- Refresh Slack, GitHub, and GitLab detail panels automatically when the panel opens or the window regains focus, plus a manual refresh button in the toolbar next to the open-externally / add-context controls.
- Resolve Slack `<@U…>` user mentions to `@displayname` in thread snippets and message bodies so they read like the Slack client instead of opaque user ids.
- Cap inline Slack image previews at half the message body width and display the full image at its natural aspect ratio, so tall screenshots no longer crop or leave letterbox padding around the frame.
- Fix "Import from Slack desktop" failing with `AES-CBC Unpad Error` when the macOS Keychain holds multiple "Slack Safe Storage" entries (e.g. leftover Mac App Store key alongside the standalone build) by trying every candidate key and using the one that actually decrypts the cookie.
