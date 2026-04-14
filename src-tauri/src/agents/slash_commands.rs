//! Slash command cache and local skill/command scanner.
//!
//! Provides two capabilities:
//!
//! 1. **Local scanning**: reads `~/.claude/skills/` and `~/.claude/commands/`
//!    directly from disk, returning results in < 5 ms with no sidecar round-trip.
//!
//! 2. **In-memory cache**: stores the last successful full result (from the
//!    sidecar/SDK) per `(provider, cwd, model)` key so subsequent `/` presses
//!    resolve instantly.
//!
//! Together these enable progressive loading: the user sees local skills
//! immediately while the full SDK result loads in the background.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

use serde::Serialize;

use super::queries::SlashCommandEntry;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CacheKey = (String, String, String); // (provider, cwd, model)

struct CachedResult {
    commands: Vec<SlashCommandEntry>,
    is_complete: bool,
}

pub struct SlashCommandCache {
    entries: RwLock<HashMap<CacheKey, CachedResult>>,
    /// Prevents concurrent background sidecar refreshes.
    refreshing: AtomicBool,
}

impl Default for SlashCommandCache {
    fn default() -> Self {
        Self::new()
    }
}

impl SlashCommandCache {
    pub fn new() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            refreshing: AtomicBool::new(false),
        }
    }

    pub fn get(&self, key: &CacheKey) -> Option<(Vec<SlashCommandEntry>, bool)> {
        self.entries
            .read()
            .ok()?
            .get(key)
            .map(|c| (c.commands.clone(), c.is_complete))
    }

    pub fn set(&self, key: CacheKey, commands: Vec<SlashCommandEntry>, is_complete: bool) {
        if let Ok(mut map) = self.entries.write() {
            map.insert(
                key,
                CachedResult {
                    commands,
                    is_complete,
                },
            );
        }
    }

    /// Try to claim the refresh lock.  Returns `true` if this caller won.
    pub fn try_start_refresh(&self) -> bool {
        self.refreshing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn finish_refresh(&self) {
        self.refreshing.store(false, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Local skill/command scanner
// ---------------------------------------------------------------------------

/// Scan skills and commands from disk following the Claude Code precedence:
///
///   1. Personal skills  — `~/.claude/skills/<name>/SKILL.md`
///   2. Project skills   — `<cwd>/.claude/skills/<name>/SKILL.md`
///   3. Personal commands — `~/.claude/commands/<name>.md`
///   4. Project commands  — `<cwd>/.claude/commands/<name>.md`
///
/// Dedup by name (first occurrence wins), so higher-priority locations
/// shadow lower ones.  Skills always shadow same-named commands because
/// they are scanned first.
pub fn scan_local_commands(working_directory: Option<&str>) -> Vec<SlashCommandEntry> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };

    let claude_dir = home.join(".claude");
    let mut entries = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // 1. Personal skills — ~/.claude/skills/*/SKILL.md (highest priority)
    scan_skills_dir(&claude_dir.join("skills"), &mut entries, &mut seen);

    // 2. Project skills — <cwd>/.claude/skills/*/SKILL.md
    if let Some(cwd) = working_directory {
        let project_skills = Path::new(cwd).join(".claude").join("skills");
        scan_skills_dir(&project_skills, &mut entries, &mut seen);
    }

    // 3. Personal commands — ~/.claude/commands/*.md
    //    (same-named skills from steps 1–2 take precedence via `seen` set)
    scan_commands_dir(&claude_dir.join("commands"), &mut entries, &mut seen);

    // 4. Project commands — <cwd>/.claude/commands/*.md (lowest priority)
    if let Some(cwd) = working_directory {
        let project_cmds = Path::new(cwd).join(".claude").join("commands");
        scan_commands_dir(&project_cmds, &mut entries, &mut seen);
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

/// Read `<dir>/<name>/SKILL.md` for every subdirectory.
fn scan_skills_dir(
    dir: &Path,
    out: &mut Vec<SlashCommandEntry>,
    seen: &mut std::collections::HashSet<String>,
) {
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read_dir.flatten() {
        // Follow symlinks: metadata() traverses symlinks, symlink_metadata() does not.
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let skill_file = entry.path().join("SKILL.md");
        let Ok(content) = std::fs::read_to_string(&skill_file) else {
            continue;
        };
        if let Some(fm) = parse_frontmatter(&content) {
            if seen.insert(fm.name.clone()) {
                out.push(SlashCommandEntry {
                    name: fm.name,
                    description: fm.description,
                    argument_hint: fm.argument_hint,
                    source: "skill".to_string(),
                });
            }
        }
    }
}

/// Read `<dir>/*.md` files (skip `.bak` etc.).  Name is inferred from filename.
fn scan_commands_dir(
    dir: &Path,
    out: &mut Vec<SlashCommandEntry>,
    seen: &mut std::collections::HashSet<String>,
) {
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str());
        if ext != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let fm = parse_frontmatter(&content);
        let name = fm
            .as_ref()
            .and_then(|f| {
                if f.name.is_empty() {
                    None
                } else {
                    Some(f.name.clone())
                }
            })
            .unwrap_or_else(|| stem.to_string());
        let description = fm
            .as_ref()
            .map(|f| f.description.clone())
            .unwrap_or_default();
        let argument_hint = fm.as_ref().and_then(|f| f.argument_hint.clone());

        if seen.insert(name.clone()) {
            out.push(SlashCommandEntry {
                name,
                description,
                argument_hint,
                source: "skill".to_string(),
            });
        }
    }
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser (no external crate)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ParsedFrontmatter {
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
}

/// Extract `name`, `description`, and `argument-hint` from YAML frontmatter
/// delimited by `---`.  Handles simple scalars, quoted values, and block
/// scalars (`|` / `>`).
pub fn parse_frontmatter(content: &str) -> Option<ParsedFrontmatter> {
    let content = content.trim_start();
    if !content.starts_with("---") {
        return None;
    }
    let after_open = &content[3..];
    let close_idx = after_open.find("\n---")?;
    let block = &after_open[..close_idx];

    let mut name = None;
    let mut description = None;
    let mut argument_hint = None;

    let lines: Vec<&str> = block.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];

        if let Some(val) = strip_key(line, "name:") {
            name = Some(unquote(val));
        } else if let Some(val) = strip_key(line, "description:") {
            description = Some(collect_value(val, &lines, &mut i));
        } else if let Some(val) = strip_key(line, "argument-hint:") {
            argument_hint = Some(collect_value(val, &lines, &mut i));
        }
        i += 1;
    }

    let name = name.filter(|n| !n.is_empty())?;
    let description = description.unwrap_or_default();
    if description.is_empty() {
        return None;
    }

    Some(ParsedFrontmatter {
        name,
        description,
        argument_hint: argument_hint.filter(|h| !h.is_empty()),
    })
}

