use super::*;
use sob_core::http::{AccessPreset, ReviewedStaffAccess, StaffAccountError, valid_staff_login};
use sob_core::sync::TransportError;

pub(super) struct Desk {
    identity: Arc<()>,
    selected: Option<String>,
    editor: Option<Editor>,
    link: Option<LinkDraft>,
    creation: Option<CreateDraft>,
    observed: Option<i64>,
    retry_at: Option<Instant>,
    busy: bool,
    needs_reload: bool,
    notice: Option<Key>,
    confirm_back: bool,
}

struct LinkDraft {
    reviewed: ReviewedStaffAccess,
    credentials: Credentials,
}

struct CreateDraft {
    generation: String,
    name: Entity<TextField>,
    display_name: Entity<TextField>,
    credentials: Credentials,
}

struct Credentials {
    email: Entity<TextField>,
    password: Option<Entity<TextField>>,
}

impl Credentials {
    fn values(&self, cx: &App) -> Option<(String, Option<String>)> {
        let email = self.email.read(cx).text().trim().to_owned();
        let password = self
            .password
            .as_ref()
            .map(|field| field.read(cx).text().to_owned());
        valid_staff_login(&email, password.as_deref()).then_some((email, password))
    }
}

struct Editor {
    reviewed: ReviewedStaffAccess,
    latest: ReviewedStaffAccess,
    proposed: AccessPreset,
}

impl Editor {
    fn new(current: ReviewedStaffAccess) -> Self {
        Self {
            reviewed: current.clone(),
            proposed: current.access.preset,
            latest: current,
        }
    }

    fn dirty(&self) -> bool {
        self.proposed != self.reviewed.access.preset
    }

    fn changed(&self) -> bool {
        self.reviewed != self.latest
    }

    fn receive(&mut self, current: ReviewedStaffAccess) {
        if self.dirty() {
            self.latest = current;
        } else {
            *self = Self::new(current);
        }
    }
}

enum Request {
    Read,
    Save(ReviewedStaffAccess, AccessPreset),
    Link {
        reviewed: ReviewedStaffAccess,
        name: String,
        email: String,
        password: Option<String>,
    },
    Create {
        generation: String,
        name: String,
        display_name: Option<String>,
        email: String,
        password: Option<String>,
    },
}

impl Root {
    pub(super) fn open_staff_access(&mut self, cx: &mut Context<Self>) {
        if !self.can_configure_salon() {
            return;
        }
        self.overlay = Overlay::StaffAccess(Box::new(Desk {
            identity: Arc::new(()),
            selected: None,
            editor: None,
            link: None,
            creation: None,
            observed: None,
            retry_at: None,
            busy: false,
            needs_reload: false,
            notice: None,
            confirm_back: false,
        }));
        cx.notify();
    }

    pub(super) fn preserve_open_staff_access(&mut self, cx: &mut Context<Self>) -> bool {
        let Overlay::StaffAccess(desk) = &mut self.overlay else {
            return false;
        };
        if !desk.has_draft() {
            return false;
        }
        desk.link = None;
        if let Some(field) = desk
            .creation
            .as_ref()
            .and_then(|draft| draft.credentials.password.as_ref())
        {
            field.update(cx, |field, cx| field.set_text("", cx));
        }
        desk.identity = Arc::new(());
        desk.observed = None;
        desk.retry_at = None;
        desk.needs_reload = desk.selected.is_some();
        desk.busy = false;
        true
    }

    fn select_staff_access(&mut self, id: &str, cx: &mut Context<Self>) {
        let Overlay::StaffAccess(desk) = &mut self.overlay else {
            return;
        };
        if desk.selected.is_some() || desk.creation.is_some() {
            return;
        }
        desk.selected = Some(id.into());
        self.request_staff_access(Request::Read, cx);
        cx.notify();
    }

    pub(super) fn refresh_staff_access(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let Overlay::StaffAccess(desk) = &mut self.overlay else {
            return;
        };
        if reconnected {
            desk.observed = None;
        }
        let retry_due = desk
            .retry_at
            .is_some_and(|deadline| deadline <= Instant::now());
        if !desk.busy
            && !desk.confirm_back
            && desk.selected.is_some()
            && (retry_due
                || (desk.retry_at.is_none()
                    && desk.observed != self.svc.store.staff_directory_revision().ok()))
        {
            self.request_staff_access(Request::Read, cx);
        }
    }

