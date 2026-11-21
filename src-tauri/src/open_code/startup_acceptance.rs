//! Opt-in real CLI smoke with disposable state, no owner credentials or inference.
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use super::{run_launcher, Startup, START_TIMEOUT};
use crate::open_code::{client, discovery, Host, OpenCodeError, OpenCodeResult, ServiceInfo};

struct Fixture {
    root: tempfile::TempDir,
    executable: PathBuf,
    port: u16,
}

impl Fixture {
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(&self.executable);
        command.env_clear();
        for key in [
            "PATH",
            "SystemRoot",
            "WINDIR",
            "COMSPEC",
            "PATHEXT",
            "SystemDrive",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let root = self.root.path();
        command
            .args(args)
            .current_dir(root)
            .env("USERPROFILE", root)
            .env("HOME", root)
            .env("APPDATA", root.join("appdata"))
            .env("LOCALAPPDATA", root.join("localappdata"))
            .env("TEMP", root.join("tmp"))
            .env("TMP", root.join("tmp"))
            .env("XDG_STATE_HOME", root.join("state"))
            .env("XDG_DATA_HOME", root.join("data"))
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_CACHE_HOME", root.join("cache"));
        command
    }

    fn registration(&self) -> OpenCodeResult<discovery::Registration> {
        let path = self.root.path().join("state/opencode/service.json");
        let raw = std::fs::read_to_string(path)
            .map_err(|_| OpenCodeError::new("not_running", "Isolated service is stopped"))?;
        let registration = discovery::parse_registration(&raw)?;
        let endpoint = reqwest::Url::parse(&registration.url).unwrap();
        assert_eq!(
            endpoint.port(),
            Some(self.port),
            "must never attach to owner service"
        );
        Ok(registration)
    }

    async fn info(&self, http: &reqwest::Client) -> OpenCodeResult<ServiceInfo> {
        let registration = self.registration()?;
        let endpoint = reqwest::Url::parse(&registration.url).unwrap();
        let session = client::ServiceSession::new(
            endpoint,
            registration.secret.clone(),
            registration.identity(),
            registration.version.clone(),
        )?;
        let info = session.info(http).await?;
        discovery::verify_identity(&registration, &info)?;
        Ok(info)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // All discovery/config paths belong to this fresh fixture. Never stop
        // the user's service or use the inherited environment for cleanup.
        let _ = run_launcher(self.command(&["service", "stop"]), Duration::from_secs(10));
    }
}

#[test]
#[ignore = "Explicit isolated installed-CLI startup acceptance; no model calls"]
fn installed_cli_cold_start_reuse_and_survival() {
    let launch = crate::cli_providers::discovery::discover("openCode").expect("installed CLI");
    assert!(launch.arguments.is_empty());
    let scratch = std::env::var_os("TMPDIR").expect("explicit scratch directory required");
    let root = tempfile::Builder::new()
        .prefix("tabs-opencode-startup-")
        .tempdir_in(scratch)
        .unwrap();
    for name in [
        "tmp",
        "appdata",
        "localappdata",
        "state",
        "data",
        "config",
        "cache",
    ] {
        std::fs::create_dir_all(root.path().join(name)).unwrap();
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let fixture = Fixture {
        root,
        executable: launch.executable,
        port,
    };
    run_launcher(
        fixture.command(&["service", "set", "port", &port.to_string()]),
        START_TIMEOUT,
    )
    .expect("isolated port config");
    let http = client::client().unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(fixture.info(&http))
            .unwrap_err()
            .code,
        "not_running"
    );
    let startup = Startup::default();
    let host = Host::new(fixture.root.path().join("tabs-workspace"), Box::new(|_| {})).unwrap();
    let first = tauri::async_runtime::block_on(startup.connect(
        || async { host.connect_registration(fixture.registration()?).await },
        || async { run_launcher(fixture.command(&["service", "start"]), START_TIMEOUT) },
    ))
    .expect("cold startup and authenticated health readback");
    let models = tauri::async_runtime::block_on(host.list_models()).expect("cold model catalog");
    let agents = tauri::async_runtime::block_on(host.list_agents()).expect("cold agent catalog");
    assert!(
        !agents.is_empty(),
        "activation barrier must populate the cold catalog"
    );
    let second = tauri::async_runtime::block_on(startup.connect(
        || async { host.connect_registration(fixture.registration()?).await },
        || async { panic!("healthy service must not be launched again") },
    ))
    .expect("healthy reuse");
    assert_eq!(first.pid, second.pid);
    host.shutdown();
    drop(host);
    drop(startup);
    let surviving = tauri::async_runtime::block_on(fixture.info(&http))
        .expect("daemon survives launcher and controller drop");
    assert_eq!(first.pid, Some(surviving.pid));
    println!("Isolated OpenCode {}: cold startup, {} models, {} agents, PID reuse and daemon survival after Host::shutdown passed", surviving.version, models.len(), agents.len());
    run_launcher(fixture.command(&["service", "stop"]), START_TIMEOUT)
        .expect("stop only isolated fixture");
    assert!(tauri::async_runtime::block_on(fixture.info(&http)).is_err());
}