/// Strip a YAML key prefix (e.g. `"description:"`) and return the remainder trimmed.
fn strip_key<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let trimmed = line.trim_start();
    trimmed.strip_prefix(key).map(str::trim)
}

/// If `val` is a block scalar indicator (`|` or `>`), collect indented
/// continuation lines.  Otherwise return the inline value (unquoted).
fn collect_value(val: &str, lines: &[&str], i: &mut usize) -> String {
    let val = val.trim();
    if val == "|" || val == ">" {
        let fold = val == ">";
        let mut parts = Vec::new();
        while *i + 1 < lines.len() {
            let next = lines[*i + 1];
            if next.is_empty() || next.starts_with(' ') || next.starts_with('\t') {
                parts.push(next.trim());
                *i += 1;
            } else {
                break;
            }
        }
        if fold {
            parts.join(" ")
        } else {
            parts.join("\n")
        }
    } else {
        unquote(val)
    }
}

/// Strip surrounding quotes (`"` or `'`) from a YAML scalar value.
fn unquote(val: &str) -> String {
    let val = val.trim();
    if (val.starts_with('"') && val.ends_with('"'))
        || (val.starts_with('\'') && val.ends_with('\''))
    {
        val[1..val.len() - 1].to_string()
    } else {
        val.to_string()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_frontmatter() {
        let input = r#"---
name: find-skills
description: Helps users discover and install agent skills.
---
body text
"#;
        let fm = parse_frontmatter(input).unwrap();
        assert_eq!(fm.name, "find-skills");
        assert_eq!(
            fm.description,
            "Helps users discover and install agent skills."
        );
        assert!(fm.argument_hint.is_none());
    }

    #[test]
    fn parse_block_scalar_description() {
        let input = "---\nname: investigate\ndescription: |\n  Systematic debugging.\n  Four phases.\n---\n";
        let fm = parse_frontmatter(input).unwrap();
        assert_eq!(fm.name, "investigate");
        assert_eq!(fm.description, "Systematic debugging.\nFour phases.");
    }

    #[test]
    fn parse_folded_scalar_description() {
        let input = "---\nname: review\ndescription: >\n  First line.\n  Second line.\n---\n";
        let fm = parse_frontmatter(input).unwrap();
        assert_eq!(fm.name, "review");
        assert_eq!(fm.description, "First line. Second line.");
    }

    #[test]
    fn parse_quoted_values() {
        let input = "---\nname: \"my-skill\"\ndescription: 'A cool skill'\n---\n";
        let fm = parse_frontmatter(input).unwrap();
        assert_eq!(fm.name, "my-skill");
        assert_eq!(fm.description, "A cool skill");
    }

    #[test]
    fn parse_command_with_argument_hint() {
        let input = "---\ndescription: Polish code\nargument-hint: [base-branch]\n---\n";
        // Commands may have no `name` — parse_frontmatter returns None.
        let fm = parse_frontmatter(input);
        assert!(fm.is_none());
    }

    #[test]
    fn parse_command_with_name_and_hint() {
        let input =
            "---\nname: polish\ndescription: Polish code\nargument-hint: [base-branch]\n---\n";
        let fm = parse_frontmatter(input).unwrap();
        assert_eq!(fm.name, "polish");
        assert_eq!(fm.argument_hint, Some("[base-branch]".to_string()));
    }

    #[test]
    fn missing_frontmatter_returns_none() {
        assert!(parse_frontmatter("no frontmatter here").is_none());
    }

    #[test]
    fn missing_description_returns_none() {
        let input = "---\nname: test\n---\n";
        assert!(parse_frontmatter(input).is_none());
    }

    #[test]
    fn scan_local_commands_returns_empty_for_nonexistent() {
        // With a bogus HOME, nothing should be found and it should not panic.
        std::env::set_var("HOME", "/tmp/helmor-test-nonexistent-dir");
        let result = scan_local_commands(None);
        assert!(result.is_empty());
    }
}
