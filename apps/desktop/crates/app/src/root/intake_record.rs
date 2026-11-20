use super::intake_editor::IntakeDraft;
use super::*;
use gpui::{Pixels, Size};
use sob_core::intake::{
    Answer, MAX_RECORD_SERVICES, QuestionKind, RecordError, RecordResponse, RecordedResponse,
    RecordingCatalog, RequiredForm, ResponseHistory, ResponseSource,
};

pub(super) struct Desk {
    client_id: String,
    client_name: String,
    history: Option<ResponseHistory>,
    before: Option<String>,
    page: Page,
    chooser: Option<Chooser>,
    subject_missing: bool,
    revision_changed: bool,
    refresh_forms_after_discard: bool,
    request: Option<Arc<()>>,
    denied: bool,
    pending: Option<RecordResponse>,
    discard: bool,
    pub(super) error: Option<Key>,
    notice: Option<Key>,
}

enum Page {
    History,
    Detail(Box<RecordedResponse>),
    Choose,
    Answer(Vec<IntakeDraft>),
}

struct Chooser {
    search: Entity<TextField>,
    catalog: Option<RecordingCatalog>,
    services: Vec<String>,
    forms: Option<Vec<RequiredForm>>,
}

enum Request {
    History(Option<String>),
    Detail(String),
    Catalog,
    Forms(Vec<String>),
    Submit(RecordResponse),
}

enum Reply {
    History(Option<String>, ResponseHistory),
    Detail(Box<RecordedResponse>),
    Catalog(RecordingCatalog),
    Forms(Vec<RequiredForm>),
    Submitted,
}

impl Desk {
    fn invalidate_history(&mut self) {
        self.history = None;
        self.before = None;
    }

    pub(super) fn subject_visibility(&mut self, clients: &[Client]) {
        self.subject_missing = clients.iter().all(|client| client.id != self.client_id);
        if self.subject_missing {
            self.invalidate_history();
            if matches!(self.page, Page::Detail(_) | Page::Choose) {
                self.page = Page::History;
            }
        }
    }

    pub(super) fn editable(&mut self) -> Option<&mut Vec<IntakeDraft>> {
        if self.request.is_none()
            && self.pending.is_none()
            && !self.discard
            && let Page::Answer(forms) = &mut self.page
        {
            return Some(forms);
        }
        None
    }

    fn selected_response(&self, cx: &App) -> Option<RecordResponse> {
        if self.subject_missing || self.revision_changed {
            return None;
        }
        let Page::Answer(forms) = &self.page else {
            return None;
        };
        RecordResponse::new(&self.client_id, forms.first()?.response(cx)?).ok()
    }

    fn set_error(&mut self, error: RecordError, submitting: bool) {
        self.error = Some(match error {
            RecordError::Denied => {
                self.page = Page::History;
                self.history = None;
                self.pending = None;
                self.denied = true;
                Key::RecordDenied
            }
            RecordError::Missing => {
                if matches!(self.page, Page::Detail(_)) {
                    self.page = Page::History;
                    self.history = None;
                }
                Key::RecordMissing
            }
            RecordError::Changed => {
                self.revision_changed = submitting;
                Key::RecordChanged
            }
            RecordError::Capacity => Key::RecordCapacity,
            RecordError::Invalid => Key::RecordInvalid,
            RecordError::Retry if submitting => Key::RecordUnconfirmed,
            RecordError::Retry => Key::RecordLoadError,
        });
    }
}

impl Root {
    fn record_desk(&mut self) -> Option<&mut Desk> {
        match &mut self.overlay {
            Overlay::Directory(desk) => desk.intake.as_mut(),
            _ => None,
        }
    }

    pub(super) fn open_intake_record(&mut self, subject: (String, String), cx: &mut Context<Self>) {
        let Overlay::Directory(desk) = &mut self.overlay else {
            return;
        };
        let (client_id, client_name) = subject;
        desk.intake = Some(Desk {
            client_id,
            client_name,
            history: None,
            before: None,
            page: Page::History,
            chooser: None,
            subject_missing: false,
            revision_changed: false,
            refresh_forms_after_discard: false,
            request: None,
            denied: false,
            pending: None,
            discard: false,
            error: None,
            notice: None,
        });
        self.request_record(Request::History(None), cx);
    }