    fn request_staff_access(&mut self, request: Request, cx: &mut Context<Self>) {
        if !self.can_configure_salon() || self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Overlay::StaffAccess(desk) = &mut self.overlay else {
            return;
        };
        let id = desk.selected.clone();
        let creating = matches!(request, Request::Create { .. });
        if desk.busy || id.is_none() != creating {
            return;
        }
        let success_notice = match &request {
            Request::Read => None,
            Request::Save(_, _) => Some(Key::AccessSaved),
            Request::Create { password, .. } => Some(if password.is_some() {
                Key::AccessAccountCreated
            } else {
                Key::AccessNewInvitationQueued
            }),
            Request::Link { password, .. } => Some(if password.is_some() {
                Key::AccessAccountLinked
            } else {
                Key::AccessInvitationQueued
            }),
        };
        let linking = matches!(request, Request::Link { .. });
        desk.busy = true;
        desk.retry_at = None;
        desk.observed = self.svc.store.staff_directory_revision().ok();
        let identity = desk.identity.clone();
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match request {
                        Request::Read => transport
                            .staff_access(id.as_deref().unwrap_or_default())
                            .map_err(StaffAccountError::from),
                        Request::Save(reviewed, preset) => transport
                            .save_staff_access(&reviewed, preset)
                            .map_err(StaffAccountError::from),
                        Request::Link {
                            reviewed,
                            name,
                            email,
                            password,
                        } => transport.link_staff_account(
                            &reviewed,
                            &name,
                            &email,
                            password.as_deref(),
                        ),
                        Request::Create {
                            generation,
                            name,
                            display_name,
                            email,
                            password,
                        } => transport.create_staff_account(
                            &generation,
                            &name,
                            display_name.as_deref(),
                            &email,
                            password.as_deref(),
                        ),
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Overlay::StaffAccess(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&identity, &desk.identity) {
                    return;
                }
                desk.busy = false;
                match result {
                    Ok(current) if success_notice.is_some() => {
                        if creating {
                            desk.selected = Some(current.access.staff_id.clone());
                            desk.creation = None;
                        }
                        desk.editor = Some(Editor::new(current));
                        desk.needs_reload = false;
                        desk.notice = success_notice;
                        if linking {
                            desk.link = None;
                        }
                        root.svc.wake(Wake::Local);
                    }
                    Ok(current) => {
                        if current.account_id.is_some() {
                            desk.link = None;
                        }
                        if let Some(editor) = &mut desk.editor {
                            editor.receive(current);
                        } else {
                            desk.editor = Some(Editor::new(current));
                        }
                        desk.needs_reload = false;
                        if !matches!(
                            desk.notice,
                            Some(
                                Key::AccessSaved
                                    | Key::AccessAccountLinked
                                    | Key::AccessInvitationQueued
                                    | Key::AccessLinkFailed
                                    | Key::AccessAccountCreated
                                    | Key::AccessNewInvitationQueued
                            )
                        ) {
                            desk.notice = None;
                        }
                    }
                    Err(error) => {
                        if creating {
                            desk.notice = Some(match error {
                                StaffAccountError::Transport(
                                    TransportError::ReplicaGenerationChanged,
                                ) => {
                                    root.svc.wake(Wake::Local);
                                    Key::AccessCreationReview
                                }
                                StaffAccountError::EmailTaken => Key::AccessEmailTaken,
                                StaffAccountError::EmailUnavailable => {
                                    Key::AccessCreationEmailUnavailable
                                }
                                StaffAccountError::InvalidDetails => Key::AccessCreationInvalid,
                                StaffAccountError::Transport(TransportError::RateLimited(_)) => {
                                    Key::AccessCreationRateLimited
                                }
                                _ => Key::AccessCreationFailed,
                            });
                            cx.notify();
                            return;
                        }
                        desk.needs_reload = true;
                        desk.notice = Some(if linking {
                            Key::AccessLinkFailed
                        } else {
                            Key::AccessFailed
                        });
                        let delay = match error {
                            StaffAccountError::Transport(
                                TransportError::Offline(_) | TransportError::Server(_),
                            ) => Some(Duration::from_secs(3)),
                            StaffAccountError::Transport(TransportError::RateLimited(delay)) => {
                                Some(delay.unwrap_or(Duration::from_secs(30)))
                            }
                            _ if success_notice.is_some() => Some(Duration::from_secs(1)),
                            _ => None,
                        };
                        desk.retry_at = delay.and_then(|delay| Instant::now().checked_add(delay));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn save_staff_access(&mut self, cx: &mut Context<Self>) {
        let Overlay::StaffAccess(desk) = &self.overlay else {
            return;
        };
        let Some(editor) = &desk.editor else { return };
        if desk.needs_reload
            || desk.confirm_back
            || !editor.dirty()
            || editor.changed()
            || !editor.latest.access.editable()
        {
            return;
        }
        self.request_staff_access(Request::Save(editor.reviewed.clone(), editor.proposed), cx);
    }

    fn open_account_link(&mut self, cx: &mut Context<Self>) {
        let label = self.t(Key::AccessLoginEmail);
        let Overlay::StaffAccess(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &desk.editor else { return };
        if desk.busy
            || desk.link.is_some()
            || desk.needs_reload
            || editor.latest.account_id.is_some()
        {
            return;
        }
        let email = cx.new(|cx| TextField::new(label, false, cx));
        desk.link = Some(LinkDraft {
            reviewed: editor.latest.clone(),
            credentials: Credentials {
                email,
                password: None,
            },
        });
        desk.notice = None;
        cx.notify();
    }

    fn toggle_initial_password(&mut self, cx: &mut Context<Self>) {
        let label = self.t(Key::AccessInitialPassword);
        let Overlay::StaffAccess(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy {
            return;
        }
        let Some(credentials) = desk
            .creation
            .as_mut()
            .map(|draft| &mut draft.credentials)
            .or_else(|| desk.link.as_mut().map(|draft| &mut draft.credentials))
        else {
            return;
        };
        credentials.password = credentials
            .password
            .is_none()
            .then(|| cx.new(|cx| TextField::new(label, true, cx)));
        if desk.notice != Some(Key::AccessCreationReview) {
            desk.notice = None;
        }
        cx.notify();
    }

    fn submit_account_link(&mut self, cx: &mut Context<Self>) {
        let Overlay::StaffAccess(desk) = &mut self.overlay else {
            return;
        };
        let (Some(editor), Some(link)) = (&desk.editor, &mut desk.link) else {
            return;
        };
        if desk.busy
            || desk.needs_reload
            || desk.confirm_back
            || editor.dirty()
            || editor.changed()
            || editor.latest.account_id.is_some()
            || link.reviewed != editor.latest
        {
            return;
        }
        let Some((email, password)) = link.credentials.values(cx) else {
            desk.notice = Some(Key::AccessLoginInvalid);
            cx.notify();
            return;
        };
        let reviewed = editor.reviewed.clone();
        let name = self.staff_name(&reviewed.access.staff_id).to_string();
        self.request_staff_access(
            Request::Link {
                reviewed,
                name,
                email,
                password,
            },
            cx,
        );
    }

    fn open_staff_creation(&mut self, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Ok(generation) = self.svc.store.verified_reviewed_generation() else {
            return;
        };
        let name = self.t(Key::AccessStaffName);
        let display_name = self.t(Key::AccessDisplayName);
        let email = self.t(Key::AccessLoginEmail);
        let Overlay::StaffAccess(desk) = &mut self.overlay else {
            return;
        };
        if desk.selected.is_some() || desk.creation.is_some() || desk.busy || desk.confirm_back {
            return;
        }
        desk.creation = Some(CreateDraft {
            generation,
            name: cx.new(|cx| TextField::new(name, false, cx)),
            display_name: cx.new(|cx| TextField::new(display_name, false, cx)),
            credentials: Credentials {
                email: cx.new(|cx| TextField::new(email, false, cx)),
                password: None,
            },
        });
        desk.notice = None;
        cx.notify();
    }

    fn review_staff_creation(&mut self, cx: &mut Context<Self>) {
        let Ok(generation) = self.svc.store.verified_reviewed_generation() else {
            return;
        };
        if let Overlay::StaffAccess(desk) = &mut self.overlay
            && !desk.busy
            && let Some(draft) = &mut desk.creation
            && draft.generation != generation
        {
            draft.generation = generation;
            desk.notice = None;
            cx.notify();
        }
    }

    fn submit_staff_creation(&mut self, cx: &mut Context<Self>) {
        let current = self.svc.store.verified_reviewed_generation().ok();
        let Overlay::StaffAccess(desk) = &mut self.overlay else {
            return;
        };
        let Some(draft) = &desk.creation else { return };
        if desk.busy
            || desk.confirm_back
            || desk.notice == Some(Key::AccessCreationReview)
            || current.as_deref() != Some(draft.generation.as_str())
        {
            return;
        }
        let name = draft.name.read(cx).text().trim().to_owned();
        let display_name = draft.display_name.read(cx).text().trim().to_owned();
        let credentials = draft.credentials.values(cx);
        if name.is_empty() {
            desk.notice = Some(Key::AccessStaffNameInvalid);
            cx.notify();
            return;
        }
        let Some((email, password)) = credentials else {
            desk.notice = Some(Key::AccessLoginInvalid);
            cx.notify();
            return;
        };
        let request = Request::Create {
            generation: draft.generation.clone(),
            name,
            display_name: (!display_name.is_empty()).then_some(display_name),
            email,
            password,
        };
        self.request_staff_access(request, cx);
    }

    pub(super) fn close_staff_access(&mut self, cx: &mut Context<Self>) {
        let Overlay::StaffAccess(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy {
            return;
        }
        if desk.has_draft() {
            desk.confirm_back = !desk.confirm_back;
        } else if desk.selected.is_some() {
            desk.back();
        } else {
            self.overlay = Overlay::None;
        }
        cx.notify();
    }

    pub(super) fn render_staff_access(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let name = desk.selected.as_ref().map(|id| self.staff_name(id));
        let body = div()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::BOLD)
                            .child(self.t(Key::StaffAccess)),
                    )
                    .child(self.button(
                        "team-access-back",
                        self.t(if desk.selected.is_some() {
                            Key::Back
                        } else {
                            Key::Close
                        }),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.close_staff_access(cx)),
                    )),
            )
            .when(!online, |body| {
                body.child(div().text_sm().child(self.t(Key::AccessOnline)))
            })
            .when(desk.busy, |body| {
                body.child(div().text_sm().child(self.t(Key::CloudWorkspacesLoading)))
            })
            .when_some(desk.notice, |body, notice| {
                body.child(div().text_sm().child(self.t(notice)))
            })
            .when_some(name, |body, name| {
                body.child(div().font_weight(FontWeight::SEMIBOLD).child(name))
            })
            .when(desk.selected.is_none() && desk.creation.is_none(), |body| {
                body.child(
                    div()
                        .id("team-access-list")
                        .min_h(px(0.))
                        .flex()
                        .flex_col()
                        .gap_2()
                        .overflow_y_scroll()
                        .when(self.report_staff_options.is_empty(), |list| {
                            list.child(self.t(Key::AssignmentNoStaff))
                        })
                        .children(self.report_staff_options.iter().map(|staff| {
                            let label = if staff.active {
                                staff.display_name.clone()
                            } else {
                                format!(
                                    "{} · {}",
                                    staff.display_name,
                                    self.t(Key::StaffPortraitInactive)
                                )
                            };
                            let id = staff.id.clone();
                            self.button(
                                SharedString::from(format!("access-{id}")),
                                label,
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    root.select_staff_access(&id, cx)
                                }),
                            )
                        })),
                )
                .when(
                    online && self.svc.store.verified_reviewed_generation().is_ok(),
                    |body| {
                        body.child(self.button(
                            "create-staff-account",
                            self.t(Key::AccessNewStaff),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.open_staff_creation(cx)),
                        ))
                    },
                )
            })
            .when(desk.confirm_back, |body| {
                body.child(self.t(Key::SalonConfirmDiscard))
                    .child(self.button(
                        "discard-team-access",
                        self.t(Key::SalonDiscard),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| {
                            if let Overlay::StaffAccess(desk) = &mut root.overlay {
                                desk.back();
                            }
                            cx.notify();
                        }),
                    ))
            })
            .when(!desk.confirm_back, |body| {
                body.when_some(desk.creation.as_ref(), |body, draft| {
                    body.child(self.render_staff_creation(desk, draft, online, cx))
                })
                .when_some(desk.editor.as_ref(), |body, editor| {
                    body.child(self.render_access_editor(desk, editor, online, cx))
                })
                .when(online && !desk.busy && desk.needs_reload, |body| {
                    body.child(self.button(
                        "reload-team-access",
                        self.t(Key::AccessReload),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.request_staff_access(Request::Read, cx)),
                    ))
                })
            });
        self.modal_with_height(
            body,
            (viewport.width - px(32.)).max(px(260.)).min(px(590.)),
            (viewport.height - px(32.)).max(px(220.)).min(px(680.)),
            Some(cx),
        )
    }

    fn render_staff_creation(
        &self,
        desk: &Desk,
        draft: &CreateDraft,
        online: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let stale = generation.as_deref() != Some(draft.generation.as_str());
        div()
            .id("staff-creation")
            .min_h(px(0.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::AccessNewStaff)),
            )
            .child(
                div()
                    .text_sm()
                    .child(self.t(Key::AccessNewStaffDescription)),
            )
            .when(!desk.busy, |form| {
                form.child(div().text_sm().child(self.t(Key::AccessStaffName)))
                    .child(draft.name.clone())
                    .child(div().text_sm().child(self.t(Key::AccessDisplayName)))
                    .child(draft.display_name.clone())
                    .child(self.render_credentials(&draft.credentials, cx))
            })
            .when(stale, |form| {
                form.when(desk.notice != Some(Key::AccessCreationReview), |form| {
                    form.child(div().text_sm().child(self.t(Key::AccessCreationReview)))
                })
                .when(online && !desk.busy && generation.is_some(), |form| {
                    form.child(self.button(
                        "review-staff-creation",
                        self.t(Key::AccessReview),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.review_staff_creation(cx)),
                    ))
                })
            })
            .when(
                online && !stale && !desk.busy && desk.notice != Some(Key::AccessCreationReview),
                |form| {
                    form.child(self.button(
                        "submit-staff-creation",
                        self.t(if draft.credentials.password.is_some() {
                            Key::AccessNewStaff
                        } else {
                            Key::AccessCreateAndInvite
                        }),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.submit_staff_creation(cx)),
                    ))
                },
            )
    }

    fn render_access_editor(
        &self,
        desk: &Desk,
        editor: &Editor,
        online: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let editable = editor.latest.access.editable();
        let current = i18n::fill(
            self.t(Key::AccessCurrent),
            &[("profile", self.t(preset_label(editor.latest.access.preset)))],
        );
        div()
            .id("team-access-editor")
            .min_h(px(0.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().text_sm().child(current))
            .when_some(editor.latest.account_email.as_ref(), |body, email| {
                body.child(div().text_sm().child(i18n::fill(
                    self.t(Key::AccessLinkedAccount),
                    &[("email", email)],
                )))
            })
            .when(!editable, |body| {
                body.child(div().text_sm().child(self.t(Key::AccessOtherRole)))
            })
            .when(editor.latest.access.account_role.is_none(), |body| {
                body.child(div().text_sm().child(self.t(Key::AccessNoAccount)))
            })
            .when(editor.changed(), |body| {
                body.child(div().text_sm().child(self.t(Key::AccessChanged)))
                    .when(editable && !desk.busy && !desk.needs_reload, |body| {
                        body.child(self.button(
                            "review-team-access",
                            self.t(Key::AccessReview),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::StaffAccess(desk) = &mut root.overlay
                                    && let Some(editor) = &mut desk.editor
                                {
                                    editor.reviewed = editor.latest.clone();
                                }
                                cx.notify();
                            }),
                        ))
                    })
            })
            .when(editable, |body| {
                body.children(AccessPreset::ALL.map(|preset| {
                    let label = self.t(preset_label(preset));
                    if desk.busy {
                        return div().text_sm().child(label).into_any_element();
                    }
                    self.button(
                        ("staff-access-choice", preset as usize),
                        label,
                        if editor.proposed == preset {
                            Kind::Primary
                        } else {
                            Kind::Ghost
                        },
                        cx.listener(move |root, _, _, cx| {
                            if let Overlay::StaffAccess(desk) = &mut root.overlay
                                && let Some(editor) = &mut desk.editor
                            {
                                editor.proposed = preset;
                                if !editor.dirty() && editor.changed() {
                                    *editor = Editor::new(editor.latest.clone());
                                }
                                desk.notice = None;
                            }
                            cx.notify();
                        }),
                    )
                    .into_any_element()
                }))
            })
            .when(
                online
                    && editable
                    && editor.dirty()
                    && !editor.changed()
                    && !desk.busy
                    && !desk.needs_reload,
                |body| {
                    body.child(self.button(
                        "save-team-access",
                        self.t(Key::AccessSave),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.save_staff_access(cx)),
                    ))
                },
            )
            .when(editor.latest.account_id.is_none(), |body| {
                let available = online
                    && !desk.busy
                    && !desk.needs_reload
                    && !editor.dirty()
                    && !editor.changed();
                body.child(self.render_account_link(desk, &editor.latest, available, cx))
            })
    }

    fn render_account_link(
        &self,
        desk: &Desk,
        latest: &ReviewedStaffAccess,
        available: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .pt_2()
            .when(desk.link.is_none() && available, |body| {
                body.child(self.button(
                    "link-staff-login",
                    self.t(Key::AccessLinkAccount),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.open_account_link(cx)),
                ))
            })
            .when_some(desk.link.as_ref(), |body, link| {
                let changed = link.reviewed != *latest;
                body.when(!desk.busy, |body| {
                    body.child(self.render_credentials(&link.credentials, cx))
                })
                .when(available && changed, |body| {
                    body.child(div().text_sm().child(self.t(Key::AccessChanged)))
                        .child(self.button(
                            "review-staff-login",
                            self.t(Key::AccessReview),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::StaffAccess(desk) = &mut root.overlay
                                    && let (Some(link), Some(editor)) =
                                        (&mut desk.link, &desk.editor)
                                {
                                    link.reviewed = editor.latest.clone();
                                }
                                cx.notify();
                            }),
                        ))
                })
                .when(available && !changed, |body| {
                    body.child(self.button(
                        "submit-staff-login",
                        self.t(if link.credentials.password.is_some() {
                            Key::AccessLinkAccount
                        } else {
                            Key::AccessQueueInvitation
                        }),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.submit_account_link(cx)),
                    ))
                })
            })
    }

    fn render_credentials(
        &self,
        credentials: &Credentials,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().text_sm().child(self.t(Key::AccessLoginEmail)))
            .child(credentials.email.clone())
            .when_some(credentials.password.as_ref(), |body, password| {
                body.child(div().text_sm().child(self.t(Key::AccessInitialPassword)))
                    .child(password.clone())
            })
            .child(self.button(
                "staff-login-password-mode",
                self.t(if credentials.password.is_some() {
                    Key::AccessUseInvitation
                } else {
                    Key::AccessUsePassword
                }),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| root.toggle_initial_password(cx)),
            ))
    }
}

