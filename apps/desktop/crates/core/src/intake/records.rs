use super::*;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResponseSource {
    Client,
    Team,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedResponse {
    pub id: String,
    pub client_id: String,
    pub source: ResponseSource,
    pub created_at: DateTime<Utc>,
    pub answers: BTreeMap<String, Answer>,
    pub revision: StoredRevision,
}

#[derive(Deserialize)]
pub struct StoredRevision {
    pub id: String,
    pub number: u32,
    pub definition: FormDefinition,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseSummary {
    pub id: String,
    pub source: ResponseSource,
    pub created_at: DateTime<Utc>,
    pub revision_id: String,
    pub form_title: String,
    pub number: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseHistory {
    pub submissions: Vec<ResponseSummary>,
    pub next_cursor: Option<String>,
}

/// The client and idempotency key stay fixed alongside the reviewed answers
/// until the server acknowledges the request or the operator abandons it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordResponse {
    #[serde(skip)]
    client_id: uuid::Uuid,
    idempotency_key: uuid::Uuid,
    #[serde(flatten)]
    response: IntakeResponse,
}

impl RecordResponse {
    pub fn new(client_id: &str, response: IntakeResponse) -> Result<Self, uuid::Error> {
        Ok(Self {
            client_id: uuid::Uuid::parse_str(client_id)?,
            idempotency_key: uuid::Uuid::now_v7(),
            response,
        })
    }

    pub(crate) fn client_id(&self) -> uuid::Uuid {
        self.client_id
    }

    pub(crate) fn matches(&self, saved: &RecordedResponse) -> bool {
        uuid::Uuid::parse_str(&saved.client_id) == Ok(self.client_id)
            && saved.revision.id == self.response.revision_id
            && saved.source == ResponseSource::Team
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum RecordError {
    Denied,
    Missing,
    Changed,
    Capacity,
    Invalid,
    RateLimited(Option<std::time::Duration>),
    Retry,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_serializes_the_reviewed_answers_and_stable_key_without_client_id_in_body() {
        let client_id = uuid::Uuid::now_v7().to_string();
        let revision_id = uuid::Uuid::now_v7().to_string();
        let packet = RecordResponse::new(
            &client_id,
            IntakeResponse {
                revision_id: revision_id.clone(),
                confirmation: true,
                answers: BTreeMap::from([
                    ("zero".into(), Answer::Number(0.)),
                    ("no".into(), Answer::Boolean(false)),
                ]),
            },
        )
        .unwrap();
        let value = serde_json::to_value(&packet).unwrap();
        assert_eq!(value, serde_json::to_value(packet.clone()).unwrap());
        assert!(value.get("clientId").is_none());
        assert!(uuid::Uuid::parse_str(value["idempotencyKey"].as_str().unwrap()).is_ok());
        assert_eq!(value["revisionId"], revision_id);
        assert_eq!(
            value["answers"],
            serde_json::json!({"zero": 0., "no": false})
        );
    }
}
