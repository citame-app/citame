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

impl HttpTransport {
    pub fn lookup_unlinked_account(&self, email: &str) -> Result<UnlinkedAccount, TransportError> {
        let email = email.trim().to_lowercase();
        if !valid_staff_login(&email, None) {
            return Err(TransportError::BadRequest(
                "Enter an exact email address".into(),
            ));
        }
        let account: UnlinkedAccount = self.post_json(
            "/admin/accounts/lookup",
            &serde_json::json!({ "email": email }),
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
            return Err(TransportError::Server("Unexpected account lookup".into()));
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
