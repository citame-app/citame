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

impl HttpTransport {
    pub fn link_staff_account(
        &self,
        reviewed: &ReviewedStaffAccess,
        name: &str,
        email: &str,
        password: Option<&str>,
    ) -> Result<ReviewedStaffAccess, TransportError> {
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

        if reviewed.account_id.is_some() {
            return Err(TransportError::BadRequest("Calendar already linked".into()));
        }
        let id = parse_id(&reviewed.access.staff_id)?.to_string();
        let mut body = serde_json::json!({
            "name": name,
            "email": email,
            "existingCalendar": {
                "staffId": id,
                "version": reviewed.access.version,
                "generation": reviewed.generation,
            },
        });
        if let Some(password) = password {
            body["password"] = serde_json::json!(password);
        }
        let created: CreatedAccount = self.post_json("/admin/staff-accounts", &body)?;
        if created.staff_id != id
            || created.role != "staff"
            || created.invited != password.is_none()
            || created.user_id.is_empty()
            || created.email != email.to_lowercase()
        {
            return Err(TransportError::Server(
                "Could not verify the linked account".into(),
            ));
        }
        let current = created.reviewed_access.verify(&id)?;
        if current.account_id.as_deref() != Some(created.user_id.as_str())
            || current.account_email.as_deref() != Some(created.email.as_str())
            || current.access.account_role.as_deref() != Some("staff")
            || current.access.preset != reviewed.access.preset
            || current.access.version <= reviewed.access.version
            || current.generation != reviewed.generation
        {
            return Err(TransportError::Server(
                "Unexpected staff account access".into(),
            ));
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
