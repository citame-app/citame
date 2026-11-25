use super::*;
use sob_core::http::marketing::{Audience, Draft, DraftRevision, DraftWrite, EmailLayout};
use std::{cell::Cell, rc::Rc};

mod email_layout;
mod invitation;
use email_layout::LayoutEditor;
pub(super) use email_layout::saved_header_preview;
use invitation::InvitationEditor;

const MAX_EDITABLE_LINES: usize = EmailLayout::PARAGRAPH_LINE_LIMIT;

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
    Invite,
    Edit,
    Duplicate,
}

pub(super) struct Editor {
    preview: bool,
    from_template: bool,
    generation: String,
    id: String,
    version: Option<u32>,
    name: Entity<TextField>,
    channel: Channel,
    trigger: Trigger,
    subject: Entity<TextField>,
    email: MessageInput,
    email_layout: Option<LayoutEditor>,
    had_email_layout: bool,
    sms: MessageInput,
    tags: Entity<TextField>,
    inactive_days: Entity<TextField>,
    delay: Entity<TextField>,
    birthday: Entity<TextField>,
    no_future: bool,
    invitation: Option<InvitationEditor>,
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
    Paragraph(usize),
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
            Self::Paragraph(_) => Key::MarketingEmailParagraph,
        }
    }

    fn limit(self) -> usize {
        match self {
            Self::Email | Self::Paragraph(_) => EmailLayout::BODY_LIMIT,
            Self::Sms => 304,
        }
    }

    fn input(self, editor: &mut Editor) -> Option<&mut MessageInput> {
        match self {
            Self::Email => Some(&mut editor.email),
            Self::Sms => Some(&mut editor.sms),
            Self::Paragraph(id) => editor.email_layout.as_mut()?.paragraph_mut(id),
        }
    }

    fn element_name(self) -> String {
        match self {
            Self::Email => "email".to_owned(),
            Self::Sms => "sms".to_owned(),
            Self::Paragraph(id) => format!("email-paragraph-{id}"),
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
            let Some(input) = self.input(editor) else {
                return;
            };
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
        from_template: bool,
        invitation: Option<InvitationEditor>,
        cx: &mut Context<Root>,
    ) -> Self {
        let email_layout = draft
            .email_layout
            .flatten()
            .map(|layout| LayoutEditor::new(*layout, cx));
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
            had_email_layout: email_layout.is_some(),
            email_layout,
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
            invitation,
            pending: None,
            stale: false,
            preview: false,
            from_template,
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
        if self
            .email_layout
            .as_ref()
            .is_some_and(LayoutEditor::selecting_image)
        {
            return None;
        }
        let selected_client_ids = match &self.invitation {
            Some(invitation) => Some(invitation.packet()?),
            None => None,
        };
        let name = text(&self.name, cx);
        let subject = text(&self.subject, cx);
        let layout = self.email_layout.as_ref().map(|layout| layout.packet(cx));
        let formatted_body = layout.as_ref().and_then(EmailLayout::validated_plain_text);
        if self.channel != Channel::Sms && layout.is_some() && formatted_body.is_none() {
            return None;
        }
        let email_body = formatted_body.unwrap_or_else(|| message_text(&self.email.lines, cx));
        let email_layout = if self.channel == Channel::Sms {
            None
        } else {
            layout
        };
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
                email_layout: (self.had_email_layout || email_layout.is_some())
                    .then_some(email_layout.map(Box::new)),
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
                    selected_client_ids,
                },
            },
        })
    }
}

