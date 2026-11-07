//! Minimal HTTP/1.1 file server for tests and benchmarks.
//!
//! Serves a synthetic file whose content is computed from the byte offset,
//! so files of any size cost no memory and can be checked independently.
//! Supports ranges, If-Range, per-connection throttling (the reason
//! segmented downloads are faster) and fault injection.

use sha2::{Digest, Sha256};
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const CHUNK: usize = 16 * 1024;

#[derive(Debug, Clone)]
pub struct Config {
    pub size: u64,
    /// Bytes per second per connection; `None` is unthrottled.
    pub rate: Option<u64>,
    pub ranges: bool,
    pub filename: Option<String>,
    /// Drop the connection after this many body bytes, for the first
    /// `fail_count` responses.
    pub fail_after: Option<u64>,
    pub fail_count: usize,
    /// After this many requests the ETag changes, as if the file was replaced.
    pub change_after: Option<usize>,
    /// Answer 503 beyond this many simultaneous connections, like many
    /// file hosts do per client.
    pub max_connections: Option<usize>,
    /// Answer 403 unless the Cookie header contains this, like a site
    /// that only serves logged-in users.
    pub require_cookie: Option<String>,
    /// Answer 403 to any request with a Range header, like sites that
    /// block download accelerators.
    pub forbid_ranges: bool,
    /// Print one line per request on stdout: method, path, range, cookie.
    pub log: bool,
    /// Answer 403 unless the Referer starts with this, like sites that
    /// block hotlinking.
    pub require_referer: Option<String>,
}

impl Config {
    pub fn new(size: u64) -> Self {
        Self {
            size,
            rate: None,
            ranges: true,
            filename: None,
            fail_after: None,
            fail_count: 0,
            change_after: None,
            max_connections: None,
            require_cookie: None,
            forbid_ranges: false,
            log: false,
            require_referer: None,
        }
    }
}

#[derive(Debug, Default)]
pub struct Stats {
    pub requests: AtomicUsize,
    pub active: AtomicUsize,
    pub peak_active: AtomicUsize,
    /// `(Host header, had a Cookie header)` for every request.
    pub cookies: Mutex<Vec<(String, bool)>>,
    failures: AtomicUsize,
}

pub struct Server {
    pub addr: SocketAddr,
    pub stats: Arc<Stats>,
}

impl Server {
    /// `http://127.0.0.1:port/file`.
    pub fn url(&self) -> String {
        format!("http://{}/file", self.addr)
    }

    /// Redirects to the same file under another origin (`localhost`).
    pub fn cross_origin_redirect_url(&self) -> String {
        format!("http://{}/redirect", self.addr)
    }
}

