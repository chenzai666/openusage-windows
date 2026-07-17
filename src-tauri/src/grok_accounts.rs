//! Grok multi-account helpers for the Settings UI:
//! - list accounts from `~/.grok/auth.json`
//! - read/write `plugins_data/grok/accounts-meta.json`
//! - device-code login (copy link, no auto-open browser)

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
// Map used when building auth entry objects
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DEFAULT_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_CODE_URL: &str = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
const SCOPES: &str = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const META_FILE: &str = "accounts-meta.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokAccountSummary {
    pub entry_key: String,
    pub email: Option<String>,
    pub email_masked: String,
    pub labels: Vec<String>,
    pub subscription_paste: Option<String>,
    pub subscription_display: Option<String>,
    pub expired: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokDeviceLoginStart {
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
    /// Full URL ready to copy (complete URI if available).
    pub copy_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokDeviceLoginStatus {
    pub state: String, // pending | complete | error | expired | cancelled
    pub message: Option<String>,
    pub entry_key: Option<String>,
    pub email_masked: Option<String>,
}

struct PendingDeviceLogin {
    device_code: String,
    client_id: String,
    interval: Duration,
    expires_at: Instant,
    last_poll: Option<Instant>,
    cancelled: bool,
}

static PENDING_LOGIN: Mutex<Option<PendingDeviceLogin>> = Mutex::new(None);

fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

fn auth_json_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".grok").join("auth.json"))
}

fn meta_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir
        .join("plugins_data")
        .join("grok")
        .join(META_FILE)
}

fn mask_email(email: &str) -> String {
    let s = email.trim();
    let Some(at) = s.find('@') else {
        return s.to_string();
    };
    let (user, domain) = s.split_at(at);
    let domain = &domain[1..];
    if user.is_empty() {
        return s.to_string();
    }
    let chars: Vec<char> = user.chars().collect();
    if chars.len() <= 3 {
        return format!("{}***@{}", chars[0], domain);
    }
    let first: String = chars.iter().take(3).collect();
    let last: String = chars.iter().rev().take(2).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{}***{}@{}", first, last, domain)
}

fn parse_renewal_paste(text: &str) -> Option<(String, String)> {
    let s = text.trim();
    if s.is_empty() {
        return None;
    }
    let method = s
        .split("billed via")
        .nth(1)
        .or_else(|| s.split(" via ").nth(1))
        .map(|m| m.trim().trim_end_matches('.').trim().to_string())
        .filter(|m| !m.is_empty());

    let months: HashMap<&str, u32> = [
        ("january", 1),
        ("february", 2),
        ("march", 3),
        ("april", 4),
        ("may", 5),
        ("june", 6),
        ("july", 7),
        ("august", 8),
        ("september", 9),
        ("october", 10),
        ("november", 11),
        ("december", 12),
    ]
    .into_iter()
    .collect();

    let mut date: Option<String> = None;
    // Renews on July 18, 2026
    if let Some(caps) = regex_lite::Regex::new(r"(?i)Renews on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})")
        .ok()
        .and_then(|re| re.captures(s))
    {
        let mon_name = caps.get(1).map(|m| m.as_str().to_lowercase()).unwrap_or_default();
        if let Some(mon) = months.get(mon_name.as_str()) {
            let day: u32 = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let year = caps.get(3).map(|m| m.as_str()).unwrap_or("");
            if day > 0 && !year.is_empty() {
                date = Some(format!("{:02}/{:02}/{}", day, mon, year));
            }
        }
    }
    if date.is_none() {
        if let Some(caps) = regex_lite::Regex::new(r"(\d{4})-(\d{2})-(\d{2})")
            .ok()
            .and_then(|re| re.captures(s))
        {
            date = Some(format!(
                "{}/{}/{}",
                &caps[3], &caps[2], &caps[1]
            ));
        }
    }

    match (date, method) {
        (Some(d), Some(m)) => Some((d, m)),
        (Some(d), None) => Some((d, String::new())),
        (None, Some(m)) => Some((String::new(), m)),
        _ => None,
    }
}

