use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

const RESET_URL: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
static RESET_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPreparation {
    identity: String,
    available_count: u64,
    pending: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetResult {
    outcome: String,
    message: String,
}

fn identity(auth: &Value) -> Result<String, String> {
    let tokens = &auth["tokens"];
    let id = tokens["account_id"]
        .as_str()
        .or_else(|| tokens["access_token"].as_str())
        .ok_or("账号登录无效，请重新导入或登录")?;
    Ok(Sha256::digest(id.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn client() -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(proxy) = crate::config::get_resolved_proxy() {
        builder = builder.proxy(proxy.proxy.clone());
    }
    builder.build().map_err(|_| "创建重置请求失败".into())
}

fn request(
    client: &reqwest::blocking::Client,
    auth: &Value,
    request_id: Option<&str>,
) -> Result<Value, String> {
    let access = auth["tokens"]["access_token"]
        .as_str()
        .ok_or("账号登录无效")?;
    let url = if request_id.is_some() {
        format!("{RESET_URL}/consume")
    } else {
        RESET_URL.into()
    };
    let mut request = if request_id.is_some() {
        client.post(url)
    } else {
        client.get(url)
    }
    .bearer_auth(access)
    .header("Accept", "application/json")
    .header("User-Agent", "OpenUsage");
    if let Some(id) = auth["tokens"]["account_id"].as_str() {
        request = request.header("ChatGPT-Account-Id", id);
    }
    if let Some(id) = request_id {
        request = request.json(&json!({ "redeem_request_id": id }));
    }
    // No automatic POST retry. Ambiguous failures retain the encrypted
    // idempotency key across retries and application restarts.
    let response = request.send().map_err(|_| {
        if request_id.is_some() {
            "重置请求结果待确认，请先刷新；再次点击会复用原请求编号，避免重复消耗重置卡"
        } else {
            "读取重置卡失败，请检查网络后重试"
        }
    })?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("登录已失效或无重置权限，请重新导入最新账号 JSON 或重新登录 Codex".into());
    }
    if !status.is_success() {
        return Err(format!(
            "重置卡接口返回 HTTP {}，请先刷新；再次操作复用未完成请求编号",
            status.as_u16()
        ));
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    response
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取重置卡响应失败，请先刷新后重试")?;
    if bytes.len() > 1024 * 1024 {
        return Err("重置卡响应超过大小限制，请先刷新".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "重置卡响应格式异常，请先刷新后重试".into())
}

fn available_count(details: &Value) -> Result<u64, String> {
    details["available_count"]
        .as_u64()
        .ok_or_else(|| "接口未返回有效的可用重置卡数量".into())
}

fn parse_result(value: &Value) -> Result<ResetResult, String> {
    let code = value["code"]
        .as_str()
        .ok_or("重置结果待确认，请先刷新后重试")?;
    let message = match code {
        "reset" => "额度重置成功，已使用 1 张重置卡，正在刷新用量。",
        "nothing_to_reset" => "当前没有需要重置的额度，请刷新查看最新状态。",
        "no_credit" => "当前没有可用的重置卡，请刷新查看剩余数量。",
        "already_redeemed" => "这次重置请求已处理，正在刷新用量。",
        _ => return Err("重置结果待确认，请先刷新；再次操作将复用原请求编号".into()),
    };
    Ok(ResetResult {
        outcome: code.into(),
        message: message.into(),
    })
}

pub fn prepare(root: &Path, entry_key: &str) -> Result<ResetPreparation, String> {
    let auth = crate::codex_accounts::reset_auth(root, entry_key)?;
    let identity = identity(&auth)?;
    let available_count = available_count(&request(&client()?, &auth, None)?)?;
    let pending = crate::codex_accounts::has_pending_reset(root, &identity)?;
    Ok(ResetPreparation {
        identity,
        available_count,
        pending,
    })
}

pub fn consume(
    root: &Path,
    entry_key: &str,
    expected_identity: &str,
) -> Result<ResetResult, String> {
    let client = client()?;
    consume_with_request(root, entry_key, expected_identity, |auth, id| {
        request(&client, auth, id)
    })
}

fn consume_with_request(
    root: &Path,
    entry_key: &str,
    expected_identity: &str,
    mut send: impl FnMut(&Value, Option<&str>) -> Result<Value, String>,
) -> Result<ResetResult, String> {
    let _guard = RESET_LOCK
        .try_lock()
        .map_err(|_| "已有重置请求正在执行，请勿重复点击")?;
    let auth = crate::codex_accounts::reset_auth(root, entry_key)?;
    let identity = identity(&auth)?;
    if identity != expected_identity {
        return Err("账号登录已变化，请重新确认重置账号".into());
    }
    let pending = crate::codex_accounts::has_pending_reset(root, &identity)?;
    // Pending requests remain replayable even if their original reset used
    // the final credit but its response was lost.
    if !pending && available_count(&send(&auth, None)?)? == 0 {
        return parse_result(&json!({"code":"no_credit"}));
    }
    let request_id = crate::codex_accounts::reset_request_id(root, &identity)?;
    let result = parse_result(&send(&auth, Some(&request_id))?)?;
    if crate::codex_accounts::finish_reset(root, &identity).is_err() {
        return Ok(ResetResult {
            outcome: result.outcome,
            message: format!(
                "{} 本地请求记录未清除，下次点击会先核对原请求。",
                result.message
            ),
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_official_backend_outcomes_without_false_success() {
        for code in ["reset", "nothing_to_reset", "no_credit", "already_redeemed"] {
            assert_eq!(parse_result(&json!({"code":code})).unwrap().outcome, code);
        }
        assert!(parse_result(&json!({"code":"unknown"})).is_err());
        assert!(parse_result(&json!({})).is_err());
    }

    #[test]
    fn rejects_missing_and_invalid_counts() {
        assert_eq!(available_count(&json!({"available_count":0})).unwrap(), 0);
        assert_eq!(available_count(&json!({"available_count":3})).unwrap(), 3);
        for value in [
            json!({}),
            json!({"available_count":-1}),
            json!({"available_count":"1"}),
        ] {
            assert!(available_count(&value).is_err());
        }
    }

    #[test]
    fn identity_binds_reset_to_account_not_a_rotating_token() {
        let first = json!({"tokens":{"account_id":"a", "access_token":"old"}});
        let updated = json!({"tokens":{"account_id":"a", "access_token":"new"}});
        assert_eq!(identity(&first).unwrap(), identity(&updated).unwrap());
        assert_ne!(
            identity(&first).unwrap(),
            identity(&json!({"tokens":{"account_id":"b"}})).unwrap()
        );
    }

    #[cfg(windows)]
    #[test]
    fn reset_does_not_spend_without_credit_and_reuses_key_after_timeout() {
        let root =
            std::env::temp_dir().join(format!("openusage-reset-test-{}", uuid::Uuid::new_v4()));
        crate::codex_accounts::import_accounts(
            &root,
            vec![json!({"type":"codex", "access_token":"access", "account_id":"a"}).to_string()],
        )
        .unwrap();
        let key = crate::codex_accounts::list_accounts(&root).unwrap();
        let entry_key = &key[0].entry_key;
        let auth = crate::codex_accounts::reset_auth(&root, entry_key).unwrap();
        let identity = identity(&auth).unwrap();
        let no_credit = consume_with_request(&root, entry_key, &identity, |_, id| {
            assert!(id.is_none());
            Ok(json!({"available_count":0}))
        })
        .unwrap();
        assert_eq!(no_credit.outcome, "no_credit");
        assert!(!crate::codex_accounts::has_pending_reset(&root, &identity).unwrap());
        let mut first_id = String::new();
        let timeout = consume_with_request(&root, entry_key, &identity, |_, id| {
            if let Some(id) = id {
                first_id = id.to_string();
                Err("timeout".into())
            } else {
                Ok(json!({"available_count":1}))
            }
        });
        assert!(timeout.is_err());
        assert!(!first_id.is_empty());
        assert!(crate::codex_accounts::has_pending_reset(&root, &identity).unwrap());
        let retried = consume_with_request(&root, entry_key, &identity, |_, id| {
            assert_eq!(id, Some(first_id.as_str()));
            Ok(json!({"code":"already_redeemed"}))
        })
        .unwrap();
        assert_eq!(retried.outcome, "already_redeemed");
        assert!(!crate::codex_accounts::has_pending_reset(&root, &identity).unwrap());
        let changed = consume_with_request(&root, entry_key, "other-account", |_, _| {
            panic!("must not send on identity mismatch")
        });
        assert!(changed.is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
