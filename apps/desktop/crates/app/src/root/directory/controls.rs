use super::*;
use sob_core::http::client_controls::{BookingAccess, ClientControls, ClientControlsUpdate};
use sob_core::sync::TransportError;

pub(super) struct Desk {
    identity: Arc<()>,
    client_id: String,
    name: String,
    current: Option<ClientControls>,
    tags: Entity<TextField>,
    reason: Entity<TextField>,
    _field_changes: [Subscription; 2],
    access: BookingAccess,
    busy: bool,
    must_reload: bool,
    confirm_back: bool,
    message: Option<Key>,
}

fn mirrored_revision(clients: &[Client], id: &str) -> Option<u64> {
    clients
        .iter()
        .find(|client| client.id == id)?
        .controls_version
}

impl Desk {
    fn change(&self, cx: &App) -> Option<ClientControlsUpdate> {
        let current = self.current.as_ref()?;
        let tags = self.tags.read(cx).text().trim();
        let tags = (tags != current.tags.join(", ")).then(|| {
            if tags.is_empty() {
                Vec::new()
            } else {
                tags.split(',').map(|tag| tag.trim().to_owned()).collect()
            }
        });
        let booking_access = (current.can_manage_booking_access
            && self.access != current.booking_access)
            .then_some(self.access);
        if tags.is_none() && booking_access.is_none() {
            return None;
        }
        Some(ClientControlsUpdate {
            version: current.version,
            tags,
            booking_access,
            reason: booking_access.map(|_| self.reason.read(cx).text().trim().to_owned()),
        })
    }

    fn apply_snapshot(&mut self, current: ClientControls, preserve_draft: bool, cx: &mut App) {
        let change = preserve_draft.then(|| self.change(cx)).flatten();
        if change.as_ref().is_none_or(|change| change.tags.is_none()) {
            self.tags
                .update(cx, |field, cx| field.set_text(&current.tags.join(", "), cx));
        }
        if !current.can_manage_booking_access
            || change
                .as_ref()
                .is_none_or(|change| change.booking_access.is_none())
            || self.access == current.booking_access
        {
            self.access = current.booking_access;
            self.reason.update(cx, |field, cx| field.clear(cx));
        }
        self.current = Some(current);
        self.must_reload = false;
    }

    fn apply_response(
        &mut self,
        current: ClientControls,
        saving: bool,
        requested_revision: Option<u64>,
        observed_revision: Option<u64>,
        cx: &mut App,
    ) -> bool {
        if !saving && observed_revision.is_some_and(|version| current.version < version) {
            if observed_revision != requested_revision {
                // Retry the read that was overtaken by the replica without rebasing the draft.
                return true;
            }
            self.must_reload = true;
            self.message = Some(Key::ClientControlChanged);
            return false;
        }
        self.apply_snapshot(current, !saving, cx);
        self.message = saving.then_some(Key::ClientControlSaved);
        false
    }
}

impl Root {
    pub(super) fn open_client_controls(&mut self, cx: &mut Context<Self>) {
        let tags_label = self.t(Key::ClientControlTags);
        let reason_label = self.t(Key::ClientControlReason);
        let Overlay::Directory(directory) = &mut self.overlay else {
            return;
        };
        let Some(client) = directory
            .form
            .as_ref()
            .and_then(|form| form.previous.as_ref())
        else {
            return;
        };
        if !self.svc.store.client_is_synced(&client.id).unwrap_or(false) {
            return;
        }
        let tags = cx.new(|cx| TextField::new(tags_label, false, cx));
        let reason = cx.new(|cx| TextField::new(reason_label, false, cx));
        let changes = [&tags, &reason].map(|field| {
            cx.subscribe(field, |_, _, event, cx| {
                if matches!(event, FieldEvent::Changed) {
                    cx.notify();
                }
            })
        });
        directory.controls = Some(Desk {
            identity: Arc::new(()),
            client_id: client.id.clone(),
            name: client.name.clone(),
            current: None,
            tags,
            reason,
            _field_changes: changes,
            access: BookingAccess::Normal,
            busy: false,
            must_reload: false,
            confirm_back: false,
            message: None,
        });
        self.request_client_controls(None, cx);
        cx.notify();
    }

