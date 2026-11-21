use super::*;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkedAccount {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub email_verified: bool,
    pub role: AccountRole,
    pub generation: String,
    pub revision: String,
}

impl UnlinkedAccount {
    pub fn can_change_to(&self, role: AccountRole) -> bool {
        role != self.role && (role == AccountRole::Client || self.email_verified)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRoleReceipt {
    pub user_id: String,
    pub role: AccountRole,
    pub staff_id: Option<String>,
    pub client_id: Option<String>,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum AccountLookupError {
    #[error("No unlinked account matches that email")]
    NotFound,
    #[error("Enter a complete email address")]
    InvalidAddress,
    #[error(transparent)]
    Transport(#[from] TransportError),
}

impl HttpTransport {
    pub fn lookup_unlinked_account(
        &self,
        email: &str,
    ) -> Result<UnlinkedAccount, AccountLookupError> {
        let email = email.trim().to_lowercase();
        if !valid_staff_login(&email, None) {
            return Err(AccountLookupError::InvalidAddress);
        }
        let account: UnlinkedAccount = read_response_with(
            self.send_json(
                "/admin/accounts/lookup",
                &serde_json::json!({ "email": email }),
            )?,
            |status, retry_after, body| {
                let error = serde_json::from_str::<serde_json::Value>(body).ok();
                let code = error
                    .as_ref()
                    .and_then(|value| value.pointer("/error/code"))
                    .and_then(serde_json::Value::as_str);
                match (status, code) {
                    (404, Some("not_found")) => AccountLookupError::NotFound,
                    (400, Some("validation_error")) => AccountLookupError::InvalidAddress,
                    _ => classify_status(status, retry_after, body, false).into(),
                }
            },
        )?;
        if account.user_id.is_empty()
            || account.email != email
            || account.generation.is_empty()
            || account.revision.len() != 64
            || !account
                .revision
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(TransportError::Server("Unexpected account lookup".into()).into());
        }
        Ok(account)
    }

    pub fn change_unlinked_role(
        &self,
        reviewed: &UnlinkedAccount,
        role: AccountRole,
    ) -> Result<AccountRoleReceipt, TransportError> {
        if !reviewed.can_change_to(role) {
            return Err(TransportError::BadRequest(
                "Choose an eligible account role".into(),
            ));
        }
        let receipt: AccountRoleReceipt = self.put_json(
            "/admin/accounts/role/reviewed",
            &serde_json::json!({
                "userId": reviewed.user_id, "generation": reviewed.generation,
                "revision": reviewed.revision, "role": role,
            }),
        )?;
        if receipt.user_id != reviewed.user_id
            || receipt.role != role
            || receipt.staff_id.is_some() != (role == AccountRole::Staff)
            || (role == AccountRole::Client && receipt.client_id.is_none())
        {
            return Err(TransportError::Server(
                "Unexpected account role acknowledgement".into(),
            ));
        }
        if let Some(id) = &receipt.staff_id {
            parse_id(id)?;
        }
        if let Some(id) = &receipt.client_id {
            parse_id(id)?;
        }
        Ok(receipt)
    }
}
