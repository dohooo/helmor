---
"helmor": patch
---

Bring full GitLab support to the Add Context sidebar and fix two inbox bugs:
- Add Context now lists GitLab issues and merge requests when the current project lives on GitLab.
- Fix the "Newest" sort behaving identically to "Recently updated" on both GitHub and GitLab — it now actually sorts by creation date.
- Fix inbox pagination silently dropping items when a page returned more results than the page size (e.g. only 20 of 23 issues showing).