fn format_subscription_display(entry: &Value) -> Option<String> {
    let mut date = entry
        .get("subscription_renews_at")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut method = entry
        .get("subscription_payment_method")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if date.is_none() || method.is_none() {
        if let Some(paste) = entry.get("subscription_paste").and_then(|v| v.as_str()) {
            if let Some((d, m)) = parse_renewal_paste(paste) {
                if date.is_none() && !d.is_empty() {
                    date = Some(d);
                }
                if method.is_none() && !m.is_empty() {
                    method = Some(m);
                }
            }
        }
    }

    if let Some(ref d) = date {
        if d.len() >= 10 && d.as_bytes().get(4) == Some(&b'-') {
            // YYYY-MM-DD → dd/mm/YYYY
            let parts: Vec<&str> = d[..10].split('-').collect();
            if parts.len() == 3 {
                date = Some(format!("{}/{}/{}", parts[2], parts[1], parts[0]));
            }
        }
    }

    match (date, method) {
        (Some(d), Some(m)) if !d.is_empty() && !m.is_empty() => Some(format!("{} · {}", d, m)),
        (Some(d), _) if !d.is_empty() => Some(d),
        (_, Some(m)) if !m.is_empty() => Some(m),
        _ => None,
    }
}

fn read_json_file(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir failed: {}", e))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("write failed: {}", e))
}

fn entry_expired(entry: &Value) -> bool {
    let expires = entry
        .get("expires_at")
        .or_else(|| entry.get("expires"))
        .and_then(|v| v.as_str());
    let Some(expires) = expires else {
        return false;
    };
    if let Ok(dt) = time::OffsetDateTime::parse(expires, &time::format_description::well_known::Rfc3339)
    {
        return dt < time::OffsetDateTime::now_utc();
    }
    // Fallback Date.parse style
    false
}

