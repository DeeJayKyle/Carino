//! Looks for AI servers running on this PC (Ollama, LM Studio, llama.cpp) by reading their model
//! list. Deliberately narrow: only 127.0.0.1, only these ports and these two read-only paths,
//! only GET. It can't be used to reach anything else.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

const PORTS: [u16; 3] = [11434, 1234, 8080];
const PATHS: [&str; 2] = ["/api/tags", "/v1/models"];
const MAX: usize = 1 << 20;

pub fn allowed(port: u16, path: &str) -> bool {
    PORTS.contains(&port) && PATHS.contains(&path)
}

#[tauri::command]
pub fn probe_local_ai(port: u16, path: String) -> Result<Option<String>, String> {
    if !allowed(port, &path) {
        return Err("Not an AI server port or listing.".into());
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = match TcpStream::connect_timeout(&addr, Duration::from_millis(800)) {
        Ok(s) => s,
        Err(_) => return Ok(None), // nothing running there
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    let req = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return Ok(None);
    }
    let mut buf = Vec::new();
    let _ = s.take(MAX as u64).read_to_end(&mut buf);
    Ok(split_ok_body(&buf))
}

/// The body of a 200 response, or None.
pub fn split_ok_body(buf: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(buf);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let status = head.lines().next()?;
    if !status.split_whitespace().nth(1).map_or(false, |c| c == "200") {
        return None;
    }
    Some(body.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ai_listings_on_known_ports() {
        assert!(allowed(11434, "/api/tags"));
        assert!(allowed(1234, "/v1/models"));
        assert!(!allowed(22, "/v1/models"));
        assert!(!allowed(11434, "/api/generate"));
        assert!(!allowed(11434, "/../etc/passwd"));
    }

    #[test]
    fn reads_only_successful_bodies() {
        assert_eq!(split_ok_body(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"models\":[]}").as_deref(), Some("{\"models\":[]}"));
        assert_eq!(split_ok_body(b"HTTP/1.1 403 Forbidden\r\n\r\nno"), None);
        assert_eq!(split_ok_body(b"garbage"), None);
    }
}