    pub(in crate::root) fn back_client_controls(&mut self, cx: &mut Context<Self>) {
        let Overlay::Directory(directory) = &mut self.overlay else {
            return;
        };
        let Some(desk) = &mut directory.controls else {
            return;
        };
        if !desk.busy {
            if desk.change(cx).is_some() {
                desk.confirm_back = !desk.confirm_back;
            } else {
                directory.controls = None;
            }
            cx.notify();
            self.refresh_client_controls(cx);
        }
    }

    pub(in crate::root) fn refresh_client_controls(&mut self, cx: &mut Context<Self>) {
        let Overlay::Directory(directory) = &mut self.overlay else {
            return;
        };
        let Some(desk) = &mut directory.controls else {
            return;
        };
        let Some(current) = &desk.current else { return };
        if desk.busy || desk.must_reload || desk.confirm_back {
            return;
        }
        let newer_revision = mirrored_revision(&directory.contacts.clients, &desk.client_id)
            .is_some_and(|version| version > current.version);
        if newer_revision {
            if desk.change(cx).is_some() {
                desk.must_reload = true;
                desk.message = Some(Key::ClientControlChanged);
                cx.notify();
            } else {
                self.request_client_controls(None, cx);
            }
        }
    }

    fn save_client_controls(&mut self, cx: &mut Context<Self>) {
        let Overlay::Directory(directory) = &self.overlay else {
            return;
        };
        let Some(change) = directory
            .controls
            .as_ref()
            .filter(|desk| !desk.must_reload)
            .and_then(|desk| desk.change(cx))
        else {
            return;
        };
        self.request_client_controls(Some(change), cx);
    }

