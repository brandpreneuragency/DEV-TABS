//! Read-only identity access to Codex 0.159.2's encrypted auth backend.
//! Format/names are defined by codex-rs/secrets/src/{lib,local}.rs.
//! Codex owns all credential writes; no plaintext/direct-keyring fallback.
use std::io::Read;
use std::path::Path;

use age::secrecy::SecretString;
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_AUTH_BYTES: u64 = 1024 * 1024;
const KEYRING_SERVICE: &str = "codex";

pub(super) fn keyring_user(home: &Path) -> Option<String> {
    let canonical = home.canonicalize().ok()?;
    let digest = format!(
        "{:x}",
        Sha256::digest(canonical.to_string_lossy().as_bytes())
    );
    Some(format!("secrets|{}", &digest[..16]))
}

pub(super) fn read_auth(home: &Path) -> Option<String> {
    read_with_key(home, |user| {
        keyring::Entry::new(KEYRING_SERVICE, user)
            .ok()?
            .get_password()
            .ok()
    })
}

fn read_with_key(home: &Path, key: impl FnOnce(&str) -> Option<String>) -> Option<String> {
    let directory = home.join("secrets");
    let path = directory.join("codex_auth.age");
    for target in [home, directory.as_path(), path.as_path()] {
        super::storage::reject_link(target).ok()?;
    }
    let file = std::fs::File::open(path).ok()?;
    let mut ciphertext = Vec::new();
    file.take(MAX_AUTH_BYTES + 1)
        .read_to_end(&mut ciphertext)
        .ok()?;
    if ciphertext.len() as u64 > MAX_AUTH_BYTES {
        return None;
    }
    let user = keyring_user(home)?;
    let passphrase = SecretString::from(key(&user)?);
    decrypt_auth(&ciphertext, passphrase)
}

