use super::*;
use sob_core::http::marketing::{Audience, Draft, DraftRevision, DraftWrite};
use std::{cell::Cell, rc::Rc};

const MAX_EDITABLE_LINES: usize = 256;

const CHANNELS: [Channel; 3] = [Channel::Email, Channel::Sms, Channel::Optimized];
const TRIGGERS: [Trigger; 4] = [
    Trigger::Manual,
    Trigger::FirstVisit,
    Trigger::Inactive,
    Trigger::Birthday,
];

#[derive(Clone, Copy)]
pub(super) enum EditorMode {
    Create(Trigger),
    Edit,
    Duplicate,
}

pub(super) struct Editor {
    preview: bool,
    generation: String,
    id: String,
    version: Option<u32>,
    name: Entity<TextField>,
    channel: Channel,
    trigger: Trigger,
    subject: Entity<TextField>,
    email: MessageInput,
    sms: MessageInput,
    tags: Entity<TextField>,
    inactive_days: Entity<TextField>,
    delay: Entity<TextField>,
    birthday: Entity<TextField>,
    no_future: bool,
    pending: Option<DraftWrite>,
    stale: bool,
}

fn input(value: &str, cx: &mut Context<Root>) -> Entity<TextField> {
    cx.new(|cx| {
        let mut field = TextField::new("", false, cx);
        field.set_text(value, cx);
        field
    })
}

#[derive(Clone, Copy)]
enum Message {
    Email,
    Sms,
}

struct MessageInput {
    lines: Vec<Entity<TextField>>,
    remaining_lines: Rc<Cell<usize>>,
}

impl MessageInput {
    fn new(message: Message, value: &str, cx: &mut Context<Root>) -> Self {
        let remaining_lines = Rc::new(Cell::new(0));
        let lines = value
            .split('\n')
            .map(|line| message.line(line, &remaining_lines, cx))
            .collect();
        let input = Self {
            lines,
            remaining_lines,
        };
        input.update_budget();
        input
    }

    fn update_budget(&self) {
        self.remaining_lines
            .set(MAX_EDITABLE_LINES.saturating_sub(self.lines.len()));
    }
}

impl Message {
    fn label(self) -> Key {
        match self {
            Self::Email => Key::MarketingEmailBody,
            Self::Sms => Key::MarketingSmsBody,
        }
    }

    fn limit(self) -> usize {
        match self {
            Self::Email => 10_000,
            Self::Sms => 304,
        }
    }

    fn input(self, editor: &mut Editor) -> &mut MessageInput {
        match self {
            Self::Email => &mut editor.email,
            Self::Sms => &mut editor.sms,
        }
    }

    fn line(
        self,
        value: &str,
        budget: &Rc<Cell<usize>>,
        cx: &mut Context<Root>,
    ) -> Entity<TextField> {
        let field = cx.new(|cx| {
            let mut field =
                TextField::new("", false, cx).with_bounded_line_paste(self.limit(), budget.clone());
            field.set_text(value, cx);
            field
        });
        cx.subscribe(&field, move |root, origin, event, cx| {
            let Some(desk) = root.marketing_desk() else {
                return;
            };
            let Some(editor) = &mut desk.editor else {
                return;
            };
            let input = self.input(editor);
            let Some(index) = input.lines.iter().position(|line| *line == origin) else {
                return;
            };
            match event {
                FieldEvent::PasteLines(tail) => {
                    input.lines.splice(
                        index + 1..index + 1,
                        tail.iter()
                            .map(|line| self.line(line, &input.remaining_lines, cx)),
                    );
                    input.update_budget();
                }
                FieldEvent::PasteTooLong => desk.error = Some(Key::MarketingPasteLimit),
                _ => return,
            }
            cx.notify();
        })
        .detach();
        field
    }
}

fn text(field: &Entity<TextField>, cx: &App) -> String {
    trim_text(field.read(cx).text()).to_owned()
}

fn trim_text(text: &str) -> &str {
    // Match the draft contract's ECMAScript String.trim.
    text.trim_matches(|c: char| c == '\u{feff}' || (c != '\u{0085}' && c.is_whitespace()))
}