    pub(super) fn back_record(&mut self, cx: &mut Context<Self>) {
        let Overlay::Directory(directory) = &mut self.overlay else {
            return;
        };
        let Some(desk) = &mut directory.intake else {
            return;
        };
        if desk.request.is_some() {
            return;
        }
        if std::mem::take(&mut desk.discard) {
            desk.refresh_forms_after_discard = false;
            cx.notify();
            return;
        }
        if desk.pending.is_some()
            || matches!(&desk.page, Page::Answer(forms)
            if forms.first().is_some_and(|form| form.dirty(cx)))
        {
            desk.discard = true;
        } else if matches!(desk.page, Page::History) {
            directory.intake = None;
        } else {
            desk.page = Page::History;
            desk.error = None;
            if desk.history.is_none() && !desk.subject_missing {
                self.request_record(Request::History(None), cx);
            }
        }
        cx.notify();
    }

    fn discard_record(&mut self, cx: &mut Context<Self>) {
        let Some(desk) = self.record_desk() else {
            return;
        };
        if !desk.discard || desk.request.is_some() {
            return;
        }
        desk.discard = false;
        if desk.pending.take().is_some() {
            // Until a fresh read succeeds, stale history cannot justify another recording.
            desk.invalidate_history();
        }
        desk.revision_changed = false;
        if std::mem::take(&mut desk.refresh_forms_after_discard)
            && !desk.subject_missing
            && let Some(chooser) = &mut desk.chooser
        {
            chooser.forms = None;
            let services = chooser.services.clone();
            desk.page = Page::Choose;
            self.request_record(Request::Forms(services), cx);
        } else {
            desk.page = Page::History;
            self.request_record(Request::History(None), cx);
        }
    }

    fn review_current_record_forms(&mut self, cx: &mut Context<Self>) {
        let Some(desk) = self.record_desk() else {
            return;
        };
        if desk.revision_changed && !desk.subject_missing && desk.request.is_none() {
            desk.refresh_forms_after_discard = true;
            desk.discard = true;
            cx.notify();
        }
    }

    fn choose_record_form(&mut self, cx: &mut Context<Self>) {
        let label = self.t(Key::FormSearchServices);
        let Some(desk) = self.record_desk() else {
            return;
        };
        if desk.denied || desk.subject_missing || desk.request.is_some() || desk.history.is_none() {
            return;
        }
        if let Some(chooser) = &desk.chooser
            && chooser.catalog.is_some()
            && !chooser.services.is_empty()
        {
            let services = chooser.services.clone();
            desk.page = Page::Choose;
            desk.notice = None;
            self.request_record(Request::Forms(services), cx);
            return;
        }
        let search = cx.new(|cx| TextField::new(label, false, cx));
        cx.observe(&search, |_, _, cx| cx.notify()).detach();
        desk.page = Page::Choose;
        desk.chooser = Some(Chooser {
            search,
            catalog: None,
            services: Vec::new(),
            forms: None,
        });
        desk.notice = None;
        self.request_record(Request::Catalog, cx);
    }

    fn change_record_services(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(desk) = self.record_desk() else {
            return;
        };
        if desk.request.is_some()
            || desk.pending.is_some()
            || desk.subject_missing
            || !matches!(desk.page, Page::Choose)
        {
            return;
        }
        let Some(choices) = &mut desk.chooser else {
            return;
        };
        let Some(catalog) = &choices.catalog else {
            return;
        };
        let Some(next) = catalog
            .get(id)
            .and_then(|entry| catalog.selection_after(&choices.services, entry))
        else {
            return;
        };
        choices.services = next;
        choices.forms = None;
        desk.error = None;
        cx.notify();
    }

    fn answer_record_form(&mut self, revision: &str, cx: &mut Context<Self>) {
        let locale = self.locale;
        let Some(desk) = self.record_desk() else {
            return;
        };
        if !matches!(desk.page, Page::Choose) || desk.subject_missing {
            return;
        }
        let Some(choices) = &desk.chooser else {
            return;
        };
        let Some(form) = choices
            .forms
            .iter()
            .flatten()
            .find(|form| form.id == revision && form.definition.allow_team_responses)
            .cloned()
        else {
            return;
        };
        if desk.request.is_some() {
            return;
        }
        desk.page = Page::Answer(vec![IntakeDraft::new(form, None, locale, cx).standalone()]);
        desk.revision_changed = false;
        desk.error = None;
        cx.notify();
    }

