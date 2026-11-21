mod record_catalog;
mod records;

pub use record_catalog::*;
pub use records::*;

pub const FORM_LIVE_TOPIC: &str = "intake_forms";
pub const RECORD_LIVE_TOPIC: &str = "intake_records";

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FormDefinition {
    #[serde(default)]
    pub kind: FormKind,
    #[serde(default = "all_services")]
    pub all_services: bool,
    #[serde(default)]
    pub service_ids: Vec<String>,
    pub title: String,
    pub description: String,
    pub required_at_booking: bool,
    pub allow_team_responses: bool,
    pub fields: Vec<Question>,
}

fn all_services() -> bool {
    true
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FormKind {
    #[default]
    Intake,
    Waiver,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminForm {
    pub id: String,
    pub version: u32,
    pub active: bool,
    pub draft: FormDefinition,
    pub published: Option<PublishedForm>,
}

impl AdminForm {
    pub fn can_publish(&self) -> bool {
        !self.active
            || self
                .published
                .as_ref()
                .is_none_or(|revision| revision.definition != self.draft)
    }
}

#[derive(Clone, Deserialize, PartialEq)]
pub struct PublishedForm {
    pub number: u32,
    pub definition: FormDefinition,
}

#[derive(Deserialize)]
pub(crate) struct AdminForms {
    pub forms: Vec<AdminFormSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminFormSummary {
    pub id: String,
    pub title: String,
    pub active: bool,
    pub version: Option<u32>,
    pub published_number: Option<u32>,
}

impl From<&AdminForm> for AdminFormSummary {
    fn from(form: &AdminForm) -> Self {
        Self {
            id: form.id.clone(),
            title: form.draft.title.clone(),
            active: form.active,
            version: Some(form.version),
            published_number: form.published.as_ref().map(|revision| revision.number),
        }
    }
}

#[derive(Clone)]
pub enum FormWrite {
    Create {
        key: String,
        definition: FormDefinition,
    },
    Save {
        id: String,
        version: u32,
        definition: FormDefinition,
    },
    Publish {
        id: String,
        version: u32,
    },
    Archive {
        id: String,
        version: u32,
    },
}

#[derive(Debug)]
pub enum FormWriteError {
    Conflict,
    Capacity,
    Invalid,
    Transport(crate::sync::TransportError),
}

// A retried write may conflict because the first reply was lost. Recover only
// the exact next version with the reviewed result, leaving unrelated edits visible.
pub(crate) fn recovered_form(
    action: &FormWrite,
    base: &AdminForm,
    form: AdminForm,
) -> Option<AdminForm> {
    if form.id != base.id || base.version.checked_add(1) != Some(form.version) {
        return None;
    }
    let matches = match action {
        FormWrite::Create { .. } => false,
        FormWrite::Save { definition, .. } => {
            form.draft == *definition
                && form.active == base.active
                && form.published == base.published
        }
        FormWrite::Publish { .. } => {
            let previous = base
                .published
                .as_ref()
                .map_or(0, |revision| revision.number);
            form.active
                && form.draft == base.draft
                && form.published.as_ref().is_some_and(|revision| {
                    previous.checked_add(1) == Some(revision.number)
                        && revision.definition == base.draft
                })
        }
        FormWrite::Archive { .. } => {
            !form.active && form.draft == base.draft && form.published == base.published
        }
    };
    matches.then_some(form)
}

impl From<crate::sync::TransportError> for FormWriteError {
    fn from(error: crate::sync::TransportError) -> Self {
        Self::Transport(error)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Question {
    pub id: String,
    pub label: String,
    pub help: String,
    pub required: bool,
    #[serde(flatten)]
    pub kind: QuestionKind,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum QuestionKind {
    Text {
        max_length: usize,
    },
    Textarea {
        max_length: usize,
    },
    Date,
    Boolean,
    Consent,
    Number {
        minimum: Option<f64>,
        maximum: Option<f64>,
    },
    SingleChoice {
        options: Vec<Choice>,
    },
    MultipleChoice {
        options: Vec<Choice>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Choice {
    pub id: String,
    pub label: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Answer {
    Text(String),
    Number(f64),
    Boolean(bool),
    Choices(BTreeSet<String>),
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeResponse {
    revision_id: String,
    confirmation: bool,
    answers: BTreeMap<String, Answer>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidAnswer;

impl Question {
    pub fn parse_text(&self, text: &str) -> Result<Option<Answer>, InvalidAnswer> {
        let text = text.trim();
        if text.is_empty() {
            return if self.required {
                Err(InvalidAnswer)
            } else {
                Ok(None)
            };
        }
        let answer = match self.kind {
            QuestionKind::Number { .. } => {
                Answer::Number(text.replace(',', ".").parse().map_err(|_| InvalidAnswer)?)
            }
            _ => Answer::Text(text.to_owned()),
        };
        self.accepts(Some(&answer))
            .then_some(Some(answer))
            .ok_or(InvalidAnswer)
    }

    pub fn accepts(&self, answer: Option<&Answer>) -> bool {
        let Some(answer) = answer else {
            return !self.required;
        };
        match (&self.kind, answer) {
            (
                QuestionKind::Text { max_length } | QuestionKind::Textarea { max_length },
                Answer::Text(value),
            ) => {
                !value.trim().is_empty()
                    && !value.contains('\0')
                    && value.encode_utf16().count() <= *max_length
            }
            (QuestionKind::Date, Answer::Text(value)) => {
                value.len() == 10
                    && NaiveDate::parse_from_str(value, "%Y-%m-%d")
                        .is_ok_and(|date| date.to_string() == *value)
            }
            (QuestionKind::Boolean, Answer::Boolean(_)) => true,
            (QuestionKind::Consent, Answer::Boolean(value)) => !self.required || *value,
            (QuestionKind::Number { minimum, maximum }, Answer::Number(value)) => {
                value.is_finite()
                    && minimum.is_none_or(|min| *value >= min)
                    && maximum.is_none_or(|max| *value <= max)
            }
            (QuestionKind::SingleChoice { options }, Answer::Text(value)) => {
                options.iter().any(|option| option.id == *value)
            }
            (QuestionKind::MultipleChoice { options }, Answer::Choices(values)) => {
                (!self.required || !values.is_empty())
                    && values
                        .iter()
                        .all(|id| options.iter().any(|option| option.id == *id))
            }
            _ => false,
        }
    }
}

impl FormDefinition {
    pub fn team_response(
        &self,
        revision_id: &str,
        confirmed: bool,
        answers: BTreeMap<String, Answer>,
    ) -> Option<IntakeResponse> {
        (self.allow_team_responses
            && confirmed
            && answers
                .keys()
                .all(|id| self.fields.iter().any(|field| field.id == *id))
            && self
                .fields
                .iter()
                .all(|field| field.accepts(answers.get(&field.id))))
        .then(|| IntakeResponse {
            revision_id: revision_id.to_owned(),
            confirmation: true,
            answers,
        })
    }
}

#[derive(Default)]
pub struct IntakeSelection {
    pub saved: Vec<String>,
    pub inline: Vec<IntakeResponse>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeRequirements {
    pub forms: Vec<RequiredForm>,
    pub review_hash: String,
    pub desktop_generation: Option<String>,
    #[serde(default)]
    pub ready_responses: Vec<ReadyResponse>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RequiredForm {
    pub id: String,
    pub definition: FormDefinition,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyResponse {
    pub id: String,
    pub revision_id: String,
    pub created_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_lost_publication_reply_accepts_only_the_reviewed_successor() {
        let draft: FormDefinition = serde_json::from_value(serde_json::json!({
            "title": "Reviewed wording", "description": "",
            "requiredAtBooking": true, "allowTeamResponses": false,
            "fields": [{ "id": uuid::Uuid::now_v7().to_string(), "label": "Question", "help": "", "required": true, "kind": "consent" }],
        })).unwrap();
        let base = AdminForm {
            id: uuid::Uuid::now_v7().to_string(),
            version: 3,
            active: false,
            published: None,
            draft: draft.clone(),
        };
        let mut successor = AdminForm {
            version: 4,
            active: true,
            published: Some(PublishedForm {
                number: 1,
                definition: draft,
            }),
            ..base.clone()
        };
        let action = FormWrite::Publish {
            id: base.id.clone(),
            version: base.version,
        };
        assert!(recovered_form(&action, &base, successor.clone()).is_some());
        successor.published.as_mut().unwrap().definition.title =
            "Someone else’s publication".into();
        assert!(recovered_form(&action, &base, successor).is_none());
    }

    #[test]
    fn team_answers_preserve_explicit_false_zero_multiline_and_confirmed_consent() {
        let mut form: FormDefinition = serde_json::from_value(json!({
            "title": "Review", "description": "", "requiredAtBooking": true, "allowTeamResponses": true,
            "fields": [
                {"id":"yes-no", "label":"Yes?", "help":"", "kind":"boolean", "required":true},
                {"id":"number", "label":"Count", "help":"", "kind":"number", "minimum":0, "maximum":4, "required":true},
                {"id":"date", "label":"Date", "help":"", "kind":"date", "required":true},
                {"id":"note", "label":"Notes", "help":"", "kind":"textarea", "maxLength":30, "required":true},
                {"id":"consent", "label":"Consent", "help":"", "kind":"consent", "required":true},
                {"id":"choices", "label":"Choices", "help":"", "kind":"multiple_choice", "required":true,
                    "options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]},
            ]
        })).unwrap();
        assert!(form.fields[1].parse_text("4,5").is_err());
        assert!(form.fields[1].parse_text("NaN").is_err());
        assert!(form.fields[2].parse_text("2026-02-29").is_err());
        assert!(form.fields[2].parse_text("2024-2-29").is_err());
        let mut answers = BTreeMap::from([
            ("yes-no".into(), Answer::Boolean(false)),
            (
                "number".into(),
                form.fields[1].parse_text("0").unwrap().unwrap(),
            ),
            (
                "date".into(),
                form.fields[2].parse_text("2024-02-29").unwrap().unwrap(),
            ),
            (
                "note".into(),
                form.fields[3]
                    .parse_text("First line\nSecond line")
                    .unwrap()
                    .unwrap(),
            ),
            ("consent".into(), Answer::Boolean(false)),
            (
                "choices".into(),
                Answer::Choices(BTreeSet::from(["b".into(), "a".into()])),
            ),
        ]);
        assert!(
            form.team_response("revision", true, answers.clone())
                .is_none()
        );
        answers.insert("consent".into(), Answer::Boolean(true));
        assert!(
            form.team_response("revision", false, answers.clone())
                .is_none()
        );
        let response = form
            .team_response("revision", true, answers.clone())
            .unwrap();
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "revisionId": "revision", "confirmation": true, "answers": {
                    "yes-no": false, "number": 0.0, "date": "2024-02-29", "note": "First line\nSecond line",
                    "consent": true, "choices": ["a", "b"],
                }
            })
        );
        form.allow_team_responses = false;
        assert!(form.team_response("revision", true, answers).is_none());
    }
}
