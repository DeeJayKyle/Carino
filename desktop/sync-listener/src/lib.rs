//! The local-network endpoint a paired phone syncs with (Carino for Windows).
//!
//! The phone can't accept connections, so the PC listens. This listener only moves bytes: every
//! request is encrypted and authenticated with the key the two devices agreed when they were paired,
//! and the app (the same engine as the phone, in the window) opens and answers it. Anything that
//! isn't `POST /carino-sync` is refused, bodies are capped, and each address is rate-limited.

use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// The port Carino listens on (the phone is told it when pairing).
pub const DEFAULT_PORT: u16 = 47900;
/// Largest request accepted (a batch of changes, files included).
pub const MAX_BODY: usize = 64 * 1024 * 1024;
/// Requests per minute from one address.
pub const PER_MINUTE: u32 = 120;

/// Answers one request body with a response body (the app's sync handler).
pub type Handler = Arc<dyn Fn(String) -> Result<String, String> + Send + Sync>;

pub struct Listener {
    pub addr: SocketAddr,
    stop: Arc<AtomicBool>,
    server: Arc<tiny_http::Server>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Listener {
    /// Starts listening on `bind` (e.g. "0.0.0.0:47900"); use port 0 for any free port.
    pub fn start(bind: &str, handler: Handler) -> Result<Listener, String> {
        let server = Arc::new(tiny_http::Server::http(bind).map_err(|e| format!("Couldn't listen on {bind}: {e}"))?);
        let addr = server.server_addr().to_ip().ok_or("Not an IP address")?;
        let stop = Arc::new(AtomicBool::new(false));
        let (s, st) = (server.clone(), stop.clone());
        let worker = thread::spawn(move || serve(s, st, handler));
        Ok(Listener { addr, stop, server, worker: Some(worker) })
    }

    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.server.unblock();
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct Limiter {
    seen: HashMap<IpAddr, (Instant, u32)>,
}

impl Limiter {
    fn allow(&mut self, ip: IpAddr) -> bool {
        let now = Instant::now();
        if self.seen.len() > 10_000 {
            self.seen.clear();
        }
        let e = self.seen.entry(ip).or_insert((now, 0));
        if now.duration_since(e.0) > Duration::from_secs(60) {
            *e = (now, 0);
        }
        e.1 += 1;
        e.1 <= PER_MINUTE
    }
}

fn serve(server: Arc<tiny_http::Server>, stop: Arc<AtomicBool>, handler: Handler) {
    let limiter = Mutex::new(Limiter { seen: HashMap::new() });
    while !stop.load(Ordering::SeqCst) {
        let mut req = match server.recv() {
            Ok(r) => r,
            Err(_) => break,
        };
        let json = |status: u16, body: String| {
            tiny_http::Response::from_string(body)
                .with_status_code(status)
                .with_header("Content-Type: application/json".parse::<tiny_http::Header>().unwrap())
        };
        if req.method() != &tiny_http::Method::Post || req.url() != "/carino-sync" {
            let _ = req.respond(json(404, r#"{"ok":false,"error":"Not found"}"#.into()));
            continue;
        }
        let ip = req.remote_addr().map(|a| a.ip()).unwrap_or(IpAddr::from([0, 0, 0, 0]));
        if !limiter.lock().unwrap().allow(ip) {
            let _ = req.respond(json(429, r#"{"ok":false,"error":"Too many requests"}"#.into()));
            continue;
        }
        if req.body_length().unwrap_or(0) > MAX_BODY {
            let _ = req.respond(json(413, r#"{"ok":false,"error":"Too large"}"#.into()));
            continue;
        }
        let mut body = String::new();
        let read = req.as_reader().take(MAX_BODY as u64 + 1).read_to_string(&mut body);
        if read.is_err() || body.len() > MAX_BODY {
            let _ = req.respond(json(413, r#"{"ok":false,"error":"Too large or not text"}"#.into()));
            continue;
        }
        let reply = match handler(body) {
            Ok(out) => json(200, out),
            Err(e) => json(503, format!("{{\"ok\":false,\"error\":{:?}}}", e)),
        };
        let _ = req.respond(reply);
    }
}

/// This PC's addresses on private networks (what the phone can reach), for the pairing QR code.
pub fn lan_addresses(port: u16, candidates: &[IpAddr]) -> Vec<String> {
    candidates
        .iter()
        .filter(|ip| match ip {
            IpAddr::V4(v4) => v4.is_private() && !v4.is_loopback(),
            IpAddr::V6(_) => false,
        })
        .map(|ip| format!("http://{ip}:{port}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;

    fn post(addr: SocketAddr, path: &str, body: &str) -> (u16, String) {
        let mut s = TcpStream::connect(addr).unwrap();
        write!(s, "POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        let status = out.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, out.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
    }

    fn echo() -> Handler {
        Arc::new(|b: String| Ok(format!("{{\"echo\":{b}}}")))
    }

    #[test]
    fn passes_sync_requests_to_the_app() {
        let l = Listener::start("127.0.0.1:0", echo()).unwrap();
        let (status, body) = post(l.addr, "/carino-sync", r#"{"v":1}"#);
        assert_eq!(status, 200);
        assert_eq!(body, r#"{"echo":{"v":1}}"#);
        l.stop();
    }

    #[test]
    fn refuses_anything_else() {
        let l = Listener::start("127.0.0.1:0", echo()).unwrap();
        assert_eq!(post(l.addr, "/", "x").0, 404);
        assert_eq!(post(l.addr, "/carino-sync/../etc", "x").0, 404);
        let mut s = TcpStream::connect(l.addr).unwrap();
        write!(s, "GET /carino-sync HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn says_so_when_the_app_cannot_answer() {
        let l = Listener::start("127.0.0.1:0", Arc::new(|_| Err("The app is closed".into()))).unwrap();
        let (status, body) = post(l.addr, "/carino-sync", "{}");
        assert_eq!(status, 503);
        assert!(body.contains("The app is closed"));
    }

    #[test]
    fn limits_each_address() {
        let l = Listener::start("127.0.0.1:0", echo()).unwrap();
        let mut limited = 0;
        for _ in 0..(PER_MINUTE + 5) {
            if post(l.addr, "/carino-sync", "{}").0 == 429 {
                limited += 1;
            }
        }
        assert_eq!(limited, 5);
    }

    #[test]
    fn refuses_oversized_bodies() {
        let l = Listener::start("127.0.0.1:0", echo()).unwrap();
        let mut s = TcpStream::connect(l.addr).unwrap();
        write!(s, "POST /carino-sync HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_BODY + 1).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 413"), "{out}");
    }

    #[test]
    fn offers_only_private_network_addresses() {
        let ips: Vec<IpAddr> = ["192.168.1.20", "10.0.0.5", "127.0.0.1", "8.8.8.8", "::1"].iter().map(|s| s.parse().unwrap()).collect();
        assert_eq!(lan_addresses(47900, &ips), vec!["http://192.168.1.20:47900", "http://10.0.0.5:47900"]);
    }
}
