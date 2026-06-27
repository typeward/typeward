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