fn template_name(trigger: Trigger) -> Key {
    match trigger {
        Trigger::Manual => Key::MarketingCustomDraft,
        Trigger::FirstVisit => Key::MarketingFirstVisitDraft,
        Trigger::Inactive => Key::MarketingInactiveDraft,
        Trigger::Birthday => Key::MarketingBirthdayDraft,
    }
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
            EditorMode::Invite => {
                let mut draft = Draft::from_template(
                    Trigger::Manual,
                    self.t(Key::MarketingInvite),
                    self.t(Key::MarketingInvitationSubject),
                    self.t(Key::MarketingInvitationBody),
                );
                draft.audience.selected_client_ids = Some(Vec::new());
                Some(draft)
            }
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
        let from_template = draft_template.is_some();
        let (draft, source) = if let Some(draft) = draft_template {
            (draft, None)
        } else {
            let Some(campaign) = campaign.filter(|c| !edit || c.status == Status::Draft) else {
                return;
            };
            if edit {
                (Draft::from(campaign), Some(campaign))
            } else {
                (Draft::duplicate(campaign, copy), None)
            }
        };
        let selected = draft.audience.selected_client_ids.clone().map(|ids| {
            (
                ids,
                campaign
                    .map(|value| value.selected_contacts.clone())
                    .unwrap_or_default(),
            )
        });
        let source = source.cloned();
        let invitation =
            selected.map(|(ids, contacts)| InvitationEditor::new(self, ids, contacts, cx));
        let Some(desk) = self.marketing_desk() else {
            return;
        };
        desk.editor = Some(Editor::new(
            draft,
            source.as_ref(),
            generation,
            from_template,
            invitation,
            cx,
        ));
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
        let (subject, body) = match trigger {
            Trigger::Manual => (Key::MarketingCustomSubject, Key::MarketingCustomBody),
            Trigger::FirstVisit => (Key::MarketingFirstSubject, Key::MarketingFirstBody),
            Trigger::Inactive => (Key::MarketingInactiveSubject, Key::MarketingInactiveBody),
            Trigger::Birthday => (Key::MarketingBirthdaySubject, Key::MarketingBirthdayBody),
        };
        Draft::from_template(
            trigger,
            self.t(template_name(trigger)),
            self.t(subject),
            self.t(body),
        )
    }

    pub(super) fn campaign_templates(
        &self,
        ready: bool,
        replacing: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.label(Key::MarketingTemplate))
            .when(replacing, |body| {
                body.child(self.t(Key::MarketingTemplateReplace))
            })
            .when(ready, |body| {
                body.children(TRIGGERS.into_iter().enumerate().map(|(index, trigger)| {
                    self.marketing_button(
                        ("campaign-template", index),
                        template_name(trigger),
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
        if editor.invitation.is_some()
            && editor.pending.is_none()
            && ((editor.channel != Channel::Sms
                && !editor.email_layout.as_ref().map_or_else(
                    || message_text(&editor.email.lines, cx).contains("{{booking_url}}"),
                    |layout| layout.packet(cx).has_booking_link(),
                ))
                || (editor.channel != Channel::Email
                    && !message_text(&editor.sms.lines, cx).contains("{{booking_url}}")))
        {
            desk.error = Some(Key::MarketingInvitationLinkRequired);
            cx.notify();
            return;
        }
        let Some(write) = editor.pending.clone().or_else(|| editor.packet(cx)) else {
            desk.error = Some(
                if editor
                    .invitation
                    .as_ref()
                    .is_some_and(|invitation| invitation.packet().is_none())
                {
                    Key::MarketingInvitationRequired
                } else {
                    Key::MarketingDraftInvalid
                },
            );
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
        let name = message.element_name();
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
                                    && let Some(input) = message.input(editor)
                                    && input.lines.len() > 1
                                {
                                    input.lines.retain(|line| *line != remove);
                                    input.update_budget();
                                    cx.notify();
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
                            && let Some(input) = message.input(editor)
                            && input.lines.len() < MAX_EDITABLE_LINES
                        {
                            input
                                .lines
                                .push(message.line("", &input.remaining_lines, cx));
                            input.update_budget();
                            cx.notify();
                        }
                    },
                    cx,
                ))
            })
    }

    fn open_campaign_preview(&mut self, cx: &mut Context<Self>) {
        if let Some(editor) = self.marketing_desk().and_then(|desk| desk.editor.as_mut()) {
            editor.preview = true;
            cx.notify();
        }
    }

    fn campaign_message_preview(&self, editor: &Editor, cx: &App) -> gpui::Div {
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
                    .child(if let Some(layout) = &editor.email_layout {
                        self.render_email_layout_preview(&layout.packet(cx), layout.image_preview())
                    } else {
                        div().child(preview_message(&message_text(&editor.email.lines, cx)))
                    })
            })
            .when(editor.channel != Channel::Email, |body| {
                body.child(self.label(Key::MarketingSms))
                    .child(preview_message(&message_text(&editor.sms.lines, cx)))
            })
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
        body.when(
            ready && editor.from_template && !editor.stale && editor.invitation.is_none(),
            |body| {
                body.child(self.marketing_button(
                    "change-campaign-template",
                    Key::MarketingChangeTemplate,
                    Kind::Ghost,
                    |root, cx| {
                        if let Some(desk) = root.marketing_desk() {
                            desk.choose_template = true;
                            cx.notify();
                        }
                    },
                    cx,
                ))
            },
        )
        .child(self.label(Key::MarketingCampaignName))
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
        .when(editor.invitation.is_none(), |body| {
            body.child(self.label(Key::MarketingTrigger)).child(
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
        })
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
                .child(self.render_email_editor(editor, cx))
        })
        .when(
            editor.channel == Channel::Sms && editor.email_layout.is_some(),
            |body| {
                body.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::MarketingSmsLayoutRemoval)),
                )
            },
        )
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
            Root::open_campaign_preview,
            cx,
        ))
        .when_some(editor.invitation.as_ref(), |body, invitation| {
            body.child(self.render_invitation_contacts(invitation, cx))
        })
        .when(editor.invitation.is_none(), |body| {
            body.child(self.label(Key::MarketingTags))
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
        })
        .when(ready && !editor.stale, |body| body.child(save))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[gpui::test]
    async fn formatted_campaign_drafts_keep_the_native_packet_and_clear_layout_for_sms(
        cx: &mut gpui::TestAppContext,
    ) {
        use sob_core::http::marketing::{EmailBlock, EmailEmphasis};
        let (_directory, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| {
            let mut root = Root::new(config, window, cx);
            root.svc.stop_sync();
            root
        });
        root.update(cx, |_, cx| {
            let layout = EmailLayout {
                header_image: None,
                heading: "Hello {{first_name}}".into(),
                preheader: "Appointment times are available".into(),
                blocks: vec![
                    EmailBlock::Booking {
                        label: "Book now".into(),
                    },
                    EmailBlock::Paragraph {
                        text: "First line\nSecond line".into(),
                        emphasis: EmailEmphasis::Italic,
                    },
                ],
            };
            let mut draft =
                Draft::from_template(Trigger::Manual, "News", "Updates", "Plain fallback");
            draft.email_layout = Some(Some(Box::new(layout.clone())));
            let mut editor = Editor::new(draft, None, "generation".into(), false, None, cx);
            let formatted = editor.packet(cx).unwrap().draft;
            assert_eq!(formatted.email_body, layout.plain_text());
            assert_eq!(formatted.email_layout, Some(Some(Box::new(layout.clone()))));
            let paragraph = Message::Paragraph(1).input(&mut editor).unwrap();
            assert_eq!(
                message_text(&paragraph.lines, cx),
                "First line\nSecond line"
            );
            editor.channel = Channel::Sms;
            let sms = editor.packet(cx).unwrap().draft;
            assert_eq!(sms.email_layout, Some(None));
            assert_eq!(sms.email_body, layout.plain_text());
            editor.channel = Channel::Email;
            assert_eq!(
                editor.packet(cx).unwrap().draft.email_layout,
                Some(Some(Box::new(layout)))
            );
        });
    }

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
            desk.choose_template = true;
            root.dismiss_marketing(cx);
            let desk = root.marketing_desk().unwrap();
            assert!(!desk.choose_template);
            assert_eq!(desk.editor.as_ref().unwrap().trigger, Trigger::Inactive);
            root.open_campaign_editor(EditorMode::Create(Trigger::FirstVisit), cx);
            let desk = root.marketing_desk().unwrap();
            let editor = desk.editor.as_ref().unwrap();
            let template = editor.packet(cx).unwrap().draft;
            assert_eq!(template.delay_minutes, 120);
            assert!(!template.audience.no_future_appointments);
            editor.subject.update(cx, |field, cx| field.set_text("Local edit", cx));

            root.open_campaign_preview(cx);
            root.dismiss_marketing(cx);
            let desk = root.marketing_desk().unwrap();
            assert!(!desk.confirm_exit);
            assert!(!desk.editor.as_ref().unwrap().preview);
            assert_eq!(desk.editor.as_ref().unwrap().subject.read(cx).text(), "Local edit");

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
                "deliveries": [{
                    "id": uuid::Uuid::now_v7(), "clientName":"Synthetic recipient",
                    "channel":"email", "status":"sent", "createdAt":"2026-11-17T09:00:00Z",
                    "sentAt":"2026-11-17T09:00:00Z"
                }],
                "pagination": {"page":1,"pageSize":20,"total":1}
            })).unwrap();
            let desk = root.marketing_desk().unwrap();
            desk.editor = None;
            desk.install_detail(campaign, deliveries, Some(generation), cx);
            root.open_campaign_editor(EditorMode::Duplicate, cx);
            let desk = root.marketing_desk().unwrap();
            let packet = desk.editor.as_ref().unwrap().packet(cx).unwrap();
            let DraftRevision::Create { id: new_id } = packet.revision else { panic!("Expected new draft"); };
            assert_ne!(new_id, id);
            assert_eq!(packet.draft.channel, Channel::Optimized);
            assert_eq!(packet.draft.birthday_lead_days, 7);
            assert_eq!(packet.draft.email_body, "First\n\nSecond");
            assert_eq!(packet.draft.audience.tags, vec!["vip"]);
            assert_eq!(desk.detail.as_ref().unwrap().0.version, 5);
            let mut saved = desk.detail.as_ref().unwrap().0.clone();
            saved.id = new_id.clone();
            saved.status = Status::Draft;
            saved.version = 1;
            desk.install_write_result(saved, desk.generation.clone(), cx);
            let (selected, history) = desk.detail.as_ref().unwrap();
            assert_eq!(selected.id, new_id);
            assert!(history.deliveries.is_empty());
            assert!(root.svc.store.outbox(5).unwrap().is_empty());
            root.open_campaign_editor(EditorMode::Invite, cx);
            let editor = root.marketing_desk().unwrap().editor.as_mut().unwrap();
            assert!(editor.packet(cx).is_none());
            let contact = uuid::Uuid::now_v7().to_string();
            editor.invitation.as_mut().unwrap().toggle(&contact);
            let draft = editor.packet(cx).unwrap().draft;
            assert_eq!(draft.trigger, Trigger::Manual);
            assert_eq!(draft.audience.selected_client_ids, Some(vec![contact]));
            assert!(draft.email_body.contains("{{booking_url}}"));
        });
    }

    #[test]
    fn preview_replaces_only_the_supported_variables() {
        assert_eq!(
            preview_message("Hi {{first_name}} from {{salon_name}}\n{{booking_url}} {{unknown}}"),
            "Hi Ana from Citame\nhttps://citame.example/book {{unknown}}"
        );
    }
}
