use base64::{engine::general_purpose, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_ACCOUNTS: usize = 20;
const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountStore {
    accounts: Vec<ImportedAccount>,
    tray_entry_key: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedAccount {
    entry_key: String,
    email_masked: String,
    auth: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    entry_key: String,
    email_masked: String,
    selected: bool,
}

fn store_path(root: &Path) -> PathBuf {
    root.join("plugins_data")
        .join("codex")
        .join("cliproxy-accounts.dpapi")
}

// Windows DPAPI binds the encrypted credential copy to the current OS user.
#[cfg(windows)]
fn protect(data: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    unsafe {
        let ok = if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("Windows 凭据加密/解密失败，请使用导入时的 Windows 用户".into());
        }
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut std::ffi::c_void);
        Ok(result)
    }
}

#[cfg(not(windows))]
fn protect(_data: &[u8], _decrypt: bool) -> Result<Vec<u8>, String> {
    Err("CLIProxy 凭据导入目前仅支持 Windows DPAPI".into())
}

fn load(root: &Path) -> Result<AccountStore, String> {
    let path = store_path(root);
    match std::fs::read(path) {
        Ok(bytes) => {
            if bytes.len() > 8 * MAX_DOCUMENT_BYTES {
                return Err("账号存储超过大小限制".into());
            }
            let plain = protect(&bytes, true)?;
            serde_json::from_slice(&plain)
                .map_err(|_| "账号存储格式损坏，请保留备份后重新导入".into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AccountStore::default()),
        Err(_) => Err("读取账号存储失败".into()),
    }
}

fn save(root: &Path, store: &AccountStore) -> Result<(), String> {
    let path = store_path(root);
    let plain = serde_json::to_vec(store).map_err(|_| "序列化账号失败")?;
    let encrypted = protect(&plain, false)?;
    std::fs::create_dir_all(path.parent().ok_or("账号目录无效")?)
        .map_err(|_| "创建账号目录失败")?;
    // Never truncate the previous encrypted store before the replacement is ready.
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, encrypted).map_err(|_| "写入加密账号失败")?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err("替换加密账号存储失败".into());
        }
    }
    #[cfg(not(windows))]
    std::fs::rename(temp, path).map_err(|_| "替换账号存储失败")?;
    Ok(())
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn claims(token: &str) -> Value {
    token
        .split('.')
        .nth(1)
        .and_then(|s| {
            general_purpose::URL_SAFE_NO_PAD
                .decode(s.trim_end_matches('='))
                .ok()
        })
        .and_then(|s| serde_json::from_slice(&s).ok())
        .unwrap_or(Value::Null)
}

fn normalize(value: &Value) -> Result<ImportedAccount, String> {
    if let Some(kind) = text(value, "type") {
        if !kind.eq_ignore_ascii_case("codex") {
            return Err("请选择 CLIProxy 的 Codex 账号 JSON".into());
        }
    }
    let tokens = value.get("tokens").unwrap_or(value);
    let access = text(tokens, "access_token")
        .ok_or("缺少 access_token；config.yaml 和 API Key 配置不是 OAuth 账号文件")?;
    if access.len() > 65536 || access.chars().any(char::is_control) {
        return Err("access_token 格式无效".into());
    }
    let id_claims = claims(&text(tokens, "id_token").unwrap_or_default());
    let access_claims = claims(&access);
    let account_id = text(tokens, "account_id").or_else(|| {
        [&id_claims, &access_claims]
            .iter()
            .find_map(|c| text(&c["https://api.openai.com/auth"], "chatgpt_account_id"))
    });
    if account_id
        .as_ref()
        .is_some_and(|s| s.len() > 512 || s.chars().any(char::is_control))
    {
        return Err("account_id 格式无效".into());
    }
    let email = text(value, "email").or_else(|| text(&id_claims, "email"));
    if email
        .as_ref()
        .is_some_and(|s| s.len() > 254 || s.chars().any(char::is_control))
    {
        return Err("email 格式无效".into());
    }
    let email_masked = email
        .as_ref()
        .and_then(|s| s.split_once('@'))
        .map(|(user, domain)| format!("{}***@{}", user.chars().take(2).collect::<String>(), domain))
        .unwrap_or_else(|| "CLIProxy 账号".into());
    let identity = account_id
        .clone()
        .or(email)
        .unwrap_or_else(|| access.clone());
    let entry_key = format!("cliproxy-{:x}", Sha256::digest(identity.as_bytes()));
    // Do not copy refresh_token: rotating the same token could log CLIProxy out.
    let auth = json!({ "tokens": { "access_token": access, "account_id": account_id } });
    Ok(ImportedAccount {
        entry_key,
        email_masked,
        auth,
    })
}

fn parse_documents(documents: &[String]) -> Result<Vec<ImportedAccount>, String> {
    if documents.is_empty() || documents.len() > MAX_ACCOUNTS {
        return Err("每次请选择 1–20 个 JSON 文件".into());
    }
    let mut out = Vec::new();
    for (index, document) in documents.iter().enumerate() {
        if document.len() > MAX_DOCUMENT_BYTES {
            return Err(format!("第 {} 个文件超过 1 MiB", index + 1));
        }
        let value: Value = serde_json::from_str(document.trim_start_matches('\u{feff}'))
            .map_err(|_| format!("第 {} 个文件不是有效 JSON", index + 1))?;
        let entries = value
            .as_array()
            .or_else(|| value.get("accounts").and_then(Value::as_array));
        if let Some(entries) = entries {
            for entry in entries {
                out.push(normalize(entry)?);
            }
        } else {
            out.push(normalize(&value)?);
        }
        if out.len() > MAX_ACCOUNTS {
            return Err("最多支持 20 个导入账号".into());
        }
    }
    if out.is_empty() {
        return Err("JSON 中没有账号".into());
    }
    Ok(out)
}

