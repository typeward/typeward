//! WebDAV cloud provider transport.
//!
//! Unlike the other integrations, a WebDAV server lives at a *user-supplied*
//! host (self-hosted Nextcloud/ownCloud, Fastmail, a NAS, ...). The shared
//! [`http`](super::http) funnel deliberately allows only a fixed compile-time
//! host set as an SSRF defense, so WebDAV cannot ride it. Instead this module
//! owns a dedicated outbound path that is gated two ways:
//!
//!   1. **Provenance** — a host only becomes reachable after the user enrolls
//!      it through the WebDAV-account save flow (`webdav_validate_host`), which
//!      persists it. A renderer-supplied URL to an un-enrolled host is rejected
//!      by the frontend before it reaches an IPC here.
//!   2. **Resolve-then-pin SSRF screening** — every request resolves the host,
//!      screens *all* resolved IPs (and any numeric-literal host, to close the
//!      resolver-bypass class) against a deny-table, then pins the connection
//!      to the vetted address. Loopback / link-local / cloud-metadata are
//!      blocked unconditionally; RFC1918 / ULA / CGNAT are blocked unless the
//!      account explicitly opted into a private/LAN server.
//!
//! Server XML (PROPFIND multistatus) is attacker-controlled, so it is parsed
//! here in Rust with quick-xml (non-validating: no external entities, no
//! entity-expansion) rather than handed to the webview's DOMParser.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use base64::Engine as _;
use bytes::Bytes;
use percent_encoding::{AsciiSet, CONTROLS, percent_decode_str, utf8_percent_encode};
use quick_xml::Reader;
use quick_xml::events::{BytesRef, Event};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

use crate::integrations::http::{
    BodyCapError, OutboundRedirect, blocking, outbound_client_builder, read_body_capped_raw,
};
use crate::{integrations::credentials, settings};

const KEYRING_SERVICE: &str = "webdav";

// Body the multistatus parser will buffer / the file bytes we hand back. The
// whole body crosses the IPC bridge, so cap it like the shared http funnel.
const MAX_XML_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 256 * 1024 * 1024;

/// Characters that must be percent-encoded inside a single WebDAV path
/// segment. We encode everything that isn't an RFC 3986 unreserved char or a
/// sub-delim that servers tolerate; `/` is never in a segment (we join
/// segments ourselves), so it stays a separator.
const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'/')
    .add(b'\\')
    .add(b'^')
    .add(b'[')
    .add(b']')
    .add(b'|');

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum WebdavError {
    #[error("invalid WebDAV URL: {0}")]
    InvalidUrl(String),
    #[error("WebDAV requires https (got {0})")]
    InsecureScheme(String),
    #[error("host is not allowed (loopback/link-local/metadata/private): {0}")]
    BlockedHost(String),
    #[error("could not resolve host: {0}")]
    Dns(String),
    #[error("redirect to a different host was blocked: {0}")]
    BlockedRedirect(String),
    #[error("network error: {0}")]
    Network(String),
    #[error("response too large: {0}")]
    TooLarge(String),
    #[error("WebDAV account is not enrolled or does not match settings: {0}")]
    AccountNotTrusted(String),
    #[error("settings lookup failed: {0}")]
    Settings(String),
    #[error("server returned {status}: {detail}")]
    Status { status: u16, detail: String },
    #[error("credential lookup failed: {0}")]
    Credential(String),
    #[error("malformed multistatus XML: {0}")]
    Xml(String),
    #[error("background task failed: {0}")]
    Join(String),
}

/// A persisted WebDAV account, passed from the frontend on every call. The
/// password is never carried here — it is read from the keyring in Rust under
/// service `webdav` / account `accountId`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavAccount {
    pub account_id: String,
    /// Normalized base collection URL, always ending in `/`, e.g.
    /// `https://cloud.example.com/remote.php/dav/files/me/`.
    pub base_url: String,
    pub username: String,
    #[serde(default)]
    pub allow_private_host: bool,
}
fn trusted_webdav_account(
    settings: &settings::Settings,
    requested: &WebdavAccount,
) -> Result<WebdavAccount, WebdavError> {
    let stored = settings
        .integrations
        .cloud
        .accounts
        .iter()
        .find(|account| {
            account.provider.eq_ignore_ascii_case(KEYRING_SERVICE)
                && account.account_id == requested.account_id
        })
        .ok_or_else(|| WebdavError::AccountNotTrusted(requested.account_id.clone()))?;

    let base_url = stored
        .base_url
        .clone()
        .ok_or_else(|| WebdavError::AccountNotTrusted(requested.account_id.clone()))?;
    let username = stored
        .username
        .clone()
        .ok_or_else(|| WebdavError::AccountNotTrusted(requested.account_id.clone()))?;

    Ok(WebdavAccount {
        account_id: stored.account_id.clone(),
        base_url,
        username,
        allow_private_host: stored.allow_private_host.unwrap_or(false),
    })
}

async fn trusted_webdav_account_for_app(
    app: tauri::AppHandle,
    requested: WebdavAccount,
) -> Result<WebdavAccount, WebdavError> {
    blocking(move || {
        let settings = settings::load(&app).map_err(|e| WebdavError::Settings(e.to_string()))?;
        trusted_webdav_account(&settings, &requested)
    })
    .await
    .map_err(WebdavError::Join)?
}

/// A trusted WebDAV account plus its keyring password, resolved once per IPC
/// command. Hoisting the password out of [`execute`] avoids a spawn-blocking
/// keyring read (a D-Bus round trip on Linux) per sub-request — `webdav_put`
/// alone issues the PUT, an MKCOL chain, a retry, and an ETag PROPFIND. Every
/// sub-request still resolves + SSRF-screens + pins its own connection, so
/// anti-rebinding protection is unchanged.
struct WebdavSession {
    account: WebdavAccount,
    password: String,
}

