use super::*;
use sob_core::intake::{Answer, IntakeResponse, InvalidAnswer, Question, QuestionKind};
use sob_core::waitlist::{OfferIntakeSelection, ReadyResponse, RequiredForm};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

pub(super) struct IntakeDraft {
    form: RequiredForm,
    saved: Option<ReadyResponse>,
    use_saved: bool,
    included: bool,
    confirmed: bool,
    fields: Vec<QuestionDraft>,
}

struct QuestionDraft {
    question: Question,
    answer: Option<Answer>,
    lines: Vec<AnswerLine>,
    multiline: Option<MultilineLimit>,
}

struct MultilineLimit {
    max_length: usize,
    remaining_lines: Rc<Cell<usize>>,
}

struct AnswerLine {
    text: Entity<TextField>,
    _events: Subscription,
}

impl IntakeDraft {
    pub(super) fn new(
        form: RequiredForm,
        saved: Option<ReadyResponse>,
        locale: i18n::Locale,
        cx: &mut Context<Root>,
    ) -> Self {
        let fields = if form.definition.allow_team_responses {
            form.definition
                .fields
                .iter()
                .map(|question| {
                    let multiline = match question.kind {
                        QuestionKind::Textarea { max_length } => Some(MultilineLimit {
                            max_length,
                            remaining_lines: Rc::new(Cell::new(max_length)),
                        }),
                        _ => None,
                    };
                    let line = match question.kind {
                        QuestionKind::Text { .. } | QuestionKind::Number { .. } => {
                            Some(answer_line("", "", None, cx))
                        }
                        QuestionKind::Date => Some(answer_line(
                            "",
                            i18n::t(locale, Key::IntakeDateFormat),
                            None,
                            cx,
                        )),
                        QuestionKind::Textarea { .. } => {
                            Some(answer_line("", "", multiline.as_ref(), cx))
                        }
                        _ => None,
                    };
                    QuestionDraft {
                        question: question.clone(),
                        answer: None,
                        lines: line.into_iter().collect(),
                        multiline,
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        Self {
            form,
            saved,
            use_saved: false,
            included: false,
            confirmed: false,
            fields,
        }
    }

    pub(super) fn revision_id(&self) -> &str {
        &self.form.id
    }

    pub(super) fn refresh_saved(&mut self, saved: Option<ReadyResponse>) {
        if self.saved.as_ref().map(|answer| &answer.id) != saved.as_ref().map(|answer| &answer.id) {
            self.use_saved = false;
        }
        self.saved = saved;
        self.confirmed = false;
    }

    fn included(&self) -> bool {
        self.included || self.form.definition.required_at_booking
    }

    fn answers(&self, cx: &App) -> Option<BTreeMap<String, Answer>> {
        let mut answers = BTreeMap::new();
        for field in &self.fields {
            if let Some(answer) = field.answer(cx).ok()? {
                answers.insert(field.question.id.clone(), answer);
            }
        }
        Some(answers)
    }

    fn response(&self, cx: &App) -> Option<IntakeResponse> {
        if !self.confirmed {
            return None;
        }
        self.form
            .definition
            .team_response(&self.form.id, true, self.answers(cx)?)
    }
}

pub(super) fn selection(forms: &[IntakeDraft], cx: &App) -> Option<OfferIntakeSelection> {
    let mut result = OfferIntakeSelection::default();
    for form in forms.iter().filter(|form| form.included()) {
        if form.use_saved {
            result.saved.push(form.saved.as_ref()?.id.clone());
        } else {
            result.inline.push(form.response(cx)?);
        }
    }
    Some(result)
}

impl QuestionDraft {
    fn answer(&self, cx: &App) -> Result<Option<Answer>, InvalidAnswer> {
        if self.lines.is_empty() {
            return self
                .question
                .accepts(self.answer.as_ref())
                .then(|| self.answer.clone())
                .ok_or(InvalidAnswer);
        }
        let value = self
            .lines
            .iter()
            .map(|line| line.text.read(cx).text())
            .collect::<Vec<_>>()
            .join("\n");
        self.question.parse_text(&value)
    }
}

fn answer_line(
    value: &str,
    placeholder: &'static str,
    paste_limit: Option<&MultilineLimit>,
    cx: &mut Context<Root>,
) -> AnswerLine {
    let text = cx.new(|cx| {
        let mut text = TextField::new(placeholder, false, cx);
        if let Some(limit) = paste_limit {
            text = text.with_bounded_line_paste(limit.max_length, limit.remaining_lines.clone());
        }
        text.set_text(value, cx);
        text
    });
    let events = cx.subscribe(&text, |root, entity, event, cx| {
        let Overlay::Waitlist(desk) = &mut root.overlay else {
            return;
        };
        let Some(review) = desk
            .offer_review
            .as_mut()
            .filter(|review| review.request.is_none())
        else {
            return;
        };
        for form in &mut review.forms {
            for field in &mut form.fields {
                let Some(index) = field.lines.iter().position(|line| line.text == entity) else {
                    continue;
                };
                match event {
                    FieldEvent::Changed => form.confirmed = false,
                    FieldEvent::PasteLines(values) => {
                        field.lines.splice(
                            index + 1..index + 1,
                            values
                                .iter()
                                .map(|line| answer_line(line, "", field.multiline.as_ref(), cx)),
                        );
                        form.confirmed = false;
                    }
                    FieldEvent::PasteTooLong => desk.error = Some(Key::IntakeInvalidAnswer),
                    FieldEvent::Submit => (),
                }
                cx.notify();
                return;
            }
        }
    });
    AnswerLine {
        text,
        _events: events,
    }
}

enum FieldChange {
    Answer(Answer),
    ToggleChoice(String),
    AddLine,
    RemoveLine(usize),
}

impl Root {
    fn edit_waitlist_intake(
        &mut self,
        revision: &str,
        edit: impl FnOnce(&mut IntakeDraft, &mut Context<Self>),
        cx: &mut Context<Self>,
    ) {
        if let Overlay::Waitlist(desk) = &mut self.overlay
            && !desk.busy
            && let Some(review) = desk
                .offer_review
                .as_mut()
                .filter(|review| review.request.is_none())
            && let Some(form) = review
                .forms
                .iter_mut()
                .find(|form| form.revision_id() == revision)
        {
            edit(form, cx);
            cx.notify();
        }
    }

    fn change_waitlist_answer(
        &mut self,
        revision: &str,
        id: &str,
        change: FieldChange,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_waitlist_intake(
            revision,
            |form, cx| {
                let Some(field) = form.fields.iter_mut().find(|field| field.question.id == id)
                else {
                    return;
                };
                match change {
                    FieldChange::Answer(answer) => {
                        field.answer = (field.answer.as_ref() != Some(&answer)).then_some(answer);
                    }
                    FieldChange::ToggleChoice(id) => {
                        let mut current = match field.answer.take() {
                            Some(Answer::Choices(values)) => values,
                            _ => BTreeSet::new(),
                        };
                        if !current.remove(&id) {
                            current.insert(id);
                        }
                        field.answer = (!current.is_empty()).then_some(Answer::Choices(current));
                    }
                    FieldChange::AddLine => {
                        let Some(multiline) = &field.multiline else {
                            return;
                        };
                        let Some(remaining) = multiline.remaining_lines.get().checked_sub(1) else {
                            return;
                        };
                        multiline.remaining_lines.set(remaining);
                        let line = answer_line("", "", Some(multiline), cx);
                        line.text.read(cx).focus(window);
                        field.lines.push(line);
                    }
                    FieldChange::RemoveLine(index) => {
                        if field.lines.len() > 1 && index < field.lines.len() {
                            field.lines.remove(index);
                            if let Some(limit) = &field.multiline {
                                limit.remaining_lines.set(limit.remaining_lines.get() + 1);
                            }
                        }
                    }
                }
                form.confirmed = false;
            },
            cx,
        );
    }

    fn intake_toggle(
        &self,
        id: String,
        label: impl Into<SharedString>,
        active: bool,
        action: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Stateful<gpui::Div> {
        self.button(
            SharedString::from(id.clone()),
            label,
            if active { Kind::Primary } else { Kind::Ghost },
            action,
        )
        .tab_index(0)
        .focus(|style| style.border_color(theme::text()))
        .debug_selector(move || id.clone())
    }

    pub(super) fn render_waitlist_intake(
        &self,
        form: &IntakeDraft,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let rev = &form.form.id;
        let definition = &form.form.definition;
        let mut row = div()
            .min_w_0()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .border_1()
            .border_color(theme::line())
            .rounded_lg()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(definition.title.clone()),
            )
            .when(!definition.description.is_empty(), |row| {
                row.child(div().text_sm().child(definition.description.clone()))
            });
        if !definition.required_at_booking {
            let revision = rev.clone();
            row = row.child(div().flex().child(self.intake_toggle(
                format!("intake-include-{rev}"),
                self.t(Key::IntakeInclude),
                form.included,
                cx.listener(move |this, _, _, cx| {
                    this.edit_waitlist_intake(
                        &revision,
                        |draft, _| {
                            draft.included = !draft.included;
                            draft.confirmed = false;
                        },
                        cx,
                    );
                }),
            )));
        }
        if !form.included() {
            return row;
        }
        if let Some(saved) = &form.saved {
            let revision = rev.clone();
            row = row.child(div().flex().child(self.intake_toggle(
                format!("intake-saved-{rev}"),
                i18n::fill(
                    self.t(Key::WaitlistUseResponse),
                    &[("date", &self.date_time_label(saved.created_at))],
                ),
                form.use_saved,
                cx.listener(move |this, _, _, cx| {
                    this.edit_waitlist_intake(
                        &revision,
                        |draft, _| {
                            draft.use_saved = !draft.use_saved;
                            draft.confirmed = false;
                        },
                        cx,
                    );
                }),
            )));
        }
        if form.use_saved {
            return row;
        }
        if !definition.allow_team_responses {
            return row.child(div().text_sm().child(self.t(Key::IntakeCustomerOnly)));
        }
        for field in &form.fields {
            row = row.child(self.render_waitlist_question(rev, field, cx));
        }
        let revision = rev.clone();
        row.child(div().text_sm().child(self.t(Key::IntakeTeamConfirm)))
            .when(form.answers(cx).is_some(), |row| {
                row.child(div().flex().child(self.intake_toggle(
                    format!("intake-confirm-{rev}"),
                    self.t(Key::IntakeConfirmed),
                    form.confirmed,
                    cx.listener(move |this, _, _, cx| {
                        this.edit_waitlist_intake(
                            &revision,
                            |draft, _| draft.confirmed = !draft.confirmed,
                            cx,
                        );
                    }),
                )))
            })
    }

    fn render_waitlist_question(
        &self,
        rev: &str,
        field: &QuestionDraft,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let question = &field.question;
        let row = div()
            .min_w_0()
            .flex()
            .flex_col()
            .gap_1()
            .text_sm()
            .child(
                div()
                    .font_weight(FontWeight::MEDIUM)
                    .child(if question.required {
                        format!("{} · {}", question.label, self.t(Key::IntakeRequired))
                    } else {
                        question.label.clone()
                    }),
            )
            .when(!question.help.is_empty(), |row| {
                row.child(
                    div()
                        .text_color(theme::muted())
                        .child(question.help.clone()),
                )
            });
        let prefix = format!("intake-{rev}-{}", question.id);
        let choices = match &question.kind {
            QuestionKind::Boolean | QuestionKind::Consent => {
                [(true, Key::IntakeYes), (false, Key::IntakeNo)]
                    .into_iter()
                    .map(|(value, label)| {
                        (
                            value.to_string(),
                            self.t(label).to_owned(),
                            Answer::Boolean(value),
                        )
                    })
                    .collect::<Vec<_>>()
            }
            QuestionKind::SingleChoice { options } | QuestionKind::MultipleChoice { options } => {
                options
                    .iter()
                    .map(|choice| {
                        (
                            choice.id.clone(),
                            choice.label.clone(),
                            Answer::Text(choice.id.clone()),
                        )
                    })
                    .collect()
            }
            _ => return self.render_waitlist_text_answer(row, rev, field, &prefix, cx),
        };
        let multiple = matches!(question.kind, QuestionKind::MultipleChoice { .. });
        row.child(
            div()
                .flex()
                .flex_wrap()
                .gap_1()
                .children(choices.into_iter().map(|(choice_id, label, answer)| {
                    let active = match field.answer.as_ref() {
                        Some(Answer::Choices(values)) => values.contains(&choice_id),
                        value => value == Some(&answer),
                    };
                    let id = format!("{prefix}-{choice_id}");
                    let (revision, field_id) = (rev.to_owned(), question.id.clone());
                    self.intake_toggle(
                        id,
                        label,
                        active,
                        cx.listener(move |this, _, window, cx| {
                            let change = if multiple {
                                FieldChange::ToggleChoice(choice_id.clone())
                            } else {
                                FieldChange::Answer(answer.clone())
                            };
                            this.change_waitlist_answer(&revision, &field_id, change, window, cx);
                        }),
                    )
                })),
        )
    }

    fn render_waitlist_text_answer(
        &self,
        row: gpui::Div,
        rev: &str,
        field: &QuestionDraft,
        prefix: &str,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let can_add_line = field
            .multiline
            .as_ref()
            .is_some_and(|limit| limit.remaining_lines.get() > 0);
        let row = row.children(field.lines.iter().enumerate().map(|(index, line)| {
            let (revision, id) = (rev.to_owned(), field.question.id.clone());
            div()
                .flex()
                .items_center()
                .gap_1()
                .child(div().flex_1().min_w_0().child(line.text.clone()))
                .when(index > 0, |row| {
                    row.child(self.intake_toggle(
                        format!("{prefix}-remove-{index}"),
                        self.t(Key::IntakeRemoveLine),
                        false,
                        cx.listener(move |this, _, window, cx| {
                            this.change_waitlist_answer(
                                &revision,
                                &id,
                                FieldChange::RemoveLine(index),
                                window,
                                cx,
                            )
                        }),
                    ))
                })
        }));
        let (revision, id) = (rev.to_owned(), field.question.id.clone());
        row.when(can_add_line, |row| {
            row.child(div().flex().child(self.intake_toggle(
                format!("{prefix}-add-line"),
                self.t(Key::IntakeAddLine),
                false,
                cx.listener(move |this, _, window, cx| {
                    this.change_waitlist_answer(&revision, &id, FieldChange::AddLine, window, cx)
                }),
            )))
        })
        .when(
            field
                .lines
                .iter()
                .any(|line| !line.text.read(cx).text().trim().is_empty())
                && field.answer(cx).is_err(),
            |row| {
                row.child(
                    div()
                        .text_color(theme::conflict_fg())
                        .child(self.t(Key::IntakeInvalidAnswer)),
                )
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[gpui::test]
    async fn waitlist_review_requires_confirmed_team_answers_or_an_explicit_saved_response(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            let form = |id: &str, required: bool, allow_team: bool| {
                serde_json::from_value(json!({
                    "id": id, "definition": {
                        "title": "Synthetic form", "description": "", "requiredAtBooking": required,
                        "allowTeamResponses": allow_team, "fields": [
                            {"id":"answer","label":"Do you agree?","help":"","kind":"boolean","required":true}
                        ]
                    }
                })).unwrap()
            };
            let saved = ReadyResponse {
                id: "recorded".into(), revision_id: "client-form".into(), created_at: Utc::now(),
            };
            let mut drafts = vec![
                IntakeDraft::new(form("team-form", true, true), None, root.locale, cx),
                IntakeDraft::new(form("client-form", true, false), Some(saved), root.locale, cx),
                IntakeDraft::new(form("optional-form", false, true), None, root.locale, cx),
            ];
            drafts[0].fields[0].answer = Some(Answer::Boolean(false));
            assert!(selection(&drafts, cx).is_none());
            drafts[0].confirmed = true;
            assert!(selection(&drafts, cx).is_none());
            drafts[1].use_saved = true;
            let submitted = selection(&drafts, cx).unwrap();
            assert_eq!(submitted.saved, ["recorded"]);
            assert_eq!(submitted.inline.len(), 1);
            drafts[2].included = true;
            assert!(selection(&drafts, cx).is_none());
            drafts[2].included = false;
            drafts[1].refresh_saved(None);
            assert!(selection(&drafts, cx).is_none());
        });
    }

    #[gpui::test]
    async fn rendered_waitlist_offer_requires_reconfirmation_after_an_answer_changes(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Online;
            let now = Utc::now();
            let entry = serde_json::from_value(json!({
                "id":"offer-entry","clientId":"client","serviceIds":[],"serviceNames":[],
                "fromDate":now.date_naive(),"toDate":now.date_naive(),
                "fromTime":"10:00","toTime":"12:00","state":"offered","version":2,"canManage":true,
                "offer":{"id":"offer","staffId":"staff","staffName":"Test professional",
                    "startsAt":now,"endsAt":now + chrono::Duration::minutes(30),
                    "expiresAt":now + chrono::Duration::hours(1),"priceCents":1500,
                    "currency":"EUR","services":[],"policy":{"enabled":false}},
            })).unwrap();
            let form = serde_json::from_value(json!({
                "id":"rev","definition":{"title":"Synthetic form","description":"","requiredAtBooking":true,
                    "allowTeamResponses":true,"fields":[
                        {"id":"q","label":"Does this apply?","help":"","kind":"boolean","required":true}
                    ]}
            })).unwrap();
            let waiver = cx.new(|cx| TextField::new("", false, cx));
            let waiver_sub = cx.observe(&waiver, |_, _, cx| cx.notify());
            root.overlay = Overlay::Waitlist(Box::new(Desk {
                active: true, page: 1, data: None, busy: false, cached: false, error: None,
                confirm: None, form: None, policy_review: None, booked: None, observed_revision: 0,
                requested_at: Instant::now(), offer_review: Some(OfferReview {
                    entry, review_hash: Some("current".into()), can_waive: false,
                    forms: vec![IntakeDraft::new(form, None, root.locale, cx)], waiver, _waiver_sub: waiver_sub,
                    request: None, confirming_requeue: false,
                }),
            }));
            cx.notify();
        });
        let click = |cx: &mut gpui::VisualTestContext, selector| {
            cx.run_until_parked();
            let bounds = cx
                .debug_bounds(selector)
                .unwrap_or_else(|| panic!("missing {selector}"));
            cx.simulate_click(bounds.center(), Default::default());
            cx.run_until_parked();
        };
        click(cx, "intake-rev-q-false");
        assert!(cx.debug_bounds("wl-accept").is_none());
        click(cx, "intake-confirm-rev");
        assert!(cx.debug_bounds("wl-accept").is_some());
        click(cx, "intake-rev-q-true");
        root.update(cx, |root, cx| {
            let Overlay::Waitlist(desk) = &root.overlay else {
                panic!("missing waitlist");
            };
            let review = desk.offer_review.as_ref().unwrap();
            assert!(matches!(
                review.forms[0].fields[0].answer,
                Some(Answer::Boolean(true))
            ));
            assert!(!review.forms[0].confirmed);
            assert!(review.intake_selection(cx).is_none());
        });
        click(cx, "intake-confirm-rev");
        assert!(cx.debug_bounds("wl-accept").is_some());
    }
}