fn decrypt_auth(ciphertext: &[u8], passphrase: SecretString) -> Option<String> {
    let decryptor = age::Decryptor::new_buffered(ciphertext).ok()?;
    if !decryptor.is_scrypt() {
        return None;
    }
    let mut identity = age::scrypt::Identity::new(passphrase);
    // Bound hostile-file CPU/memory cost while allowing the CLI's calibrated key.
    identity.set_max_work_factor(20);
    let reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .ok()?;
    let mut plaintext = Vec::new();
    reader
        .take(MAX_AUTH_BYTES + 1)
        .read_to_end(&mut plaintext)
        .ok()?;
    if plaintext.len() as u64 > MAX_AUTH_BYTES {
        return None;
    }
    let document: Value = serde_json::from_slice(&plaintext).ok()?;
    if document.get("version")?.as_u64()? > 1 {
        return None;
    }
    document
        .pointer("/secrets/global~1CODEX_AUTH")?
        .as_str()
        .map(str::to_owned)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use serde_json::json;

    fn fixture() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("tabs-encrypted-auth-")
            .tempdir_in(super::super::storage::test_temp_root())
            .unwrap()
    }

    pub(in crate::provider_accounts) fn synthetic_auth() -> String {
        let claims = json!({
            "email":"synthetic@example.test",
            "exp":4102444800_u64,
            "https://api.openai.com/auth":{
                "chatgpt_user_id":"synthetic-user",
                "chatgpt_account_id":"synthetic-workspace",
                "chatgpt_plan_type":"plus"
            }
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        json!({
            "auth_mode":"chatgpt",
            "last_refresh":"2099-01-01T00:00:00Z",
            "tokens":{
                "id_token":format!("synthetic.{payload}.synthetic"),
                "access_token":format!("synthetic.{payload}.synthetic"),
                "refresh_token":"not-a-real-refresh-token",
                "account_id":"synthetic-workspace"
            },
            "synthetic_padding":"x".repeat(6000)
        })
        .to_string()
    }

    fn encrypt_document(document: &Value, passphrase: &str) -> Vec<u8> {
        let mut recipient = age::scrypt::Recipient::new(SecretString::from(passphrase.to_owned()));
        // Only synthetic fixtures use a cheap work factor. Production never writes.
        recipient.set_work_factor(8);
        age::encrypt(&recipient, &serde_json::to_vec(document).unwrap()).unwrap()
    }

    pub(in crate::provider_accounts) fn write_fixture(home: &Path, passphrase: &str, auth: &str) {
        let directory = super::super::storage::directory(home, "secrets").unwrap();
        let ciphertext = encrypt_document(
            &json!({"version":1,"secrets":{"global/CODEX_AUTH":auth}}),
            passphrase,
        );
        assert!(!ciphertext
            .windows(auth.len())
            .any(|bytes| bytes == auth.as_bytes()));
        std::fs::write(directory.join("codex_auth.age"), ciphertext).unwrap();
    }

    #[test]
    fn large_oauth_payload_reopens_with_only_its_slot_key_and_no_plaintext() {
        let root = fixture();
        let first = super::super::storage::directory(root.path(), "codex-1").unwrap();
        let other = super::super::storage::directory(root.path(), "codex-2").unwrap();
        let auth = synthetic_auth();
        assert!(auth.encode_utf16().count() > 2560);
        write_fixture(&first, "synthetic-slot-one-key", &auth);
        let expected_user = keyring_user(&first).unwrap();
        assert_ne!(Some(expected_user.clone()), keyring_user(&other));
        for _ in 0..2 {
            assert_eq!(
                read_with_key(&first, |user| {
                    assert_eq!(user, expected_user);
                    Some("synthetic-slot-one-key".into())
                }),
                Some(auth.clone())
            );
        }
        assert!(read_with_key(&first, |_| Some("other-slot-key".into())).is_none());
        assert!(read_with_key(&first, |_| None).is_none());
        assert!(read_with_key(&other, |_| panic!("No key lookup for an empty slot")).is_none());
        assert!(!first.join("auth.json").exists());
    }

    #[test]
    fn corrupt_future_or_missing_auth_fails_closed_without_repair() {
        let home = fixture();
        write_fixture(home.path(), "fixture-key", &synthetic_auth());
        let target = home.path().join("secrets/codex_auth.age");
        let mut ciphertext = std::fs::read(&target).unwrap();
        *ciphertext.last_mut().unwrap() ^= 1;
        std::fs::write(&target, &ciphertext).unwrap();
        assert!(read_with_key(home.path(), |_| Some("fixture-key".into())).is_none());
        assert_eq!(std::fs::read(&target).unwrap(), ciphertext);
        for document in [
            json!({"version":2,"secrets":{"global/CODEX_AUTH":"synthetic"}}),
            json!({"version":1,"secrets":{"global/OTHER":"synthetic"}}),
        ] {
            let ciphertext = encrypt_document(&document, "fixture-key");
            assert!(
                decrypt_auth(&ciphertext, SecretString::from("fixture-key".to_string())).is_none()
            );
        }
        std::fs::write(&target, vec![0; MAX_AUTH_BYTES as usize + 1]).unwrap();
        assert!(read_with_key(home.path(), |_| panic!(
            "Oversize rejected before key lookup"
        ))
        .is_none());
    }

    #[test]
    fn plaintext_and_unrelated_secret_files_are_never_identity_fallbacks() {
        let home = fixture();
        std::fs::write(home.path().join("auth.json"), synthetic_auth()).unwrap();
        let secrets = super::super::storage::directory(home.path(), "secrets").unwrap();
        std::fs::write(secrets.join("local.age"), b"not-primary-auth").unwrap();
        assert!(read_with_key(home.path(), |_| panic!("No fallback key lookup")).is_none());
        assert_eq!(std::fs::read_dir(secrets).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn linked_secret_directory_is_rejected_before_key_lookup() {
        let root = fixture();
        let home = super::super::storage::directory(root.path(), "home").unwrap();
        let outside = super::super::storage::directory(root.path(), "outside").unwrap();
        // A junction does not require Windows developer-mode/symlink privileges.
        assert!(std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(home.join("secrets"))
            .arg(&outside)
            .output()
            .unwrap()
            .status
            .success());
        assert!(read_with_key(&home, |_| panic!("Linked paths must fail closed")).is_none());
        std::fs::remove_dir(home.join("secrets")).unwrap();
        assert!(outside.exists());
    }

    #[cfg(windows)]
    #[test]
    fn native_keyring_limit_is_avoided_and_large_auth_survives_reopen() {
        struct OwnedEntry(keyring::Entry);
        impl Drop for OwnedEntry {
            fn drop(&mut self) {
                let _ = self.0.delete_credential();
            }
        }
        let home = fixture();
        let user = keyring_user(home.path()).unwrap();
        let entry = OwnedEntry(keyring::Entry::new(KEYRING_SERVICE, &user).unwrap());
        assert!(matches!(
            entry.0.get_password(),
            Err(keyring::Error::NoEntry)
        ));
        let auth = synthetic_auth();
        assert!(matches!(
            entry.0.set_password(&auth),
            Err(keyring::Error::TooLong(_, 2560))
        ));
        entry
            .0
            .set_password("synthetic-short-encryption-key")
            .unwrap();
        write_fixture(home.path(), "synthetic-short-encryption-key", &auth);
        for _ in 0..2 {
            assert_eq!(read_auth(home.path()), Some(auth.clone()));
        }
        entry.0.delete_credential().unwrap();
        assert!(matches!(
            entry.0.get_password(),
            Err(keyring::Error::NoEntry)
        ));
        assert!(read_auth(home.path()).is_none());
    }
}
