use super::*;
use std::time::{Duration, Instant};
pub(super) fn fixture() -> (tempfile::TempDir, Arc<ScriptsHost>) {
    let dir = tempfile::Builder::new()
        .prefix("tabs-scripts-test-")
        .tempdir_in(std::env::var_os("TMPDIR").expect("tests require TMPDIR"))
        .unwrap();
    let host = Arc::new(ScriptsHost::new(dir.path().join("scripts")));
    (dir, host)
}
pub(super) fn input(code: &str) -> ScriptInput {
    ScriptInput {
        name: "Harmless fixture".into(),
        description: "Native isolated test".into(),
        code: code.into(),
        runtime: Runtime::Powershell,
        working_directory: String::new(),
        confirmation_required: true,
        timeout_seconds: 15,
    }
}
pub(super) fn wait(h: &ScriptsHost, id: &str) -> ScriptOutput {
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        let o = h.output(id).unwrap();
        if !o.run.status.active() {
            return o;
        }
        assert!(Instant::now() < deadline, "job did not finish");
        std::thread::sleep(Duration::from_millis(30));
    }
}
#[test]
fn rejects_path_ids() {
    assert!(!valid_id("../escape"));
    assert!(valid_id("0123456789abcdef0123456789abcdef"));
}
#[test]
fn idempotency_rejects_changed_confirmation_payload() {
    let (_dir, h) = fixture();
    let mut i = input("'ok'");
    i.confirmation_required = false;
    let s = h.save(i, None, None).unwrap();
    let r = h
        .start(&s.id, 1, "opaque_Nano-ID_0123456789", false)
        .unwrap();
    let changed = h.start(&s.id, 1, "opaque_Nano-ID_0123456789", true);
    wait(&h, &r.id);
    assert!(
        changed.is_err(),
        "a changed payload must not reuse an admission receipt"
    );
}
#[test]
fn persistence_cas_duplicate_delete_and_corruption() {
    let (dir, h) = fixture();
    let s = h.save(input("Write-Output 'saved'"), None, None).unwrap();
    assert!(h
        .save(input("Write-Output 'wrong'"), Some(s.id.clone()), Some(9))
        .is_err());
    let edited = h
        .save(input("Write-Output 'edited'"), Some(s.id.clone()), Some(1))
        .unwrap();
    assert_eq!(edited.revision, 2);
    let copy = h.duplicate(&s.id).unwrap();
    assert_ne!(copy.id, s.id);
    assert_eq!(copy.input.code, edited.input.code);
    assert!(h.delete(&s.id, 1).is_err());
    h.delete(&s.id, 2).unwrap();
    assert!(
        ScriptsHost::new(dir.path().join("scripts"))
            .snapshot()
            .is_err(),
        "exclusive lease"
    );
    drop(h);
    let h = ScriptsHost::new(dir.path().join("scripts"));
    assert_eq!(h.snapshot().unwrap().scripts[0].id, copy.id);
    let p = dir.path().join("scripts/catalog.json");
    std::fs::write(&p, b"owner-corrupt-data").unwrap();
    assert!(h.save(input("'no overwrite'"), None, None).is_err());
    drop(h);
    let h = ScriptsHost::new(dir.path().join("scripts"));
    assert!(h.snapshot().is_err());
    assert_eq!(std::fs::read(p).unwrap(), b"owner-corrupt-data");
}
#[test]
fn powershell_real_output_exit_idempotency_and_history() {
    let (dir, h) = fixture();
    assert_eq!(h.snapshot().unwrap().execution_blocked, None);
    let s = h.save(input("[Console]::Out.WriteLine('native-out'); [Console]::Error.WriteLine('native-err'); exit 7"), None, None).unwrap();
    assert!(h.start(&s.id, 1, "smoke", false).is_err());
    let r = h.start(&s.id, 1, "smoke", true).unwrap();
    assert_eq!(h.start(&s.id, 1, "smoke", true).unwrap().id, r.id);
    assert!(h.start(&s.id, 2, "smoke", true).is_err());
    let o = wait(&h, &r.id);
    assert_eq!(o.run.status, Status::Failed);
    assert_eq!(o.run.exit_code, Some(7), "{} {:?}", o.stderr, o.run.error);
    assert!(o.stdout.contains("native-out"));
    assert!(o.stderr.contains("native-err"));
    h.delete(&s.id, 1).unwrap();
    assert_eq!(h.output(&r.id).unwrap().snapshot, s);
    h.shutdown();
    drop(h);
    // Worker drops its Arc immediately after signalling completion.
    std::thread::sleep(Duration::from_millis(50));
    let h = ScriptsHost::new(dir.path().join("scripts"));
    assert_eq!(h.output(&r.id).unwrap().run.exit_code, Some(7));
    assert!(h.snapshot().unwrap().scripts.is_empty());
}
#[test]
fn validation_and_unknown_records() {
    let (dir, h) = fixture();
    assert!(h.output("../escape").is_err());
    assert!(h.cancel("../escape").is_err());
    assert!(h.duplicate("../escape").is_err());
    for path in [
        "relative",
        "\\\\server\\share",
        "C:/does-not-exist-tabs-fixture",
    ] {
        let mut i = input("'x'");
        i.working_directory = path.into();
        assert!(h.save(i, None, None).is_err());
    }
    let mut i = input("'x'");
    i.timeout_seconds = 86401;
    assert!(h.save(i, None, None).is_err());
    let mut v = serde_json::to_value(input("'x'")).unwrap();
    v["runtime"] = "remote".into();
    assert!(serde_json::from_value::<ScriptInput>(v).is_err());
    h.save(input("'x'"), None, None).unwrap();
    drop(h);
    let p = dir.path().join("scripts/catalog.json");
    let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    v["version"] = 99.into();
    let bytes = serde_json::to_vec(&v).unwrap();
    std::fs::write(&p, &bytes).unwrap();
    assert!(ScriptsHost::new(dir.path().join("scripts"))
        .snapshot()
        .is_err());
    assert_eq!(std::fs::read(p).unwrap(), bytes);
}
