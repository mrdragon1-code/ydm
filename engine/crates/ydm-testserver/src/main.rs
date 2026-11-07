//! `ydm-testserver [--port P] [--size MB] [--rate KB/s per connection] [--no-ranges]
//!                 [--filename NAME] [--require-cookie NAME=VALUE]`

use ydm_testserver::{Config, spawn};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let mut port = 8080;
    let mut cfg = Config::new(256 << 20);
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut text = || args.next().expect("missing value");
        match arg.as_str() {
            "--filename" => cfg.filename = Some(text()),
            "--require-cookie" => cfg.require_cookie = Some(text()),
            "--require-referer" => cfg.require_referer = Some(text()),
            _ => {}
        }
        if matches!(arg.as_str(), "--filename" | "--require-cookie" | "--require-referer") {
            continue;
        }
        let mut value = || {
            args.next()
                .and_then(|v| v.parse::<u64>().ok())
                .expect("missing number")
        };
        match arg.as_str() {
            "--port" => port = value() as u16,
            "--size" => cfg.size = value() << 20,
            "--rate" => cfg.rate = Some(value() << 10),
            "--no-ranges" => cfg.ranges = false,
            "--forbid-ranges" => cfg.forbid_ranges = true,
            "--log" => cfg.log = true,
            "--max-connections" => cfg.max_connections = Some(value() as usize),
            _ => {
                eprintln!(
                    "usage: ydm-testserver [--port P] [--size MB] [--rate KB/s] [--no-ranges] [--forbid-ranges] [--log] [--max-connections N] [--filename NAME] [--require-cookie NAME=VALUE] [--require-referer PREFIX]"
                );
                std::process::exit(2);
            }
        }
    }
    let server = spawn(&format!("127.0.0.1:{port}"), cfg.clone()).await?;
    println!("serving {} MB at {}", cfg.size >> 20, server.url());
    if let Some(rate) = cfg.rate {
        println!("throttled to {} KB/s per connection", rate >> 10);
    }
    println!("sha256 {}", ydm_testserver::sha256(cfg.size));
    std::future::pending::<()>().await;
    Ok(())
}
