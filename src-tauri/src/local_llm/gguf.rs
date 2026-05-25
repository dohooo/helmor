//! Minimal GGUF metadata reader. Reads the header + KV pairs, skips
//! the tensor index. Used by the Local LLM panel so custom GGUFs the
//! user pastes in (outside our curated catalog) still get accurate
//! "trained max context" + "KV cache bytes/token" estimates instead
//! of falling back to a hand-wavy 32K guess.
//!
//! References:
//!   - GGUF spec: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
//!   - llama.cpp metadata key naming:
//!     https://github.com/ggml-org/llama.cpp/blob/master/src/llama-arch.cpp
//!
//! We support GGUF v2 and v3 (the only versions llama-server still
//! reads). v1 is a relic from 2023 — if we ever hit it the parser
//! returns a clear error and the caller falls back to the constant.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use anyhow::{anyhow, Context, Result};

const GGUF_MAGIC: u32 = 0x4655_4747; // b"GGUF" little-endian

/// Upper bound on top-level metadata KV count. Real GGUFs sit at ~30-200
/// KVs; even tokenizer-heavy models stay under 500. The header field is
/// `u64` and we deref it into `HashMap::with_capacity`, so without a cap
/// a corrupt / malicious file can force a massive allocation before we
/// ever read a byte of payload. 10K is ~50× the largest legitimate count
/// we've seen — buy headroom, bail past it.
const MAX_METADATA_KV_COUNT: u64 = 10_000;
/// Cumulative bound on bytes read into metadata strings/arrays. The
/// per-string cap (64 MB) is already restrictive but says nothing about
/// totals — `MAX_METADATA_KV_COUNT × per-string cap` is ~640 GB. Real
/// GGUF metadata sits under 100 MB even with full tokenizer vocab.
/// 256 MB buys generous headroom for unusual layouts while keeping a
/// corrupted file from OOMing the host.
const MAX_METADATA_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

/// Subset of GGUF metadata Helmor consumes. Other 30+ keys (rope params,
/// quantization metadata, tokenizer vocab, ...) are read off the wire
/// then dropped — we only keep what drives the context-window UI.
#[derive(Debug, Clone)]
pub struct ModelMetadata {
    /// Architecture string from `general.architecture` (llama / qwen2 /
    /// qwen3 / mistral / phi3 / gemma / ...). The other metadata keys
    /// are namespaced under this prefix.
    pub architecture: String,
    /// `general.name` — friendly model label for the panel header. Often
    /// missing or generic; callers should fall back to the filename.
    pub name: Option<String>,
    /// `<arch>.context_length` — the trained context window. UI clamps
    /// the slider to this; below this the model just stays accurate,
    /// above it accuracy collapses (positional encoding extrapolation).
    pub context_length: u32,
    /// Total transformer blocks (`<arch>.block_count`). Drives KV cache
    /// sizing — every block has its own K + V tensor.
    pub block_count: u32,
    /// Model hidden size (`<arch>.embedding_length`). Combined with
    /// head_count gives the per-head dim.
    pub embedding_length: u32,
    /// Query attention heads (`<arch>.attention.head_count`).
    pub head_count: u32,
    /// KV heads (`<arch>.attention.head_count_kv`). Equal to
    /// `head_count` for plain MHA; smaller for GQA / MQA. Most modern
    /// models (Llama 3, Qwen 2/3) are GQA so this is the bit that
    /// makes KV cache 4-8× smaller than naive.
    pub kv_head_count: u32,
}

impl ModelMetadata {
    /// Bytes of fp16 KV cache per token. Matches what llama-server
    /// actually allocates at startup when `-ctk f16 -ctv f16` (the
    /// default). Formula: `2 (K and V) × kv_heads × head_dim × layers × 2 (fp16)`.
    pub fn kv_bytes_per_token(&self) -> u32 {
        if self.head_count == 0 {
            return 0;
        }
        let head_dim = self.embedding_length / self.head_count.max(1);
        let kv_heads = self.kv_head_count.max(1);
        // 2 tensors (K, V) × kv_heads × head_dim × layers × 2 bytes (fp16)
        // = 4 × kv_heads × head_dim × layers
        kv_heads
            .saturating_mul(head_dim)
            .saturating_mul(self.block_count)
            .saturating_mul(4)
    }
}

/// One typed metadata value as parsed from the GGUF KV stream. We only
/// expose the variants Helmor reads (scalar ints, strings); anything
/// else is parsed and dropped silently so the cursor advances past it.
#[derive(Debug, Clone)]
enum MetaValue {
    U64(u64),
    String(String),
    Other,
}

impl MetaValue {
    fn as_u64(&self) -> Option<u64> {
        match self {
            MetaValue::U64(v) => Some(*v),
            _ => None,
        }
    }
    fn as_str(&self) -> Option<&str> {
        match self {
            MetaValue::String(v) => Some(v.as_str()),
            _ => None,
        }
    }
}

