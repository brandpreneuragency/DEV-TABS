//! All user code waits on stdin until the interpreter belongs to a kill-on-close job.
#[cfg(all(test, windows))]
#[path = "process_tests.rs"]
mod tests;
use super::*;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

pub(super) struct Control {
    pub stop: AtomicU8, // 1 cancel, 2 application shutdown
    pub job: Mutex<Option<Arc<Job>>>,
    pub done: (Mutex<bool>, std::sync::Condvar),
    pub thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl Control {
    pub fn new() -> Self {
        Self {
            stop: AtomicU8::new(0),
            job: Mutex::new(None),
            done: (Mutex::new(false), std::sync::Condvar::new()),
            thread: Mutex::new(None),
        }
    }
    pub fn stop(&self, reason: u8) {
        self.stop.store(reason, Ordering::SeqCst);
        if let Some(job) = self.job.lock().unwrap().as_ref() {
            job.terminate();
        }
    }
    pub fn wait(&self) -> bool {
        let (lock, cv) = &self.done;
        let done = *cv
            .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(15), |done| !*done)
            .unwrap()
            .0;
        if done {
            if let Some(handle) = self.thread.lock().unwrap().take() {
                let _ = handle.join();
            }
        }
        done
    }
}

#[cfg(windows)]
pub(super) struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}
#[cfg(windows)]
impl Job {
    fn assign(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err("Cannot create Scripts process job".into());
        }
        let job = Self(handle);
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
            || unsafe { AssignProcessToJobObject(handle, child.as_raw_handle()) } == 0
        {
            return Err("Cannot assign Scripts process to its job; no code released".into());
        }
        Ok(job)
    }
    pub fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
    fn wait_empty(&self) -> Result<(), String> {
        use windows_sys::Win32::System::JobObjects::*;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            if unsafe {
                QueryInformationJobObject(
                    self.0,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err("Cannot verify Scripts tree termination".into());
            }
            if info.ActiveProcesses == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("Scripts tree termination timed out".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(not(windows))]
pub(super) struct Job;
#[cfg(not(windows))]
impl Job {
    fn assign(_: &Child) -> Result<Self, String> {
        Err("Windows required".into())
    }
    pub fn terminate(&self) {}
    fn wait_empty(&self) -> Result<(), String> {
        Ok(())
    }
}

pub(super) fn execution_blocked() -> Option<String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        };
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Some("Cannot verify ordinary user token".into());
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = 0;
        let ok = unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                &mut elevation as *mut _ as *mut _,
                std::mem::size_of_val(&elevation) as u32,
                &mut size,
            )
        };
        unsafe {
            CloseHandle(token);
        }
        if ok == 0 || elevation.TokenIsElevated != 0 {
            return Some("Scripts execution requires a non-elevated Windows application".into());
        }
        None
    }
    #[cfg(not(windows))]
    {
        Some("Scripts execution is supported only on MOTHER Windows".into())
    }
}
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
    fn GetDriveTypeW(root: *const u16) -> u32;
}
pub(super) fn windows_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let mut buf = [0u16; 32768];
        let len = unsafe { GetWindowsDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
        if len > 0 && len < buf.len() {
            return PathBuf::from(String::from_utf16_lossy(&buf[..len]));
        }
    }
    PathBuf::new()
}
pub(super) fn local_directory(p: &std::path::Path) -> Result<PathBuf, String> {
    let raw = p.to_string_lossy();
    // Windows canonicalize()/native folder APIs can return a verbatim local drive.
    // Accept that spelling, but still reject UNC/device/relative destinations.
    let s = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    let b = s.as_bytes();
    if b.len() < 3
        || !b[0].is_ascii_alphabetic()
        || b[1] != b':'
        || !matches!(b[2], b'/' | b'\\')
        || !p.is_dir()
    {
        return Err("Working directory must be an existing absolute local folder".into());
    }
    let canonical = p.canonicalize().map_err(|e| e.to_string())?;
    let text = canonical.to_string_lossy();
    if text.starts_with("\\\\?\\UNC\\") {
        return Err("Network working directories are not supported".into());
    }
    #[cfg(windows)]
    {
        let plain = text.strip_prefix("\\\\?\\").unwrap_or(&text);
        let root = format!("{}\\", &plain[..2]);
        let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
        if unsafe { GetDriveTypeW(wide.as_ptr()) } != 3 {
            return Err("Working directory must be on a fixed local drive".into());
        }
    }
    Ok(canonical)
}
fn real_executable(p: &std::path::Path) -> bool {
    if p.to_string_lossy()
        .to_ascii_lowercase()
        .contains("windowsapps")
    {
        return false;
    }
    if storage::reject_link(p).is_err() {
        return false;
    }
    std::fs::File::open(p)
        .and_then(|mut f| {
            let mut magic = [0; 2];
            f.read_exact(&mut magic)?;
            Ok(magic == *b"MZ")
        })
        .unwrap_or(false)
}
pub(super) fn runtimes() -> Vec<RuntimeInfo> {
    let mut out = Vec::new();
    let ps = windows_dir().join("System32/WindowsPowerShell/v1.0/powershell.exe");
    if real_executable(&ps) {
        out.push(RuntimeInfo {
            id: Runtime::Powershell,
            label: "Windows PowerShell".into(),
            executable: ps.to_string_lossy().into(),
        });
    }
    for (id, name, label) in [
        (Runtime::Python, "python.exe", "Python"),
        (Runtime::Node, "node.exe", "Node.js"),
        (Runtime::Bash, "bash.exe", "Git Bash"),
    ] {
        let mut candidates: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .filter(|p| p.is_absolute())
                .map(|p| p.join(name))
                .collect();
        if id == Runtime::Bash {
            candidates.insert(0, PathBuf::from("C:/Program Files/Git/bin/bash.exe"));
        }
        if let Some(p) = candidates.into_iter().find(|p| {
            real_executable(p)
                && (id != Runtime::Bash || p.to_string_lossy().to_ascii_lowercase().contains("git"))
        }) {
            out.push(RuntimeInfo {
                id,
                label: label.into(),
                executable: p.to_string_lossy().into(),
            });
        }
    }
    out
}
fn command(
    runtime: &Runtime,
    executable: &str,
    source: &std::path::Path,
    cwd: &std::path::Path,
) -> Command {
    let mut c = Command::new(executable);
    c.env_clear();
    for name in [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "COMSPEC",
        "PATHEXT",
        "PATH",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
    ] {
        if let Some(v) = std::env::var_os(name) {
            c.env(name, v);
        }
    }
    // Node and Git Bash do not accept Windows' verbatim prefix as a script path.
    // This is an owned, already-validated local source file, not a shell string.
    let source_text = source.to_string_lossy();
    c.env(
        "TABS_SCRIPT_SOURCE",
        source_text
            .strip_prefix(r"\\?\")
            .unwrap_or(&source_text)
            .replace('\\', "/"),
    );
    match runtime {
        Runtime::Powershell => {
            c.args(["-NoLogo","-NoProfile","-NonInteractive","-Command", "$ErrorActionPreference='Stop'; $global:LASTEXITCODE=0; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); if ([Console]::In.ReadLine() -ne 'GO') { exit 125 }; try { & ([ScriptBlock]::Create([IO.File]::ReadAllText($env:TABS_SCRIPT_SOURCE))); $ok=$?; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $ok) { exit 1 } } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }"]);
        }
        Runtime::Python => {
            c.args(["-I","-S","-u","-c", "import sys,os; gate=sys.stdin.readline(); p=os.environ['TABS_SCRIPT_SOURCE']; exec(compile(open(p,encoding='utf-8').read(),p,'exec'),{'__name__':'__main__','__file__':p}) if gate==('GO'+chr(10)) else sys.exit(125)"]);
        }
        Runtime::Node => {
            c.args(["--input-type=commonjs","-e", "const fs=require('fs');let b=Buffer.alloc(1),s='';while(fs.readSync(0,b,0,1,null)&&b[0]!==10)s+=b.toString();if(s!=='GO')process.exit(125);require('module')._compile;const M=require('module'),p=process.env.TABS_SCRIPT_SOURCE,m=new M(p);m.filename=p;m.paths=M._nodeModulePaths(require('path').dirname(p));m._compile(fs.readFileSync(p,'utf8'),p);"]);
        }
        Runtime::Bash => {
            c.args([
                "--noprofile",
                "--norc",
                "-c",
                "IFS= read -r gate; [ \"$gate\" = GO ] || exit 125; source \"$TABS_SCRIPT_SOURCE\"",
            ]);
        }
    }
    c.current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c
}
#[derive(Default)]
struct Logs {
    used: usize,
    truncated: bool,
    error: Option<String>,
}
fn drain(mut pipe: impl Read, mut file: std::fs::File, logs: Arc<Mutex<Logs>>) {
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let mut l = logs.lock().unwrap();
                let take = n.min(MAX_LOG_BYTES.saturating_sub(l.used));
                if take < n {
                    l.truncated = true;
                }
                if let Err(e) = file.write_all(&buf[..take]) {
                    l.error = Some(format!("Output persistence failed: {e}"));
                }
                l.used += take;
            }
            Err(e) => {
                logs.lock().unwrap().error = Some(format!("Output read failed: {e}"));
                break;
            }
        }
    }
    if let Err(e) = file.sync_all() {
        logs.lock().unwrap().error = Some(format!("Output sync failed: {e}"));
    }
}
pub(super) struct Outcome {
    pub status: Status,
    pub code: Option<i32>,
    pub error: Option<String>,
    pub truncated: bool,
}
pub(super) fn run(
    script: &SavedScript,
    executable: &str,
    dir: &std::path::Path,
    cwd: &std::path::Path,
    control: &Control,
) -> Result<Outcome, String> {
    if let Some(reason) = execution_blocked() {
        return Err(reason);
    }
    let source = dir.join("code.txt");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&source)
        .map_err(|e| e.to_string())?;
    f.write_all(script.input.code.as_bytes())
        .and_then(|_| f.sync_all())
        .map_err(|e| e.to_string())?;
    drop(f);
    let stdout = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("stdout.log"))
        .map_err(|e| e.to_string())?;
    let stderr = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("stderr.log"))
        .map_err(|e| e.to_string())?;
    let mut child = command(&script.input.runtime, executable, &source, cwd)
        .spawn()
        .map_err(|e| format!("Runtime launch failed: {e}"))?;
    let job = match Job::assign(&child) {
        Ok(j) => Arc::new(j),
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    *control.job.lock().unwrap() = Some(job.clone());
    let logs = Arc::new(Mutex::new(Logs::default()));
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let l = logs.clone();
    let out_thread = std::thread::spawn(move || drain(out, stdout, l));
    let l = logs.clone();
    let err_thread = std::thread::spawn(move || drain(err, stderr, l));
    let gate_result = if control.stop.load(Ordering::SeqCst) == 0 {
        child.stdin.take().unwrap().write_all(b"GO\n")
    } else {
        drop(child.stdin.take());
        Ok(())
    };
    let started = Instant::now();
    let mut timed_out = false;
    let mut wait_error = gate_result
        .err()
        .map(|e| format!("Runtime gate failed: {e}"));
    let exit = loop {
        if control.stop.load(Ordering::SeqCst) != 0
            || started.elapsed().as_secs() >= script.input.timeout_seconds
            || wait_error.is_some()
        {
            timed_out = control.stop.load(Ordering::SeqCst) == 0 && wait_error.is_none();
            job.terminate();
            break child.wait();
        }
        match child.try_wait() {
            Ok(Some(e)) => break Ok(e),
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                wait_error = Some(e.to_string());
                job.terminate();
                break child.wait();
            }
        }
    };
    // Also stop descendants after their parent exits normally; no detached jobs.
    job.terminate();
    let tree_result = job.wait_empty();
    if tree_result.is_err() {
        drop(control.job.lock().unwrap().take());
    }
    drop(job);
    let _ = out_thread.join();
    let _ = err_thread.join();
    control.job.lock().unwrap().take();
    let l = logs.lock().unwrap();
    let reason = control.stop.load(Ordering::SeqCst);
    let code = exit.as_ref().ok().and_then(|e| e.code());
    let error = wait_error
        .or_else(|| tree_result.err())
        .or_else(|| exit.err().map(|e| e.to_string()))
        .or_else(|| l.error.clone())
        .or_else(|| {
            if timed_out {
                Some("Script timeout exceeded".into())
            } else if reason == 2 {
                Some("Application exited; owned job stopped".into())
            } else {
                None
            }
        });
    let status = if reason == 2 {
        Status::Interrupted
    } else if reason == 1 {
        Status::Cancelled
    } else if timed_out || error.is_some() || code != Some(0) {
        Status::Failed
    } else {
        Status::Succeeded
    };
    Ok(Outcome {
        status,
        code,
        error,
        truncated: l.truncated,
    })
}
