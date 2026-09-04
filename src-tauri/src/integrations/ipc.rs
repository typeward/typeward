//! Length-prefixed framing for raw IPC responses that must carry small JSON
//! metadata next to a large binary body.
//!
//! Returning the body through `tauri::ipc::Response` skips the ~3-4x bloat a
//! serde `Vec<u8>` pays (it crosses the bridge as a JSON number array, held
//! simultaneously as a Rust Vec, a JSON string, and a JS number array). The
//! sibling metadata that would otherwise share the JSON struct rides in a
//! fixed-layout prefix instead:
//!
//! ```text
//! [u32 LE meta_len][meta JSON bytes][body bytes]
//! ```
//!
//! The length prefix — not any delimiter scan — is authoritative, so a body
//! that happens to contain JSON-looking bytes is never mis-split. The frontend
//! reads it back with `unframeMetaBody` (src/integrations/ipc-frame.ts); the
//! two layouts are kept in lockstep and cross-checked by tests on each side.
pub fn frame_meta_body(meta_json: &[u8], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + meta_json.len() + body.len());
    out.extend_from_slice(&(meta_json.len() as u32).to_le_bytes());
    out.extend_from_slice(meta_json);
    out.extend_from_slice(body);
    out
}

/// The raw byte body of a binary-upload command's request. The bytes arrive as
/// the IPC ArrayBuffer body (not a JSON number array); a non-raw or absent body
/// (e.g. a metadata-only call) reads as empty.
///
/// Callers whose contract is "this command must carry a byte body" want
/// [`raw_body_required`] instead — the empty fallback here silently uploads a
/// zero-length file when the body is missing.
pub fn raw_body(request: &tauri::ipc::Request<'_>) -> Vec<u8> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => Vec::new(),
    }
}

/// Like [`raw_body`] but errors when the request has no raw byte body, so a
/// write command can't be tricked into persisting an empty file. This is the
/// variant the binary-write commands use; `raw_body` stays lenient for callers
/// where a metadata-only body is a legitimate shape.
pub fn raw_body_required(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        _ => Err("expected a raw request body".to_string()),
    }
}

/// Decode a percent-encoded header value. Binary-upload commands carry their
/// metadata as headers (the JSON arg slot is taken by the raw byte body); the
/// renderer percent-encodes via `encodeURIComponent` so arbitrary Unicode
/// survives the ASCII-only header channel. Pure, so it's unit-testable without
/// constructing a `tauri::ipc::Request`.
pub fn percent_decode(name: &str, raw: &str) -> Result<String, String> {
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map(|cow| cow.into_owned())
        .map_err(|_| format!("invalid UTF-8 in `{name}` header"))
}

/// Required percent-encoded header → owned `String`.
pub fn decode_header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing `{name}` header"))?
        .to_str()
        .map_err(|_| format!("invalid `{name}` header"))?;
    percent_decode(name, raw)
}

/// Optional percent-encoded header → owned `String` (absent ⇒ `None`).
pub fn decode_opt_header(
    request: &tauri::ipc::Request<'_>,
    name: &str,
) -> Result<Option<String>, String> {
    match request.headers().get(name) {
        None => Ok(None),
        Some(v) => {
            let raw = v.to_str().map_err(|_| format!("invalid `{name}` header"))?;
            percent_decode(name, raw).map(Some)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(framed: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let len = u32::from_le_bytes(framed[0..4].try_into().unwrap()) as usize;
        (framed[4..4 + len].to_vec(), framed[4 + len..].to_vec())
    }

    #[test]
    fn frames_and_round_trips() {
        let meta = br#"{"status":200}"#;
        let body = [0u8, 1, 2, 255, 254];
        let framed = frame_meta_body(meta, &body);
        assert_eq!(&framed[0..4], &(meta.len() as u32).to_le_bytes());
        let (m, b) = split(&framed);
        assert_eq!(m, meta);
        assert_eq!(b, body);
    }

    #[test]
    fn handles_empty_body() {
        let meta = br#"{"etag":null}"#;
        let framed = frame_meta_body(meta, &[]);
        assert_eq!(framed.len(), 4 + meta.len());
        let (m, b) = split(&framed);
        assert_eq!(m, meta);
        assert!(b.is_empty());
    }

    #[test]
    fn handles_empty_meta() {
        let framed = frame_meta_body(&[], &[9, 9, 9]);
        assert_eq!(&framed[0..4], &0u32.to_le_bytes());
        let (m, b) = split(&framed);
        assert!(m.is_empty());
        assert_eq!(b, [9, 9, 9]);
    }

    #[test]
    fn percent_decode_round_trips_encode_uri_component() {
        // Exactly what JS `encodeURIComponent("figures/a b%c.png")` emits.
        assert_eq!(
            percent_decode("h", "figures%2Fa%20b%25c.png").unwrap(),
            "figures/a b%c.png"
        );
        assert_eq!(percent_decode("h", "caf%C3%A9").unwrap(), "café");
    }

    #[test]
    fn percent_decode_rejects_invalid_utf8() {
        assert!(percent_decode("h", "%FF%FE").is_err());
    }

    #[test]
    fn body_with_brace_bytes_is_not_confused_with_meta() {
        // The length prefix is authoritative — a body carrying JSON-looking
        // bytes (e.g. an HTTP error body) must not be mis-split.
        let meta = br#"{"status":404}"#;
        let body = br#"{"error":"this is the body, not metadata"}"#;
        let framed = frame_meta_body(meta, body);
        let (m, b) = split(&framed);
        assert_eq!(m, meta);
        assert_eq!(b, body);
    }
}