pub fn read_metadata(path: &Path) -> Result<ModelMetadata> {
    // Extension sniff first — turns "tried to read a .png" into a clear
    // "unsupported file type" instead of "bad magic 89504e47".
    let extension_ok = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false);
    if !extension_ok {
        return Err(anyhow!(
            "Unsupported file type — only `.gguf` models are accepted (got {})",
            path.display()
        ));
    }
    if !path.is_file() {
        return Err(anyhow!("File not found: {}", path.display()));
    }
    let file = File::open(path)
        .with_context(|| format!("open {} for GGUF metadata read", path.display()))?;
    // 1 MB buffer covers virtually every model's KV section in one read;
    // the parser only needs sequential access, not random seeks.
    let mut reader = BufReader::with_capacity(1024 * 1024, file);

    let magic = read_u32(&mut reader)?;
    if magic != GGUF_MAGIC {
        return Err(anyhow!(
            "Not a valid GGUF file — header magic mismatch (file may be truncated or in a different format)"
        ));
    }
    let version = read_u32(&mut reader)?;
    if !(2..=3).contains(&version) {
        return Err(anyhow!(
            "unsupported GGUF version {version} (Helmor reads v2 and v3)"
        ));
    }
    // v2/v3 both use u64 counts here. v1 used u32, but we bail above.
    let _tensor_count = read_u64(&mut reader)?;
    let metadata_kv_count = read_u64(&mut reader)?;
    if metadata_kv_count > MAX_METADATA_KV_COUNT {
        return Err(anyhow!(
            "absurd metadata KV count {metadata_kv_count} in GGUF header (cap {MAX_METADATA_KV_COUNT})"
        ));
    }

    let mut kvs: HashMap<String, MetaValue> = HashMap::with_capacity(metadata_kv_count as usize);
    let mut budget = MAX_METADATA_TOTAL_BYTES;
    for _ in 0..metadata_kv_count {
        let key = read_string(&mut reader, &mut budget)?;
        let value = read_value(&mut reader, &mut budget)?;
        kvs.insert(key, value);
    }

    let architecture = kvs
        .get("general.architecture")
        .and_then(MetaValue::as_str)
        .ok_or_else(|| anyhow!("GGUF missing `general.architecture`"))?
        .to_string();

    let name = kvs
        .get("general.name")
        .and_then(MetaValue::as_str)
        .map(str::to_owned);

    let arch_key = |suffix: &str| format!("{architecture}.{suffix}");
    let lookup_u32 = |suffix: &str| -> Option<u32> {
        kvs.get(&arch_key(suffix))
            .and_then(MetaValue::as_u64)
            .and_then(|v| u32::try_from(v).ok())
    };

    let context_length = lookup_u32("context_length")
        .ok_or_else(|| anyhow!("GGUF missing `{architecture}.context_length`"))?;
    let block_count = lookup_u32("block_count")
        .ok_or_else(|| anyhow!("GGUF missing `{architecture}.block_count`"))?;
    let embedding_length = lookup_u32("embedding_length")
        .ok_or_else(|| anyhow!("GGUF missing `{architecture}.embedding_length`"))?;
    let head_count = lookup_u32("attention.head_count")
        .ok_or_else(|| anyhow!("GGUF missing `{architecture}.attention.head_count`"))?;
    // GQA models declare a distinct `head_count_kv`; pure-MHA models
    // (early Llama 2, some Mistral variants) omit it and we fall back
    // to `head_count`.
    let kv_head_count = lookup_u32("attention.head_count_kv").unwrap_or(head_count);

    Ok(ModelMetadata {
        architecture,
        name,
        context_length,
        block_count,
        embedding_length,
        head_count,
        kv_head_count,
    })
}

// ---------------------------------------------------------------------------
// Low-level decoders. Everything in GGUF is little-endian. The reader
// is `Read` (sequential only) because GGUF metadata + tensor descriptors
// stream front-to-back without needing seeks.
// ---------------------------------------------------------------------------

