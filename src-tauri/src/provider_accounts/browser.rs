//! Opens an owned Codex login or an exact provider usage destination, never a shell.

pub(super) fn open(url: &str) -> Result<(), String> {
    if !super::client::valid_auth_url(url) {
        return Err("Codex returned an unsafe login URL".into());
    }
    open_system(url)
}

pub(super) fn open_usage(account_id: &str) -> Result<(), String> {
    let url = if super::inception::is_account(account_id) {
        super::inception::usage_url(account_id)?
    } else {
        super::external::usage_url(account_id)?
    };
    open_system(url)
}

fn open_system(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
        let operation: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if result as isize <= 32 {
            return Err("Could not open the provider page in the system browser".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    Err("Provider pages currently require Windows".into())
}