    fn request_client_controls(
        &mut self,
        change: Option<ClientControlsUpdate>,
        cx: &mut Context<Self>,
    ) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Overlay::Directory(directory) = &mut self.overlay else {
            return;
        };
        let Some(desk) = &mut directory.controls else {
            return;
        };
        if desk.busy {
            return;
        }
        desk.busy = true;
        desk.message = None;
        let id = desk.client_id.clone();
        let requested_revision = self.svc.store.client_controls_revision(&id).ok().flatten();
        let identity = desk.identity.clone();
        let session = self.svc.session.clone();
        let saving = change.is_some();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match change {
                        Some(change) => transport.save_client_controls(&id, &change),
                        None => transport.client_controls(&id).map(Some),
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Overlay::Directory(directory) = &mut root.overlay else {
                    return;
                };
                let Some(desk) = directory
                    .controls
                    .as_mut()
                    .filter(|desk| Arc::ptr_eq(&identity, &desk.identity))
                else {
                    return;
                };
                desk.busy = false;
                let observed_revision = root
                    .svc
                    .store
                    .client_controls_revision(&desk.client_id)
                    .ok()
                    .flatten();
                if let Ok(Some(current)) = result {
                    let retry = desk.apply_response(
                        current,
                        saving,
                        requested_revision,
                        observed_revision,
                        cx,
                    );
                    cx.notify();
                    if retry {
                        root.request_client_controls(None, cx);
                    } else {
                        root.refresh_client_controls(cx);
                    }
                    return;
                }
                desk.message = match result {
                    Ok(Some(_)) => unreachable!(),
                    Ok(None) => {
                        desk.must_reload = true;
                        Some(Key::ClientControlChanged)
                    }
                    Err(TransportError::Unauthorized | TransportError::Forbidden(_)) => {
                        desk.current = None;
                        desk.tags.update(cx, |field, cx| field.clear(cx));
                        desk.reason.update(cx, |field, cx| field.clear(cx));
                        Some(Key::ClientControlUnavailable)
                    }
                    Err(TransportError::BadRequest(_)) => Some(if saving {
                        Key::ClientControlInvalid
                    } else {
                        Key::ClientControlUnavailable
                    }),
                    Err(_) if saving => {
                        desk.must_reload = true;
                        Some(Key::ClientControlChanged)
                    }
                    Err(_) => Some(Key::ClientControlUnavailable),
                };
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_client_controls(&self, desk: &Desk, cx: &mut Context<Self>) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let ready = online && !desk.busy;
        let allow_save = ready && !desk.must_reload && desk.change(cx).is_some();
        let body = div()
            .id("client-controls")
            .max_h(px(520.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::ClientControls)),
            )
            .child(desk.name.clone())
            .when(!online, |body| body.child(self.t(Key::ClientControlOnline)))
            .when(desk.busy, |body| {
                body.child(self.t(Key::ClientControlLoading))
            })
            .when_some(
                desk.current
                    .as_ref()
                    .filter(|_| !desk.busy && !desk.confirm_back),
                |body, current| {
                    body.child(self.directory_field(Key::ClientControlTags, desk.tags.clone()))
                        .child(
                            div()
                                .text_sm()
                                .text_color(theme::muted())
                                .child(self.t(Key::ClientControlTagsHint)),
                        )
                        .child(div().text_sm().child(format!(
                            "{} · {}",
                            self.t(Key::ClientControlCurrentTags),
                            current.tags.join(", ")
                        )))
                        .child(self.t(access_label(current.booking_access)))
                        .when_some(current.reason.as_ref(), |body, reason| {
                            body.child(div().text_sm().child(reason.clone()))
                        })
                        .when(current.can_manage_booking_access && ready, |body| {
                            body.child(
                                div().flex().flex_wrap().gap_2().children(
                                    [
                                        BookingAccess::Normal,
                                        BookingAccess::Trusted,
                                        BookingAccess::Blocked,
                                    ]
                                    .into_iter()
                                    .enumerate()
                                    .map(|(index, access)| {
                                        self.directory_button(
                                            ("client-access", index),
                                            self.t(access_label(access)),
                                            if desk.access == access {
                                                Kind::Primary
                                            } else {
                                                Kind::Ghost
                                            },
                                            cx.listener(move |root, _, _, cx| {
                                                if let Overlay::Directory(directory) =
                                                    &mut root.overlay
                                                    && let Some(desk) = &mut directory.controls
                                                {
                                                    desk.access = access;
                                                    cx.notify();
                                                }
                                            }),
                                        )
                                    }),
                                ),
                            )
                        })
                        .when(
                            current.can_manage_booking_access
                                && desk.access != current.booking_access,
                            |body| {
                                body.child(
                                    self.directory_field(
                                        Key::ClientControlReason,
                                        desk.reason.clone(),
                                    ),
                                )
                            },
                        )
                },
            )
            .when_some(desk.message, |body, message| {
                body.child(div().text_sm().child(self.t(message)))
            })
            .when(desk.confirm_back, |body| {
                body.child(self.t(Key::SalonConfirmDiscard))
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .justify_end()
                    .when(desk.confirm_back, |row| {
                        row.child(self.directory_button(
                            "client-controls-keep",
                            self.t(Key::ReviewKeepEditing),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::Directory(directory) = &mut root.overlay
                                    && let Some(desk) = &mut directory.controls
                                {
                                    desk.confirm_back = false;
                                    cx.notify();
                                    root.refresh_client_controls(cx);
                                }
                            }),
                        ))
                    })
                    .when(!desk.busy, |row| {
                        row.child(self.directory_button(
                            "client-controls-back",
                            self.t(if desk.confirm_back {
                                Key::SalonDiscard
                            } else {
                                Key::Back
                            }),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::Directory(directory) = &mut root.overlay
                                    && directory
                                        .controls
                                        .as_ref()
                                        .is_some_and(|desk| desk.confirm_back && !desk.busy)
                                {
                                    directory.controls = None;
                                    cx.notify();
                                } else {
                                    root.back_client_controls(cx);
                                }
                            }),
                        ))
                    })
                    .when(ready && !desk.confirm_back, |row| {
                        row.child(self.directory_button(
                            "client-controls-reload",
                            self.t(Key::ClientControlReload),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.request_client_controls(None, cx)),
                        ))
                    })
                    .when(allow_save && !desk.confirm_back, |row| {
                        row.child(self.directory_button(
                            "client-controls-save",
                            self.t(Key::DirectorySave),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.save_client_controls(cx)),
                        ))
                    }),
            );
        self.modal(div().child(body))
    }
}

