use super::*;
use sob_core::http::{
    ReviewedSalonConfiguration, SALON_SLOT_STEPS, SalonConfiguration, SalonConfigurationDraft,
};
use sob_core::store::SalonConfigurationWork;

mod business_profile;
mod numbering;
mod profile_media;
use business_profile::BusinessEditor;

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
    work: SalonConfigurationWork,
    reviewing_conflict: Option<String>,
    confirm_close: bool,
    observed: Option<DateTime<Utc>>,
    message: Option<Key>,
    read_failed: bool,
    review_after_restore: bool,
    media: profile_media::MediaDesk,
    numbering: numbering::NumberingDesk,
}

impl Desk {
    fn editable(&self) -> bool {
        match &self.work {
            SalonConfigurationWork::Idle => true,
            SalonConfigurationWork::Pending(_) => false,
            SalonConfigurationWork::Conflict { id, .. } => {
                self.reviewing_conflict.as_ref() == Some(id)
            }
        }
    }
}

struct Editor {
    saved: ReviewedSalonConfiguration,
    inputs: [Entity<TextField>; 6],
    online: bool,
    step: u32,
    profile: Option<BusinessEditor>,
    show_profile: bool,
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
        let profile = input
            .business_profile
            .as_ref()
            .map(|profile| BusinessEditor::new(profile, cx));
        Self {
            online: input.online_booking_enabled,
            step: input.slot_granularity_minutes,
            saved,
            inputs,
            profile,
            show_profile: false,
        }
    }

    fn draft(&self, cx: &App) -> Option<SalonConfiguration> {
        let [name, zone, notice, horizon, first, second] = self
            .inputs
            .each_ref()
            .map(|input| input.read(cx).text().trim());
        let mut draft = SalonConfigurationDraft {
            name,
            timezone: zone,
            slot_step: self.step,
            notice,
            horizon,
            online_booking: self.online,
            first_reminder: first,
            second_reminder: second,
        }
        .validated()?;
        if let Some(profile) = &self.profile {
            draft.business_profile = Some(profile.draft(cx).ok()?);
        }
        Some(draft)
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
        let store = &self.svc.store;
        let editor = store
            .cached_salon_configuration()
            .ok()
            .flatten()
            .map(|saved| Editor::new(saved, None, LABELS.map(|key| self.t(key)), cx));
        let work = store.salon_configuration_work();
        let message = work.is_err().then_some(Key::SalonLocalFailure);
        self.overlay = Overlay::SalonConfiguration(Box::new(Desk {
            instance: Arc::new(()),
            editor,
            busy: false,
            work: work.unwrap_or(SalonConfigurationWork::Pending(None)),
            reviewing_conflict: None,
            confirm_close: false,
            observed: None,
            message,
            read_failed: false,
            review_after_restore: false,
            media: profile_media::MediaDesk::default(),
            numbering: numbering::NumberingDesk::default(),
        }));
        self.request_salon_configuration(false, cx);
    }

    pub(super) fn preserve_open_salon_draft(&mut self, cx: &App) -> bool {
        let Overlay::SalonConfiguration(desk) = &mut self.overlay else {
            return false;
        };
        let keep = desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx))
            || desk.reviewing_conflict.is_some()
            || desk.media.dirty()
            || desk.numbering.dirty();
        if keep {
            desk.instance = Arc::new(());
            desk.busy = false;
            desk.media.reset_request();
            desk.numbering.reset_request();
            desk.review_after_restore = true;
            desk.message = Some(Key::SalonRestoreReview);
        }
        keep
    }

    pub(super) fn refresh_salon_configuration(
        &mut self,
        reconnected: bool,
        cx: &mut Context<Self>,
    ) {
        let Overlay::SalonConfiguration(desk) = &mut self.overlay else {
            return;
        };
        let Ok(work) = self.svc.store.salon_configuration_work() else {
            return;
        };
        let finished = matches!(desk.work, SalonConfigurationWork::Pending(_))
            && work == SalonConfigurationWork::Idle;
        if work != desk.work {
            desk.work = work;
            desk.reviewing_conflict = None;
            if finished {
                desk.editor = None;
                desk.message = Some(Key::SalonSaved);
            } else if matches!(desk.work, SalonConfigurationWork::Conflict { .. }) {
                desk.message = Some(Key::SalonConflict);
            }
            cx.notify();
        }
        let observed = self
            .svc
            .store
            .salon_settings()
            .ok()
            .flatten()
            .map(|s| s.updated_at);
        if self.status.connectivity == Connectivity::Online
            && !desk.busy
            && !desk.review_after_restore
            && desk.work == SalonConfigurationWork::Idle
            && !desk.confirm_close
            && !desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx))
            && (finished || reconnected || observed != desk.observed)
        {
            self.request_salon_configuration(false, cx);
        }
        self.refresh_profile_images(observed, reconnected, cx);
        self.refresh_numbering(observed, reconnected, cx);
    }

    fn request_salon_configuration(&mut self, review_conflict: bool, cx: &mut Context<Self>) {
        let Overlay::SalonConfiguration(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy
            || matches!(desk.work, SalonConfigurationWork::Pending(_))
            || self.status.connectivity != Connectivity::Online
        {
            return;
        }
        if desk
            .editor
            .as_ref()
            .is_some_and(|editor| editor.draft(cx).is_none())
        {
            desk.message = Some(Key::SalonInvalid);
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
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.salon_configuration() })
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
                    Ok(saved) if root.svc.store.cache_salon_configuration(&saved).is_ok() => {
                        let recovered = desk.editor.as_ref().and_then(|editor| {
                            sob_core::http::SalonConfigurationWrite::new(
                                &editor.saved,
                                &editor.draft(cx)?,
                            )
                        });
                        let draft = match &desk.work {
                            SalonConfigurationWork::Conflict { id, write } if review_conflict => {
                                desk.reviewing_conflict = Some(id.clone());
                                recovered
                                    .as_ref()
                                    .unwrap_or(write)
                                    .review_against(&saved.settings)
                            }
                            _ => recovered
                                .as_ref()
                                .and_then(|write| write.review_against(&saved.settings)),
                        };
                        if review_conflict && draft.is_none() && !desk.review_after_restore {
                            desk.message = Some(Key::SalonLocalFailure);
                            desk.reviewing_conflict = None;
                        } else if desk.reviewing_conflict.is_some() || draft.is_some() {
                            desk.message = Some(Key::SalonReviewLatest);
                        } else if desk.message != Some(Key::SalonSaved) {
                            desk.message = None;
                        }
                        let mut editor = Editor::new(saved, draft, labels, cx);
                        editor.show_profile = editor.profile.is_some()
                            && desk
                                .editor
                                .as_ref()
                                .is_some_and(|previous| previous.show_profile);
                        desk.editor = Some(editor);
                        desk.read_failed = false;
                        desk.review_after_restore = false;
                    }
                    Ok(_) => {
                        desk.read_failed = true;
                        desk.message = Some(Key::SalonLocalFailure);
                    }
                    Err(_) => {
                        desk.read_failed = true;
                        desk.message = Some(Key::SalonLoadFailed);
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
        if !desk.editable() || desk.busy || desk.confirm_close || desk.review_after_restore {
            return;
        }
        let Some(editor) = &desk.editor else { return };
        let Some(draft) = editor.draft(cx) else {
            desk.message = Some(Key::SalonInvalid);
            cx.notify();
            return;
        };
        match self.svc.store.queue_salon_configuration(
            &editor.saved,
            &draft,
            desk.reviewing_conflict.as_deref(),
        ) {
            Ok(true) => {
                desk.work = self
                    .svc
                    .store
                    .salon_configuration_work()
                    .unwrap_or(SalonConfigurationWork::Pending(None));
                desk.message = None;
                desk.reviewing_conflict = None;
                desk.editor = None;
                self.edited(cx);
                return;
            }
            Ok(false) => {
                if desk.reviewing_conflict.take().is_some() {
                    desk.message = Some(Key::SalonSaved);
                    self.edited(cx);
                    return;
                }
            }
            Err(_) => desk.message = Some(Key::SalonLocalFailure),
        }
        cx.notify();
    }

    pub(super) fn close_salon_configuration(&mut self, cx: &mut Context<Self>) {
        let Overlay::SalonConfiguration(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy || desk.media.busy() || desk.numbering.busy {
            return;
        }
        if desk.confirm_close {
            desk.confirm_close = false;
        } else if desk.media.dirty()
            || desk.numbering.dirty()
            || desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx))
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
        if desk.numbering.open && !desk.confirm_close {
            return self.modal_with_height(
                div().flex().min_h_0().child(
                    div()
                        .id("salon-numbering-scroll")
                        .min_h_0()
                        .flex_1()
                        .overflow_y_scroll()
                        .child(self.render_numbering(&desk.numbering, cx)),
                ),
                (viewport.width - px(32.)).max(px(220.)).min(px(610.)),
                (viewport.height - px(28.)).max(px(140.)),
                Some(cx),
            );
        }
        if desk.media.open && !desk.confirm_close {
            return self.modal_with_height(
                div().flex().min_h_0().child(
                    div()
                        .id("profile-image-scroll")
                        .debug_selector(|| "profile-image-scroll".to_string())
                        .min_h_0()
                        .flex_1()
                        .overflow_y_scroll()
                        .child(self.render_profile_images(&desk.media, cx)),
                ),
                (viewport.width - px(32.)).max(px(220.)).min(px(610.)),
                (viewport.height - px(28.)).max(px(140.)),
                Some(cx),
            );
        }
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
                !online && desk.editor.is_none() && desk.work == SalonConfigurationWork::Idle,
                |body| body.child(self.t(Key::SalonNeedsConnection)),
            )
            .when_some(
                match &desk.work {
                    SalonConfigurationWork::Pending(Some(write)) => Some(write),
                    _ => None,
                },
                |body, write| {
                    body.child(div().flex().flex_col().gap_1().children(
                        write.proposed_fields().filter_map(|(field, value)| {
                            self.render_pending_salon_field(field, value)
                        }),
                    ))
                },
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
                let locked = !desk.editable();
                let pending = matches!(desk.work, SalonConfigurationWork::Pending(_));
                let needs_review =
                    matches!(desk.work, SalonConfigurationWork::Conflict { .. }) && locked;
                let mut actions = div().flex().flex_wrap().gap_2();
                if let Some(editor) = &desk.editor
                    && !locked
                {
                    actions = actions.when(
                        !desk.review_after_restore
                            && (editor.dirty(cx) || desk.reviewing_conflict.is_some()),
                        |actions| {
                            actions.child(self.button(
                                "salon-save",
                                self.t(if online {
                                    Key::SalonSave
                                } else {
                                    Key::SalonSaveOffline
                                }),
                                Kind::Primary,
                                cx.listener(|root, _, _, cx| root.save_salon_configuration(cx)),
                            ))
                        },
                    );
                }
                if online
                    && !pending
                    && (desk.editor.is_none()
                        || needs_review
                        || desk.read_failed
                        || desk.review_after_restore)
                {
                    actions = actions.child(self.button(
                        "salon-refresh",
                        self.t(if needs_review || desk.review_after_restore {
                            Key::SalonReloadReview
                        } else {
                            Key::FormReload
                        }),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            root.request_salon_configuration(needs_review, cx)
                        }),
                    ));
                }
                if desk
                    .editor
                    .as_ref()
                    .is_some_and(|editor| editor.profile.is_some())
                {
                    actions = actions
                        .child(self.button(
                            "salon-media",
                            self.t(Key::ProfileMediaTitle),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.open_profile_images(cx)),
                        ))
                        .child(self.button(
                            "salon-numbering",
                            self.t(Key::NumberingTitle),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.open_numbering(cx)),
                        ));
                }
                body.when(pending, |body| body.child(self.t(Key::SalonQueued)))
                    .when(
                        needs_review && desk.message != Some(Key::SalonConflict),
                        |body| body.child(self.t(Key::SalonConflict)),
                    )
                    .when_some(
                        desk.editor
                            .as_ref()
                            .filter(|_| !locked || desk.review_after_restore),
                        |body, editor| body.child(self.render_salon_editor(editor, cx)),
                    )
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

    fn render_pending_salon_field(
        &self,
        field: &str,
        value: &serde_json::Value,
    ) -> Option<gpui::Div> {
        if field == "businessProfile" {
            return Some(div().text_sm().child(self.t(Key::BusinessProfileTitle)));
        }
        let label = match field {
            "name" => Key::SalonName,
            "timezone" => Key::SalonTimezone,
            "minNoticeMinutes" => Key::SalonMinNotice,
            "maxDaysAhead" => Key::SalonMaxDays,
            "reminderFirstLeadMinutes" => Key::SalonFirstReminder,
            "reminderSecondLeadMinutes" => Key::SalonSecondReminder,
            "slotGranularityMinutes" => Key::SalonStep,
            "onlineBookingEnabled" => Key::SalonBooking,
            _ => return None,
        };
        let value = match value {
            serde_json::Value::String(text) => text.clone(),
            serde_json::Value::Bool(enabled) => self
                .t(if *enabled {
                    Key::SalonBookingOn
                } else {
                    Key::SalonBookingOff
                })
                .to_owned(),
            serde_json::Value::Null => self.t(Key::SalonOff).to_owned(),
            _ => value.to_string(),
        };
        Some(
            div()
                .text_sm()
                .child(self.t(label))
                .child(" · ")
                .child(value),
        )
    }

    fn render_salon_editor(&self, editor: &Editor, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .min_h(px(0.))
            .flex_shrink()
            .when(editor.profile.is_some(), |view| {
                view.child(
                    div().flex().flex_wrap().gap_2().children(
                        [
                            (false, Key::SalonConfiguration),
                            (true, Key::BusinessProfileTitle),
                        ]
                        .map(|(show_profile, label)| {
                            self.button(
                                ("salon-settings-section", show_profile as usize),
                                self.t(label),
                                if show_profile == editor.show_profile {
                                    Kind::Primary
                                } else {
                                    Kind::Ghost
                                },
                                cx.listener(move |root, _, _, cx| {
                                    if let Overlay::SalonConfiguration(desk) = &mut root.overlay
                                        && let Some(editor) = &mut desk.editor
                                    {
                                        editor.show_profile = show_profile;
                                        cx.notify();
                                    }
                                }),
                            )
                        }),
                    ),
                )
            })
            .when(!editor.show_profile, |view| {
                view.child(self.render_general_salon_settings(editor, cx))
            })
            .when_some(
                editor.profile.as_ref().filter(|_| editor.show_profile),
                |view, profile| view.child(self.render_business_profile(profile, cx)),
            )
    }

    fn render_general_salon_settings(
        &self,
        editor: &Editor,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
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

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    fn reviewed_fixture() -> ReviewedSalonConfiguration {
        serde_json::from_value(serde_json::json!({
            "name": "Test Salon", "timezone": "Europe/Madrid", "slotGranularityMinutes": 15,
            "minNoticeMinutes": 30, "maxDaysAhead": 60, "onlineBookingEnabled": true,
            "reminderFirstLeadMinutes": 1440, "reminderSecondLeadMinutes": 120,
            "revision": "2026-11-21T00:00:00Z", "generation": "initial"
        }))
        .unwrap()
    }

    #[gpui::test]
    async fn saving_settings_offline_queues_the_edit_and_closes_without_discarding_it(
        cx: &mut TestAppContext,
    ) {
        let (_directory, window) = super::super::tests::open(cx);
        window.update(cx, |root, _, cx| {
            root.svc.store.cache_salon_configuration(&reviewed_fixture()).unwrap();
            root.status.connectivity = Connectivity::Offline;
            root.open_salon_configuration(cx);
            let Overlay::SalonConfiguration(desk) = &mut root.overlay else { panic!("Expected offline settings") };
            assert!(desk.editable());
            desk.editor.as_mut().unwrap().online = false;
            root.save_salon_configuration(cx);
            assert!(matches!(&root.overlay, Overlay::SalonConfiguration(desk) if matches!(desk.work, SalonConfigurationWork::Pending(_))));
            root.dismiss_overlay(cx);
            assert!(matches!(&root.overlay, Overlay::None));
            assert!(matches!(root.svc.store.salon_configuration_work().unwrap(), SalonConfigurationWork::Pending(Some(_))));
        }).unwrap();
    }

    #[gpui::test]
    async fn leaving_a_native_settings_draft_requires_confirmation(cx: &mut TestAppContext) {
        let (_directory, window) = super::super::tests::open(cx);
        window.update(cx, |root, _, cx| {
            let mut editor = Editor::new(reviewed_fixture(), None, LABELS.map(|key| root.t(key)), cx);
            assert!(!editor.dirty(cx));
            editor.online = false;
            root.overlay = Overlay::SalonConfiguration(Box::new(Desk {
                instance: Arc::new(()), editor: Some(editor), busy: false, work: SalonConfigurationWork::Idle,
                reviewing_conflict: None, confirm_close: false, observed: None, message: None, read_failed: false, review_after_restore: false, media: profile_media::MediaDesk::default(), numbering: numbering::NumberingDesk::default(),
            }));
            assert!(root.preserve_open_salon_draft(cx));
            root.save_salon_configuration(cx);
            assert!(root.svc.store.outbox(1).unwrap().is_empty());
            root.dismiss_overlay(cx);
            assert!(matches!(&root.overlay, Overlay::SalonConfiguration(desk) if desk.confirm_close));
            root.dismiss_overlay(cx);
            assert!(matches!(&root.overlay, Overlay::SalonConfiguration(desk)
                if !desk.confirm_close && desk.editor.as_ref().is_some_and(|editor| !editor.online)));
        }).unwrap();
    }
}