    fn save_record(&mut self, cx: &mut Context<Self>) {
        let Some(desk) = self.record_desk() else {
            return;
        };
        if let Some(packet) = desk.pending.clone().or_else(|| desk.selected_response(cx)) {
            self.request_record(Request::Submit(packet), cx);
        }
    }

    pub(super) fn refresh_private_record(&mut self, cx: &mut Context<Self>) {
        let Some(desk) = self.record_desk() else {
            return;
        };
        if desk.subject_missing {
            return;
        }
        let request = match &desk.page {
            Page::History => Request::History(desk.before.clone()),
            Page::Detail(record) => Request::Detail(record.id.clone()),
            _ => return,
        };
        // Replies from the previous connection cannot reinstall an old private view.
        desk.request = None;
        desk.page = Page::History;
        desk.invalidate_history();
        self.request_record(request, cx);
    }

    fn request_record(&mut self, request: Request, cx: &mut Context<Self>) {
        let transport = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online);
        let session = self.svc.session.clone();
        let Some(desk) = self.record_desk() else {
            return;
        };
        if desk.request.is_some()
            || desk.discard
            || (desk.subject_missing
                && (!matches!(request, Request::Submit(_)) || desk.pending.is_none()))
        {
            cx.notify();
            return;
        }
        if let Some(chooser) = &mut desk.chooser {
            match request {
                Request::Catalog => {
                    chooser.catalog = None;
                    chooser.forms = None;
                }
                Request::Forms(_) => chooser.forms = None,
                _ => (),
            }
        }
        let Some(transport) = transport else {
            desk.error = Some(Key::RecordOffline);
            cx.notify();
            return;
        };
        let client = desk.client_id.clone();
        let identity = Arc::new(());
        desk.request = Some(identity.clone());
        desk.error = None;
        if let Request::Submit(packet) = &request {
            desk.pending = Some(packet.clone());
        }
        let submitting = matches!(request, Request::Submit(_));
        let loading_forms = matches!(request, Request::Forms(_));
        cx.notify();
        cx.spawn(async move |view, cx| {
            let reply = cx
                .background_executor()
                .spawn(async move {
                    match request {
                        Request::History(before) => transport
                            .client_response_history(&client, before.as_deref())
                            .map(|history| Reply::History(before, history)),
                        Request::Detail(id) => transport
                            .client_recorded_response(&client, &id)
                            .map(Box::new)
                            .map(Reply::Detail),
                        Request::Catalog => transport
                            .client_recording_catalog(&client)
                            .map(Reply::Catalog),
                        Request::Forms(services) => transport
                            .client_recording_forms(&client, &services)
                            .map(|requirements| Reply::Forms(requirements.forms)),
                        Request::Submit(packet) => transport
                            .record_client_response(&packet)
                            .map(|()| Reply::Submitted),
                    }
                })
                .await;
            let _ = view.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Some(desk) = root.record_desk() else {
                    return;
                };
                if !desk
                    .request
                    .as_ref()
                    .is_some_and(|pending| Arc::ptr_eq(pending, &identity))
                {
                    return;
                }
                desk.request = None;
                if desk.subject_missing && !submitting {
                    cx.notify();
                    return;
                }
                match reply {
                    Ok(Reply::History(before, history)) => {
                        desk.history = Some(history);
                        desk.before = before;
                        desk.page = Page::History;
                        desk.denied = false;
                    }
                    Ok(Reply::Detail(detail)) => desk.page = Page::Detail(detail),
                    Ok(Reply::Catalog(catalog)) => {
                        if let Some(chooser) = &mut desk.chooser {
                            let previous = std::mem::take(&mut chooser.services);
                            for id in previous {
                                if let Some(next) = catalog.get(&id).and_then(|entry| {
                                    catalog.selection_after(&chooser.services, entry)
                                }) {
                                    chooser.services = next;
                                }
                            }
                            chooser.catalog = Some(catalog);
                        }
                    }
                    Ok(Reply::Forms(forms)) => {
                        if let Some(chooser) = &mut desk.chooser {
                            chooser.forms = Some(forms);
                        }
                    }
                    Ok(Reply::Submitted) => {
                        desk.pending = None;
                        desk.page = Page::History;
                        desk.notice = Some(Key::RecordSaved);
                        desk.invalidate_history();
                        root.request_record(Request::History(None), cx);
                    }
                    Err(error) => {
                        if error != RecordError::Retry {
                            desk.pending = None;
                        }
                        if loading_forms
                            && matches!(error, RecordError::Invalid | RecordError::Missing)
                        {
                            desk.error = Some(Key::RecordInvalidServices);
                        } else {
                            desk.set_error(error, submitting);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Root {
    pub(super) fn render_intake_record(
        &self,
        desk: &Desk,
        viewport: Size<Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let busy = desk.request.is_some();
        let (scroll_id, content) = if busy {
            ("record-loading", div().child(self.t(Key::FormWorking)))
        } else if desk.discard {
            (
                "record-discard",
                div().child(self.t(if desk.pending.is_some() {
                    Key::RecordDiscardPending
                } else {
                    Key::RecordDiscardDraft
                })),
            )
        } else if desk.pending.is_some() {
            ("record-pending", div().child(self.t(Key::RecordRetryHelp)))
        } else {
            match &desk.page {
                Page::History => (
                    "record-history",
                    self.render_response_history(desk, online, cx),
                ),
                Page::Detail(detail) => (
                    "record-detail",
                    if online {
                        self.render_recorded_response(detail)
                    } else {
                        div()
                    },
                ),
                Page::Choose => (
                    "record-choose",
                    desk.chooser.as_ref().map_or_else(div, |choices| {
                        self.render_record_choices(choices, online, cx)
                    }),
                ),
                Page::Answer(forms) => (
                    "record-answer",
                    div().children(forms.iter().map(|form| self.render_intake_form(form, cx))),
                ),
            }
        };
        let body = div()
            .id("record-keyboard")
            .tab_group()
            .flex().flex_col().min_h_0().flex_shrink().gap_3()
            .when(desk.subject_missing, |body| body.child(self.t(Key::RecordSubjectUnavailable)))
            .child(div().text_lg().font_weight(FontWeight::BOLD).child(self.t(Key::RecordHistory)))
            .child(div().text_sm().text_color(theme::muted()).child(desk.client_name.clone()))
            .when_some(desk.error, |body, key| {
                body.child(div().text_sm().text_color(theme::conflict_fg()).child(self.t(key)))
            })
            .when(!online && desk.error != Some(Key::RecordOffline), |body| body.child(self.t(Key::RecordOffline)))
            .when_some(desk.notice, |body, key| body.child(div().text_sm().child(self.t(key))))
            .child(
                div().id(scroll_id).debug_selector(move || scroll_id.to_owned())
                    .min_h_0().flex_shrink().overflow_y_scroll().child(content),
            )
            .when(!busy, |body| body.child(
                div().id("record-footer").debug_selector(|| "record-footer".to_owned())
                    .flex().flex_wrap().flex_shrink_0().gap_2()
                    .child(self.record_button("record-back", if desk.discard { Key::Cancel } else { Key::Back },
                        Kind::Ghost, cx.listener(|root, _, _, cx| root.back_record(cx))))
                    .when(desk.discard, |footer| footer.child(self.record_button(
                        "record-confirm-discard", Key::FormDiscard, Kind::Danger,
                        cx.listener(|root, _, _, cx| root.discard_record(cx)))))
                    .when(!desk.discard && desk.revision_changed && !desk.subject_missing && online, |footer|
                        footer.child(self.record_button(
                            "record-current-forms", Key::RecordCurrentForms, Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.review_current_record_forms(cx)))))
                    .when(!desk.discard && online && (desk.pending.is_some()
                        || (!desk.revision_changed && !desk.subject_missing
                            && matches!(&desk.page, Page::Answer(forms) if forms.first().and_then(|form| form.response(cx)).is_some()))),
                        |footer| footer.child(self.record_button(
                            "record-save", if desk.pending.is_some() { Key::FormRetry } else { Key::RecordSave },
                            Kind::Primary, cx.listener(|root, _, _, cx| root.save_record(cx)))))
            ));
        self.modal_with_height(
            div().child(body),
            (viewport.width - px(28.)).max(px(220.)).min(px(720.)),
            (viewport.height - px(24.)).max(px(150.)),
            Some(cx),
        )
    }

    fn record_button(
        &self,
        id: &'static str,
        key: Key,
        kind: Kind,
        action: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Stateful<gpui::Div> {
        self.button(id, self.t(key), kind, action)
            .tab_index(0)
            .focus(|style| style.border_color(theme::text()))
            .debug_selector(move || id.to_owned())
    }

    fn render_response_history(
        &self,
        desk: &Desk,
        online: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .when(online && !desk.subject_missing, |row| {
                        row.child(self.record_button(
                            "record-reload",
                            Key::FormReload,
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                root.request_record(Request::History(None), cx)
                            }),
                        ))
                    })
                    .when(online && desk.history.is_some() && !desk.denied, |row| {
                        row.child(self.record_button(
                            "record-start",
                            Key::RecordStart,
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.choose_record_form(cx)),
                        ))
                    }),
            )
            .when_some(desk.history.as_ref().filter(|_| online), |body, history| {
                body.when(history.submissions.is_empty(), |body| {
                    body.child(self.t(Key::RecordEmpty))
                })
                .children(
                    history
                        .submissions
                        .iter()
                        .enumerate()
                        .map(|(index, entry)| {
                            let id = entry.id.clone();
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap_2()
                                .border_1()
                                .border_color(theme::line())
                                .rounded_md()
                                .p_2()
                                .child(
                                    div()
                                        .min_w_0()
                                        .flex()
                                        .flex_col()
                                        .child(
                                            div()
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .child(entry.form_title.clone()),
                                        )
                                        .child(div().text_sm().text_color(theme::muted()).child(
                                            self.record_caption(
                                                entry.number,
                                                entry.created_at,
                                                entry.source,
                                            ),
                                        )),
                                )
                                .child(
                                    self.button(
                                        ("record-response", index),
                                        self.t(Key::RecordOpen),
                                        Kind::Ghost,
                                        cx.listener(move |root, _, _, cx| {
                                            root.request_record(Request::Detail(id.clone()), cx);
                                        }),
                                    )
                                    .tab_index(0)
                                    .focus(|style| style.border_color(theme::text())),
                                )
                        }),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .when(desk.before.is_some(), |row| {
                            row.child(self.record_button(
                                "record-first",
                                Key::RecordFirst,
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| {
                                    root.request_record(Request::History(None), cx);
                                }),
                            ))
                        })
                        .when_some(history.next_cursor.clone(), |row, next| {
                            row.child(self.record_button(
                                "record-more",
                                Key::RecordMore,
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    root.request_record(Request::History(Some(next.clone())), cx);
                                }),
                            ))
                        }),
                )
            })
    }

    fn record_caption(
        &self,
        revision: u32,
        created_at: DateTime<Utc>,
        source: ResponseSource,
    ) -> String {
        format!(
            "{} {} · {} · {}",
            self.t(Key::RecordRevision),
            revision,
            self.date_time_label(created_at),
            self.t(match source {
                ResponseSource::Client => Key::RecordByClient,
                ResponseSource::Team => Key::RecordByTeam,
            })
        )
    }

    fn render_recorded_response(&self, record: &RecordedResponse) -> gpui::Div {
        let revision = &record.revision;
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .font_weight(FontWeight::BOLD)
                    .child(revision.definition.title.clone()),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.record_caption(revision.number, record.created_at, record.source)),
            )
            .child(self.t(Key::RecordImmutable))
            .when(!revision.definition.description.is_empty(), |body| {
                body.child(revision.definition.description.clone())
            })
            .children(revision.definition.fields.iter().map(|question| {
                let answer = record.answers.get(&question.id);
                let answer = match (answer, &question.kind) {
                    (Some(Answer::Text(id)), QuestionKind::SingleChoice { options }) => options
                        .iter()
                        .find(|choice| choice.id == *id)
                        .map(|choice| choice.label.clone()),
                    (Some(Answer::Choices(ids)), QuestionKind::MultipleChoice { options }) => Some(
                        options
                            .iter()
                            .filter(|choice| ids.contains(&choice.id))
                            .map(|choice| choice.label.as_str())
                            .collect::<Vec<_>>()
                            .join("\n"),
                    ),
                    (Some(Answer::Boolean(value)), _) => Some(
                        self.t(if *value {
                            Key::IntakeYes
                        } else {
                            Key::IntakeNo
                        })
                        .to_owned(),
                    ),
                    (Some(Answer::Text(text)), _) => Some(text.clone()),
                    (Some(Answer::Number(number)), _) => {
                        let text = number.to_string();
                        Some(if self.locale == Locale::EsAr {
                            text.replace('.', ",")
                        } else {
                            text
                        })
                    }
                    _ => None,
                }
                .filter(|answer| !answer.is_empty())
                .unwrap_or_else(|| self.t(Key::RecordNoAnswer).to_owned());
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .p_2()
                    .border_1()
                    .border_color(theme::line())
                    .rounded_md()
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(question.label.clone()),
                    )
                    .when(!question.help.is_empty(), |row| {
                        row.child(
                            div()
                                .text_sm()
                                .text_color(theme::muted())
                                .child(question.help.clone()),
                        )
                    })
                    .child(answer)
            }))
    }

    fn render_record_choices(
        &self,
        chooser: &Chooser,
        online: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let Some(catalog) = &chooser.catalog else {
            return div().when(online, |body| {
                body.child(self.record_button(
                    "record-retry-catalog",
                    Key::FormReload,
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.request_record(Request::Catalog, cx)),
                ))
            });
        };
        let query = chooser.search.read(cx).text().trim().to_lowercase();
        let candidates = catalog.services.iter().filter(|service| {
            !chooser.services.contains(&service.id)
                && (service.name.to_lowercase().contains(&query) || service.id.contains(&query))
                && catalog
                    .selection_after(&chooser.services, service)
                    .is_some()
        });
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.t(Key::RecordChooseServices))
            .child(
                div()
                    .text_sm()
                    .child(format!("{}/{MAX_RECORD_SERVICES}", chooser.services.len())),
            )
            .child(
                div().flex().flex_wrap().gap_2().children(
                    chooser
                        .services
                        .iter()
                        .enumerate()
                        .filter_map(|(index, id)| {
                            Some(self.record_service_choice(
                                ("record-selected-service", index),
                                catalog.get(id)?,
                                true,
                                cx,
                            ))
                        }),
                ),
            )
            .child(chooser.search.clone())
            .when(online, |body| {
                body.child(self.record_button(
                    "record-reload-catalog",
                    Key::RecordReloadCatalog,
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.request_record(Request::Catalog, cx)),
                ))
            })
            .child(
                div()
                    .id("record-services")
                    .max_h(px(158.))
                    .overflow_y_scroll()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .children(candidates.enumerate().map(|(index, service)| {
                                self.record_service_choice(
                                    ("record-service", index),
                                    service,
                                    false,
                                    cx,
                                )
                            })),
                    ),
            )
            .when(online && !chooser.services.is_empty(), |body| {
                let services = chooser.services.clone();
                body.child(self.record_button(
                    "record-load-forms",
                    Key::RecordLoadForms,
                    Kind::Primary,
                    cx.listener(move |root, _, _, cx| {
                        root.request_record(Request::Forms(services.clone()), cx)
                    }),
                ))
            })
            .when_some(chooser.forms.as_ref(), |body, forms| {
                body.when(forms.is_empty(), |body| {
                    body.child(self.t(Key::RecordNoForms))
                })
                .children(forms.iter().enumerate().map(|(index, form)| {
                    let revision = form.id.clone();
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap_2()
                        .p_2()
                        .border_1()
                        .border_color(theme::line())
                        .rounded_md()
                        .child(form.definition.title.clone())
                        .when(form.definition.allow_team_responses && online, |row| {
                            row.child(
                                self.button(
                                    ("record-choose-form", index),
                                    self.t(Key::RecordOpen),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        root.answer_record_form(&revision, cx)
                                    }),
                                )
                                .tab_index(0)
                                .focus(|style| style.border_color(theme::text())),
                            )
                        })
                        .when(!form.definition.allow_team_responses, |row| {
                            row.child(div().text_sm().child(self.t(Key::IntakeCustomerOnly)))
                        })
                }))
            })
    }

    fn record_service_choice(
        &self,
        element: impl Into<ElementId>,
        service: &sob_core::intake::RecordingService,
        selected: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        let id = service.id.clone();
        let label = i18n::fill(
            self.t(Key::RecordServiceOption),
            &[
                ("name", &service.name),
                ("minutes", &service.duration_minutes.to_string()),
                ("id", id.rsplit('-').next().unwrap_or(&id)),
            ],
        );
        self.button(
            element,
            label,
            if selected { Kind::Primary } else { Kind::Ghost },
            cx.listener(move |root, _, _, cx| root.change_record_services(&id, cx)),
        )
        .tab_index(0)
        .focus(|style| style.border_color(theme::text()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use serde_json::json;

    #[gpui::test]
    async fn desktop_edits_and_confirms_a_private_response_without_an_offline_mutation(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(535.), px(445.)));
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            root.svc.store.set_meta("client_directory", "allowed").unwrap();
            root.open_directory(cx);
            root.open_intake_record(("01a1d81e-0000-7000-8000-0000000000c1".into(), "Lucia".into()), cx);
            root.status.connectivity = Connectivity::Online;
            let desk = root.record_desk().unwrap();
            desk.history = Some(ResponseHistory { submissions: Vec::new(), next_cursor: None });
            desk.request = None;
            desk.error = None;
            root.choose_record_form(cx);
            let desk = root.record_desk().unwrap();
            desk.request = None;
            let chooser = desk.chooser.as_mut().unwrap();
            chooser.forms = Some(vec![serde_json::from_value(json!({
                "id": "fixture-revision",
                "definition": {
                    "title": "Synthetic safety question",
                    "description": "Wording shown to the customer",
                    "requiredAtBooking": false,
                    "allowTeamResponses": true,
                    "fields": [{ "id":"yes-no", "label":"Does this apply?", "help":"", "required":true, "kind":"boolean" }],
                }
            })).unwrap()]);
            root.answer_record_form("fixture-revision", cx);
        });
        cx.run_until_parked();
        let body = cx.debug_bounds("record-answer").unwrap();
        let footer = cx.debug_bounds("record-footer").unwrap();
        assert!(body.bottom() <= footer.top() && footer.bottom() < px(445.));
        let no = cx
            .debug_bounds("intake-fixture-revision-yes-no-false")
            .unwrap();
        cx.simulate_click(no.center(), Default::default());
        cx.run_until_parked();
        let confirm = cx.debug_bounds("intake-confirm-fixture-revision").unwrap();
        cx.simulate_click(confirm.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            let desk = root.record_desk().unwrap();
            let packet = serde_json::to_value(desk.selected_response(cx).unwrap()).unwrap();
            assert_eq!(packet["answers"]["yes-no"], false);
            assert_eq!(packet["confirmation"], true);
            root.status.connectivity = Connectivity::Offline;
            root.save_record(cx);
            assert_eq!(root.record_desk().unwrap().error, Some(Key::RecordOffline));
            assert!(root.svc.store.outbox(20).unwrap().is_empty());
            root.back_record(cx);
            assert!(root.record_desk().unwrap().discard);
            root.back_record(cx);
            let desk = root.record_desk().unwrap();
            assert!(!desk.discard);
            let packet = desk.selected_response(cx).unwrap();
            let identity = serde_json::to_value(&packet).unwrap();
            desk.pending = Some(packet);
            desk.before = Some("stale-history-cursor".into());
            desk.subject_visibility(&[]);
            assert!(desk.subject_missing && desk.history.is_none());
            assert!(desk.selected_response(cx).is_none());
            assert_eq!(
                serde_json::to_value(desk.pending.as_ref().unwrap()).unwrap(),
                identity
            );
            root.back_record(cx);
            root.discard_record(cx);
            let desk = root.record_desk().unwrap();
            assert!(desk.history.is_none() && desk.pending.is_none() && desk.before.is_none());
        });
    }

    #[gpui::test]
    async fn tab_and_enter_can_return_from_the_private_history(cx: &mut TestAppContext) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.svc
                .store
                .set_meta("client_directory", "allowed")
                .unwrap();
            root.status.connectivity = Connectivity::Offline;
            root.open_directory(cx);
            root.open_intake_record(
                (
                    "01a1d81e-0000-7000-8000-0000000000c1".into(),
                    "Lucia".into(),
                ),
                cx,
            );
        });
        cx.run_until_parked();
        cx.simulate_keystrokes("tab");
        cx.simulate_event(gpui::KeyUpEvent {
            keystroke: gpui::Keystroke::parse("enter").unwrap(),
        });
        root.update(cx, |root, _| assert!(root.record_desk().is_none()));
    }
}