fn access_label(access: BookingAccess) -> Key {
    match access {
        BookingAccess::Normal => Key::ClientControlNormal,
        BookingAccess::Trusted => Key::ClientControlTrusted,
        BookingAccess::Blocked => Key::ClientControlBlocked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn a_cloud_update_preserves_drafts_in_both_client_panels(cx: &mut TestAppContext) {
        let (_dir, window) = crate::root::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.svc
                    .store
                    .set_meta("client_directory", "allowed")
                    .unwrap();
                root.open_directory(cx);
                let Overlay::Directory(directory) = &root.overlay else {
                    panic!("missing directory")
                };
                let contact = directory.contacts.clients[0].clone();
                root.directory_form(Some(&contact.id), cx);
                root.open_client_controls(cx);
                let snapshot = |version, access| ClientControls {
                    client_id: contact.id.clone(),
                    tags: vec!["regular".into()],
                    booking_access: access,
                    reason: None,
                    version,
                    can_manage_booking_access: true,
                };
                {
                    let Overlay::Directory(directory) = &mut root.overlay else {
                        panic!("missing directory")
                    };
                    directory
                        .form
                        .as_ref()
                        .unwrap()
                        .notes
                        .update(cx, |field, cx| field.set_text("Unsaved contact notes", cx));
                    let desk = directory.controls.as_mut().unwrap();
                    desk.apply_snapshot(snapshot(1, BookingAccess::Normal), false, cx);
                    desk.tags
                        .update(cx, |field, cx| field.set_text("colour", cx));
                    directory.contacts.clients[0].controls_version = Some(2);
                }
                root.back_client_controls(cx);
                root.refresh_client_controls(cx);
                assert!(matches!(&root.overlay, Overlay::Directory(directory) if directory.controls.as_ref().is_some_and(|desk| desk.confirm_back && !desk.must_reload)));
                root.back_client_controls(cx);
                let Overlay::Directory(directory) = &mut root.overlay else {
                    panic!("missing directory")
                };
                let desk = directory.controls.as_mut().unwrap();
                assert!(desk.must_reload);
                desk.apply_snapshot(snapshot(2, BookingAccess::Blocked), true, cx);
                let change = desk.change(cx).unwrap();
                assert_eq!(change.version, 2);
                assert_eq!(change.tags.unwrap(), vec!["colour"]);
                assert!(change.booking_access.is_none());
                assert!(change.reason.is_none());
                assert_eq!(
                    directory.form.as_ref().unwrap().notes.read(cx).text(),
                    "Unsaved contact notes"
                );

                desk.apply_snapshot(snapshot(3, BookingAccess::Normal), false, cx);
                desk.access = BookingAccess::Blocked;
                desk.reason.update(cx, |field, cx| field.set_text("Keep this reason", cx));
                assert!(desk.apply_response(snapshot(4, BookingAccess::Blocked), false, Some(3), Some(5), cx));
                assert!(!desk.apply_response(snapshot(4, BookingAccess::Blocked), false, Some(5), Some(5), cx));
                assert!(desk.must_reload);
                assert_eq!(desk.current.as_ref().unwrap().version, 3);
                assert!(!desk.apply_response(snapshot(5, BookingAccess::Trusted), false, Some(5), Some(5), cx));
                let change = desk.change(cx).unwrap();
                assert_eq!(change.booking_access, Some(BookingAccess::Blocked));
                assert_eq!(change.reason.as_deref(), Some("Keep this reason"));
            })
            .unwrap();
    }
}
