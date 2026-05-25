---
"helmor": patch
---

Fix "Import from Slack desktop" failing with a keychain "item not found" error by looking up the Safe Storage key by its stable service name instead of a hard-coded account label, so the import keeps working when Slack renames its keychain account between versions.