fn message_text(lines: &[Entity<TextField>], cx: &App) -> String {
    let text = lines
        .iter()
        .map(|line| line.read(cx).text())
        .collect::<Vec<_>>()
        .join("\n");
    trim_text(&text).to_owned()
}

fn optional_days(value: &str) -> Option<Option<u32>> {
    if value.is_empty() {
        return Some(None);
    }
    let days = value.parse().ok()?;
    (1..=3650).contains(&days).then_some(Some(days))
}

fn timing(value: &str, max: u32, relevant: bool) -> Option<u32> {
    value
        .parse()
        .ok()
        .filter(|n| *n <= max)
        .or_else(|| (!relevant).then_some(0))
}

impl Editor {
    fn new(
        draft: Draft,
        source: Option<&Campaign>,
        generation: String,
        cx: &mut Context<Root>,
    ) -> Self {
        Self {
            generation,
            id: source
                .map(|campaign| campaign.id.clone())
                .unwrap_or_else(|| uuid::Uuid::now_v7().to_string()),
            version: source.map(|campaign| campaign.version),
            name: input(&draft.name, cx),
            channel: draft.channel,
            trigger: draft.trigger,
            subject: input(&draft.subject, cx),
            email: MessageInput::new(Message::Email, &draft.email_body, cx),
            sms: MessageInput::new(Message::Sms, &draft.sms_body, cx),
            tags: input(&draft.audience.tags.join(", "), cx),
            inactive_days: input(
                &draft
                    .audience
                    .inactive_days
                    .map(|days| days.to_string())
                    .unwrap_or_default(),
                cx,
            ),
            delay: input(&draft.delay_minutes.to_string(), cx),
            birthday: input(&draft.birthday_lead_days.to_string(), cx),
            no_future: draft.audience.no_future_appointments,
            pending: None,
            stale: false,
            preview: false,
        }
    }

    pub(super) fn unlock(&mut self) {
        self.pending = None;
    }

    pub(super) fn mark_stale(&mut self) {
        self.unlock();
        self.stale = true;
    }

    pub(super) fn in_preview(&self) -> bool {
        self.preview
    }

    pub(super) fn close_preview(&mut self) -> bool {
        std::mem::take(&mut self.preview)
    }

    fn packet(&self, cx: &App) -> Option<DraftWrite> {
        let name = text(&self.name, cx);
        let subject = text(&self.subject, cx);
        let email_body = message_text(&self.email.lines, cx);
        let sms_body = message_text(&self.sms.lines, cx);
        let delay_minutes = timing(
            &text(&self.delay, cx),
            525600,
            self.trigger == Trigger::FirstVisit,
        )?;
        let birthday_lead_days = timing(
            &text(&self.birthday, cx),
            30,
            self.trigger == Trigger::Birthday,
        )?;
        let tags: Vec<_> = text(&self.tags, cx)
            .split(',')
            .map(str::trim)
            .filter(|tag| !tag.is_empty())
            .map(str::to_owned)
            .collect();
        if name.is_empty()
            || name.encode_utf16().count() > 160
            || subject.encode_utf16().count() > 200
            || subject.contains(['\r', '\n'])
            || email_body.encode_utf16().count() > Message::Email.limit()
            || sms_body.encode_utf16().count() > Message::Sms.limit()
        {
            return None;
        }
        Some(DraftWrite {
            generation: self.generation.clone(),
            revision: self.version.map_or_else(
                || DraftRevision::Create {
                    id: self.id.clone(),
                },
                |version| DraftRevision::Edit {
                    id: self.id.clone(),
                    version,
                },
            ),
            draft: Draft {
                name,
                channel: self.channel,
                trigger: self.trigger,
                subject,
                email_body,
                sms_body,
                delay_minutes,
                birthday_lead_days,
                audience: Audience {
                    tags,
                    no_future_appointments: self.no_future,
                    inactive_days: optional_days(&text(&self.inactive_days, cx))?,
                },
            },
        })
    }
}

fn duplicate_name(name: &str, copy: &str) -> String {
    let suffix = format!(" · {copy}");
    let mut remaining = 160usize.saturating_sub(suffix.encode_utf16().count());
    let mut name: String = name
        .chars()
        .take_while(|c| {
            let Some(next) = remaining.checked_sub(c.len_utf16()) else {
                return false;
            };
            remaining = next;
            true
        })
        .collect();
    name.push_str(&suffix);
    name
}

