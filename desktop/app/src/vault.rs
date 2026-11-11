//! Seals Carino's master key with Windows' Data Protection API (DPAPI): only this Windows user
//! account on this PC can open it again. The key is passed in and out as base64.

use base64::{engine::general_purpose::STANDARD, Engine};

#[tauri::command]
pub fn vault_seal(plain: String) -> Result<String, String> {
    let bytes = STANDARD.decode(plain).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(platform::protect(&bytes)?))
}

#[tauri::command]
pub fn vault_open(sealed: String) -> Result<String, String> {
    let bytes = STANDARD.decode(sealed).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(platform::unprotect(&bytes)?))
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN};

    const ENTROPY: &[u8] = b"carino-vault-v1";

    fn run(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let mut inp = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_ptr() as *mut u8 };
        let mut ent = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: the blobs point at live buffers for the duration of the call; the output is
        // copied and then released with LocalFree, as the API requires.
        let ok = unsafe {
            if protect {
                CryptProtectData(&mut inp, std::ptr::null(), &mut ent, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            } else {
                CryptUnprotectData(&mut inp, std::ptr::null_mut(), &mut ent, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            }
        };
        if ok == 0 {
            return Err("Windows could not protect or open the saved key.".into());
        }
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe { LocalFree(out.pbData as _) };
        Ok(v)
    }

    pub fn protect(b: &[u8]) -> Result<Vec<u8>, String> { run(b, true) }
    pub fn unprotect(b: &[u8]) -> Result<Vec<u8>, String> { run(b, false) }
}

#[cfg(not(windows))]
mod platform {
    // Development builds on other systems: no system key store here, so the app keeps using its
    // browser-held key (a non-extractable WebCrypto key) instead.
    pub fn protect(_: &[u8]) -> Result<Vec<u8>, String> { Err("unsupported".into()) }
    pub fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> { Err("unsupported".into()) }
}
