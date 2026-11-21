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
