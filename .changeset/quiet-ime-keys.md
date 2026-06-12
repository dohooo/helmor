---
"helmor": patch
---

Fix Chinese IME input in terminal sessions:
- Full-width punctuation (e.g. ？) typed with a Chinese input method no longer gets swallowed.
- Switching to another input method mid-composition no longer commits pinyin letters with stray spaces.
