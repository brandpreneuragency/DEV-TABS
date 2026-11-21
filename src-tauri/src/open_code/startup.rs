//! On-demand startup of the shared service, never ownership of its process tree.
use std::future::Future;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::types::{OpenCodeError, OpenCodeResult};

const START_TIMEOUT: Duration = Duration::from_secs(20);
const FAILURE_BACKOFF: Duration = Duration::from_secs(15);

#[cfg(all(test, windows))]
#[path = "startup_acceptance.rs"]
mod acceptance;

#[derive(Default)]
pub(super) struct Startup {
    gate: tauri::async_runtime::Mutex<Option<(Instant, OpenCodeError)>>,
}

impl Startup {
    pub async fn connect<T, Probe, ProbeFuture, Start, StartFuture>(
        &self,
        mut probe: Probe,
        start: Start,
    ) -> OpenCodeResult<T>
    where
        Probe: FnMut() -> ProbeFuture,
        ProbeFuture: Future<Output = OpenCodeResult<T>>,
        Start: FnOnce() -> StartFuture,
        StartFuture: Future<Output = OpenCodeResult<()>>,
    {
        // Re-probe under the lock so concurrent catalog/bridge/refresh calls
        // do not each launch a service during the same cold start.
        let mut failure = self.gate.lock().await;
        match probe().await {
            Ok(value) => {
                *failure = None;
                return Ok(value);
            }
            Err(error) if error.code == "not_running" => {}
            Err(error) => return Err(error),
        }
        if let Some((at, error)) = failure.as_ref() {
            if at.elapsed() < FAILURE_BACKOFF {
                return Err(error.clone());
            }
        }
        let launched = start().await;
        // A launcher exit is not readiness. A concurrent official client may
        // also have started the service even if our launcher failed.
        let result = match probe().await {
            Ok(value) => Ok(value),
            Err(error) if error.code != "not_running" => Err(error),
            Err(_) => match launched {
                Err(error) => Err(error),
                Ok(()) => Err(OpenCodeError::unavailable(
                    "OpenCode did not become ready. Check OpenCode and refresh the connection.",
                )),
            },
        };
        *failure = result
            .as_ref()
            .err()
            .map(|error| (Instant::now(), error.clone()));
        result
    }
}

pub(super) async fn start() -> OpenCodeResult<()> {
    tauri::async_runtime::spawn_blocking(|| {
        let launch = crate::cli_providers::discovery::discover("openCode")
            .map_err(OpenCodeError::unavailable)?;
        let mut command = Command::new(launch.executable);
        command.args(launch.arguments).args(["service", "start"]);
        run_launcher(command, START_TIMEOUT)
    })
    .await
    .map_err(|_| OpenCodeError::unavailable("OpenCode service startup could not be completed"))?
}

/// Wait only for the launcher. The probe runner's owned job would kill the
/// shared daemon on return, so it must not be used here. Discard raw output.
fn run_launcher(mut command: Command, timeout: Duration) -> OpenCodeResult<()> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|_| {
        OpenCodeError::unavailable(
            "OpenCode could not be launched. Check its installation and refresh the connection.",
        )
    })?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(OpenCodeError::unavailable(
                "OpenCode service start failed. Check that OpenCode V2 is installed, then refresh the connection.",
            )),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            result => {
                // Only our launcher is ours to kill; never terminate its tree.
                let _ = child.kill();
                let _ = child.wait();
                return Err(OpenCodeError::unavailable(if result.is_err() {
                    "OpenCode startup could not be checked. Refresh the connection."
                } else {
                    "OpenCode startup timed out. Check OpenCode and refresh the connection."
                }));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;
    use std::future::ready;

    #[test]
    fn starts_a_stopped_service_then_verifies_it_again() {
        let startup = Startup::default();
        let running = AtomicBool::new(false);
        let starts = AtomicUsize::new(0);
        let probes = AtomicUsize::new(0);
        let result = tauri::async_runtime::block_on(startup.connect(
            || async {
                probes.fetch_add(1, Ordering::SeqCst);
                if running.load(Ordering::SeqCst) {
                    Ok(42)
                } else {
                    Err(OpenCodeError::new("not_running", "Stopped fixture"))
                }
            },
            || async {
                starts.fetch_add(1, Ordering::SeqCst);
                running.store(true, Ordering::SeqCst);
                Ok(())
            },
        ));
        assert_eq!(result.expect("automatically connected"), 42);
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(probes.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn does_not_start_for_healthy_auth_protocol_or_registration_failures() {
        let startup = Startup::default();
        tauri::async_runtime::block_on(startup.connect(
            || ready(Ok(42)),
            || async { panic!("healthy service must be reused") },
        ))
        .unwrap();
        for code in [
            "unauthorized",
            "protocol",
            "incompatible",
            "versionMismatch",
            "unavailable",
            "transport",
        ] {
            let error = tauri::async_runtime::block_on(startup.connect(
                || ready(Err::<(), _>(OpenCodeError::new(code, "fixture"))),
                || async { panic!("must not restart or repair a running/untrusted service") },
            ))
            .unwrap_err();
            assert_eq!(error.code, code);
        }
    }

    #[test]
    fn concurrent_connections_start_only_once() {
        let startup = Startup::default();
        let running = AtomicBool::new(false);
        let starts = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    tauri::async_runtime::block_on(startup.connect(
                        || {
                            ready(if running.load(Ordering::SeqCst) {
                                Ok(())
                            } else {
                                Err(OpenCodeError::new("not_running", "fixture"))
                            })
                        },
                        || async {
                            starts.fetch_add(1, Ordering::SeqCst);
                            std::thread::sleep(Duration::from_millis(20));
                            running.store(true, Ordering::SeqCst);
                            Ok(())
                        },
                    ))
                    .unwrap();
                });
            }
        });
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failed_readiness_is_not_success_and_launch_retries_are_bounded() {
        let startup = Startup::default();
        let starts = AtomicUsize::new(0);
        for _ in 0..3 {
            let result = tauri::async_runtime::block_on(startup.connect(
                || ready(Err::<(), _>(OpenCodeError::new("not_running", "fixture"))),
                || async {
                    starts.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            ));
            assert_eq!(result.unwrap_err().code, "unavailable");
        }
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        tauri::async_runtime::block_on(startup.connect(
            || ready(Ok(())),
            || async { panic!("manual recovery must be detected") },
        ))
        .unwrap();
        assert!(tauri::async_runtime::block_on(startup.gate.lock()).is_none());
    }

    fn fixture_command() -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "open_code::startup::tests::slow_launcher_fixture",
            "--ignored",
        ]);
        command
    }

    #[test]
    #[ignore = "Child-process fixture, invoked only by the bounded launcher test"]
    fn slow_launcher_fixture() {
        std::thread::sleep(Duration::from_secs(2));
    }

    #[test]
    fn bounds_and_reaps_a_stalled_launcher() {
        let error = run_launcher(fixture_command(), Duration::from_millis(40)).unwrap_err();
        assert!(error.message.contains("timed out"));
    }

    #[test]
    fn launch_failure_does_not_expose_command_arguments() {
        let mut command = Command::new("tabs-nonexistent-opencode-fixture.exe");
        command.arg("SYNTHETIC_PRIVATE_ARGUMENT");
        let error = run_launcher(command, START_TIMEOUT).unwrap_err();
        assert!(!error.message.contains("SYNTHETIC_PRIVATE_ARGUMENT"));
        assert!(error.message.contains("installation"));
    }
}
