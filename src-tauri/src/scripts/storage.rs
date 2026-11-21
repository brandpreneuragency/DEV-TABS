use super::{model::Catalog, *};
use serde::{de::DeserializeOwned, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

pub(super) fn reject_link(p: &Path) -> Result<(), String> {
    if let Ok(m) = std::fs::symlink_metadata(p) {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if m.file_attributes() & 0x400 != 0 {
                return Err("Scripts store contains a reparse point".into());
            }
        }
        if m.file_type().is_symlink() {
            return Err("Scripts store contains a symlink".into());
        }
    }
    Ok(())
}
pub(super) fn read<T: DeserializeOwned>(p: &Path, limit: u64) -> Result<T, String> {
    reject_link(p)?;
    let f = File::open(p).map_err(|e| format!("Cannot read Scripts data: {e}"))?;
    if f.metadata().map_err(|e| e.to_string())?.len() > limit {
        return Err("Scripts data exceeds its limit".into());
    }
    let mut bytes = Vec::new();
    f.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("Scripts data exceeds its limit".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid Scripts data; preserved: {e}"))
}
pub(super) fn atomic<T: Serialize>(p: &Path, value: &T, fresh: bool) -> Result<(), String> {
    reject_link(p)?;
    let mut f = tempfile::NamedTempFile::new_in(p.parent().ok_or("Invalid store path")?)
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut f, value).map_err(|e| e.to_string())?;
    f.flush()
        .and_then(|_| f.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    if fresh {
        f.persist_noclobber(p).map_err(|e| e.to_string())?;
    } else {
        f.persist(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(super) struct Store {
    pub root: PathBuf,
    _lease: File,
    pub catalog: Catalog,
    original: Vec<u8>,
}
impl Store {
    pub fn open(root: &Path) -> Result<Self, String> {
        // Reject links at every existing ancestor, not just the leaf.
        for p in root.ancestors() {
            reject_link(p)?;
        }
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let lease_path = root.join("store.lock");
        reject_link(&lease_path)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        #[cfg(not(windows))]
        return Err("Scripts storage requires Windows".into());
        let lease = options
            .open(lease_path)
            .map_err(|_| "Scripts store is in use by another process")?;
        for name in ["runs", "work"] {
            let p = root.join(name);
            reject_link(&p)?;
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let path = root.join("catalog.json");
        reject_link(&path)?;
        let catalog = if path.exists() {
            read(&path, 32 * 1024 * 1024)?
        } else {
            Catalog {
                version: 1,
                ..Default::default()
            }
        };
        Self::validate(&catalog)?;
        let original = if path.exists() {
            std::fs::read(&path).map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        let mut s = Self {
            root: root.to_path_buf(),
            _lease: lease,
            catalog,
            original,
        };
        // Validate immutable records before accepting any metadata changes.
        for r in &s.catalog.runs {
            reject_link(&s.run_dir(&r.id))?;
            let _: bool = read(&s.run_dir(&r.id).join("confirmed.json"), 16)?;
            let snap: SavedScript = read(&s.run_dir(&r.id).join("source.json"), 2 * 1024 * 1024)?;
            if snap.id != r.script_id
                || snap.revision != r.script_revision
                || source_hash(&snap)? != r.source_hash
            {
                return Err("Scripts source snapshot mismatch; preserved".into());
            }
        }
        let mut recovered = s.catalog.clone();
        for r in &mut recovered.runs {
            if r.status.active() {
                r.status = Status::Interrupted;
                r.completed_at = Some(now());
                r.error = Some("Application stopped before job completion; not restarted".into());
            }
        }
        if recovered
            .runs
            .iter()
            .zip(&s.catalog.runs)
            .any(|(a, b)| a.status != b.status)
        {
            s.commit(recovered)?;
        }
        Ok(s)
    }
    fn validate(c: &Catalog) -> Result<(), String> {
        if c.version != 1 {
            return Err("Unknown Scripts data version; preserved".into());
        }
        let mut ids = std::collections::HashSet::new();
        let mut reqs = std::collections::HashSet::new();
        for s in &c.scripts {
            if !valid_id(&s.id) || s.revision == 0 || !ids.insert(s.id.clone()) {
                return Err("Invalid Scripts identity".into());
            }
            validate_input(&s.input)?;
        }
        ids.clear();
        for r in &c.runs {
            if !valid_id(&r.id)
                || !valid_id(&r.script_id)
                || !valid_request(&r.request_id)
                || !ids.insert(r.id.clone())
                || !reqs.insert(r.request_id.clone())
            {
                return Err("Invalid Scripts run identity".into());
            }
        }
        Ok(())
    }
    pub fn commit(&mut self, next: Catalog) -> Result<(), String> {
        Self::validate(&next)?;
        if serde_json::to_vec(&next).map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
            return Err("Scripts catalog capacity reached; existing data preserved".into());
        }
        let p = self.root.join("catalog.json");
        reject_link(&p)?;
        let current = match std::fs::read(&p) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.to_string()),
        };
        if current != self.original {
            return Err(
                "Scripts data changed outside this host; preserved, reopen required".into(),
            );
        }
        atomic(&p, &next, self.original.is_empty())?;
        self.original = std::fs::read(p).map_err(|e| e.to_string())?;
        self.catalog = next;
        Ok(())
    }
    pub fn run_dir(&self, id: &str) -> PathBuf {
        self.root.join("runs").join(id)
    }
}
