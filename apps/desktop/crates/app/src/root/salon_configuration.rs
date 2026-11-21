use super::*;
use sob_core::http::{
    ReviewedSalonConfiguration, SALON_SLOT_STEPS, SalonConfiguration, SalonConfigurationDraft,
    SalonConfigurationWrite, SalonWriteResult,
};
use sob_core::sync::TransportError;

const LABELS: [Key; 6] = [
    Key::SalonName,
    Key::SalonTimezone,
    Key::SalonMinNotice,
    Key::SalonMaxDays,
    Key::SalonFirstReminder,
    Key::SalonSecondReminder,
];

pub(super) struct Desk {
    instance: Arc<()>,
    editor: Option<Editor>,
    busy: bool,
    pending: Option<SalonConfigurationWrite>,
    conflict: bool,
    confirm_close: bool,
    observed: Option<DateTime<Utc>>,
    message: Option<Key>,
    read_failed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn leaving_a_native_settings_draft_requires_confirmation(cx: &mut TestAppContext) {
        let (_directory, window) = super::super::tests::open(cx);
        window.update(cx, |root, _, cx| {
            let saved: ReviewedSalonConfiguration = serde_json::from_value(serde_json::json!({
                "name": "Test Salon", "timezone": "Europe/Madrid", "slotGranularityMinutes": 15,
                "minNoticeMinutes": 30, "maxDaysAhead": 60, "onlineBookingEnabled": true,
                "reminderFirstLeadMinutes": 1440, "reminderSecondLeadMinutes": 120,
                "revision": "2026-11-21T00:00:00Z"
            })).unwrap();
            let mut editor = Editor::new(saved, None, LABELS.map(|key| root.t(key)), cx);
            assert!(!editor.dirty(cx));
            editor.online = false;
            root.overlay = Overlay::SalonConfiguration(Box::new(Desk {
                instance: Arc::new(()), editor: Some(editor), busy: false, pending: None,
                conflict: false, confirm_close: false, observed: None, message: None, read_failed: false,
            }));
            root.dismiss_overlay(cx);
            assert!(matches!(&root.overlay, Overlay::SalonConfiguration(desk) if desk.confirm_close));
            root.dismiss_overlay(cx);
            assert!(matches!(&root.overlay, Overlay::SalonConfiguration(desk)
                if !desk.confirm_close && desk.editor.as_ref().is_some_and(|editor| !editor.online)));
        }).unwrap();
    }
}

struct Editor {
    saved: ReviewedSalonConfiguration,
    inputs: [Entity<TextField>; 6],
    online: bool,
    step: u32,
}

impl Editor {
    fn new(
        saved: ReviewedSalonConfiguration,
        draft: Option<SalonConfiguration>,
        labels: [&'static str; 6],
        cx: &mut Context<Root>,
    ) -> Self {
        let input = draft.as_ref().unwrap_or(&saved.settings);
        let optional = |value: Option<u32>| value.map(|n| n.to_string()).unwrap_or_default();
        let values = [
            input.name.clone(),
            input.timezone.clone(),
            input.min_notice_minutes.to_string(),
            input.max_days_ahead.to_string(),
            optional(input.reminder_first_lead_minutes),
            optional(input.reminder_second_lead_minutes),
        ];
        let inputs = std::array::from_fn(|i| {
            let field = cx.new(|cx| {
                let mut field = TextField::new(labels[i], false, cx);
                field.set_text(&values[i], cx);
                field
            });
            cx.observe(&field, |_, _, cx| cx.notify()).detach();
            field
        });
        Self {
            online: input.online_booking_enabled,
            step: input.slot_granularity_minutes,
            saved,
            inputs,
        }
    }

    fn draft(&self, cx: &App) -> Option<SalonConfiguration> {
        let [name, zone, notice, horizon, first, second] = self
            .inputs
            .each_ref()
            .map(|input| input.read(cx).text().trim());
        SalonConfigurationDraft {
            name,
            timezone: zone,
            slot_step: self.step,
            notice,
            horizon,
            online_booking: self.online,
            first_reminder: first,
            second_reminder: second,
        }
        .validated()
    }

    fn dirty(&self, cx: &App) -> bool {
        self.draft(cx).as_ref() != Some(&self.saved.settings)
    }
}

impl Root {
    pub(super) fn can_configure_salon(&self) -> bool {
        self.svc
            .current_session()
            .is_some_and(|session| session.role == "owner")
    }