pub fn list_accounts(app_data_dir: &Path) -> Result<Vec<GrokAccountSummary>, String> {
    let auth_path = auth_json_path().ok_or_else(|| "无法解析用户目录".to_string())?;
    let auth = read_json_file(&auth_path).unwrap_or_else(|| json!({}));
    let obj = auth.as_object().cloned().unwrap_or_default();

    let meta = read_json_file(&meta_path(app_data_dir)).unwrap_or_else(|| json!({ "entries": {} }));
    let meta_entries = meta
        .get("entries")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for (entry_key, entry) in obj.iter() {
        if !entry.is_object() {
            continue;
        }
        let token = entry
            .get("key")
            .or_else(|| entry.get("access_token"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());
        if token.is_none() {
            continue;
        }

        let email = entry
            .get("email")
            .or_else(|| entry.get("user_email"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let em = meta_entries.get(entry_key).cloned().unwrap_or(json!({}));
        let labels: Vec<String> = em
            .get("labels")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .take(8)
                    .collect()
            })
            .unwrap_or_default();

        let paste = em
            .get("subscription_paste")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        out.push(GrokAccountSummary {
            entry_key: entry_key.clone(),
            email_masked: email
                .as_deref()
                .map(mask_email)
                .unwrap_or_else(|| "未命名账号".to_string()),
            email,
            labels,
            subscription_paste: paste,
            subscription_display: format_subscription_display(&em),
            expired: entry_expired(entry),
        });
    }

    out.sort_by(|a, b| a.email_masked.cmp(&b.email_masked));
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokAccountMetaUpdate {
    pub entry_key: String,
    pub labels: Option<Vec<String>>,
    pub subscription_paste: Option<String>,
}

pub fn update_account_meta(
    app_data_dir: &Path,
    update: GrokAccountMetaUpdate,
) -> Result<GrokAccountSummary, String> {
    let entry_key = update.entry_key.trim().to_string();
    if entry_key.is_empty() {
        return Err("entryKey 不能为空".into());
    }

    let path = meta_path(app_data_dir);
    let mut meta = read_json_file(&path).unwrap_or_else(|| json!({ "entries": {} }));
    if !meta.get("entries").map(|v| v.is_object()).unwrap_or(false) {
        meta["entries"] = json!({});
    }
    let entries = meta
        .get_mut("entries")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| "meta entries invalid".to_string())?;

    let mut entry = entries
        .get(&entry_key)
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !entry.is_object() {
        entry = json!({});
    }
    let obj = entry.as_object_mut().unwrap();

    if let Some(labels) = update.labels {
        let cleaned: Vec<String> = labels
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .take(8)
            .map(|s| {
                if s.chars().count() > 32 {
                    s.chars().take(32).collect()
                } else {
                    s
                }
            })
            .collect();
        obj.insert("labels".into(), json!(cleaned));
    }

    if let Some(paste) = update.subscription_paste {
        let paste = paste.trim().to_string();
        if paste.is_empty() {
            obj.remove("subscription_paste");
            obj.remove("subscription_renews_at");
            obj.remove("subscription_payment_method");
        } else {
            obj.insert("subscription_paste".into(), json!(paste));
            if let Some((d, m)) = parse_renewal_paste(&paste) {
                if !d.is_empty() {
                    obj.insert("subscription_renews_at".into(), json!(d));
                }
                if !m.is_empty() {
                    obj.insert("subscription_payment_method".into(), json!(m));
                }
            }
        }
    }

    entries.insert(entry_key.clone(), entry.clone());
    write_json_file(&path, &meta)?;

    let accounts = list_accounts(app_data_dir)?;
    if let Some(found) = accounts.into_iter().find(|a| a.entry_key == entry_key) {
        return Ok(found);
    }

    let labels: Vec<String> = entry
        .get("labels")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok(GrokAccountSummary {
        entry_key,
        email: None,
        email_masked: "未命名账号".into(),
        labels,
        subscription_paste: entry
            .get("subscription_paste")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        subscription_display: format_subscription_display(&entry),
        expired: false,
    })
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

pub fn start_device_login() -> Result<GrokDeviceLoginStart, String> {
    let client = http_client()?;
    let body = format!(
        "client_id={}&scope={}",
        urlencoding_encode(DEFAULT_CLIENT_ID),
        urlencoding_encode(SCOPES)
    );
    let resp = client
        .post(DEVICE_CODE_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(body)
        .send()
        .map_err(|e| format!("device code 请求失败: {}", e))?;

    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("device code 失败 HTTP {}: {}", status.as_u16(), text));
    }

    let data: Value = serde_json::from_str(&text).map_err(|e| format!("device code 响应解析失败: {}", e))?;
    let device_code = data
        .get("device_code")
        .and_then(|v| v.as_str())
        .ok_or("响应缺少 device_code")?
        .to_string();
    let user_code = data
        .get("user_code")
        .and_then(|v| v.as_str())
        .ok_or("响应缺少 user_code")?
        .to_string();
    let verification_uri = data
        .get("verification_uri")
        .or_else(|| data.get("verification_url"))
        .and_then(|v| v.as_str())
        .unwrap_or("https://auth.x.ai/device")
        .to_string();
    let verification_uri_complete = data
        .get("verification_uri_complete")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let expires_in = data
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(900);
    let interval = data
        .get("interval")
        .and_then(|v| v.as_u64())
        .unwrap_or(5)
        .max(3);

    let copy_url = verification_uri_complete
        .clone()
        .unwrap_or_else(|| format!("{}?user_code={}", verification_uri, user_code));

    {
        let mut guard = PENDING_LOGIN.lock().map_err(|_| "login lock poisoned")?;
        *guard = Some(PendingDeviceLogin {
            device_code,
            client_id: DEFAULT_CLIENT_ID.to_string(),
            interval: Duration::from_secs(interval),
            expires_at: Instant::now() + Duration::from_secs(expires_in),
            last_poll: None,
            cancelled: false,
        });
    }

    Ok(GrokDeviceLoginStart {
        user_code,
        verification_uri,
        verification_uri_complete,
        expires_in,
        interval,
        copy_url,
    })
}

pub fn cancel_device_login() {
    if let Ok(mut guard) = PENDING_LOGIN.lock() {
        if let Some(pending) = guard.as_mut() {
            pending.cancelled = true;
        }
        *guard = None;
    }
}

pub fn poll_device_login() -> Result<GrokDeviceLoginStatus, String> {
    let (device_code, client_id, interval, expires_at, last_poll, cancelled) = {
        let guard = PENDING_LOGIN.lock().map_err(|_| "login lock poisoned")?;
        let Some(pending) = guard.as_ref() else {
            return Ok(GrokDeviceLoginStatus {
                state: "cancelled".into(),
                message: Some("没有进行中的登录".into()),
                entry_key: None,
                email_masked: None,
            });
        };
        (
            pending.device_code.clone(),
            pending.client_id.clone(),
            pending.interval,
            pending.expires_at,
            pending.last_poll,
            pending.cancelled,
        )
    };

    if cancelled {
        cancel_device_login();
        return Ok(GrokDeviceLoginStatus {
            state: "cancelled".into(),
            message: Some("已取消".into()),
            entry_key: None,
            email_masked: None,
        });
    }

    if Instant::now() >= expires_at {
        cancel_device_login();
        return Ok(GrokDeviceLoginStatus {
            state: "expired".into(),
            message: Some("登录码已过期，请重新开始".into()),
            entry_key: None,
            email_masked: None,
        });
    }

    if let Some(last) = last_poll {
        if last.elapsed() < interval {
            return Ok(GrokDeviceLoginStatus {
                state: "pending".into(),
                message: Some("等待浏览器授权…".into()),
                entry_key: None,
                email_masked: None,
            });
        }
    }

    {
        let mut guard = PENDING_LOGIN.lock().map_err(|_| "login lock poisoned")?;
        if let Some(pending) = guard.as_mut() {
            pending.last_poll = Some(Instant::now());
        }
    }

    let client = http_client()?;
    let body = format!(
        "grant_type={}&device_code={}&client_id={}",
        urlencoding_encode("urn:ietf:params:oauth:grant-type:device_code"),
        urlencoding_encode(&device_code),
        urlencoding_encode(&client_id)
    );
    let resp = client
        .post(TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(body)
        .send()
        .map_err(|e| format!("token 轮询失败: {}", e))?;

    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    let data: Value = serde_json::from_str(&text).unwrap_or(json!({}));

    if status.is_success() {
        let access = data
            .get("access_token")
            .and_then(|v| v.as_str())
            .ok_or("token 响应缺少 access_token")?;
        let refresh = data
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let id_token = data
            .get("id_token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let expires_in = data
            .get("expires_in")
            .and_then(|v| v.as_u64())
            .unwrap_or(3600);

        let (sub, email) = decode_id_claims(id_token.as_deref());
        let entry_key = format!(
            "https://auth.x.ai::{}{}",
            client_id,
            sub.as_ref()
                .map(|s| format!("::{}", s))
                .unwrap_or_default()
        );

        let expires_at = (time::OffsetDateTime::now_utc() + time::Duration::seconds(expires_in as i64))
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| "".into());

        let mut entry = Map::new();
        entry.insert("key".into(), json!(access));
        entry.insert("auth_mode".into(), json!("oidc"));
        entry.insert("expires_at".into(), json!(expires_at));
        entry.insert("oidc_client_id".into(), json!(client_id));
        if let Some(r) = refresh {
            entry.insert("refresh_token".into(), json!(r));
        }
        if let Some(id) = id_token {
            entry.insert("id_token".into(), json!(id));
        }
        if let Some(e) = email.clone() {
            entry.insert("email".into(), json!(e));
        }
        entry.insert(
            "create_time".into(),
            json!(time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default()),
        );

        persist_auth_entry(&entry_key, Value::Object(entry))?;
        cancel_device_login();

        return Ok(GrokDeviceLoginStatus {
            state: "complete".into(),
            message: Some("登录成功".into()),
            entry_key: Some(entry_key),
            email_masked: Some(
                email
                    .as_deref()
                    .map(mask_email)
                    .unwrap_or_else(|| "已登录".into()),
            ),
        });
    }

    let err = data
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    match err {
        "authorization_pending" | "slow_down" => Ok(GrokDeviceLoginStatus {
            state: "pending".into(),
            message: Some("等待浏览器授权…".into()),
            entry_key: None,
            email_masked: None,
        }),
        "expired_token" | "access_denied" => {
            cancel_device_login();
            Ok(GrokDeviceLoginStatus {
                state: "expired".into(),
                message: Some(format!("登录失败: {}", err)),
                entry_key: None,
                email_masked: None,
            })
        }
        other => Ok(GrokDeviceLoginStatus {
            state: "pending".into(),
            message: Some(format!("等待中 ({})", other)),
            entry_key: None,
            email_masked: None,
        }),
    }
}

fn persist_auth_entry(entry_key: &str, entry: Value) -> Result<(), String> {
    let path = auth_json_path().ok_or_else(|| "无法解析用户目录".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut auth = read_json_file(&path).unwrap_or_else(|| json!({}));
    if !auth.is_object() {
        auth = json!({});
    }
    auth.as_object_mut()
        .unwrap()
        .insert(entry_key.to_string(), entry);
    write_json_file(&path, &auth)
}

fn decode_id_claims(id_token: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(token) = id_token else {
        return (None, None);
    };
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 {
        return (None, None);
    }
    let payload_b64 = parts[1];
    let padded = match payload_b64.len() % 4 {
        2 => format!("{}==", payload_b64),
        3 => format!("{}=", payload_b64),
        _ => payload_b64.to_string(),
    };
    let decoded = match base64::Engine::decode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        payload_b64,
    )
    .or_else(|_| {
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, padded.as_bytes())
    }) {
        Ok(b) => b,
        Err(_) => return (None, None),
    };
    let value: Value = match serde_json::from_slice(&decoded) {
        Ok(v) => v,
        Err(_) => return (None, None),
    };
    let sub = value
        .get("sub")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let email = value
        .get("email")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    (sub, email)
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_email() {
        assert_eq!(mask_email("chenzai666@gmail.com"), "che***66@gmail.com");
    }

    #[test]
    fn parses_play_renewal() {
        let (d, m) =
            parse_renewal_paste("Renews on July 18, 2026 · billed via Google Play").unwrap();
        assert_eq!(d, "18/07/2026");
        assert_eq!(m, "Google Play");
    }
}