fn read_u8(reader: &mut impl Read) -> Result<u8> {
    let mut buf = [0u8; 1];
    reader.read_exact(&mut buf)?;
    Ok(buf[0])
}
fn read_u16(reader: &mut impl Read) -> Result<u16> {
    let mut buf = [0u8; 2];
    reader.read_exact(&mut buf)?;
    Ok(u16::from_le_bytes(buf))
}
fn read_u32(reader: &mut impl Read) -> Result<u32> {
    let mut buf = [0u8; 4];
    reader.read_exact(&mut buf)?;
    Ok(u32::from_le_bytes(buf))
}
fn read_u64(reader: &mut impl Read) -> Result<u64> {
    let mut buf = [0u8; 8];
    reader.read_exact(&mut buf)?;
    Ok(u64::from_le_bytes(buf))
}
fn read_i8(reader: &mut impl Read) -> Result<i8> {
    Ok(read_u8(reader)? as i8)
}
fn read_i16(reader: &mut impl Read) -> Result<i16> {
    Ok(read_u16(reader)? as i16)
}
fn read_i32(reader: &mut impl Read) -> Result<i32> {
    Ok(read_u32(reader)? as i32)
}
fn read_i64(reader: &mut impl Read) -> Result<i64> {
    Ok(read_u64(reader)? as i64)
}
fn read_f32(reader: &mut impl Read) -> Result<f32> {
    Ok(f32::from_bits(read_u32(reader)?))
}
fn read_f64(reader: &mut impl Read) -> Result<f64> {
    Ok(f64::from_bits(read_u64(reader)?))
}
fn read_bool(reader: &mut impl Read) -> Result<bool> {
    Ok(read_u8(reader)? != 0)
}
fn debit_budget(budget: &mut u64, n: u64) -> Result<()> {
    if n > *budget {
        return Err(anyhow!(
            "GGUF metadata exceeds {MAX_METADATA_TOTAL_BYTES}-byte cumulative cap"
        ));
    }
    *budget -= n;
    Ok(())
}

fn read_string(reader: &mut impl Read, budget: &mut u64) -> Result<String> {
    let len = read_u64(reader)?;
    if len > 64 * 1024 * 1024 {
        // Largest legitimate string is the tokenizer vocab JSON ≪ 64 MB.
        // Anything past this is a corrupt header — bail before alloc.
        return Err(anyhow!("absurd string length {len} in GGUF metadata"));
    }
    debit_budget(budget, len)?;
    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf)?;
    String::from_utf8(buf).map_err(|e| anyhow!("non-UTF8 string in GGUF metadata: {e}"))
}

fn read_value(reader: &mut impl Read, budget: &mut u64) -> Result<MetaValue> {
    let type_id = read_u32(reader)?;
    read_value_typed(reader, type_id, budget)
}

