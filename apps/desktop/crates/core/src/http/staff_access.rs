use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessPreset {
    Manager,
    Receptionist,
    Professional,
    Restricted,
}

impl AccessPreset {
    pub const ALL: [Self; 4] = [
        Self::Manager,
        Self::Receptionist,
        Self::Professional,
        Self::Restricted,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountRole {
    Owner,
    Staff,
    Client,
}

impl AccountRole {
    pub const ALL: [Self; 3] = [Self::Owner, Self::Staff, Self::Client];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Staff => "staff",
            Self::Client => "client",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffAccess {
    pub staff_id: String,
    pub preset: AccessPreset,
    pub version: u64,
    pub account_role: Option<String>,
}

impl StaffAccess {
    pub fn editable(&self) -> bool {
        matches!(self.account_role.as_deref(), None | Some("staff"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedStaffAccess {
    pub generation: String,
    pub account_id: Option<String>,
    pub account_email: Option<String>,
    pub access: StaffAccess,
}

impl ReviewedStaffAccess {
    fn verify(self, staff_id: &str) -> Result<Self, TransportError> {
        if self.access.staff_id != staff_id
            || self.access.version == 0
            || self.generation.is_empty()
        {
            return Err(TransportError::Server(
                "Unexpected staff access response".into(),
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum StaffAccountError {
    #[error("An account already uses this email")]
    EmailTaken,
    #[error("Staff invitations require an email provider")]
    EmailUnavailable,
    #[error("Invalid staff account details")]
    InvalidDetails,
    #[error("The calendar has upcoming appointments")]
    FutureAppointments,
    #[error(transparent)]
    Transport(#[from] TransportError),
}

/// Fast form checks. The server validates the complete provisioning contract.
pub fn valid_staff_login(email: &str, password: Option<&str>) -> bool {
    email.split_once('@').is_some_and(|(local, domain)| {
        !local.is_empty()
            && !domain.contains('@')
            && domain
                .split_once('.')
                .is_some_and(|(label, suffix)| !label.is_empty() && !suffix.is_empty())
    }) && !email.chars().any(char::is_whitespace)
        && password.is_none_or(|value| (8..=128).contains(&value.encode_utf16().count()))
}

impl HttpTransport {
    pub fn change_staff_role(
        &self,
        reviewed: &ReviewedStaffAccess,
        role: AccountRole,
    ) -> Result<ReviewedStaffAccess, StaffAccountError> {
        let (Some(account_id), Some(email), Some(previous)) = (
            &reviewed.account_id,
            &reviewed.account_email,
            &reviewed.access.account_role,
        ) else {
            return Err(StaffAccountError::InvalidDetails);
        };
        if previous == role.as_str() {
            return Err(StaffAccountError::InvalidDetails);
        }
        let id = parse_id(&reviewed.access.staff_id)?.to_string();
        let path = format!("/admin/staff/{id}/account-role/reviewed");
        let body = serde_json::json!({
            "generation": reviewed.generation, "accountId": account_id, "expectedRole": previous,
            "expectedEmail": email, "version": reviewed.access.version, "role": role,
        });
        let saved: ReviewedStaffAccess = read_response_with(
            self.send_put_json(&path, &body)?,
            |status, retry_after, body| {
                let future_appointments = serde_json::from_str::<serde_json::Value>(body)
                    .is_ok_and(|value| {
                        value
                            .pointer("/error/code")
                            .and_then(serde_json::Value::as_str)
                            == Some("has_future_appointments")
                    });
                if status == 409 && future_appointments {
                    StaffAccountError::FutureAppointments
                } else {
                    classify_status(status, retry_after, body, false).into()
                }
            },
        )?;
        let saved = saved.verify(&id)?;
        if saved.generation != reviewed.generation
            || saved.account_id != reviewed.account_id
            || saved.account_email != reviewed.account_email
            || saved.access.account_role.as_deref() != Some(role.as_str())
            || saved.access.version <= reviewed.access.version
        {
            return Err(
                TransportError::Server("Unexpected role change acknowledgement".into()).into(),
            );
        }
        Ok(saved)
    }

    pub fn link_staff_account(
        &self,
        reviewed: &ReviewedStaffAccess,
        name: &str,
        email: &str,
        password: Option<&str>,
    ) -> Result<ReviewedStaffAccess, StaffAccountError> {
        if reviewed.account_id.is_some() {
            return Err(TransportError::BadRequest("Calendar already linked".into()).into());
        }
        let id = parse_id(&reviewed.access.staff_id)?.to_string();
        let body = serde_json::json!({
            "name": name,
            "email": email,
            "existingCalendar": {
                "staffId": id,
                "version": reviewed.access.version,
                "generation": reviewed.generation,
            },
        });
        let current = self.provision_staff_account(body, &reviewed.generation, email, password)?;
        if current.access.staff_id != id
            || current.access.preset != reviewed.access.preset
            || current.access.version <= reviewed.access.version
        {
            return Err(
                TransportError::Server("Unexpected linked staff account access".into()).into(),
            );
        }
        Ok(current)
    }

    pub fn create_staff_account(
        &self,
        generation: &str,
        name: &str,
        display_name: Option<&str>,
        email: &str,
        password: Option<&str>,
    ) -> Result<ReviewedStaffAccess, StaffAccountError> {
        let mut body = serde_json::json!({
            "name": name,
            "email": email,
            "newCalendar": { "generation": generation },
        });
        if let Some(display_name) = display_name {
            body["displayName"] = serde_json::json!(display_name);
        }
        self.provision_staff_account(body, generation, email, password)
    }

    fn provision_staff_account(
        &self,
        mut body: serde_json::Value,
        generation: &str,
        email: &str,
        password: Option<&str>,
    ) -> Result<ReviewedStaffAccess, StaffAccountError> {
        if !valid_staff_login(email, password) {
            return Err(StaffAccountError::InvalidDetails);
        }
        if let Some(password) = password {
            body["password"] = serde_json::json!(password);
        }
        let created: CreatedAccount = read_response_with(
            self.send_json("/admin/staff-accounts", &body)?,
            |status, retry_after, body| {
                let error = serde_json::from_str::<serde_json::Value>(body).ok();
                let code = error
                    .as_ref()
                    .and_then(|value| value.pointer("/error/code"))
                    .and_then(serde_json::Value::as_str);
                match (status, code) {
                    (409, Some("invalid_state")) => StaffAccountError::EmailTaken,
                    (503, Some("email_unavailable")) => StaffAccountError::EmailUnavailable,
                    (400, Some("validation_error")) => StaffAccountError::InvalidDetails,
                    _ => classify_status(status, retry_after, body, false).into(),
                }
            },
        )?;
        if created.role != "staff"
            || created.invited != password.is_none()
            || created.user_id.is_empty()
            || created.email != email.to_lowercase()
        {
            return Err(TransportError::Server("Could not verify the staff account".into()).into());
        }
        let id = parse_id(&created.staff_id)?.to_string();
        let current = created.reviewed_access.verify(&id)?;
        if current.account_id.as_deref() != Some(created.user_id.as_str())
            || current.account_email.as_deref() != Some(created.email.as_str())
            || current.access.account_role.as_deref() != Some("staff")
            || current.generation != generation
        {
            return Err(TransportError::Server("Unexpected staff account access".into()).into());
        }
        Ok(current)
    }

    pub fn staff_access(&self, staff_id: &str) -> Result<ReviewedStaffAccess, TransportError> {
        let id = parse_id(staff_id)?.to_string();
        let path = format!("/admin/staff/{id}/access/reviewed");
        let result: ReviewedStaffAccess =
            read_response(self.get(&self.agent, &path, None)?, false)?;
        result.verify(&id)
    }

    pub fn save_staff_access(
        &self,
        reviewed: &ReviewedStaffAccess,
        preset: AccessPreset,
    ) -> Result<ReviewedStaffAccess, TransportError> {
        if !reviewed.access.editable() {
            return Err(TransportError::BadRequest(
                "This account cannot use staff access presets".into(),
            ));
        }
        let id = parse_id(&reviewed.access.staff_id)?.to_string();
        let path = format!("/admin/staff/{id}/access/reviewed");
        let body = serde_json::json!({
            "generation": reviewed.generation, "accountId": reviewed.account_id,
            "version": reviewed.access.version, "preset": preset,
        });
        let result: ReviewedStaffAccess = self.put_json(&path, &body)?;
        let saved = result.verify(&id)?;
        if saved.generation != reviewed.generation
            || saved.account_id != reviewed.account_id
            || saved.access.preset != preset
            || saved.access.version <= reviewed.access.version
        {
            return Err(TransportError::Server(
                "Could not verify the saved access profile".into(),
            ));
        }
        Ok(saved)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatedAccount {
    user_id: String,
    staff_id: String,
    email: String,
    role: String,
    invited: bool,
    reviewed_access: ReviewedStaffAccess,
}
