use super::*;
use sob_core::http::marketing::{Audience, Draft, DraftRevision, DraftWrite};

const CHANNELS: [Channel; 3] = [Channel::Email, Channel::Sms, Channel::Optimized];
const TRIGGERS: [Trigger; 4] = [
    Trigger::Manual,
    Trigger::FirstVisit,
    Trigger::Inactive,
    Trigger::Birthday,
];

pub(super) struct Editor {
    generation: String,
    id: String,
    version: Option<u32>,
    name: Entity<TextField>,
    channel: Channel,
    trigger: Trigger,
    subject: Entity<TextField>,
    email: Vec<Entity<TextField>>,
    sms: Vec<Entity<TextField>>,
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

    fn lines(self, editor: &mut Editor) -> &mut Vec<Entity<TextField>> {
        match self {
            Self::Email => &mut editor.email,
            Self::Sms => &mut editor.sms,
        }
    }

    fn line(self, value: &str, cx: &mut Context<Root>) -> Entity<TextField> {
        let field = cx.new(|cx| {
            let mut field = TextField::new("", false, cx).with_line_paste(self.limit());
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
            let lines = self.lines(editor);
            let Some(index) = lines.iter().position(|line| *line == origin) else {
                return;
            };
            match event {
                FieldEvent::PasteLines(tail) => {
                    lines.splice(
                        index + 1..index + 1,
                        tail.iter().map(|line| self.line(line, cx)),
                    );
                }
                FieldEvent::PasteTooLong => desk.error = Some(Key::MarketingDraftInvalid),
                _ => return,
            }
            cx.notify();
        })
        .detach();
        field
    }
}

fn text(field: &Entity<TextField>, cx: &App) -> String {
    field.read(cx).text().trim().to_owned()
}

fn message_text(lines: &[Entity<TextField>], cx: &App) -> String {
    lines
        .iter()
        .map(|line| line.read(cx).text())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

fn optional_days(value: &str) -> Option<Option<u32>> {
    if value.is_empty() {
        return Some(None);
    }
    let days = value.parse().ok()?;
    (1..=3650).contains(&days).then_some(Some(days))
}

impl Editor {
    fn new(campaign: Option<&Campaign>, generation: String, cx: &mut Context<Root>) -> Self {
        let days = campaign
            .and_then(|c| c.audience.inactive_days)
            .map(|days| days.to_string())
            .unwrap_or_default();
        let tags = campaign
            .map(|c| c.audience.tags.join(", "))
            .unwrap_or_default();
        Self {
            generation,
            id: campaign
                .map(|c| c.id.clone())
                .unwrap_or_else(|| uuid::Uuid::now_v7().to_string()),
            version: campaign.map(|c| c.version),
            name: input(campaign.map_or("", |c| &c.name), cx),
            channel: campaign.map_or(Channel::Email, |c| c.channel),
            trigger: campaign.map_or(Trigger::Manual, |c| c.trigger),
            subject: input(campaign.map_or("", |c| &c.subject), cx),
            email: campaign
                .map_or("", |c| &c.email_body)
                .split('\n')
                .map(|value| Message::Email.line(value, cx))
                .collect(),
            sms: campaign
                .map_or("", |c| &c.sms_body)
                .split('\n')
                .map(|value| Message::Sms.line(value, cx))
                .collect(),
            tags: input(&tags, cx),
            inactive_days: input(&days, cx),
            delay: input(&campaign.map_or(0, |c| c.delay_minutes).to_string(), cx),
            birthday: input(
                &campaign.map_or(0, |c| c.birthday_lead_days).to_string(),
                cx,
            ),
            no_future: campaign.is_some_and(|c| c.audience.no_future_appointments),
            pending: None,
            stale: false,
        }
    }

    pub(super) fn unlock(&mut self) {
        self.pending = None;
    }

    pub(super) fn mark_stale(&mut self) {
        self.unlock();
        self.stale = true;
    }

    fn packet(&self, cx: &App) -> Option<DraftWrite> {
        let name = text(&self.name, cx);
        let subject = text(&self.subject, cx);
        let email_body = message_text(&self.email, cx);
        let sms_body = message_text(&self.sms, cx);
        let delay_minutes = text(&self.delay, cx).parse().ok()?;
        let birthday_lead_days = text(&self.birthday, cx).parse().ok()?;
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
            || delay_minutes > 525600
            || birthday_lead_days > 30
            || tags.len() > 20
            || tags
                .iter()
                .any(|tag| tag.encode_utf16().count() > 40 || tag.contains(';'))
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

impl Root {
    pub(super) fn open_campaign_editor(&mut self, edit: bool, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let Some(desk) = self.marketing_desk().filter(|desk| !desk.busy) else {
            return;
        };
        let campaign = desk.detail.as_ref().map(|(c, _)| c);
        let Some(generation) = generation.filter(|g| !edit || desk.generation.as_ref() == Some(g))
        else {
            desk.error = Some(Key::BookingIntakeRestore);
            cx.notify();
            return;
        };
        if edit && !campaign.is_some_and(|c| c.status == Status::Draft) {
            return;
        }
        desk.editor = Some(Editor::new(campaign.filter(|_| edit), generation, cx));
        desk.error = None;
        desk.review = None;
        desk.confirm_exit = false;
        // A background list/detail read may still be in flight.
        desk.request = None;
        desk.refreshing = false;
        cx.notify();
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
        let request = if let Some((campaign, deliveries)) = &desk.detail {
            Request::Detail(campaign.id.clone(), deliveries.pagination.page)
        } else if let Some(id) = pending_id {
            Request::Detail(id, 1)
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
                                    let lines = message.lines(editor);
                                    if lines.len() > 1 {
                                        lines.retain(|line| *line != remove);
                                        cx.notify();
                                    }
                                }
                            },
                            cx,
                        ))
                    })
            }))
            .child(self.marketing_button(
                SharedString::from(format!("add-{name}-line")),
                Key::MarketingAddLine,
                Kind::Ghost,
                move |root, cx| {
                    if let Some(editor) =
                        root.marketing_desk().and_then(|desk| desk.editor.as_mut())
                    {
                        let lines = message.lines(editor);
                        if lines.len() <= message.limit() {
                            lines.push(message.line("", cx));
                            cx.notify();
                        }
                    }
                },
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
        let email = editor.channel != Channel::Sms;
        let sms = editor.channel != Channel::Email;
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
                    .child(self.edit_message(Message::Email, &editor.email, cx))
            })
            .when(sms, |body| {
                body.child(self.edit_message(Message::Sms, &editor.sms, cx))
            })
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
                .tab_index(0),
            )
            .when(ready && !editor.stale, |body| body.child(save))
    }
}
