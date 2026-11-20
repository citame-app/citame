use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormDefinition {
    pub title: String,
    pub description: String,
    pub required_at_booking: bool,
    pub allow_team_responses: bool,
    pub fields: Vec<Question>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Question {
    pub id: String,
    pub label: String,
    pub help: String,
    pub required: bool,
    #[serde(flatten)]
    pub kind: QuestionKind,
}

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
pub struct Choice {
    pub id: String,
    pub label: String,
}

#[derive(Clone, PartialEq, Serialize)]
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