impl WebdavSession {
    async fn open(app: tauri::AppHandle, requested: WebdavAccount) -> Result<Self, WebdavError> {
        let account = trusted_webdav_account_for_app(app, requested).await?;
        let password = account_password(&account.account_id).await?;
        Ok(Self { account, password })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavEntry {
    /// Path relative to the account base, e.g. `figures/plot.pdf`. Directories
    /// carry no trailing slash; `is_dir` is authoritative.
    pub rel_path: String,
    pub is_dir: bool,
    /// Normalized ETag (quotes and any weak `W/` prefix stripped). Acts as the
    /// per-file `rev` for the sync engine.
    pub etag: Option<String>,
    pub size: Option<u64>,
    pub last_modified: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavListResult {
    pub entries: Vec<WebdavEntry>,
}

/// Metadata prefix for a framed `webdav_get` response — the file bytes ride
/// raw in the body half (see [`crate::integrations::ipc`]) instead of as a
/// JSON number array.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WebdavGetMeta {
    etag: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavPutResult {
    pub etag: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostVerdict {
    pub ok: bool,
    pub host: String,
    pub port: u16,
    /// The base path component, always ending in `/`.
    pub base_path: String,
    /// The normalized base URL the frontend should persist.
    pub base_url: String,
    pub reason: Option<String>,
}

// ===========================================================================
// SSRF screening
// ===========================================================================

/// Parse a host string as an IP literal, accepting the obfuscated IPv4 forms
/// (decimal `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`, short
/// `127.1`) that `IpAddr::from_str` rejects but the OS resolver / url crate
/// may accept — closing the numeric-literal resolver-bypass class.
fn parse_ip_literal(host: &str) -> Option<IpAddr> {
    let host = host.trim();
    let unbracketed = host.strip_prefix('[').and_then(|h| h.strip_suffix(']'));
    if let Some(v6) = unbracketed {
        return v6.parse::<Ipv6Addr>().ok().map(IpAddr::V6);
    }
    if host.contains(':') {
        return host.parse::<Ipv6Addr>().ok().map(IpAddr::V6);
    }
    parse_ipv4_relaxed(host).map(IpAddr::V4)
}

fn parse_u32_radix(part: &str) -> Option<u32> {
    if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
        if hex.is_empty() {
            return None;
        }
        u32::from_str_radix(hex, 16).ok()
    } else if part.len() > 1 && part.starts_with('0') {
        u32::from_str_radix(part, 8).ok()
    } else {
        part.parse::<u32>().ok()
    }
}

/// inet_aton-style relaxed IPv4 parsing. Only returns Some when the whole
/// string is numeric (1-4 dotted parts); ordinary hostnames fall through to
/// DNS resolution.
fn parse_ipv4_relaxed(host: &str) -> Option<Ipv4Addr> {
    if host.is_empty() {
        return None;
    }
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 4 {
        return None;
    }
    let nums: Vec<u32> = parts
        .iter()
        .map(|p| parse_u32_radix(p))
        .collect::<Option<Vec<_>>>()?;
    let value: u32 = match nums.as_slice() {
        [a] => *a,
        [a, b] => {
            if *a > 0xff || *b > 0x00ff_ffff {
                return None;
            }
            (a << 24) | b
        }
        [a, b, c] => {
            if *a > 0xff || *b > 0xff || *c > 0xffff {
                return None;
            }
            (a << 24) | (b << 16) | c
        }
        [a, b, c, d] => {
            if *a > 0xff || *b > 0xff || *c > 0xff || *d > 0xff {
                return None;
            }
            (a << 24) | (b << 16) | (c << 8) | d
        }
        _ => return None,
    };
    Some(Ipv4Addr::from(value))
}

/// True when an address must never be reached, regardless of the private
/// opt-in: loopback, link-local (incl. the 169.254.169.254 metadata IP),
/// unspecified, multicast/broadcast, and the IPv6 metadata address.
fn is_hard_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_hard_blocked(IpAddr::V4(mapped));
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || is_v6_link_local(v6)
                || is_v6_metadata(v6)
        }
    }
}

fn is_v6_link_local(v6: Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xffc0) == 0xfe80
}

fn is_v6_unique_local(v6: Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xfe00) == 0xfc00
}

/// AWS/GCP/Azure IPv6 instance metadata. Inside ULA, so it would slip through
/// a private opt-in — block it explicitly.
fn is_v6_metadata(v6: Ipv6Addr) -> bool {
    v6 == Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x254)
}

fn is_v4_private_class(v4: Ipv4Addr) -> bool {
    // RFC1918 + CGNAT (100.64/10). 169.254.169.254 is link-local, handled by
    // is_hard_blocked, so opting into "private" never exposes metadata.
    v4.is_private() || matches!(v4.octets(), [100, b, _, _] if (64..=127).contains(&b))
}

/// Final decision for a single resolved IP given the account's opt-in.
fn is_blocked_ip(ip: IpAddr, allow_private: bool) -> bool {
    if is_hard_blocked(ip) {
        return true;
    }
    if allow_private {
        return false;
    }
    match ip {
        IpAddr::V4(v4) => is_v4_private_class(v4),
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_v4_private_class(mapped);
            }
            is_v6_unique_local(v6)
        }
    }
}

/// Resolve `host` (or accept a literal) and screen every resulting address.
/// Rejects if the host has no addresses or *any* address is blocked (defends
/// against round-robin DNS that mixes a public and a private answer). Returns
/// the vetted socket addresses to pin the connection to.
async fn resolve_and_screen(
    host: &str,
    port: u16,
    allow_private: bool,
) -> Result<Vec<SocketAddr>, WebdavError> {
    if let Some(ip) = parse_ip_literal(host) {
        if is_blocked_ip(ip, allow_private) {
            return Err(WebdavError::BlockedHost(host.to_string()));
        }
        return Ok(vec![SocketAddr::new(ip, port)]);
    }

    let lookup_host = host.to_string();
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((lookup_host.as_str(), port))
        .await
        .map_err(|e| WebdavError::Dns(e.to_string()))?
        .collect();

    if addrs.is_empty() {
        return Err(WebdavError::Dns(format!("no addresses for {host}")));
    }
    for addr in &addrs {
        if is_blocked_ip(addr.ip(), allow_private) {
            return Err(WebdavError::BlockedHost(host.to_string()));
        }
    }
    Ok(addrs)
}

// ===========================================================================
// URL handling
// ===========================================================================

fn host_of(url: &Url) -> Result<String, WebdavError> {
    url.host_str()
        .map(|h| {
            h.trim_start_matches('[')
                .trim_end_matches(']')
                .to_ascii_lowercase()
        })
        .ok_or_else(|| WebdavError::InvalidUrl(url.as_str().to_string()))
}

/// Normalize a user-supplied base URL: require https, force a single trailing
/// slash on the path. Returns the parsed URL plus its decoded path prefix.
fn normalize_base(base_url: &str) -> Result<(Url, String), WebdavError> {
    let mut url = Url::parse(base_url).map_err(|e| WebdavError::InvalidUrl(e.to_string()))?;
    if url.scheme() != "https" {
        return Err(WebdavError::InsecureScheme(url.scheme().to_string()));
    }
    if !url.path().ends_with('/') {
        let p = format!("{}/", url.path());
        url.set_path(&p);
    }
    let decoded_path = percent_decode_str(url.path())
        .decode_utf8_lossy()
        .into_owned();
    Ok((url, decoded_path))
}