pub async fn spawn(addr: &str, cfg: Config) -> io::Result<Server> {
    let listener = TcpListener::bind(addr).await?;
    let addr = listener.local_addr()?;
    let stats = Arc::new(Stats::default());
    let cfg = Arc::new(cfg);
    let s = stats.clone();
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let (cfg, stats) = (cfg.clone(), s.clone());
            tokio::spawn(async move {
                let active = stats.active.fetch_add(1, Ordering::SeqCst) + 1;
                stats.peak_active.fetch_max(active, Ordering::SeqCst);
                let _ = handle(sock, &cfg, &stats, addr).await;
                stats.active.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    Ok(Server { addr, stats })
}

/// Content of the synthetic file at `offset`.
pub fn byte_at(offset: u64) -> u8 {
    let x = offset.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    (x >> 56) as u8 ^ offset as u8
}

pub fn sha256(size: u64) -> String {
    let mut hasher = Sha256::new();
    let mut buf = vec![0; CHUNK];
    let mut offset = 0;
    while offset < size {
        let n = (size - offset).min(CHUNK as u64) as usize;
        fill(&mut buf[..n], offset);
        hasher.update(&buf[..n]);
        offset += n as u64;
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn fill(buf: &mut [u8], offset: u64) {
    for (i, b) in buf.iter_mut().enumerate() {
        *b = byte_at(offset + i as u64);
    }
}

async fn handle(
    mut sock: TcpStream,
    cfg: &Config,
    stats: &Stats,
    addr: SocketAddr,
) -> io::Result<()> {
    let head = read_head(&mut sock).await?;
    let mut request_line = head.lines().next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_string();
    let path = request_line.next().unwrap_or_default().to_string();
    let header = |name: &str| {
        head.lines()
            .skip(1)
            .filter_map(|l| l.split_once(':'))
            .find(|(k, _)| k.trim().eq_ignore_ascii_case(name))
            .map(|(_, v)| v.trim().to_string())
    };

    let n = stats.requests.fetch_add(1, Ordering::SeqCst) + 1;
    let host = header("host").unwrap_or_default();
    stats
        .cookies
        .lock()
        .unwrap()
        .push((host, header("cookie").is_some()));
    if cfg.log {
        println!(
            "{method} {path} range={} cookie={}",
            header("range").unwrap_or_else(|| "-".into()),
            if header("cookie").is_some() { "yes" } else { "no" },
        );
    }

    // A page that clicks through to /login after a few seconds, for test
    // drivers that install the extension only after the first page opens.
    if path == "/start" {
        let body = "<!doctype html><meta http-equiv=\"refresh\" content=\"4;url=/login\">";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        return sock.write_all(resp.as_bytes()).await;
    }

    // A page linking to the file, so a click sends a Referer. With `?auto`
    // it clicks by itself after a few seconds, for drivers that cannot.
    if path == "/page" || path == "/page?auto" {
        let click = if path.ends_with("?auto") {
            "<script>setTimeout(() => document.getElementById('dl').click(), 4000)</script>"
        } else {
            ""
        };
        let body = format!("<!doctype html><a id=\"dl\" href=\"/file\">download</a>{click}");
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        return sock.write_all(resp.as_bytes()).await;
    }

    if path == "/file"
        && let Some(prefix) = &cfg.require_referer
        && !header("referer").is_some_and(|r| r.starts_with(prefix.as_str()))
    {
        let resp = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        return sock.write_all(resp.as_bytes()).await;
    }

    // Diagnostics sent by a client under test; already logged above.
    if path.starts_with("/diag") {
        let resp = "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n";
        return sock.write_all(resp.as_bytes()).await;
    }

    // Logs in like a real site: sets the cookie, then sends to the file.
    if path == "/login" {
        let cookie = cfg.require_cookie.as_deref().unwrap_or("sid=42");
        let resp = format!(
            "HTTP/1.1 302 Found\r\nSet-Cookie: {cookie}; Path=/\r\nLocation: /file\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        return sock.write_all(resp.as_bytes()).await;
    }

    if path == "/redirect" {
        let to = format!("http://localhost:{}/file", addr.port());
        let resp = format!(
            "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        return sock.write_all(resp.as_bytes()).await;
    }

    if cfg.forbid_ranges && header("range").is_some() {
        let resp = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        return sock.write_all(resp.as_bytes()).await;
    }

    if let Some(needed) = &cfg.require_cookie
        && !header("cookie").is_some_and(|c| c.contains(needed.as_str()))
    {
        let resp = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        return sock.write_all(resp.as_bytes()).await;
    }

    if cfg
        .max_connections
        .is_some_and(|max| stats.active.load(Ordering::SeqCst) > max)
    {
        let resp =
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        return sock.write_all(resp.as_bytes()).await;
    }

    let etag = match cfg.change_after {
        Some(k) if n > k => "\"v2\"",
        _ => "\"v1\"",
    };
    let mut range = cfg
        .ranges
        .then(|| header("range").and_then(|r| parse_range(&r, cfg.size)))
        .flatten();
    if header("if-range").is_some_and(|v| v != etag) {
        range = None;
    }

    let mut resp = String::new();
    let (start, end) = match range {
        Some((a, b)) => {
            resp += "HTTP/1.1 206 Partial Content\r\n";
            resp += &format!("Content-Range: bytes {a}-{b}/{}\r\n", cfg.size);
            (a, b + 1)
        }
        None => {
            resp += "HTTP/1.1 200 OK\r\n";
            (0, cfg.size)
        }
    };
    resp += &format!(
        "Content-Length: {}\r\nETag: {etag}\r\nConnection: close\r\n",
        end - start
    );
    if cfg.ranges {
        resp += "Accept-Ranges: bytes\r\n";
    }
    if let Some(name) = &cfg.filename {
        resp += &format!("Content-Disposition: attachment; filename=\"{name}\"\r\n");
    }
    resp += "\r\n";
    sock.write_all(resp.as_bytes()).await?;
    if method == "HEAD" {
        return Ok(());
    }

    let fail_at = cfg
        .fail_after
        .filter(|_| stats.failures.fetch_add(1, Ordering::SeqCst) < cfg.fail_count);
    let started = Instant::now();
    let mut buf = vec![0; CHUNK];
    let mut offset = start;
    while offset < end {
        let n = (end - offset).min(CHUNK as u64) as usize;
        fill(&mut buf[..n], offset);
        sock.write_all(&buf[..n]).await?;
        offset += n as u64;
        let sent = offset - start;
        if fail_at.is_some_and(|f| sent >= f) {
            return Ok(()); // connection dropped mid-body
        }
        if let Some(rate) = cfg.rate {
            let due = Duration::from_secs_f64(sent as f64 / rate as f64);
            if let Some(wait) = due.checked_sub(started.elapsed()) {
                tokio::time::sleep(wait).await;
            }
        }
    }
    sock.flush().await
}

async fn read_head(sock: &mut TcpStream) -> io::Result<String> {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0; 1024];
    while !head.ends_with(b"\r\n\r\n") {
        let n = sock.read(&mut chunk).await?;
        if n == 0 || head.len() > 16 * 1024 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        head.extend_from_slice(&chunk[..n]);
    }
    Ok(String::from_utf8_lossy(&head).into_owned())
}

/// `bytes=a-b` or `bytes=a-`, clamped to the file.
fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let (a, b) = value.strip_prefix("bytes=")?.split_once('-')?;
    let a: u64 = a.trim().parse().ok()?;
    let b: u64 = match b.trim() {
        "" => size - 1,
        b => b.parse::<u64>().ok()?.min(size - 1),
    };
    (a <= b).then_some((a, b))
}