pub fn import_accounts(root: &Path, documents: Vec<String>) -> Result<usize, String> {
    let incoming = parse_documents(&documents)?;
    let _guard = STORE_LOCK.lock().map_err(|_| "账号存储繁忙")?;
    let mut store = load(root)?;
    let mut imported = std::collections::HashSet::new();
    for account in incoming {
        imported.insert(account.entry_key.clone());
        if let Some(existing) = store
            .accounts
            .iter_mut()
            .find(|a| a.entry_key == account.entry_key)
        {
            *existing = account;
        } else {
            store.accounts.push(account);
        }
    }
    if store.accounts.len() > MAX_ACCOUNTS {
        return Err("最多支持 20 个导入账号，请先移除不用的账号".into());
    }
    if store.tray_entry_key.is_none() {
        store.tray_entry_key = store.accounts.first().map(|a| a.entry_key.clone());
    }
    save(root, &store)?;
    Ok(imported.len())
}

pub fn list_accounts(root: &Path) -> Result<Vec<AccountSummary>, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "账号存储繁忙")?;
    let store = load(root)?;
    Ok(store
        .accounts
        .iter()
        .map(|a| AccountSummary {
            entry_key: a.entry_key.clone(),
            email_masked: a.email_masked.clone(),
            selected: store.tray_entry_key.as_ref() == Some(&a.entry_key),
        })
        .collect())
}

pub fn remove_account(root: &Path, entry_key: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "账号存储繁忙")?;
    let mut store = load(root)?;
    store.accounts.retain(|a| a.entry_key != entry_key);
    if store.tray_entry_key.as_deref() == Some(entry_key) {
        store.tray_entry_key = None;
    }
    save(root, &store)
}

pub fn set_tray_account(root: &Path, entry_key: String) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "账号存储繁忙")?;
    let mut store = load(root)?;
    if entry_key != "local" && !store.accounts.iter().any(|a| a.entry_key == entry_key) {
        return Err("账号不存在".into());
    }
    store.tray_entry_key = Some(entry_key);
    save(root, &store)
}

// Only exposed to the Codex plugin; credentials never become frontend probe output.
pub fn plugin_accounts(root: &Path) -> Result<String, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "账号存储繁忙")?;
    let mut value = serde_json::to_value(load(root)?).map_err(|_| "读取导入账号失败")?;
    value["configured"] = Value::Bool(store_path(root).exists());
    serde_json::to_string(&value).map_err(|_| "读取导入账号失败".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_cliproxy_and_native_codex_formats_without_refresh_token() {
        for input in [
            json!({"type":"codex", "access_token":"access", "refresh_token":"secret", "email":"demo@example.com", "account_id":"a"}),
            json!({"tokens":{"access_token":"access", "refresh_token":"secret", "account_id":"a"}}),
        ] {
            let account = normalize(&input).unwrap();
            assert_eq!(account.auth["tokens"]["access_token"], "access");
            assert!(account.auth["tokens"].get("refresh_token").is_none());
        }
    }

    #[test]
    fn stable_identity_deduplicates_token_updates() {
        let a = normalize(&json!({"access_token":"old", "account_id":"a"})).unwrap();
        let b = normalize(&json!({"access_token":"new", "account_id":"a"})).unwrap();
        assert_eq!(a.entry_key, b.entry_key);
        assert!(!a.entry_key.contains("old"));
    }

    #[test]
    fn rejects_other_providers_api_keys_and_header_injection() {
        for input in [
            json!({"type":"grok", "access_token":"a"}),
            json!({"api_key":"key"}),
            json!({"access_token":"a\r\nb"}),
            json!({"access_token":"a", "account_id":"a\nb"}),
        ] {
            assert!(normalize(&input).is_err());
        }
    }

    #[test]
    fn accepts_bom_and_arrays_and_rejects_empty_or_large_batches() {
        assert_eq!(
            parse_documents(&["\u{feff}[{\"access_token\":\"a\"}]".into()])
                .unwrap()
                .len(),
            1
        );
        assert!(parse_documents(&["[]".into()]).is_err());
        assert!(parse_documents(&["{".into()]).is_err());
        assert!(parse_documents(&["x".repeat(MAX_DOCUMENT_BYTES + 1)]).is_err());
        assert!(parse_documents(&vec!["{}".into(); MAX_ACCOUNTS + 1]).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn encrypted_import_roundtrip_does_not_expose_tokens_in_summary_or_disk() {
        let root =
            std::env::temp_dir().join(format!("openusage-codex-test-{}", uuid::Uuid::new_v4()));
        let input = json!({"type":"codex", "access_token":"private-test-token", "account_id":"a", "email":"demo@example.com"});
        assert_eq!(import_accounts(&root, vec![input.to_string()]).unwrap(), 1);
        assert_eq!(import_accounts(&root, vec![input.to_string()]).unwrap(), 1);
        let summaries = list_accounts(&root).unwrap();
        assert_eq!(summaries.len(), 1);
        assert!(!serde_json::to_string(&summaries)
            .unwrap()
            .contains("private-test-token"));
        let bytes = std::fs::read(store_path(&root)).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("private-test-token"));
        assert!(plugin_accounts(&root)
            .unwrap()
            .contains("private-test-token"));
        set_tray_account(&root, "local".into()).unwrap();
        assert!(!list_accounts(&root).unwrap()[0].selected);
        remove_account(&root, &summaries[0].entry_key).unwrap();
        assert!(list_accounts(&root).unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
