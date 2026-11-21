//! Trusted local owner scripts, not a sandbox. No provider credentials are read.
mod model;
mod process;
mod storage;
pub use model::*;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_LOG_BYTES: usize = 1024 * 1024;
const MAX_CONCURRENT: usize = 2;
const MAX_TIMEOUT: u64 = 86400;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn valid_request(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn check_id(id: &str) -> Result<(), String> {
    if valid_id(id) {
        Ok(())
    } else {
        Err("Invalid Scripts id".into())
    }
}
fn new_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "Secure randomness unavailable")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn source_hash(s: &SavedScript) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(s).map_err(|e| e.to_string())?)
    ))
}
fn validate_input(i: &ScriptInput) -> Result<(), String> {
    if i.name.trim().is_empty()
        || i.name.len() > 160
        || i.description.len() > 4096
        || i.code.trim().is_empty()
        || i.code.len() > 256 * 1024
        || i.working_directory.len() > 32760
        || i.timeout_seconds == 0
        || i.timeout_seconds > MAX_TIMEOUT
        || i.name.contains('\0')
        || i.working_directory.contains('\0')
    {
        return Err("Invalid script: name 1–160 bytes, description ≤4096, code 1–262144, timeout 1–86400 seconds".into());
    }
    Ok(())
}
struct Inner {
    store: Option<storage::Store>,
    active: HashMap<String, Arc<process::Control>>,
    fault: Option<String>,
}
pub struct ScriptsHost {
    root: PathBuf,
    inner: Mutex<Inner>,
    closing: AtomicBool,
}
impl ScriptsHost {
    /// Lazy: a corrupt Scripts catalog must never prevent the rest of TABS starting.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            inner: Mutex::new(Inner {
                store: None,
                active: HashMap::new(),
                fault: None,
            }),
            closing: AtomicBool::new(false),
        }
    }
    fn init<'a>(&self, inner: &'a mut Inner) -> Result<&'a mut storage::Store, String> {
        if let Some(e) = &inner.fault {
            return Err(e.clone());
        }
        if inner.store.is_none() {
            inner.store = Some(storage::Store::open(&self.root)?);
        }
        Ok(inner.store.as_mut().unwrap())
    }
    pub fn snapshot(&self) -> Result<ScriptsSnapshot, String> {
        let mut inner = self.inner.lock().map_err(|_| "Scripts lock poisoned")?;
        let store = self.init(&mut inner)?;
        let mut runs = store.catalog.runs.clone();
        runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(ScriptsSnapshot {
            scripts: store.catalog.scripts.clone(),
            runs,
            runtimes: process::runtimes(),
            execution_blocked: if self.closing.load(Ordering::SeqCst) {
                Some("Scripts host is shutting down".into())
            } else {
                process::execution_blocked()
            },
            default_working_directory: self.root.join("work").to_string_lossy().into(),
            max_concurrent: MAX_CONCURRENT,
            max_log_bytes: MAX_LOG_BYTES,
            max_timeout_seconds: MAX_TIMEOUT,
        })
    }
    pub fn save(
        &self,
        input: ScriptInput,
        id: Option<String>,
        expected_revision: Option<u64>,
    ) -> Result<SavedScript, String> {
        validate_input(&input)?;
        if !input.working_directory.is_empty() {
            process::local_directory(std::path::Path::new(&input.working_directory))?;
        }
        let mut inner = self.inner.lock().map_err(|_| "Scripts lock poisoned")?;
        let store = self.init(&mut inner)?;
        let mut next = store.catalog.clone();
        let result = if let Some(id) = id {
            check_id(&id)?;
            let s = next
                .scripts
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or("Script not found")?;
            if expected_revision != Some(s.revision) {
                return Err("Script revision conflict; reload before saving".into());
            }
            s.input = input;
            s.revision = s.revision.checked_add(1).ok_or("Revision exhausted")?;
            s.updated_at = now();
            s.clone()
        } else {
            if expected_revision.is_some() {
                return Err("New script must not include a revision".into());
            }
            let s = SavedScript {
                input,
                id: new_id()?,
                revision: 1,
                created_at: now(),
                updated_at: now(),
            };
            next.scripts.push(s.clone());
            s
        };
        store.commit(next)?;
        Ok(result)
    }
    pub fn duplicate(&self, id: &str) -> Result<SavedScript, String> {
        check_id(id)?;
        let mut inner = self.inner.lock().map_err(|_| "Scripts lock poisoned")?;
        let store = self.init(&mut inner)?;
        let mut next = store.catalog.clone();
        let mut s = next
            .scripts
            .iter()
            .find(|s| s.id == id)
            .ok_or("Script not found")?
            .clone();
        s.id = new_id()?;
        s.revision = 1;
        s.created_at = now();
        s.updated_at = s.created_at;
        // Keep a bounded name even for multibyte UTF-8 names.
        while s.input.name.len() > 153 {
            s.input.name.pop();
        }
        s.input.name.push_str(" (copy)");
        next.scripts.push(s.clone());
        store.commit(next)?;
        Ok(s)
    }
    pub fn delete(&self, id: &str, expected_revision: u64) -> Result<(), String> {
        check_id(id)?;
        let mut inner = self.inner.lock().map_err(|_| "Scripts lock poisoned")?;
        let store = self.init(&mut inner)?;
        let mut next = store.catalog.clone();
        let s = next
            .scripts
            .iter()
            .find(|s| s.id == id)
            .ok_or("Script not found")?;
        if s.revision != expected_revision {
            return Err("Script revision conflict".into());
        }
        next.scripts.retain(|s| s.id != id);
        store.commit(next)
    }
    pub fn start(
        self: &Arc<Self>,
        id: &str,
        expected_revision: u64,
        request_id: &str,
        confirmed: bool,
    ) -> Result<ScriptRun, String> {
        check_id(id)?;
        if !valid_request(request_id) {
            return Err("Invalid requestId".into());
        }
        let mut inner = self.inner.lock().map_err(|_| "Scripts lock poisoned")?;
        let store = self.init(&mut inner)?;
        if let Some(run) = store
            .catalog
            .runs
            .iter()
            .find(|r| r.request_id == request_id)
        {
            let old_confirmed: bool =
                storage::read(&store.run_dir(&run.id).join("confirmed.json"), 16)?;
            if run.script_id != id
                || run.script_revision != expected_revision
                || old_confirmed != confirmed
            {
                return Err("requestId already belongs to a different request".into());
            }
            return Ok(run.clone());
        }
        if self.closing.load(Ordering::SeqCst) {
            return Err("Scripts host is shutting down".into());
        }
        if let Some(reason) = process::execution_blocked() {
            return Err(reason);
        }
        if store
            .catalog
            .runs
            .iter()
            .filter(|r| r.status.active())
            .count()
            >= MAX_CONCURRENT
        {
            return Err("Two Scripts jobs are already active".into());
        }
        if store
            .catalog
            .runs
            .iter()
            .any(|r| r.script_id == id && r.status.active())
        {
            return Err("This script already has an active job".into());
        }
        let script = store
            .catalog
            .scripts
            .iter()
            .find(|s| s.id == id)
            .ok_or("Script not found")?
            .clone();
        if script.revision != expected_revision {
            return Err("Script revision conflict; review current code before running".into());
        }
        if script.input.confirmation_required && !confirmed {
            return Err("Explicit confirmation is required".into());
        }
        let runtime = process::runtimes()
            .into_iter()
            .find(|r| r.id == script.input.runtime)
            .ok_or("Selected runtime is unavailable")?;
        let cwd = if script.input.working_directory.is_empty() {
            self.root.join("work")
        } else {
            PathBuf::from(&script.input.working_directory)
        };
        process::local_directory(&cwd)?;
        let run = ScriptRun {
            id: new_id()?,
            request_id: request_id.into(),
            script_id: id.into(),
            script_name: script.input.name.clone(),
            script_revision: script.revision,
            source_hash: source_hash(&script)?,
            runtime: script.input.runtime.clone(),
            working_directory: cwd.to_string_lossy().into(),
            status: Status::Running,
            created_at: now(),
            started_at: Some(now()),
            completed_at: None,
            exit_code: None,
            error: None,
            log_truncated: false,
        };
        let dir = store.run_dir(&run.id);
        std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
        storage::atomic(&dir.join("source.json"), &script, true)?;
        storage::atomic(&dir.join("confirmed.json"), &confirmed, true)?;
        let mut next = store.catalog.clone();
        next.runs.push(run.clone());
        store.commit(next)?;
        let control = Arc::new(process::Control::new());
        inner.active.insert(run.id.clone(), control.clone());
        let host = self.clone();
        let run_id = run.id.clone();
        let task_control = control.clone();
        let spawned = std::thread::Builder::new()
            .name("tabs-script".into())
            .spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    process::run(&script, &runtime.executable, &dir, &cwd, &task_control)
                }))
                .unwrap_or_else(|_| {
                    task_control.stop(2);
                    Err("Scripts worker panicked; owned job terminated".into())
                });
                host.finish(&run_id, outcome);
                *task_control.done.0.lock().unwrap() = true;
                task_control.done.1.notify_all();
            });
        if let Err(e) = spawned {
            inner.active.remove(&run.id);
            let store = inner.store.as_mut().unwrap();
            let mut next = store.catalog.clone();
            let r = next.runs.iter_mut().find(|r| r.id == run.id).unwrap();
            r.status = Status::Failed;
            r.completed_at = Some(now());
            r.error = Some(format!("Cannot start worker: {e}"));
            store.commit(next)?;
            return Err(format!("Cannot start Scripts worker: {e}"));
        } else if let Ok(handle) = spawned {
            *control.thread.lock().unwrap() = Some(handle);
        }
        Ok(run)
    }
    fn finish(&self, id: &str, outcome: Result<process::Outcome, String>) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(store) = inner.store.as_mut() {
            let mut next = store.catalog.clone();
            if let Some(r) = next.runs.iter_mut().find(|r| r.id == id) {
                r.completed_at = Some(now());
                match outcome {
                    Ok(o) => {
                        r.status = o.status;
                        r.exit_code = o.code;
                        r.error = o.error;
                        r.log_truncated = o.truncated;
                    }
                    Err(e) => {
                        r.status = Status::Failed;
                        r.error = Some(e);
                    }
                }
                if let Err(e) = store.commit(next) {
                    inner.fault = Some(format!("Job ended but history persistence failed: {e}"));
                }
            }
        }
        inner.active.remove(id);
    }
    pub fn cancel(&self, run_id: &str) -> Result<ScriptRun, String> {
        check_id(run_id)?;
        let control = {
            let mut inner = self.inner.lock().map_err(|_| "Scripts lock poisoned")?;
            self.init(&mut inner)?;
            inner.active.get(run_id).cloned()
        };
        if let Some(c) = control {
            c.stop(1);
            if !c.wait() {
                return Err("Job termination has not completed".into());
            }
        }
        let mut inner = self.inner.lock().map_err(|_| "Scripts lock poisoned")?;
        self.init(&mut inner)?
            .catalog
            .runs
            .iter()
            .find(|r| r.id == run_id)
            .cloned()
            .ok_or_else(|| "Run not found".into())
    }
    pub fn output(&self, run_id: &str) -> Result<ScriptOutput, String> {
        use std::io::Read;
        check_id(run_id)?;
        let mut inner = self.inner.lock().map_err(|_| "Scripts lock poisoned")?;
        let store = self.init(&mut inner)?;
        let run = store
            .catalog
            .runs
            .iter()
            .find(|r| r.id == run_id)
            .ok_or("Run not found")?
            .clone();
        let dir = store.run_dir(run_id);
        storage::reject_link(&dir)?;
        let snapshot: SavedScript = storage::read(&dir.join("source.json"), 2 * 1024 * 1024)?;
        if source_hash(&snapshot)? != run.source_hash {
            return Err("Run source snapshot changed; preserved".into());
        }
        let read_log = |name: &str| -> Result<String, String> {
            let p = dir.join(name);
            storage::reject_link(&p)?;
            let file = match std::fs::File::open(p) {
                Ok(f) => f,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
                Err(e) => return Err(e.to_string()),
            };
            let mut bytes = Vec::new();
            file.take(MAX_LOG_BYTES as u64)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        };
        Ok(ScriptOutput {
            truncated: run.log_truncated,
            run,
            snapshot,
            stdout: read_log("stdout.log")?,
            stderr: read_log("stderr.log")?,
        })
    }
    /// Called only on actual RunEvent::Exit, never hide/minimize/tray navigation.
    pub fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let controls: Vec<_> = self
            .inner
            .lock()
            .unwrap()
            .active
            .values()
            .cloned()
            .collect();
        for c in &controls {
            c.stop(2);
        }
        for c in controls {
            if !c.wait() {
                eprintln!("Scripts shutdown: owned job cleanup did not finish within 15 seconds");
            }
        }
    }
}
#[cfg(all(test, windows))]
mod lifecycle_tests;
#[cfg(test)]
mod tests;