    pub(super) fn open_salon_configuration(&mut self, cx: &mut Context<Self>) {
        if !self.can_configure_salon() {
            return;
        }
        self.overlay = Overlay::SalonConfiguration(Box::new(Desk {
            instance: Arc::new(()),
            editor: None,
            busy: false,
            pending: None,
            conflict: false,
            confirm_close: false,
            observed: None,
            message: None,
            read_failed: false,
        }));
        self.request_salon_configuration(None, cx);
    }

    pub(super) fn refresh_salon_configuration(
        &mut self,
        reconnected: bool,
        cx: &mut Context<Self>,
    ) {
        let Overlay::SalonConfiguration(desk) = &self.overlay else {
            return;
        };
        if desk.busy
            || desk.pending.is_some()
            || desk.conflict
            || desk.confirm_close
            || desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx))
        {
            return;
        }
        let observed = self
            .svc
            .store
            .salon_settings()
            .ok()
            .flatten()
            .map(|s| s.updated_at);
        if reconnected || observed != desk.observed {
            self.request_salon_configuration(None, cx);
        }
    }

    fn request_salon_configuration(
        &mut self,
        write: Option<SalonConfigurationWrite>,
        cx: &mut Context<Self>,
    ) {
        let Overlay::SalonConfiguration(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy {
            return;
        }
        if self.status.connectivity != Connectivity::Online {
            desk.message = Some(Key::SalonNeedsConnection);
            cx.notify();
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        desk.busy = true;
        desk.observed = self
            .svc
            .store
            .salon_settings()
            .ok()
            .flatten()
            .map(|s| s.updated_at);
        let instance = desk.instance.clone();
        let session = self.svc.session.clone();
        let retry = write.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match write {
                        Some(write) => transport.write_salon_configuration(&write),
                        None => transport.salon_configuration().map(SalonWriteResult::Saved),
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let labels = LABELS.map(|key| root.t(key));
                let Overlay::SalonConfiguration(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&desk.instance, &instance) {
                    return;
                }
                desk.busy = false;
                match result {
                    Ok(SalonWriteResult::Saved(saved)) => {
                        let reviewed = if retry.is_none()
                            && (desk.conflict || desk.pending.is_some())
                        {
                            desk.editor
                                .as_ref()
                                .and_then(|editor| {
                                    SalonConfigurationWrite::new(&editor.saved, &editor.draft(cx)?)
                                })
                                .and_then(|write| write.review_against(&saved.settings))
                        } else {
                            None
                        };
                        desk.message = if retry.is_some() {
                            Some(Key::SalonSaved)
                        } else {
                            reviewed
                                .as_ref()
                                .filter(|draft| **draft != saved.settings)
                                .map(|_| Key::SalonReviewLatest)
                        };
                        desk.editor = Some(Editor::new(saved, reviewed, labels, cx));
                        desk.pending = None;
                        desk.conflict = false;
                        desk.read_failed = false;
                        if retry.is_some() {
                            root.svc.wake(Wake::Manual);
                        }
                    }
                    Ok(SalonWriteResult::Conflict) => {
                        desk.conflict = true;
                        desk.pending = None;
                        desk.message = Some(Key::SalonConflict);
                    }
                    Err(error) => {
                        desk.read_failed = retry.is_none();
                        if matches!(
                            error,
                            TransportError::Offline(_)
                                | TransportError::Server(_)
                                | TransportError::RateLimited(_)
                        ) {
                            desk.pending = retry;
                        }
                        desk.message = Some(match error {
                            TransportError::BadRequest(_) => Key::SalonInvalid,
                            _ if desk.pending.is_some() => Key::SalonUnconfirmed,
                            _ => Key::SalonLoadFailed,
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn save_salon_configuration(&mut self, cx: &mut Context<Self>) {
        let Overlay::SalonConfiguration(desk) = &mut self.overlay else {
            return;
        };
        if desk.conflict || desk.busy || desk.confirm_close {
            return;
        }
        if let Some(pending) = desk.pending.clone() {
            self.request_salon_configuration(Some(pending), cx);
            return;
        }
        let Some(editor) = &desk.editor else { return };
        let Some(draft) = editor.draft(cx) else {
            desk.message = Some(Key::SalonInvalid);
            cx.notify();
            return;
        };
        if let Some(write) = SalonConfigurationWrite::new(&editor.saved, &draft) {
            self.request_salon_configuration(Some(write), cx);
        }
    }

    pub(super) fn close_salon_configuration(&mut self, cx: &mut Context<Self>) {
        let Overlay::SalonConfiguration(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy {
            return;
        }
        if desk.confirm_close {
            desk.confirm_close = false;
        } else if desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx))
            || desk.pending.is_some()
        {
            desk.confirm_close = true;
        } else {
            self.overlay = Overlay::None;
        }
        cx.notify();
    }

    pub(super) fn render_salon_configuration(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::BOLD)
                    .child(self.t(Key::SalonConfiguration)),
            )
            .when_some(desk.message, |body, message| {
                body.child(div().text_sm().child(self.t(message)))
            })
            .when(
                !online && desk.message != Some(Key::SalonNeedsConnection),
                |body| body.child(self.t(Key::SalonNeedsConnection)),
            )
            .when(desk.busy, |body| {
                body.child(self.t(Key::CloudWorkspacesLoading))
            })
            .when(desk.confirm_close, |body| {
                body.child(self.t(Key::SalonConfirmDiscard)).child(
                    div()
                        .flex()
                        .gap_2()
                        .child(self.button(
                            "salon-discard",
                            self.t(Key::SalonDiscard),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| {
                                root.overlay = Overlay::None;
                                cx.notify();
                            }),
                        ))
                        .child(self.button(
                            "salon-keep",
                            self.t(Key::Cancel),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.close_salon_configuration(cx)),
                        )),
                )
            })
            .when(!desk.busy && !desk.confirm_close, |body| {
                let locked = desk.pending.is_some() || desk.conflict;
                let mut actions = div().flex().flex_wrap().gap_2();
                if let Some(editor) = &desk.editor
                    && !locked
                {
                    actions = actions.when(online && editor.dirty(cx), |actions| {
                        actions.child(self.button(
                            "salon-save",
                            self.t(Key::SalonSave),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.save_salon_configuration(cx)),
                        ))
                    });
                }
                if online && (desk.editor.is_none() || locked || desk.read_failed) {
                    actions = actions.child(self.button(
                        "salon-refresh",
                        self.t(if locked {
                            Key::SalonReloadReview
                        } else {
                            Key::FormReload
                        }),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.request_salon_configuration(None, cx)),
                    ));
                    if desk.pending.is_some() {
                        actions = actions.child(self.button(
                            "salon-retry",
                            self.t(Key::ShiftRetrySave),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.save_salon_configuration(cx)),
                        ));
                    }
                }
                body.when_some(desk.editor.as_ref().filter(|_| !locked), |body, editor| {
                    body.child(self.render_salon_editor(editor, cx))
                })
                .child(actions.child(self.button(
                    "salon-close",
                    self.t(Key::Close),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                )))
            });
        self.modal_with_height(
            body,
            (viewport.width - px(32.)).max(px(220.)).min(px(610.)),
            (viewport.height - px(28.)).max(px(140.)),
            Some(cx),
        )
    }

    fn render_salon_editor(&self, editor: &Editor, cx: &mut Context<Self>) -> impl IntoElement {
        let minutes = self.t(Key::SalonMinutes);
        div()
            .id("salon-options-scroll")
            .flex()
            .flex_col()
            .gap_2()
            .min_h(px(0.))
            .flex_shrink()
            .overflow_y_scroll()
            .children(LABELS.iter().zip(&editor.inputs).map(|(label, input)| {
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().text_sm().child(self.t(*label)))
                    .child(input.clone())
            }))
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::SalonReminderHelp)),
            )
            .child(div().text_sm().child(self.t(Key::SalonStep)))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(SALON_SLOT_STEPS.map(|step| {
                        self.button(
                            ("salon-step", step as usize),
                            SharedString::from(format!("{step} {minutes}")),
                            if editor.step == step {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |root, _, _, cx| {
                                if let Overlay::SalonConfiguration(desk) = &mut root.overlay
                                    && let Some(editor) = &mut desk.editor
                                {
                                    editor.step = step;
                                    cx.notify();
                                }
                            }),
                        )
                    })),
            )
            .child(div().text_sm().child(self.t(Key::SalonBooking)))
            .child(self.button(
                "salon-online",
                self.t(if editor.online {
                    Key::SalonBookingOn
                } else {
                    Key::SalonBookingOff
                }),
                if editor.online {
                    Kind::Primary
                } else {
                    Kind::Ghost
                },
                cx.listener(|root, _, _, cx| {
                    if let Overlay::SalonConfiguration(desk) = &mut root.overlay
                        && let Some(editor) = &mut desk.editor
                    {
                        editor.online = !editor.online;
                        cx.notify();
                    }
                }),
            ))
    }
}
