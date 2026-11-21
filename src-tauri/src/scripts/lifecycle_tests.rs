use super::tests::{fixture, input, wait};
use super::*;
use std::time::{Duration, Instant};
struct Shutdown(Arc<ScriptsHost>);
impl Drop for Shutdown {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}
#[test]
fn cancel_waits_for_real_descendant_tree() {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    let (_dir, h) = fixture();
    let _cleanup = Shutdown(h.clone());
    // Child self-expires too, even if the assertion/process ownership regresses.
    let code = "$p = Start-Process -FilePath ($PSHOME + '\\powershell.exe') -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 20' -PassThru; [Console]::Out.WriteLine($p.Id); Start-Sleep -Seconds 20";
    let s = h.save(input(code), None, None).unwrap();
    let r = h.start(&s.id, 1, "descendant", true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let pid = loop {
        let o = h.output(&r.id).unwrap();
        if let Ok(pid) = o.stdout.trim().parse::<u32>() {
            break pid;
        }
        assert!(o.run.status.active(), "{} {:?}", o.stderr, o.run.error);
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    };
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(
        !handle.is_null(),
        "descendant must be real and alive before cancellation"
    );
    let result = h.cancel(&r.id).unwrap();
    let waited = unsafe { WaitForSingleObject(handle, 2000) };
    unsafe {
        CloseHandle(handle);
    }
    assert_eq!(result.status, Status::Cancelled);
    assert_eq!(
        waited, WAIT_OBJECT_0,
        "cancel must wait for owned descendant termination"
    );
}
#[test]
fn timeout_log_cap_and_success_are_real() {
    let (_dir, h) = fixture();
    let _cleanup = Shutdown(h.clone());
    let mut i = input("Start-Sleep -Seconds 20");
    i.timeout_seconds = 1;
    let s = h.save(i, None, None).unwrap();
    let r = h.start(&s.id, 1, "timeout", true).unwrap();
    let o = wait(&h, &r.id);
    assert_eq!(o.run.status, Status::Failed);
    assert!(o.run.error.unwrap().contains("timeout"));
    let s = h.save(input("[Console]::Out.Write(('x' * 1200000)); [Console]::Error.Write(('y' * 1200000)); [Console]::Out.Write('finished')"), None, None).unwrap();
    let r = h.start(&s.id, 1, "cap", true).unwrap();
    let o = wait(&h, &r.id);
    assert_eq!(
        o.run.status,
        Status::Succeeded,
        "{} {:?}",
        o.stderr,
        o.run.error
    );
    assert_eq!(o.run.exit_code, Some(0));
    assert!(o.truncated);
    assert_eq!(o.stdout.len() + o.stderr.len(), MAX_LOG_BYTES);
}
#[test]
fn concurrency_shutdown_and_restart_never_relaunch() {
    let (dir, h) = fixture();
    let _cleanup = Shutdown(h.clone());
    let s = h
        .save(input("Start-Sleep -Seconds 20"), None, None)
        .unwrap();
    let s2 = h.duplicate(&s.id).unwrap();
    let s3 = h.duplicate(&s.id).unwrap();
    let r = h.start(&s.id, 1, "shutdown1", true).unwrap();
    assert!(h.start(&s.id, 1, "same-script", true).is_err());
    let r2 = h.start(&s2.id, 1, "shutdown2", true).unwrap();
    assert!(h.start(&s3.id, 1, "over-cap", true).is_err());
    h.shutdown();
    assert_eq!(h.output(&r.id).unwrap().run.status, Status::Interrupted);
    assert_eq!(h.output(&r2.id).unwrap().run.status, Status::Interrupted);
    assert!(h.start(&s3.id, 1, "after-shutdown", true).is_err());
    drop(_cleanup);
    drop(h);
    // Emulate an interrupted persisted active record, not a real orphan process.
    let p = dir.path().join("scripts/catalog.json");
    let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    v["runs"][0]["status"] = "running".into();
    v["runs"][0]["completedAt"] = serde_json::Value::Null;
    std::fs::write(&p, serde_json::to_vec(&v).unwrap()).unwrap();
    let h = Arc::new(ScriptsHost::new(dir.path().join("scripts")));
    let snap = h.snapshot().unwrap();
    assert_eq!(snap.runs.len(), 2);
    assert!(snap.runs.iter().all(|r| r.status == Status::Interrupted));
    assert_eq!(h.start(&s.id, 1, "shutdown1", true).unwrap().id, r.id);
    assert!(h.inner.lock().unwrap().active.is_empty());
}
#[test]
fn every_discovered_runtime_executes_and_stdin_is_eof() {
    let (_dir, h) = fixture();
    let _cleanup = Shutdown(h.clone());
    let runtimes = h.snapshot().unwrap().runtimes;
    assert!(runtimes.iter().any(|r| r.id == Runtime::Powershell));
    for runtime in runtimes {
        let code=match runtime.id {
            Runtime::Powershell => "if ($null -ne [Console]::In.ReadLine()) { exit 3 }; if ($env:OPENAI_API_KEY -or $env:NODE_OPTIONS -or $env:PYTHONPATH -or $env:BASH_ENV) { exit 4 }; [Console]::Out.WriteLine('runtime-ok')",
            Runtime::Python => "import sys,os\nassert sys.stdin.read()==''\nassert not any(os.getenv(k) for k in ['OPENAI_API_KEY','NODE_OPTIONS','PYTHONPATH','BASH_ENV'])\nprint('runtime-ok')",
            Runtime::Node => "if(require('fs').readFileSync(0,'utf8')!=='')process.exit(3);if(['OPENAI_API_KEY','NODE_OPTIONS','PYTHONPATH','BASH_ENV'].some(k=>process.env[k]))process.exit(4);console.log('runtime-ok')",
            Runtime::Bash => "if read -r value; then exit 3; fi; test -z \"${OPENAI_API_KEY}${NODE_OPTIONS}${PYTHONPATH}${BASH_ENV}\" || exit 4; printf 'runtime-ok\\n'",
        };
        let mut i = input(code);
        i.runtime = runtime.id.clone();
        let s = h.save(i, None, None).unwrap();
        let r = h.start(&s.id, 1, &new_id().unwrap(), true).unwrap();
        let o = wait(&h, &r.id);
        assert_eq!(
            o.run.status,
            Status::Succeeded,
            "{:?}: {} {:?}",
            runtime.id,
            o.stderr,
            o.run.error
        );
        assert!(o.stdout.contains("runtime-ok"), "{:?}", runtime.id);
        println!(
            "real runtime {:?}: exit {:?}, stdout={}",
            runtime.id,
            o.run.exit_code,
            o.stdout.trim()
        );
    }
}
#[test]
fn unknown_saved_fields_are_not_silently_overwritten() {
    let (dir, h) = fixture();
    h.save(input("'x'"), None, None).unwrap();
    drop(h);
    let p = dir.path().join("scripts/catalog.json");
    let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    v["scripts"][0]["futureField"] = true.into();
    let bytes = serde_json::to_vec(&v).unwrap();
    std::fs::write(&p, &bytes).unwrap();
    let h = ScriptsHost::new(dir.path().join("scripts"));
    assert!(h.snapshot().is_err());
    assert_eq!(std::fs::read(p).unwrap(), bytes);
}

#[test]
fn powershell_propagates_last_native_command_failure() {
    let (_dir, h) = fixture();
    let _cleanup = Shutdown(h.clone());
    let script = h
        .save(input("& $env:COMSPEC /d /c 'exit 7'"), None, None)
        .unwrap();
    let run = h.start(&script.id, 1, "native-exit-code", true).unwrap();
    let output = wait(&h, &run.id);
    assert_eq!(output.run.status, Status::Failed);
    assert_eq!(output.run.exit_code, Some(7));
}

#[test]
fn canonical_windows_root_runs_with_its_default_working_directory() {
    let (dir, original) = fixture();
    original.snapshot().unwrap();
    drop(original);
    let root = dir.path().join("scripts").canonicalize().unwrap();
    let h = Arc::new(ScriptsHost::new(root));
    let _cleanup = Shutdown(h.clone());
    for runtime in h.snapshot().unwrap().runtimes {
        let code = match runtime.id {
            Runtime::Powershell => "Write-Output 'canonical-ok'",
            Runtime::Python => "print('canonical-ok')",
            Runtime::Node => "console.log('canonical-ok')",
            Runtime::Bash => "printf 'canonical-ok\\n'",
        };
        let mut draft = input(code);
        draft.runtime = runtime.id.clone();
        let script = h.save(draft, None, None).unwrap();
        let run = h.start(&script.id, 1, &new_id().unwrap(), true).unwrap();
        let output = wait(&h, &run.id);
        assert_eq!(
            output.run.status,
            Status::Succeeded,
            "{:?}: {} {:?}",
            runtime.id,
            output.stderr,
            output.run.error
        );
        assert!(output.stdout.contains("canonical-ok"));
    }
}