fn preview_message(value: &str) -> String {
    value
        .replace("{{first_name}}", "Ana")
        .replace("{{salon_name}}", "Citame")
        .replace("{{booking_url}}", "https://citame.example/book")
}

impl Root {
    pub(super) fn open_campaign_editor(&mut self, mode: EditorMode, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let draft_template = match mode {
            EditorMode::Create(trigger) => Some(self.campaign_template(trigger)),
            _ => None,
        };
        let copy = self.t(Key::MarketingCopy);
        let Some(desk) = self
            .marketing_desk()
            .filter(|desk| !desk.busy && desk.action.is_none())
        else {
            return;
        };
        let campaign = desk.detail.as_ref().map(|(c, _)| c);
        let edit = matches!(mode, EditorMode::Edit);
        let Some(generation) =
            generation.filter(|g| draft_template.is_some() || desk.generation.as_ref() == Some(g))
        else {
            desk.error = Some(Key::BookingIntakeRestore);
            cx.notify();
            return;
        };
        let (draft, source) = if let Some(draft) = draft_template {
            (draft, None)
        } else {
            let Some(campaign) = campaign.filter(|c| !edit || c.status == Status::Draft) else {
                return;
            };
            let mut draft = Draft::from(campaign);
            if !edit {
                draft.name = duplicate_name(&draft.name, copy);
            }
            (draft, edit.then_some(campaign))
        };
        desk.editor = Some(Editor::new(draft, source, generation, cx));
        desk.choose_template = false;
        desk.error = None;
        desk.review = None;
        desk.confirm_exit = false;
        // A background list/detail read may still be in flight.
        desk.request = None;
        desk.refreshing = false;
        cx.notify();
    }

    fn campaign_template(&self, trigger: Trigger) -> Draft {
        let (name, subject, body) = match trigger {
            Trigger::Manual => (
                Key::MarketingCustomDraft,
                Key::MarketingCustomSubject,
                Key::MarketingCustomBody,
            ),
            Trigger::FirstVisit => (
                Key::MarketingFirstVisit,
                Key::MarketingFirstSubject,
                Key::MarketingFirstBody,
            ),
            Trigger::Inactive => (
                Key::MarketingInactive,
                Key::MarketingInactiveSubject,
                Key::MarketingInactiveBody,
            ),
            Trigger::Birthday => (
                Key::MarketingBirthday,
                Key::MarketingBirthdaySubject,
                Key::MarketingBirthdayBody,
            ),
        };
        let inactive = trigger == Trigger::Inactive;
        Draft {
            name: self.t(name).into(),
            channel: Channel::Email,
            trigger,
            subject: self.t(subject).into(),
            email_body: self.t(body).into(),
            sms_body: self.t(body).into(),
            delay_minutes: if trigger == Trigger::FirstVisit {
                120
            } else {
                0
            },
            birthday_lead_days: 0,
            audience: Audience {
                tags: Vec::new(),
                inactive_days: inactive.then_some(60),
                no_future_appointments: inactive,
            },
        }
    }