fn encode_rel(rel_path: &str) -> String {
    rel_path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|seg| utf8_percent_encode(seg, SEGMENT).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// Reject a relative path that could climb out of the account's base
/// collection. `SEGMENT` deliberately leaves `.` unencoded (it is an RFC 3986
/// unreserved char), so a `..` segment would survive `encode_rel` and then be
/// resolved as a dot-segment by `Url::join` — landing the request on the vetted
/// host but ABOVE the enrolled base path. The renderer is untrusted (webview
/// XSS = arbitrary IPC), so the check belongs here in Rust rather than only in
/// the frontend's `normalizeRemoteRelPath` funnel, which guards local cache IO.
fn reject_escaping_rel(rel_path: &str) -> Result<(), WebdavError> {
    let unsafe_segment = rel_path
        .split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .any(|seg| seg == "." || seg == ".." || seg.eq_ignore_ascii_case(".typeward"));
    if unsafe_segment {
        return Err(WebdavError::InvalidUrl(format!(
            "unsafe remote path: {rel_path}"
        )));
    }
    Ok(())
}

/// Build the absolute request URL for `rel_path` under the account base.
fn request_url(account: &WebdavAccount, rel_path: &str, is_dir: bool) -> Result<Url, WebdavError> {
    reject_escaping_rel(rel_path)?;
    let (base, _) = normalize_base(&account.base_url)?;
    let encoded = encode_rel(rel_path);
    let mut joined = base
        .join(&encoded)
        .map_err(|e| WebdavError::InvalidUrl(e.to_string()))?;
    if is_dir && !joined.path().ends_with('/') {
        let p = format!("{}/", joined.path());
        joined.set_path(&p);
    }
    Ok(joined)
}

fn normalize_etag(raw: &str) -> Option<String> {
    let t = raw.trim();
    let t = t
        .strip_prefix("W/")
        .or_else(|| t.strip_prefix("w/"))
        .unwrap_or(t);
    let t = t.trim().trim_matches('"').trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

// ===========================================================================
// HTTP execution (screened client + Basic auth)
// ===========================================================================

fn basic_auth_header(username: &str, password: &str) -> String {
    let token = base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
    format!("Basic {token}")
}

async fn account_password(account_id: &str) -> Result<String, WebdavError> {
    let id = account_id.to_string();
    let secret = blocking(move || credentials::get_secret(KEYRING_SERVICE, &id))
        .await
        .map_err(WebdavError::Join)?
        .map_err(|e| WebdavError::Credential(e.to_string()))?;
    secret.ok_or_else(|| WebdavError::Credential("no stored password for account".into()))
}

/// Build a reqwest client pinned to the screened addresses for `host`. Goes
/// through the shared outbound chokepoint with `OutboundRedirect::SameHost`, so
/// the same-host-https-only redirect policy is installed by construction and a
/// redirect can never escape the pinned (vetted) address.
fn build_client(host: &str, addrs: &[SocketAddr]) -> Result<Client, WebdavError> {
    let expected = host.to_ascii_lowercase();
    outbound_client_builder(OutboundRedirect::SameHost(expected.clone()))
        .connect_timeout(Duration::from_secs(15))
        // An idle-gap timeout, not a whole-request deadline. A 120s total
        // budget against the 256 MB `MAX_FILE_BYTES` cap demands a sustained
        // >2.1 MB/s link: on a typical self-hosted uplink every legal-but-large
        // project asset aborted at exactly 120s, then retried forever and
        // pinned the sync badge in a permanent error. Body size stays bounded by
        // `read_body_capped_raw`; a genuinely dead peer still trips this.
        // (Same pattern and rationale as the AI stream client.)
        .read_timeout(Duration::from_secs(60))
        .resolve_to_addrs(&expected, addrs)
        .build()
        .map_err(|e| WebdavError::Network(e.to_string()))
}

struct RawResponse {
    status: u16,
    etag: Option<String>,
    body: Vec<u8>,
}

async fn execute(
    session: &WebdavSession,
    method: Method,
    url: &Url,
    headers: &[(&str, String)],
    body: Option<Bytes>,
    cap: usize,
) -> Result<RawResponse, WebdavError> {
    let account = &session.account;
    let host = host_of(url)?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| WebdavError::InvalidUrl(url.as_str().to_string()))?;
    let addrs = resolve_and_screen(&host, port, account.allow_private_host).await?;
    let client = build_client(&host, &addrs)?;

    let mut builder = client.request(method, url.clone()).header(
        "Authorization",
        basic_auth_header(&account.username, &session.password),
    );
    for (name, value) in headers {
        builder = builder.header(*name, value);
    }
    if let Some(bytes) = body {
        builder = builder.body(bytes);
    }

    let res = builder.send().await.map_err(|e| {
        // A blocked same-host redirect surfaces as a reqwest error; keep the
        // message specific so the UI can explain it.
        if e.is_redirect() {
            WebdavError::BlockedRedirect(host.clone())
        } else {
            WebdavError::Network(e.to_string())
        }
    })?;

    let status = res.status().as_u16();
    let etag = res
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .and_then(normalize_etag);

    let body = read_body_capped_raw(res, cap).await.map_err(|e| match e {
        BodyCapError::TooLarge(msg) => WebdavError::TooLarge(msg),
        BodyCapError::Read(msg) => WebdavError::Network(msg),
    })?;

    Ok(RawResponse { status, etag, body })
}

fn http_ok(status: u16) -> bool {
    (200..300).contains(&status)
}

fn status_err(status: u16, body: &[u8]) -> WebdavError {
    let detail = String::from_utf8_lossy(body);
    let detail: String = detail.chars().take(500).collect();
    WebdavError::Status { status, detail }
}

// ===========================================================================
// multistatus parsing (quick-xml, prefix-agnostic local-name matching)
// ===========================================================================

struct RawEntry {
    href_path: String,
    is_dir: bool,
    etag: Option<String>,
    size: Option<u64>,
    last_modified: Option<String>,
}

fn local_name(qname: &[u8]) -> String {
    let name = match qname.iter().rposition(|&b| b == b':') {
        Some(i) => &qname[i + 1..],
        None => qname,
    };
    String::from_utf8_lossy(name).to_ascii_lowercase()
}

#[derive(PartialEq)]
enum Field {
    None,
    Href,
    Status,
    Etag,
    Size,
    LastMod,
}

fn parse_multistatus(xml: &[u8]) -> Result<Vec<RawEntry>, WebdavError> {
    let mut reader = Reader::from_reader(xml);

    let mut entries: Vec<RawEntry> = Vec::new();
    let mut buf = Vec::new();

    // response-level accumulation
    let mut href: Option<String> = None;
    let mut resp_is_dir = false;
    let mut resp_etag: Option<String> = None;
    let mut resp_size: Option<u64> = None;
    let mut resp_lastmod: Option<String> = None;

    // propstat-level temp
    let mut in_propstat = false;
    let mut in_resourcetype = false;
    let mut ps_status_text = String::new();
    let mut ps_is_dir = false;
    let mut ps_etag: Option<String> = None;
    let mut ps_size: Option<u64> = None;
    let mut ps_lastmod: Option<String> = None;

    let mut field = Field::None;
    let mut text_buf = String::new();
    let mut text_poisoned = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Err(e) => return Err(WebdavError::Xml(e.to_string())),
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref());
                match name.as_str() {
                    "response" => {
                        href = None;
                        resp_is_dir = false;
                        resp_etag = None;
                        resp_size = None;
                        resp_lastmod = None;
                    }
                    "propstat" => {
                        in_propstat = true;
                        ps_status_text.clear();
                        ps_is_dir = false;
                        ps_etag = None;
                        ps_size = None;
                        ps_lastmod = None;
                    }
                    "resourcetype" => in_resourcetype = true,
                    "collection" => {
                        if in_resourcetype {
                            ps_is_dir = true;
                        }
                    }
                    "href" => {
                        field = Field::Href;
                        text_buf.clear();
                        text_poisoned = false;
                    }
                    "status" if in_propstat => {
                        field = Field::Status;
                        text_buf.clear();
                        text_poisoned = false;
                    }
                    "getetag" if in_propstat => {
                        field = Field::Etag;
                        text_buf.clear();
                        text_poisoned = false;
                    }
                    "getcontentlength" if in_propstat => {
                        field = Field::Size;
                        text_buf.clear();
                        text_poisoned = false;
                    }
                    "getlastmodified" if in_propstat => {
                        field = Field::LastMod;
                        text_buf.clear();
                        text_poisoned = false;
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let name = local_name(e.name().as_ref());
                if name == "collection" && in_resourcetype {
                    ps_is_dir = true;
                }
            }
            Ok(Event::Text(e)) => {
                if field != Field::None {
                    let t = e.decode().unwrap_or_default();
                    text_buf.push_str(&t);
                }
            }
            // quick-xml >= 0.38 no longer inlines `&...;` references into Text
            // events; they arrive as their own event and must be resolved here
            // or an href like `a&amp;b.tex` silently loses characters.
            Ok(Event::GeneralRef(e)) => {
                if field != Field::None && !push_general_ref(&e, &mut text_buf) {
                    text_poisoned = true;
                }
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref());
                match name.as_str() {
                    "href" => {
                        if matches!(field, Field::Href) {
                            // A poisoned href drops the whole entry: an empty
                            // or partial value could alias a different path.
                            href = if text_poisoned {
                                None
                            } else {
                                Some(text_buf.trim().to_string())
                            };
                        }
                        field = Field::None;
                    }
                    "status" => {
                        if matches!(field, Field::Status) {
                            ps_status_text = if text_poisoned {
                                String::new()
                            } else {
                                text_buf.clone()
                            };
                        }
                        field = Field::None;
                    }
                    "getetag" => {
                        if matches!(field, Field::Etag) {
                            ps_etag = if text_poisoned {
                                None
                            } else {
                                normalize_etag(&text_buf)
                            };
                        }
                        field = Field::None;
                    }
                    "getcontentlength" => {
                        if matches!(field, Field::Size) {
                            ps_size = if text_poisoned {
                                None
                            } else {
                                text_buf.trim().parse::<u64>().ok()
                            };
                        }
                        field = Field::None;
                    }
                    "getlastmodified" => {
                        if matches!(field, Field::LastMod) && !text_poisoned {
                            let v = text_buf.trim();
                            if !v.is_empty() {
                                ps_lastmod = Some(v.to_string());
                            }
                        }
                        field = Field::None;
                    }
                    "resourcetype" => in_resourcetype = false,
                    "propstat" => {
                        if status_is_ok(&ps_status_text) {
                            resp_is_dir = resp_is_dir || ps_is_dir;
                            if ps_etag.is_some() {
                                resp_etag = ps_etag.take();
                            }
                            if ps_size.is_some() {
                                resp_size = ps_size.take();
                            }
                            if ps_lastmod.is_some() {
                                resp_lastmod = ps_lastmod.take();
                            }
                        }
                        in_propstat = false;
                    }
                    "response" => {
                        if let Some(h) = href.take() {
                            let path = href_to_path(&h);
                            entries.push(RawEntry {
                                href_path: path,
                                is_dir: resp_is_dir,
                                etag: resp_etag.take(),
                                size: resp_size.take(),
                                last_modified: resp_lastmod.take(),
                            });
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        buf.clear();
    }

    Ok(entries)
}

/// Resolve numeric character references and the five predefined XML entities —
/// exactly the set the old `unescape()` inlined. Anything else (a DTD-defined
/// custom entity, a malformed char ref) returns `false` without touching
/// `out`: this parser deliberately does no entity expansion, and the caller
/// poisons the whole accumulated value — emitting partial text instead would
/// let a truncated href alias a different file.
#[must_use]
fn push_general_ref(r: &BytesRef<'_>, out: &mut String) -> bool {
    match r.resolve_char_ref() {
        Ok(Some(ch)) => {
            out.push(ch);
            true
        }
        Ok(None) => match r
            .decode()
            .ok()
            .and_then(|name| quick_xml::escape::resolve_xml_entity(&name))
        {
            Some(s) => {
                out.push_str(s);
                true
            }
            None => false,
        },
        Err(_) => false,
    }
}

fn status_is_ok(status_line: &str) -> bool {
    // "HTTP/1.1 200 OK" -> first 3-digit token in 2xx.
    status_line
        .split_whitespace()
        .find_map(|tok| tok.parse::<u16>().ok())
        .map(http_ok)
        .unwrap_or(false)
}

/// Take a possibly-absolute href, reduce to its decoded path component.
fn href_to_path(href: &str) -> String {
    let path = if let Ok(u) = Url::parse(href) {
        u.path().to_string()
    } else {
        // absolute-path form: strip a query/fragment if present
        href.split(['?', '#']).next().unwrap_or(href).to_string()
    };
    percent_decode_str(&path).decode_utf8_lossy().into_owned()
}

/// Convert parsed raw entries into account-relative entries, dropping the
/// listed collection itself (`request_path`) and computing `rel_path` against
/// `base_path`.
fn to_entries(raw: Vec<RawEntry>, base_path: &str, request_path: &str) -> Vec<WebdavEntry> {
    let base = ensure_trailing_slash(base_path);
    let req = ensure_trailing_slash(request_path);
    let mut out = Vec::new();
    for e in raw {
        let href = ensure_trailing_slash_if(&e.href_path, e.is_dir);
        // skip the listed directory itself
        if trim_trailing_slash(&href) == trim_trailing_slash(&req) {
            continue;
        }
        let Some(rel) = href.strip_prefix(base.as_str()) else {
            continue;
        };
        let rel = trim_trailing_slash(rel).to_string();
        if rel.is_empty() {
            continue;
        }
        out.push(WebdavEntry {
            rel_path: rel,
            is_dir: e.is_dir,
            etag: e.etag,
            size: e.size,
            last_modified: e.last_modified,
        });
    }
    out
}

fn ensure_trailing_slash(s: &str) -> String {
    if s.ends_with('/') {
        s.to_string()
    } else {
        format!("{s}/")
    }
}

fn ensure_trailing_slash_if(s: &str, cond: bool) -> String {
    if cond {
        ensure_trailing_slash(s)
    } else {
        s.to_string()
    }
}

fn trim_trailing_slash(s: &str) -> &str {
    s.strip_suffix('/').unwrap_or(s)
}

// ===========================================================================
// IPC commands
// ===========================================================================

/// Validate and normalize a user-entered WebDAV base URL at enrollment time.
/// Requires https and screens the host (resolve + deny-table, honoring the
/// private opt-in). Returns the normalized base URL to persist.
#[tauri::command]
pub async fn webdav_validate_host(url: String, allow_private: bool) -> Result<HostVerdict, String> {
    webdav_validate_host_inner(url, allow_private)
        .await
        .map_err(|e| e.to_string())
}

async fn webdav_validate_host_inner(
    url: String,
    allow_private: bool,
) -> Result<HostVerdict, WebdavError> {
    let (base, base_path) = normalize_base(&url)?;
    let host = host_of(&base)?;
    let port = base
        .port_or_known_default()
        .ok_or_else(|| WebdavError::InvalidUrl(url.clone()))?;

    if let Err(e) = resolve_and_screen(&host, port, allow_private).await {
        return Ok(HostVerdict {
            ok: false,
            host,
            port,
            base_path,
            base_url: base.to_string(),
            reason: Some(e.to_string()),
        });
    }

    Ok(HostVerdict {
        ok: true,
        host,
        port,
        base_path,
        base_url: base.to_string(),
        reason: None,
    })
}

/// Cheap auth/reachability probe: PROPFIND Depth:0 on the account base.
#[tauri::command]
pub async fn webdav_status_probe(
    app: tauri::AppHandle,
    account: WebdavAccount,
) -> Result<bool, String> {
    webdav_status_probe_body(app, account)
        .await
        .map_err(|e| e.to_string())
}

async fn webdav_status_probe_body(
    app: tauri::AppHandle,
    account: WebdavAccount,
) -> Result<bool, WebdavError> {
    let session = WebdavSession::open(app, account).await?;
    webdav_status_probe_inner(&session).await
}

/// Keyring account id for a WebDAV login. Mirrors `webdavAccountId` in
/// `src/integrations/cloud/webdav/auth.ts` — the two must agree or enrollment
/// stores the password under one id and the probe looks for another.
fn derive_account_id(host: &str, username: &str) -> String {
    format!("{username}@{host}")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Verify credentials for an account that is not enrolled yet.
///
/// Every other `webdav_*` command resolves its account through
/// `trusted_webdav_account`, which reads `cloud.accounts` from settings.json.
/// Enrollment cannot satisfy that by construction: the account is only written
/// to settings *after* the probe succeeds, so the first connection of any server
/// failed with `AccountNotTrusted` and the enrollment flow then deleted the
/// freshly stored password — making WebDAV, the only cloud backend,
/// un-enrollable from a fresh install.
///
/// This takes the login directly and persists nothing. It is not a hole in the
/// allowlist-by-account rule:
///   - the base URL goes through the same `normalize_base` (https only) and the
///     per-request `resolve_and_screen` SSRF screen as every other command, and
///   - the account id is *recomputed* from the supplied host + username and must
///     match the one passed in, so a compromised renderer cannot point an
///     already-enrolled account's stored password at a host of its choosing.
#[tauri::command]
pub async fn webdav_enroll_probe(account: WebdavAccount) -> Result<bool, String> {
    webdav_enroll_probe_body(account)
        .await
        .map_err(|e| e.to_string())
}

async fn webdav_enroll_probe_body(requested: WebdavAccount) -> Result<bool, WebdavError> {
    let (base, _) = normalize_base(&requested.base_url)?;
    let host = host_of(&base)?;
    let expected_id = derive_account_id(&host, &requested.username);
    if expected_id != requested.account_id {
        return Err(WebdavError::AccountNotTrusted(requested.account_id));
    }
    let password = account_password(&requested.account_id).await?;
    let session = WebdavSession {
        account: WebdavAccount {
            base_url: base.to_string(),
            ..requested
        },
        password,
    };
    webdav_status_probe_inner(&session).await
}

async fn webdav_status_probe_inner(session: &WebdavSession) -> Result<bool, WebdavError> {
    let url = request_url(&session.account, "", true)?;
    let body = Bytes::from_static(PROPFIND_BODY.as_bytes());
    let res = execute(
        session,
        propfind_method()?,
        &url,
        &[
            ("Depth", "0".into()),
            ("Content-Type", "application/xml; charset=utf-8".into()),
        ],
        Some(body),
        MAX_XML_BYTES,
    )
    .await?;
    Ok(http_ok(res.status))
}

/// PROPFIND Depth:1 listing of `rel_path` under the account base.
#[tauri::command]
pub async fn webdav_propfind(
    app: tauri::AppHandle,
    account: WebdavAccount,
    rel_path: String,
    depth: u8,
) -> Result<WebdavListResult, String> {
    webdav_propfind_body(app, account, rel_path, depth)
        .await
        .map_err(|e| e.to_string())
}

async fn webdav_propfind_body(
    app: tauri::AppHandle,
    account: WebdavAccount,
    rel_path: String,
    depth: u8,
) -> Result<WebdavListResult, WebdavError> {
    let session = WebdavSession::open(app, account).await?;
    webdav_propfind_inner(&session, &rel_path, depth).await
}

async fn webdav_propfind_inner(
    session: &WebdavSession,
    rel_path: &str,
    depth: u8,
) -> Result<WebdavListResult, WebdavError> {
    let account = &session.account;
    let url = request_url(account, rel_path, true)?;
    let depth_header = if depth == 0 { "0" } else { "1" };
    let body = Bytes::from_static(PROPFIND_BODY.as_bytes());
    let res = execute(
        session,
        propfind_method()?,
        &url,
        &[
            ("Depth", depth_header.into()),
            ("Content-Type", "application/xml; charset=utf-8".into()),
        ],
        Some(body),
        MAX_XML_BYTES,
    )
    .await?;
    if !http_ok(res.status) {
        return Err(status_err(res.status, &res.body));
    }
    let (_, base_path) = normalize_base(&account.base_url)?;
    let request_path = percent_decode_str(url.path())
        .decode_utf8_lossy()
        .into_owned();
    let raw = parse_multistatus(&res.body)?;
    Ok(WebdavListResult {
        entries: to_entries(raw, &base_path, &request_path),
    })
}

/// GET file bytes + ETag.
#[tauri::command]
pub async fn webdav_get(
    app: tauri::AppHandle,
    account: WebdavAccount,
    rel_path: String,
) -> Result<tauri::ipc::Response, String> {
    webdav_get_body(app, account, rel_path)
        .await
        .map_err(|e| e.to_string())
}

async fn webdav_get_body(
    app: tauri::AppHandle,
    account: WebdavAccount,
    rel_path: String,
) -> Result<tauri::ipc::Response, WebdavError> {
    let session = WebdavSession::open(app, account).await?;
    let url = request_url(&session.account, &rel_path, false)?;
    let res = execute(&session, Method::GET, &url, &[], None, MAX_FILE_BYTES).await?;
    if !http_ok(res.status) {
        return Err(status_err(res.status, &res.body));
    }
    let meta_json = serde_json::to_vec(&WebdavGetMeta { etag: res.etag })
        .map_err(|e| WebdavError::Network(format!("response meta encode: {e}")))?;
    Ok(tauri::ipc::Response::new(
        crate::integrations::ipc::frame_meta_body(&meta_json, &res.body),
    ))
}

/// PUT file bytes. Creates missing ancestor collections (MKCOL chain), and
/// uses `If-Match` for optimistic concurrency when a known rev is given.
struct PutRequest {
    account: WebdavAccount,
    rel_path: String,
    if_match: Option<String>,
    body: Bytes,
}

fn ensure_upload_within_cap(len: usize) -> Result<(), WebdavError> {
    if len > MAX_FILE_BYTES {
        return Err(WebdavError::TooLarge(format!(
            "upload body is {len} bytes (cap {MAX_FILE_BYTES})"
        )));
    }
    Ok(())
}

/// Upload bytes ride as the raw IPC body; account/path/if-match as
/// percent-encoded headers (the JSON arg slot is taken by the raw body).
/// Parsed synchronously so the borrowed `Request` never crosses an await.
/// The size cap runs before the body is copied out of the request so an
/// oversized upload is rejected without ever being duplicated.
fn parse_put_request(request: &tauri::ipc::Request<'_>) -> Result<PutRequest, WebdavError> {
    if let tauri::ipc::InvokeBody::Raw(bytes) = request.body() {
        ensure_upload_within_cap(bytes.len())?;
    }
    let body = Bytes::from(crate::integrations::ipc::raw_body(request));
    let account: WebdavAccount = serde_json::from_str(
        &crate::integrations::ipc::decode_header(request, "x-webdav-account")
            .map_err(WebdavError::Network)?,
    )
    .map_err(|e| WebdavError::Network(format!("account decode: {e}")))?;
    let rel_path = crate::integrations::ipc::decode_header(request, "x-rel-path")
        .map_err(WebdavError::Network)?;
    let if_match = crate::integrations::ipc::decode_opt_header(request, "x-if-match")
        .map_err(WebdavError::Network)?;
    Ok(PutRequest {
        account,
        rel_path,
        if_match,
        body,
    })
}

#[tauri::command]
pub async fn webdav_put(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<WebdavPutResult, String> {
    let parsed = parse_put_request(&request).map_err(|e| e.to_string())?;
    webdav_put_body(app, parsed)
        .await
        .map_err(|e| e.to_string())
}

async fn webdav_put_body(
    app: tauri::AppHandle,
    req: PutRequest,
) -> Result<WebdavPutResult, WebdavError> {
    let session = WebdavSession::open(app, req.account).await?;
    let url = request_url(&session.account, &req.rel_path, false)?;
    let mut headers: Vec<(&str, String)> = Vec::new();
    if let Some(rev) = &req.if_match {
        headers.push(("If-Match", format!("\"{rev}\"")));
    }

    let res = execute(
        &session,
        Method::PUT,
        &url,
        &headers,
        Some(req.body.clone()),
        MAX_XML_BYTES,
    )
    .await?;
    if needs_parent_collection(res.status) {
        ensure_ancestors(&session, &req.rel_path).await?;
        let retry = execute(
            &session,
            Method::PUT,
            &url,
            &headers,
            Some(req.body),
            MAX_XML_BYTES,
        )
        .await?;
        if !http_ok(retry.status) {
            return Err(status_err(retry.status, &retry.body));
        }
        return Ok(WebdavPutResult {
            etag: resolve_put_etag(&session, &req.rel_path, retry.etag).await,
        });
    }
    if !http_ok(res.status) {
        return Err(status_err(res.status, &res.body));
    }
    Ok(WebdavPutResult {
        etag: resolve_put_etag(&session, &req.rel_path, res.etag).await,
    })
}

/// Create a collection at `rel_path`, with any missing ancestors. Idempotent,
/// so the cloud layer can plant the shared `Typeward/` projects folder and a
/// project's own folder on every create without first checking whether they
/// exist. Needed because the sync engine's first pass PROPFINDs the project
/// root, which 404s when nothing has been uploaded into it yet.
#[tauri::command]
pub async fn webdav_mkcol(
    app: tauri::AppHandle,
    account: WebdavAccount,
    rel_path: String,
) -> Result<(), String> {
    webdav_mkcol_body(app, account, rel_path)
        .await
        .map_err(|e| e.to_string())
}

async fn webdav_mkcol_body(
    app: tauri::AppHandle,
    account: WebdavAccount,
    rel_path: String,
) -> Result<(), WebdavError> {
    let session = WebdavSession::open(app, account).await?;
    ensure_collection(&session, &rel_path).await
}

/// DELETE a file (or collection). 404 is treated as already-converged.
#[tauri::command]
pub async fn webdav_delete(
    app: tauri::AppHandle,
    account: WebdavAccount,
    rel_path: String,
    if_match: Option<String>,
) -> Result<(), String> {
    webdav_delete_body(app, account, rel_path, if_match)
        .await
        .map_err(|e| e.to_string())
}

async fn webdav_delete_body(
    app: tauri::AppHandle,
    account: WebdavAccount,
    rel_path: String,
    if_match: Option<String>,
) -> Result<(), WebdavError> {
    let session = WebdavSession::open(app, account).await?;
    let url = request_url(&session.account, &rel_path, false)?;
    let mut headers: Vec<(&str, String)> = Vec::new();
    if let Some(rev) = &if_match {
        headers.push(("If-Match", format!("\"{rev}\"")));
    }
    let res = execute(
        &session,
        Method::DELETE,
        &url,
        &headers,
        None,
        MAX_XML_BYTES,
    )
    .await?;
    if http_ok(res.status) || res.status == 404 {
        Ok(())
    } else {
        Err(status_err(res.status, &res.body))
    }
}

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
    <D:getetag/>
    <D:getcontentlength/>
    <D:getlastmodified/>
  </D:prop>
</D:propfind>"#;

/// Whether a PUT status means "the parent collection does not exist", so the
/// MKCOL chain should be created and the upload retried once.
///
/// RFC 4918 9.7.1 mandates 409 here, and Nextcloud/ownCloud/Apache send it, but
/// real servers disagree: Koofr answers 404. Without 404 in this set the very
/// first push of any project that has a subfolder fails permanently there, and
/// the sync engine retries the same doomed upload on every backoff.
fn needs_parent_collection(status: u16) -> bool {
    status == 409 || status == 404
}

fn propfind_method() -> Result<Method, WebdavError> {
    Method::from_bytes(b"PROPFIND").map_err(|e| WebdavError::Network(e.to_string()))
}

fn mkcol_method() -> Result<Method, WebdavError> {
    Method::from_bytes(b"MKCOL").map_err(|e| WebdavError::Network(e.to_string()))
}

/// Every collection prefix of `rel_path`, top-down: `a/b/c` yields
/// `["a", "a/b", "a/b/c"]`. Empty segments are dropped so a doubled or
/// trailing slash cannot mint an empty MKCOL target.
fn collection_prefixes(rel_path: &str) -> Vec<String> {
    let mut prefixes: Vec<String> = Vec::new();
    let mut prefix = String::new();
    for seg in rel_path.split('/').filter(|s| !s.is_empty()) {
        if prefix.is_empty() {
            prefix = seg.to_string();
        } else {
            prefix = format!("{prefix}/{seg}");
        }
        prefixes.push(prefix.clone());
    }
    prefixes
}

/// Create `rel_path` as a collection, along with every missing ancestor,
/// top-down. Idempotent: an existing collection answers 405, which counts as
/// success, so callers can plant a folder unconditionally.
async fn ensure_collection(session: &WebdavSession, rel_path: &str) -> Result<(), WebdavError> {
    for prefix in collection_prefixes(rel_path) {
        let url = request_url(&session.account, &prefix, true)?;
        let res = execute(session, mkcol_method()?, &url, &[], None, MAX_XML_BYTES).await?;
        // 201 created, 405 already exists -> both fine; anything else is fatal.
        if !http_ok(res.status) && res.status != 405 {
            return Err(status_err(res.status, &res.body));
        }
    }
    Ok(())
}

/// Create each missing ancestor collection of `rel_path`, top-down.
async fn ensure_ancestors(session: &WebdavSession, rel_path: &str) -> Result<(), WebdavError> {
    let segments: Vec<&str> = rel_path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() <= 1 {
        return Ok(());
    }
    ensure_collection(session, &segments[..segments.len() - 1].join("/")).await
}

/// Some servers omit the ETag on the PUT response; fetch it with a Depth:0
/// PROPFIND so echo suppression and conditional writes still work.
async fn resolve_put_etag(
    session: &WebdavSession,
    rel_path: &str,
    from_put: Option<String>,
) -> Option<String> {
    if from_put.is_some() {
        return from_put;
    }
    let list = webdav_propfind_inner(session, rel_path, 0).await.ok()?;
    list.entries
        .into_iter()
        .find(|e| !e.is_dir)
        .and_then(|e| e.etag)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::settings::{CloudAccountRef, Settings};

    fn settings_with_webdav_account() -> Settings {
        let mut settings = Settings::default();
        settings.integrations.cloud.accounts.push(CloudAccountRef {
            provider: "webdav".into(),
            account_id: "acct-1".into(),
            label: Some("Team DAV".into()),
            base_url: Some("https://dav.example.com/remote.php/dav/files/alice/".into()),
            username: Some("alice".into()),
            allow_private_host: Some(false),
        });
        settings
    }

    #[test]
    fn trusted_account_uses_persisted_webdav_metadata() {
        let settings = settings_with_webdav_account();
        let requested = WebdavAccount {
            account_id: "acct-1".into(),
            base_url: "https://attacker.example/".into(),
            username: "mallory".into(),
            allow_private_host: true,
        };

        let trusted = trusted_webdav_account(&settings, &requested).unwrap();

        assert_eq!(trusted.account_id, "acct-1");
        assert_eq!(
            trusted.base_url,
            "https://dav.example.com/remote.php/dav/files/alice/"
        );
        assert_eq!(trusted.username, "alice");
        assert!(!trusted.allow_private_host);
    }

    #[test]
    fn trusted_account_rejects_unenrolled_webdav_account() {
        let settings = settings_with_webdav_account();
        let requested = WebdavAccount {
            account_id: "missing".into(),
            base_url: "https://dav.example.com/".into(),
            username: "alice".into(),
            allow_private_host: false,
        };

        assert!(matches!(
            trusted_webdav_account(&settings, &requested),
            Err(WebdavError::AccountNotTrusted(_))
        ));
    }

    fn enrolled_account() -> WebdavAccount {
        WebdavAccount {
            account_id: "acct-1".into(),
            base_url: "https://dav.example.com/remote.php/dav/files/alice/".into(),
            username: "alice".into(),
            allow_private_host: false,
        }
    }

    #[test]
    fn request_url_rejects_paths_that_climb_out_of_the_base_collection() {
        // `.` is unreserved, so SEGMENT leaves `..` intact and Url::join would
        // resolve it — reaching the rest of the user's account on the vetted
        // host. The renderer is untrusted, so this must fail in Rust.
        let account = enrolled_account();
        for rel in [
            "../../../secrets.kdbx",
            "a/../../b.tex",
            "..",
            "./a.tex",
            r"..\..\windows.tex",
        ] {
            assert!(
                matches!(
                    request_url(&account, rel, false),
                    Err(WebdavError::InvalidUrl(_))
                ),
                "expected rejection for {rel}"
            );
        }
    }

    #[test]
    fn request_url_rejects_the_sidecar_directory_at_any_depth() {
        let account = enrolled_account();
        for rel in [".typeward/cursor.json", "sub/.TypeWard/x", ".typeward"] {
            assert!(
                matches!(
                    request_url(&account, rel, false),
                    Err(WebdavError::InvalidUrl(_))
                ),
                "expected rejection for {rel}"
            );
        }
    }

    #[test]
    fn derived_account_id_matches_the_frontend_rule() {
        // Must agree with `webdavAccountId` in cloud/webdav/auth.ts, or the
        // password is stored under one id and looked up under another.
        assert_eq!(
            derive_account_id("dav.example.com", "alice"),
            "alice@dav.example.com"
        );
        assert_eq!(
            derive_account_id("dav.example.com", "a li/ce"),
            "a_li_ce@dav.example.com"
        );
    }

    #[tokio::test]
    async fn enroll_probe_refuses_an_account_id_that_does_not_match_the_host() {
        // The binding is what keeps this un-enrolled path from becoming a way to
        // aim an already-enrolled account's stored password at a foreign host.
        let mismatched = WebdavAccount {
            account_id: "alice@dav.example.com".into(),
            base_url: "https://attacker.example/dav/".into(),
            username: "alice".into(),
            allow_private_host: false,
        };
        assert!(matches!(
            webdav_enroll_probe_body(mismatched).await,
            Err(WebdavError::AccountNotTrusted(_))
        ));
    }

    #[tokio::test]
    async fn enroll_probe_still_requires_https() {
        let insecure = WebdavAccount {
            account_id: "alice@dav.example.com".into(),
            base_url: "http://dav.example.com/dav/".into(),
            username: "alice".into(),
            allow_private_host: false,
        };
        assert!(matches!(
            webdav_enroll_probe_body(insecure).await,
            Err(WebdavError::InsecureScheme(_))
        ));
    }

    #[test]
    fn request_url_builds_ordinary_paths_under_the_base() {
        let account = enrolled_account();
        let url = request_url(&account, "chapters/intro one.tex", false).unwrap();
        assert_eq!(
            url.as_str(),
            "https://dav.example.com/remote.php/dav/files/alice/chapters/intro%20one.tex"
        );
        let dir = request_url(&account, "chapters", true).unwrap();
        assert!(dir.as_str().ends_with("/chapters/"));
    }

    #[test]
    fn parses_decimal_hex_octal_ipv4_literals() {
        assert_eq!(
            parse_ipv4_relaxed("2130706433"),
            Some(Ipv4Addr::new(127, 0, 0, 1))
        );
        assert_eq!(
            parse_ipv4_relaxed("0x7f000001"),
            Some(Ipv4Addr::new(127, 0, 0, 1))
        );
        assert_eq!(
            parse_ipv4_relaxed("0177.0.0.1"),
            Some(Ipv4Addr::new(127, 0, 0, 1))
        );
        assert_eq!(
            parse_ipv4_relaxed("127.1"),
            Some(Ipv4Addr::new(127, 0, 0, 1))
        );
        assert_eq!(
            parse_ipv4_relaxed("192.168.0.1"),
            Some(Ipv4Addr::new(192, 168, 0, 1))
        );
        assert_eq!(parse_ipv4_relaxed("cloud.example.com"), None);
    }

    #[test]
    fn hard_blocks_loopback_linklocal_metadata() {
        for h in [
            "127.0.0.1",
            "169.254.169.254",
            "0.0.0.0",
            "0x7f000001",
            "2130706433",
        ] {
            let ip = parse_ip_literal(h).expect(h);
            assert!(
                is_blocked_ip(ip, true),
                "{h} must stay blocked even with opt-in"
            );
        }
        let v6_meta = parse_ip_literal("[fd00:ec2::254]").unwrap();
        assert!(
            is_blocked_ip(v6_meta, true),
            "ipv6 metadata must stay blocked with opt-in"
        );
        let v6_loop = parse_ip_literal("[::1]").unwrap();
        assert!(is_blocked_ip(v6_loop, true));
    }

    #[test]
    fn private_ranges_gated_by_optin() {
        for h in ["10.0.0.5", "172.16.3.4", "192.168.1.50", "100.64.0.1"] {
            let ip = parse_ip_literal(h).expect(h);
            assert!(is_blocked_ip(ip, false), "{h} blocked without opt-in");
            assert!(!is_blocked_ip(ip, true), "{h} allowed with opt-in");
        }
        let ula = parse_ip_literal("[fd12:3456::1]").unwrap();
        assert!(is_blocked_ip(ula, false));
        assert!(!is_blocked_ip(ula, true));
    }

    #[test]
    fn public_hosts_pass() {
        let ip = parse_ip_literal("93.184.216.34").unwrap();
        assert!(!is_blocked_ip(ip, false));
        // ipv4-mapped public address
        let mapped = parse_ip_literal("[::ffff:93.184.216.34]").unwrap();
        assert!(!is_blocked_ip(mapped, false));
        // ipv4-mapped private must still be caught
        let mapped_priv = parse_ip_literal("[::ffff:192.168.0.1]").unwrap();
        assert!(is_blocked_ip(mapped_priv, false));
    }

    #[test]
    fn encodes_path_segments_preserving_separators() {
        assert_eq!(encode_rel("figures/plot 1.pdf"), "figures/plot%201.pdf");
        assert_eq!(encode_rel("a/b#c.tex"), "a/b%23c.tex");
        assert_eq!(
            encode_rel("café/résumé.tex"),
            "caf%C3%A9/r%C3%A9sum%C3%A9.tex"
        );
    }

    #[test]
    fn normalizes_etag() {
        assert_eq!(normalize_etag("\"abc123\""), Some("abc123".into()));
        assert_eq!(normalize_etag("W/\"abc123\""), Some("abc123".into()));
        assert_eq!(normalize_etag("  \"x\" "), Some("x".into()));
        assert_eq!(normalize_etag("\"\""), None);
    }

    #[test]
    fn parses_multistatus_with_mixed_prefixes_and_propstat_split() {
        let xml = br#"<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response>
            <d:href>/dav/files/me/project/</d:href>
            <d:propstat>
              <d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getetag>"root1"</d:getetag></d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
          <d:response>
            <d:href>/dav/files/me/project/main.tex</d:href>
            <d:propstat>
              <d:prop>
                <d:resourcetype/>
                <d:getcontentlength>4525</d:getcontentlength>
                <d:getetag>"file-abc"</d:getetag>
                <d:getlastmodified>Wed, 12 Apr 2006 17:48:03 GMT</d:getlastmodified>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
            <d:propstat>
              <d:prop><d:getcontenttype/></d:prop>
              <d:status>HTTP/1.1 404 Not Found</d:status>
            </d:propstat>
          </d:response>
          <lp1:response xmlns:lp1="DAV:">
            <lp1:href>/dav/files/me/project/figures/</lp1:href>
            <lp1:propstat>
              <lp1:prop><lp1:resourcetype><lp1:collection/></lp1:resourcetype><lp1:getetag>"dir-x"</lp1:getetag></lp1:prop>
              <lp1:status>HTTP/1.1 200 OK</lp1:status>
            </lp1:propstat>
          </lp1:response>
        </d:multistatus>"#;
        let raw = parse_multistatus(xml).unwrap();
        let entries = to_entries(raw, "/dav/files/me/project/", "/dav/files/me/project/");
        assert_eq!(entries.len(), 2);
        let file = entries.iter().find(|e| e.rel_path == "main.tex").unwrap();
        assert!(!file.is_dir);
        assert_eq!(file.etag.as_deref(), Some("file-abc"));
        assert_eq!(file.size, Some(4525));
        let dir = entries.iter().find(|e| e.rel_path == "figures").unwrap();
        assert!(dir.is_dir);
        assert_eq!(dir.etag.as_deref(), Some("dir-x"));
    }

    #[test]
    fn multistatus_href_entities_resolve_to_literal_chars() {
        let xml = br#"<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response>
            <d:href>/dav/files/me/project/a&amp;b &#38; c&#x26;d &lt;e&gt;.tex</d:href>
            <d:propstat>
              <d:prop><d:resourcetype/><d:getetag>"e1"</d:getetag></d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>"#;
        let raw = parse_multistatus(xml).unwrap();
        let entries = to_entries(raw, "/dav/files/me/project/", "/dav/files/me/project/");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "a&b & c&d <e>.tex");
        assert_eq!(entries[0].etag.as_deref(), Some("e1"));
    }

    #[test]
    fn multistatus_drops_entry_with_custom_entity_href_but_keeps_siblings() {
        let xml = br#"<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response>
            <d:href>/dav/files/me/project/before.tex</d:href>
            <d:propstat>
              <d:prop><d:resourcetype/><d:getetag>"b1"</d:getetag></d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
          <d:response>
            <d:href>/dav/&xxe;/x.tex</d:href>
            <d:propstat>
              <d:prop><d:resourcetype/></d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
          <d:response>
            <d:href>/dav/files/me/project/after.tex</d:href>
            <d:propstat>
              <d:prop><d:resourcetype/><d:getetag>"a1"</d:getetag></d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>"#;
        let raw = parse_multistatus(xml).unwrap();
        assert_eq!(raw.len(), 2);
        let entries = to_entries(raw, "/dav/files/me/project/", "/dav/files/me/project/");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].rel_path, "before.tex");
        assert_eq!(entries[1].rel_path, "after.tex");
    }

    #[test]
    fn poisoned_href_cannot_alias_another_entry_path() {
        // If the unresolvable entity merely vanished, `a&custom;b.tex` would
        // collapse to `ab.tex` and steal the real entry's identity.
        let xml = br#"<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response>
            <d:href>/dav/files/me/project/a&custom;b.tex</d:href>
            <d:propstat>
              <d:prop><d:resourcetype/><d:getetag>"evil"</d:getetag></d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
          <d:response>
            <d:href>/dav/files/me/project/ab.tex</d:href>
            <d:propstat>
              <d:prop><d:resourcetype/><d:getetag>"real"</d:getetag></d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>"#;
        let raw = parse_multistatus(xml).unwrap();
        assert_eq!(raw.len(), 1);
        assert_eq!(raw[0].href_path, "/dav/files/me/project/ab.tex");
        let entries = to_entries(raw, "/dav/files/me/project/", "/dav/files/me/project/");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "ab.tex");
        assert_eq!(entries[0].etag.as_deref(), Some("real"));
    }

    #[test]
    fn custom_entity_in_prop_value_degrades_that_value_only() {
        let xml = br#"<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response>
            <d:href>/dav/files/me/project/main.tex</d:href>
            <d:propstat>
              <d:prop>
                <d:resourcetype/>
                <d:getetag>"e1"</d:getetag>
                <d:getlastmodified>Wed,&nbsp;12 Apr 2006 17:48:03 GMT</d:getlastmodified>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>"#;
        let raw = parse_multistatus(xml).unwrap();
        let entries = to_entries(raw, "/dav/files/me/project/", "/dav/files/me/project/");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "main.tex");
        assert_eq!(entries[0].etag.as_deref(), Some("e1"));
        assert_eq!(entries[0].last_modified, None);
    }

    #[test]
    fn put_upload_cap_rejects_oversized_bodies() {
        assert!(ensure_upload_within_cap(0).is_ok());
        assert!(ensure_upload_within_cap(MAX_FILE_BYTES).is_ok());
        assert!(matches!(
            ensure_upload_within_cap(MAX_FILE_BYTES + 1),
            Err(WebdavError::TooLarge(_))
        ));
    }

    #[test]
    fn skips_self_entry_when_listing_subdir() {
        let xml = br#"<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response>
            <d:href>/dav/files/me/project/figures/</d:href>
            <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
          </d:response>
          <d:response>
            <d:href>/dav/files/me/project/figures/plot.pdf</d:href>
            <d:propstat><d:prop><d:resourcetype/><d:getetag>"p1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
          </d:response>
        </d:multistatus>"#;
        let raw = parse_multistatus(xml).unwrap();
        let entries = to_entries(
            raw,
            "/dav/files/me/project/",
            "/dav/files/me/project/figures/",
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "figures/plot.pdf");
    }

    #[test]
    fn href_decoding_handles_percent_and_unicode() {
        assert_eq!(
            href_to_path("/dav/a%20test/r%C3%A9sum%C3%A9.tex"),
            "/dav/a test/résumé.tex"
        );
        assert_eq!(href_to_path("https://h.example/dav/x%23y"), "/dav/x#y");
    }

    #[test]
    fn basic_auth_is_base64_userpass() {
        // "me:pw" -> bWU6cHc=
        assert_eq!(basic_auth_header("me", "pw"), "Basic bWU6cHc=");
    }

    #[test]
    fn normalize_base_requires_https_and_trailing_slash() {
        let (u, p) = normalize_base("https://h.example/remote.php/dav/files/me").unwrap();
        assert!(u.as_str().ends_with('/'));
        assert_eq!(p, "/remote.php/dav/files/me/");
        assert!(matches!(
            normalize_base("http://h.example/dav/"),
            Err(WebdavError::InsecureScheme(_))
        ));
    }

    #[test]
    fn put_retries_the_mkcol_chain_on_both_missing_parent_statuses() {
        // Koofr answers 404 where RFC 4918 mandates 409; both must arm MKCOL.
        assert!(needs_parent_collection(409));
        assert!(needs_parent_collection(404));
        // Anything the retry cannot fix must surface instead.
        for status in [200, 201, 204, 401, 403, 412, 423, 507] {
            assert!(!needs_parent_collection(status), "status {status}");
        }
    }

    #[test]
    fn collection_prefixes_walk_every_level_top_down() {
        assert_eq!(
            collection_prefixes("Typeward/My Thesis"),
            vec!["Typeward".to_string(), "Typeward/My Thesis".to_string()]
        );
        // A doubled or trailing slash must not mint an empty MKCOL target.
        assert_eq!(
            collection_prefixes("/Typeward//a/"),
            vec!["Typeward".to_string(), "Typeward/a".to_string()]
        );
        assert!(collection_prefixes("").is_empty());
    }
}