impl Desk {
    fn has_draft(&self) -> bool {
        self.editor.as_ref().is_some_and(Editor::dirty)
            || self.link.is_some()
            || self.creation.is_some()
    }

    fn back(&mut self) {
        self.selected = None;
        self.editor = None;
        self.link = None;
        self.creation = None;
        self.notice = None;
        self.retry_at = None;
        self.needs_reload = false;
        self.confirm_back = false;
    }
}

fn preset_label(preset: AccessPreset) -> Key {
    match preset {
        AccessPreset::Manager => Key::AccessManager,
        AccessPreset::Receptionist => Key::AccessReception,
        AccessPreset::Professional => Key::AccessProfessional,
        AccessPreset::Restricted => Key::AccessRestricted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use sob_core::http::StaffAccess;

    #[test]
    fn a_changed_link_keeps_the_pending_choice_separate_from_the_review() {
        let review = ReviewedStaffAccess {
            generation: "initial".into(),
            account_id: Some("first".into()),
            account_email: Some("first@example.test".into()),
            access: StaffAccess {
                staff_id: "professional".into(),
                preset: AccessPreset::Professional,
                version: 1,
                account_role: Some("staff".into()),
            },
        };
        let mut editor = Editor::new(review.clone());
        editor.proposed = AccessPreset::Manager;
        let latest = ReviewedStaffAccess {
            account_id: Some("second".into()),
            account_email: Some("second@example.test".into()),
            ..review.clone()
        };
        editor.receive(latest.clone());
        assert!(editor.changed());
        assert_eq!(editor.proposed, AccessPreset::Manager);
        assert_eq!(editor.reviewed, review);
        assert_eq!(editor.latest, latest);
    }

    #[gpui::test]
    async fn a_reconnect_and_backdrop_keep_an_unsaved_access_draft(cx: &mut TestAppContext) {
        let (_directory, window) = super::super::tests::open(cx);
        window.update(cx, |root, _, cx| {
            let mut editor = Editor::new(ReviewedStaffAccess {
                generation: "initial".into(),
                account_id: None,
                account_email: None,
                access: StaffAccess {
                    staff_id: "professional".into(), preset: AccessPreset::Professional,
                    version: 1, account_role: None,
                },
            });
            editor.proposed = AccessPreset::Restricted;
            root.overlay = Overlay::StaffAccess(Box::new(Desk {
                identity: Arc::new(()), selected: Some("professional".into()), editor: Some(editor),
                link: None, creation: None,
                observed: Some(1), retry_at: None, busy: true, needs_reload: false,
                notice: None, confirm_back: false,
            }));
            root.refresh_staff_access(true, cx);
            let Overlay::StaffAccess(desk) = &mut root.overlay else { panic!("editor closed") };
            assert_eq!(desk.observed, None);
            desk.busy = false;
            root.dismiss_overlay(cx);
            assert!(matches!(&root.overlay, Overlay::StaffAccess(desk)
                if desk.confirm_back && desk.editor.as_ref().is_some_and(|editor| editor.proposed == AccessPreset::Restricted)));
        }).unwrap();
    }

    #[gpui::test]
    async fn new_staff_form_requires_online_access_and_preserves_a_draft_on_restore(
        cx: &mut TestAppContext,
    ) {
        let (_directory, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.status.connectivity = Connectivity::Offline;
                root.open_staff_access(cx);
                root.open_staff_creation(cx);
                assert!(
                    matches!(&root.overlay, Overlay::StaffAccess(desk) if desk.creation.is_none())
                );
                root.status.connectivity = Connectivity::Online;
                root.open_staff_creation(cx);
                if let Overlay::StaffAccess(desk) = &mut root.overlay {
                    desk.notice = Some(Key::AccessCreationReview);
                }
                root.toggle_initial_password(cx);
                root.review_staff_creation(cx);
                let Overlay::StaffAccess(desk) = &root.overlay else {
                    panic!("No staff desk")
                };
                assert_eq!(desk.notice, Some(Key::AccessCreationReview));
                let draft = desk.creation.as_ref().expect("No creation draft");
                draft
                    .name
                    .update(cx, |field, cx| field.set_text("Synthetic staff", cx));
                draft
                    .credentials
                    .password
                    .as_ref()
                    .unwrap()
                    .update(cx, |field, cx| {
                        field.set_text("synthetic initial password", cx)
                    });
                root.svc.store.set_meta("sync_generation", "restored-staff-test").unwrap();
                root.reload(cx);
                let Overlay::StaffAccess(desk) = &root.overlay else {
                    panic!("Draft closed")
                };
                let draft = desk.creation.as_ref().expect("Draft discarded");
                assert_eq!(draft.name.read(cx).text(), "Synthetic staff");
                assert_ne!(draft.generation, "restored-staff-test");
                assert!(!desk.needs_reload);
                assert_eq!(
                    draft.credentials.password.as_ref().unwrap().read(cx).text(),
                    ""
                );
                draft.credentials.email.update(cx, |field, cx| {
                    field.set_text("synthetic-staff@example.test", cx);
                });
                draft.credentials.password.as_ref().unwrap().update(cx, |field, cx| {
                    field.set_text("synthetic replacement password", cx);
                });
                assert!(draft.credentials.values(cx).is_some());
                root.submit_staff_creation(cx);
                assert!(matches!(&root.overlay, Overlay::StaffAccess(desk) if !desk.busy));
                root.review_staff_creation(cx);
                assert!(matches!(&root.overlay, Overlay::StaffAccess(desk)
                    if desk.creation.as_ref().is_some_and(|draft| draft.generation == "restored-staff-test")));
                root.close_staff_access(cx);
                assert!(matches!(&root.overlay, Overlay::StaffAccess(desk) if desk.confirm_back));
            })
            .unwrap();
    }
}