    pub(super) fn campaign_templates(&self, ready: bool, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.label(Key::MarketingTemplate))
            .when(ready, |body| {
                body.children(TRIGGERS.into_iter().enumerate().map(|(index, trigger)| {
                    let label = if trigger == Trigger::Manual {
                        Key::MarketingCustomDraft
                    } else {
                        trigger_key(trigger)
                    };
                    self.marketing_button(
                        ("campaign-template", index),
                        label,
                        Kind::Ghost,
                        move |root, cx| root.open_campaign_editor(EditorMode::Create(trigger), cx),
                        cx,
                    )
                }))
            })
    }

    pub(super) fn leave_campaign_editor(&mut self, cx: &mut Context<Self>) {
        let Some(desk) = self.marketing_desk().filter(|desk| !desk.busy) else {
            return;
        };
        if !desk.confirm_exit {
            desk.confirm_exit = true;
            cx.notify();
            return;
        }
        let pending_id = desk.editor.as_ref().and_then(|editor| {
            (desk.uncertain && editor.version.is_none()).then(|| editor.id.clone())
        });
        desk.editor = None;
        desk.uncertain = false;
        desk.confirm_exit = false;
        desk.error = None;
        let request = if let Some(id) = pending_id {
            Request::Detail(id, 1)
        } else if let Some((campaign, deliveries)) = &desk.detail {
            Request::Detail(campaign.id.clone(), deliveries.pagination.page)
        } else {
            Request::List(desk.list.as_ref().map_or(1, |list| list.pagination.page))
        };
        self.request_marketing(request, cx);
        cx.notify();
    }

    fn save_campaign_editor(&mut self, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let Some(desk) = self
            .marketing_desk()
            .filter(|desk| !desk.busy && !desk.confirm_exit)
        else {
            return;
        };
        let Some(editor) = desk.editor.as_mut().filter(|editor| !editor.stale) else {
            return;
        };
        if generation.as_ref() != Some(&editor.generation) {
            editor.mark_stale();
            desk.error = Some(Key::BookingIntakeRestore);
            cx.notify();
            return;
        }
        let Some(write) = editor.pending.clone().or_else(|| editor.packet(cx)) else {
            desk.error = Some(Key::MarketingDraftInvalid);
            cx.notify();
            return;
        };
        editor.pending = Some(write.clone());
        self.request_marketing(Request::SaveDraft(write), cx);
    }

    fn edit_message(
        &self,
        message: Message,
        lines: &[Entity<TextField>],
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let name = match message {
            Message::Email => "email",
            Message::Sms => "sms",
        };
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(self.label(message.label()))
            .children(lines.iter().enumerate().map(|(index, line)| {
                let line = line.clone();
                let remove = line.clone();
                div()
                    .flex()
                    .gap_2()
                    .child(div().flex_1().min_w_0().child(line))
                    .when(lines.len() > 1, |row| {
                        row.child(self.marketing_button(
                            SharedString::from(format!("remove-{name}-line-{index}")),
                            Key::RemoveNoteLine,
                            Kind::Ghost,
                            move |root, cx| {
                                if let Some(editor) =
                                    root.marketing_desk().and_then(|desk| desk.editor.as_mut())
                                {
                                    let input = message.input(editor);
                                    if input.lines.len() > 1 {
                                        input.lines.retain(|line| *line != remove);
                                        input.update_budget();
                                        cx.notify();
                                    }
                                }
                            },
                            cx,
                        ))
                    })
            }))
            .when(lines.len() < MAX_EDITABLE_LINES, |body| {
                body.child(self.marketing_button(
                    SharedString::from(format!("add-{name}-line")),
                    Key::MarketingAddLine,
                    Kind::Ghost,
                    move |root, cx| {
                        if let Some(editor) =
                            root.marketing_desk().and_then(|desk| desk.editor.as_mut())
                        {
                            let input = message.input(editor);
                            if input.lines.len() < MAX_EDITABLE_LINES {
                                input
                                    .lines
                                    .push(message.line("", &input.remaining_lines, cx));
                                input.update_budget();
                                cx.notify();
                            }
                        }
                    },
                    cx,
                ))
            })
    }

    fn toggle_campaign_preview(&mut self, cx: &mut Context<Self>) {
        if let Some(editor) = self.marketing_desk().and_then(|desk| desk.editor.as_mut()) {
            editor.preview = !editor.preview;
            cx.notify();
        }
    }

    fn campaign_message_preview(&self, editor: &Editor, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.label(Key::MarketingPreviewExample))
            .when(editor.channel != Channel::Sms, |body| {
                body.child(self.label(Key::Email))
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(preview_message(&text(&editor.subject, cx))),
                    )
                    .child(preview_message(&message_text(&editor.email.lines, cx)))
            })
            .when(editor.channel != Channel::Email, |body| {
                body.child(self.label(Key::MarketingSms))
                    .child(preview_message(&message_text(&editor.sms.lines, cx)))
            })
            .child(self.marketing_button(
                "close-marketing-preview",
                Key::Back,
                Kind::Ghost,
                Root::toggle_campaign_preview,
                cx,
            ))
    }

    pub(super) fn render_campaign_editor(
        &self,
        desk: &Desk,
        editor: &Editor,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let heading = if editor.version.is_some() {
            Key::MarketingEditDraft
        } else {
            Key::MarketingCreateDraft
        };
        let body = div().flex().flex_col().gap_2().child(self.label(heading));
        if desk.confirm_exit {
            return body
                .child(self.t(if desk.uncertain {
                    Key::MarketingExitCheck
                } else {
                    Key::MarketingDiscardWarning
                }))
                .child(self.marketing_button(
                    "continue-editing-marketing-draft",
                    Key::Back,
                    Kind::Ghost,
                    |root, cx| {
                        if let Some(desk) = root.marketing_desk() {
                            desk.confirm_exit = false;
                            cx.notify();
                        }
                    },
                    cx,
                ));
        }
        if editor.preview {
            return body.child(self.campaign_message_preview(editor, cx));
        }
        let save = self.marketing_button(
            "save-campaign-draft",
            if desk.uncertain {
                Key::MarketingRetry
            } else {
                Key::MarketingSaveDraft
            },
            Kind::Primary,
            Root::save_campaign_editor,
            cx,
        );
        if editor.pending.is_some() {
            return body.when(ready, |body| body.child(save));
        }
        let subject = editor.subject.read(cx).text();
        let email = editor.channel != Channel::Sms
            || subject.encode_utf16().count() > 200
            || subject.contains(['\r', '\n'])
            || message_text(&editor.email.lines, cx).encode_utf16().count()
                > Message::Email.limit();
        let sms = editor.channel != Channel::Email
            || message_text(&editor.sms.lines, cx).encode_utf16().count() > Message::Sms.limit();
        body.child(self.label(Key::MarketingCampaignName))
            .child(editor.name.clone())
            .child(self.label(Key::MarketingChannel))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(CHANNELS.into_iter().enumerate().map(|(index, channel)| {
                        self.chip(
                            ("campaign-channel", index),
                            self.t(channel_key(channel)),
                            editor.channel == channel,
                            cx.listener(move |root, _, _, cx| {
                                if let Some(editor) =
                                    root.marketing_desk().and_then(|desk| desk.editor.as_mut())
                                {
                                    editor.channel = channel;
                                    cx.notify();
                                }
                            }),
                        )
                        .tab_index(0)
                        .focus(|style| style.border_color(theme::text()))
                    })),
            )
            .child(self.label(Key::MarketingTrigger))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(TRIGGERS.into_iter().enumerate().map(|(index, trigger)| {
                        self.chip(
                            ("campaign-trigger", index),
                            self.t(trigger_key(trigger)),
                            editor.trigger == trigger,
                            cx.listener(move |root, _, _, cx| {
                                if let Some(editor) =
                                    root.marketing_desk().and_then(|desk| desk.editor.as_mut())
                                {
                                    editor.trigger = trigger;
                                    if trigger == Trigger::Inactive
                                        && editor.inactive_days.read(cx).text().trim().is_empty()
                                    {
                                        editor
                                            .inactive_days
                                            .update(cx, |field, cx| field.set_text("60", cx));
                                    }
                                    cx.notify();
                                }
                            }),
                        )
                        .tab_index(0)
                        .focus(|style| style.border_color(theme::text()))
                    })),
            )
            .when(editor.trigger == Trigger::FirstVisit, |body| {
                body.child(self.label(Key::MarketingDelayField))
                    .child(editor.delay.clone())
            })
            .when(editor.trigger == Trigger::Birthday, |body| {
                body.child(self.label(Key::MarketingBirthdayField))
                    .child(editor.birthday.clone())
            })
            .when(email, |body| {
                body.child(self.label(Key::MarketingSubject))
                    .child(editor.subject.clone())
                    .child(self.edit_message(Message::Email, &editor.email.lines, cx))
            })
            .when(sms, |body| {
                body.child(self.edit_message(Message::Sms, &editor.sms.lines, cx))
            })
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::MarketingVariables)),
            )
            .child(self.marketing_button(
                "preview-marketing-message",
                Key::MarketingMessagePreview,
                Kind::Ghost,
                Root::toggle_campaign_preview,
                cx,
            ))
            .child(self.label(Key::MarketingTags))
            .child(editor.tags.clone())
            .child(self.label(Key::MarketingInactiveDaysField))
            .child(editor.inactive_days.clone())
            .child(
                self.chip(
                    "campaign-no-future",
                    self.t(Key::MarketingNoFuture),
                    editor.no_future,
                    cx.listener(|root, _, _, cx| {
                        if let Some(editor) =
                            root.marketing_desk().and_then(|desk| desk.editor.as_mut())
                        {
                            editor.no_future = !editor.no_future;
                            cx.notify();
                        }
                    }),
                )
                .tab_index(0)
                .focus(|style| style.border_color(theme::text())),
            )
            .when(ready && !editor.stale, |body| body.child(save))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[gpui::test]
    async fn marketing_templates_and_duplicates_open_local_drafts(cx: &mut gpui::TestAppContext) {
        let (_directory, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| {
            let mut root = Root::new(config, window, cx);
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Offline;
            root.open_marketing(cx);
            root
        });
        root.update(cx, |root, cx| {
            root.status.connectivity = Connectivity::Online;
            root.open_campaign_editor(EditorMode::Create(Trigger::Inactive), cx);
            let desk = root.marketing_desk().unwrap();
            let editor = desk.editor.as_ref().unwrap();
            assert!(matches!(editor.packet(cx).unwrap().revision, DraftRevision::Create { .. }));
            assert_eq!(editor.trigger, Trigger::Inactive);
            assert_eq!(editor.inactive_days.read(cx).text(), "60");
            assert!(editor.no_future);
            root.toggle_campaign_preview(cx);
            root.dismiss_marketing(cx);
            let desk = root.marketing_desk().unwrap();
            assert!(!desk.confirm_exit);
            assert!(!desk.editor.as_ref().unwrap().preview);

            let generation = root.svc.store.verified_reviewed_generation().unwrap();
            let id = uuid::Uuid::now_v7().to_string();
            let campaign = serde_json::from_value(json!({
                "id": id, "name": "Treatment news", "channel": "optimized", "trigger": "birthday",
                "status": "active", "version": 5, "subject":"Subject", "emailBody": "First\n\nSecond",
                "smsBody":"Hello {{first_name}}", "delayMinutes":0, "birthdayLeadDays":7,
                "scheduledFor":null, "audience":{"tags":["vip"],"inactiveDays":null,"noFutureAppointments":true},
                "counts":{"pending":0,"processing":0,"sent":2,"skipped":0,"failed":0,"unknown":0,"cancelled":0},
            })).unwrap();
            let deliveries = serde_json::from_value(json!({
                "deliveries": [], "pagination": {"page":1,"pageSize":20,"total":0}
            })).unwrap();
            let desk = root.marketing_desk().unwrap();
            desk.editor = None;
            desk.install_detail(campaign, deliveries, Some(generation), cx);
            root.open_campaign_editor(EditorMode::Duplicate, cx);
            let desk = root.marketing_desk().unwrap();
            let packet = desk.editor.as_ref().unwrap().packet(cx).unwrap();
            assert!(matches!(packet.revision, DraftRevision::Create { id: new_id } if new_id != id));
            assert_eq!(packet.draft.channel, Channel::Optimized);
            assert_eq!(packet.draft.birthday_lead_days, 7);
            assert_eq!(packet.draft.email_body, "First\n\nSecond");
            assert_eq!(packet.draft.audience.tags, vec!["vip"]);
            assert_eq!(desk.detail.as_ref().unwrap().0.version, 5);
            assert!(root.svc.store.outbox(5).unwrap().is_empty());
        });
    }

    #[test]
    fn preview_and_copy_keep_templates_and_unicode_intact() {
        assert_eq!(
            preview_message("Hi {{first_name}} from {{salon_name}}\n{{booking_url}} {{unknown}}"),
            "Hi Ana from Citame\nhttps://citame.example/book {{unknown}}"
        );
        let name = duplicate_name(&"🎂".repeat(80), "Copia");
        assert!(name.ends_with(" · Copia"));
        assert!(name.encode_utf16().count() <= 160);
    }
}