fn read_value_typed(reader: &mut impl Read, type_id: u32, budget: &mut u64) -> Result<MetaValue> {
    match type_id {
        0 => Ok(MetaValue::U64(read_u8(reader)? as u64)),
        1 => Ok(MetaValue::U64(read_i8(reader)? as u64)),
        2 => Ok(MetaValue::U64(read_u16(reader)? as u64)),
        3 => Ok(MetaValue::U64(read_i16(reader)? as u64)),
        4 => Ok(MetaValue::U64(read_u32(reader)? as u64)),
        5 => Ok(MetaValue::U64(read_i32(reader)? as u64)),
        6 => {
            // Discard f32 value (we don't surface any float-typed keys).
            let _ = read_f32(reader)?;
            Ok(MetaValue::Other)
        }
        7 => {
            let _ = read_bool(reader)?;
            Ok(MetaValue::Other)
        }
        8 => Ok(MetaValue::String(read_string(reader, budget)?)),
        9 => {
            // Array: inner type (u32) + length (u64) + values
            let inner_type = read_u32(reader)?;
            let len = read_u64(reader)?;
            if len > 1024 * 1024 {
                return Err(anyhow!("absurd array length {len} in GGUF metadata"));
            }
            for _ in 0..len {
                read_value_typed(reader, inner_type, budget)?;
            }
            Ok(MetaValue::Other)
        }
        10 => Ok(MetaValue::U64(read_u64(reader)?)),
        11 => Ok(MetaValue::U64(read_i64(reader)? as u64)),
        12 => {
            let _ = read_f64(reader)?;
            Ok(MetaValue::Other)
        }
        other => Err(anyhow!("unknown GGUF value type {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::{Builder, NamedTempFile};

    fn gguf_tempfile() -> NamedTempFile {
        Builder::new().suffix(".gguf").tempfile().unwrap()
    }

    /// Build a synthetic GGUF v3 header + just enough metadata KVs to
    /// satisfy `read_metadata`. Mirrors what llama.cpp's `gguf-writer`
    /// would produce for a typical model.
    fn write_min_gguf(tensor_count: u64, kvs: Vec<(&str, Kv)>) -> NamedTempFile {
        let mut file = gguf_tempfile();
        let f = file.as_file_mut();
        f.write_all(&GGUF_MAGIC.to_le_bytes()).unwrap();
        f.write_all(&3u32.to_le_bytes()).unwrap();
        f.write_all(&tensor_count.to_le_bytes()).unwrap();
        f.write_all(&(kvs.len() as u64).to_le_bytes()).unwrap();
        for (k, v) in kvs {
            write_string(f, k);
            v.write(f);
        }
        file
    }

    fn write_string(f: &mut std::fs::File, s: &str) {
        f.write_all(&(s.len() as u64).to_le_bytes()).unwrap();
        f.write_all(s.as_bytes()).unwrap();
    }

    enum Kv {
        Str(String),
        U32(u32),
    }
    impl Kv {
        fn write(&self, f: &mut std::fs::File) {
            match self {
                Kv::Str(s) => {
                    f.write_all(&8u32.to_le_bytes()).unwrap();
                    write_string(f, s);
                }
                Kv::U32(v) => {
                    f.write_all(&4u32.to_le_bytes()).unwrap();
                    f.write_all(&v.to_le_bytes()).unwrap();
                }
            }
        }
    }

    #[test]
    fn parses_minimal_llama_gguf() {
        let file = write_min_gguf(
            0,
            vec![
                ("general.architecture", Kv::Str("llama".into())),
                ("general.name", Kv::Str("Llama 3 8B".into())),
                ("llama.context_length", Kv::U32(8192)),
                ("llama.block_count", Kv::U32(32)),
                ("llama.embedding_length", Kv::U32(4096)),
                ("llama.attention.head_count", Kv::U32(32)),
                ("llama.attention.head_count_kv", Kv::U32(8)),
            ],
        );
        let meta = read_metadata(file.path()).unwrap();
        assert_eq!(meta.architecture, "llama");
        assert_eq!(meta.name.as_deref(), Some("Llama 3 8B"));
        assert_eq!(meta.context_length, 8192);
        assert_eq!(meta.block_count, 32);
        assert_eq!(meta.head_count, 32);
        assert_eq!(meta.kv_head_count, 8);
        // head_dim = 4096 / 32 = 128. KV/token = 4 × 8 × 128 × 32 = 131_072
        assert_eq!(meta.kv_bytes_per_token(), 131_072);
    }

    #[test]
    fn falls_back_to_head_count_when_kv_count_absent() {
        // Pre-GQA MHA model — only one head_count present.
        let file = write_min_gguf(
            0,
            vec![
                ("general.architecture", Kv::Str("llama".into())),
                ("llama.context_length", Kv::U32(2048)),
                ("llama.block_count", Kv::U32(32)),
                ("llama.embedding_length", Kv::U32(4096)),
                ("llama.attention.head_count", Kv::U32(32)),
            ],
        );
        let meta = read_metadata(file.path()).unwrap();
        assert_eq!(meta.kv_head_count, 32);
        // KV/token = 4 × 32 × 128 × 32 = 524_288
        assert_eq!(meta.kv_bytes_per_token(), 524_288);
    }

    #[test]
    fn rejects_files_without_gguf_extension() {
        let mut file = NamedTempFile::new().unwrap();
        file.as_file_mut().write_all(b"NOTGGUFBYTES").unwrap();
        let err = read_metadata(file.path()).unwrap_err();
        assert!(
            err.to_string().contains("Unsupported file type"),
            "expected extension reject, got {err}"
        );
    }

    #[test]
    fn rejects_gguf_files_with_bad_magic() {
        let mut file = gguf_tempfile();
        file.as_file_mut().write_all(b"NOTGGUFBYTES").unwrap();
        let err = read_metadata(file.path()).unwrap_err();
        assert!(
            err.to_string().contains("header magic mismatch"),
            "expected magic mismatch, got {err}"
        );
    }

    #[test]
    fn rejects_missing_files() {
        let path = std::path::PathBuf::from("/tmp/helmor-does-not-exist-xyzzy.gguf");
        let err = read_metadata(&path).unwrap_err();
        assert!(
            err.to_string().contains("File not found"),
            "expected file-not-found, got {err}"
        );
    }

    #[test]
    fn requires_arch_specific_keys() {
        let file = write_min_gguf(0, vec![("general.architecture", Kv::Str("llama".into()))]);
        let err = read_metadata(file.path()).unwrap_err();
        assert!(err.to_string().contains("context_length"));
    }

    #[test]
    fn rejects_absurd_metadata_kv_count() {
        // Header claims more KVs than the cap allows — must bail before
        // touching the (effectively unbounded) HashMap allocation /
        // payload-read loop. We hand-craft the header so we don't have
        // to actually write 10K+ records.
        let mut file = gguf_tempfile();
        let f = file.as_file_mut();
        f.write_all(&GGUF_MAGIC.to_le_bytes()).unwrap();
        f.write_all(&3u32.to_le_bytes()).unwrap();
        f.write_all(&0u64.to_le_bytes()).unwrap(); // tensor_count
        f.write_all(&(MAX_METADATA_KV_COUNT + 1).to_le_bytes())
            .unwrap();
        let err = read_metadata(file.path()).unwrap_err();
        assert!(
            err.to_string().contains("absurd metadata KV count"),
            "expected cap error, got {err}"
        );
    }
}
