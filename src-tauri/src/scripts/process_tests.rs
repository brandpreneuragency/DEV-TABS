use super::*;
use std::path::Path;
#[test]
fn gate_holds_user_code_until_job_assignment() {
    let dir = tempfile::Builder::new()
        .prefix("tabs-script-gate-")
        .tempdir_in(std::env::var_os("TMPDIR").unwrap())
        .unwrap();
    let source = dir.path().join("code.txt");
    let marker = dir.path().join("executed.txt");
    std::fs::write(&source, "[IO.File]::WriteAllText('executed.txt','yes')").unwrap();
    let ps = runtimes()
        .into_iter()
        .find(|r| r.id == Runtime::Powershell)
        .unwrap();
    let child = command(&Runtime::Powershell, &ps.executable, &source, dir.path())
        .spawn()
        .unwrap();
    // Fixture cleanup is registered before waiting/asserting, even on panic.
    struct Guard(Child);
    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut guard = Guard(child);
    std::thread::sleep(Duration::from_millis(700));
    assert!(!marker.exists(), "no user code before assignment and gate");
    assert!(guard.0.try_wait().unwrap().is_none());
    let job = Job::assign(&guard.0).unwrap();
    guard.0.stdin.take().unwrap().write_all(b"GO\n").unwrap();
    let exit = guard.0.wait().unwrap();
    job.terminate();
    job.wait_empty().unwrap();
    assert!(exit.success());
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "yes");
}
#[test]
fn environment_is_explicit_and_aliases_are_rejected() {
    let c = command(
        &Runtime::Python,
        "python.exe",
        Path::new("C:/fixture/code.txt"),
        Path::new("C:/fixture"),
    );
    let names: Vec<_> = c
        .get_envs()
        .filter_map(|(k, v)| v.map(|_| k.to_string_lossy().to_ascii_uppercase()))
        .collect();
    for forbidden in [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "NODE_OPTIONS",
        "PYTHONPATH",
        "PYTHONSTARTUP",
        "BASH_ENV",
        "ENV",
        "SHELLOPTS",
        "PSMODULEPATH",
    ] {
        assert!(!names.iter().any(|n| n == forbidden));
    }
    assert!(!real_executable(Path::new(
        "C:/Users/fixture/AppData/Local/Microsoft/WindowsApps/python.exe"
    )));
    assert!(!real_executable(Path::new("C:/does-not-exist-runtime.exe")));
    assert!(local_directory(Path::new("\\\\?\\UNC\\server\\share")).is_err());
}
