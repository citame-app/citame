use super::*;
use sob_core::http::{PortraitDirectory, PortraitStaff, PortraitUpdate};
use sob_core::staff_portrait_image::prepare_photo;
use sob_core::sync::TransportError;

struct Photos {
    directory: PortraitDirectory,
    selected: Option<String>,
    preview: Option<Arc<gpui::RenderImage>>,
    unavailable: bool,
}

impl Photos {
    fn current(&self) -> Option<&PortraitStaff> {
        let id = self.selected.as_deref()?;
        self.directory.staff.iter().find(|member| member.id == id)
    }
}

pub(super) struct Desk {
    instance: Arc<()>,
    photos: Option<Photos>,
    busy: bool,
    notice: Option<Key>,
    pub(super) confirming_removal: bool,
    draft: Option<PortraitUpdate>,
    preview_scope: Option<Entity<Arc<gpui::RenderImage>>>,
    observed_revision: i64,
    refresh_pending: bool,
    retry_at: Option<Instant>,
}

enum Action {
    Load,
    Change(PortraitUpdate),
}

impl Root {
    pub(super) fn open_staff_portraits(&mut self, cx: &mut Context<Self>) {
        self.overlay = Overlay::StaffPortraits(Box::new(Desk {
            instance: Arc::new(()),
            photos: None,
            busy: false,
            notice: None,
            confirming_removal: false,
            draft: None,
            preview_scope: None,
            observed_revision: 0,
            refresh_pending: false,
            retry_at: None,
        }));
        self.staff_portrait_request(None, Action::Load, cx);
    }

    pub(super) fn refresh_staff_portraits(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let Overlay::StaffPortraits(desk) = &mut self.overlay else {
            return;
        };
        desk.refresh_pending |= reconnected;
        if !desk.busy
            && desk.draft.is_none()
            && !desk.confirming_removal
            && desk.retry_at.map_or_else(
                || {
                    desk.refresh_pending
                        || self
                            .svc
                            .store
                            .staff_directory_revision()
                            .is_ok_and(|revision| revision != desk.observed_revision)
                },
                |retry| Instant::now() >= retry,
            )
        {
            self.staff_portrait_request(None, Action::Load, cx);
        }
    }

    fn staff_portrait_request(
        &mut self,
        selected: Option<String>,
        action: Action,
        cx: &mut Context<Self>,
    ) {
        let Overlay::StaffPortraits(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy
            || match action {
                Action::Load => desk.draft.is_some() || desk.confirming_removal,
                Action::Change(_) => {
                    self.status.connectivity == Connectivity::Offline || desk.retry_at.is_some()
                }
            }
        {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            desk.notice = Some(Key::StaffPortraitOffline);
            cx.notify();
            return;
        };
        let instance = desk.instance.clone();
        let session = self.svc.session.clone();
        let selected = selected.or_else(|| desk.photos.as_ref()?.selected.clone());
        let renderer = cx.svg_renderer();
        desk.draft = None;
        desk.observed_revision = self.svc.store.staff_directory_revision().unwrap_or(0);
        desk.refresh_pending = false;
        desk.retry_at = None;
        desk.busy = true;
        desk.notice = None;
        desk.confirming_removal = false;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let (photos, notice, retry_after) =
                cx.background_executor()
                    .spawn(async move {
                        let update = match action {
                            Action::Load => None,
                            Action::Change(update) => Some(update),
                        };
                        let notice = update.and_then(|update| {
                            selected.as_deref().map(|id| {
                                match transport.set_staff_portrait(id, update) {
                                    Ok(()) => Key::StaffPortraitSaved,
                                    Err(_) => Key::StaffPortraitChangeFailed,
                                }
                            })
                        });
                        let directory = match transport.portrait_directory() {
                            Ok(directory) => directory,
                            Err(error) => {
                                let failed = if matches!(error, TransportError::Offline(_)) {
                                    Key::StaffPortraitOffline
                                } else {
                                    Key::StaffPortraitFailure
                                };
                                let retry_after = match error {
                                    TransportError::RateLimited(delay) => {
                                        Some(delay.unwrap_or(Duration::from_secs(5)))
                                    }
                                    TransportError::Offline(_) | TransportError::Server(_) => {
                                        Some(Duration::from_secs(5))
                                    }
                                    _ => None,
                                };
                                return (None, notice.or(Some(failed)), retry_after);
                            }
                        };
                        let member = selected
                            .as_deref()
                            .and_then(|id| directory.staff.iter().find(|member| member.id == id))
                            .or_else(|| directory.staff.first());
                        let selected = member.map(|member| member.id.clone());
                        let preview = member.and_then(|member| {
                            member.portrait_version.as_ref().map(|version| {
                                transport.staff_portrait(&member.id, version).ok().and_then(
                                    |bytes| {
                                        gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, bytes)
                                            .to_image_data(renderer.clone())
                                            .ok()
                                    },
                                )
                            })
                        });
                        let unavailable = preview.as_ref().is_some_and(Option::is_none);
                        (
                            Some(Photos {
                                directory,
                                selected,
                                preview: preview.flatten(),
                                unavailable,
                            }),
                            notice,
                            None,
                        )
                    })
                    .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) {
                    return;
                }
                let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&desk.instance, &instance) {
                    return;
                }
                desk.busy = false;
                if photos.is_some() || retry_after.is_none() {
                    desk.preview_scope = photos
                        .as_ref()
                        .and_then(|photos| photos.preview.clone())
                        .map(|image| {
                            cx.new(|cx| {
                                cx.on_release(|image: &mut Arc<gpui::RenderImage>, app| {
                                    app.drop_image(image.clone(), None);
                                })
                                .detach();
                                image
                            })
                        });
                    desk.photos = photos;
                }
                desk.notice = notice;
                desk.retry_at = retry_after.and_then(|delay| Instant::now().checked_add(delay));
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_staff_portraits(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let content = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .font_weight(FontWeight::BOLD)
                            .text_lg()
                            .child(self.t(Key::StaffPortraits)),
                    )
                    .child(self.button(
                        "staff-photos-close",
                        self.t(Key::Close),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                    )),
            )
            .when_some(desk.notice, |view, notice| {
                view.child(div().text_sm().child(self.t(notice)))
            })
            .when(
                self.status.connectivity == Connectivity::Offline && desk.notice.is_none(),
                |view| view.child(div().text_sm().child(self.t(Key::StaffPortraitOffline))),
            )
            .when(desk.busy, |view| {
                view.child(div().text_sm().child(self.t(Key::StaffPortraitLoading)))
            })
            .when(
                !desk.busy && desk.draft.is_none() && !desk.confirming_removal,
                |view| {
                    view.child(self.button(
                        "staff-photos-refresh",
                        self.t(Key::InboxRefresh),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            root.staff_portrait_request(None, Action::Load, cx)
                        }),
                    ))
                },
            )
            .when_some(desk.photos.as_ref(), |view, photos| {
                view.when(photos.directory.staff.is_empty(), |view| {
                    view.child(div().text_sm().child(self.t(Key::StaffPortraitEmpty)))
                })
                .child(div().flex().flex_wrap().gap_2().children(
                    photos.directory.staff.iter().map(|member| {
                        let id = member.id.clone();
                        let kind = if photos.selected.as_deref() == Some(&member.id) {
                            Kind::Primary
                        } else {
                            Kind::Ghost
                        };
                        let name = if member.active {
                            member.display_name.clone()
                        } else {
                            format!(
                                "{} · {}",
                                member.display_name,
                                self.t(Key::StaffPortraitInactive)
                            )
                        };
                        self.button(
                            SharedString::from(format!("staff-photo-select-{id}")),
                            name,
                            kind,
                            cx.listener(move |root, _, _, cx| {
                                root.staff_portrait_request(Some(id.clone()), Action::Load, cx)
                            }),
                        )
                    }),
                ))
                .when_some(photos.current(), |view, member| {
                    let version = member.portrait_version.clone();
                    let status = match &version {
                        Some(_) if member.active && member.portrait_published => {
                            Key::StaffPortraitPublic
                        }
                        Some(_) => Key::StaffPortraitPrivate,
                        None => Key::StaffPortraitNone,
                    };
                    view.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap_3()
                            .when_some(photos.preview.as_ref(), |row, preview| {
                                row.child(
                                    gpui::img(preview.clone())
                                        .size(px(88.))
                                        .rounded_md()
                                        .object_fit(gpui::ObjectFit::Cover),
                                )
                            })
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .child(
                                        div()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(member.display_name.clone()),
                                    )
                                    .child(
                                        div()
                                            .text_sm()
                                            .text_color(theme::muted())
                                            .child(self.t(status)),
                                    )
                                    .when(photos.unavailable, |column| {
                                        column.child(
                                            div()
                                                .text_sm()
                                                .child(self.t(Key::StaffPortraitFailure)),
                                        )
                                    }),
                            ),
                    )
                    .when(!photos.directory.can_edit, |view| {
                        view.child(div().text_sm().child(self.t(Key::StaffPortraitReadOnly)))
                    })
                    .when(
                        photos.directory.can_edit
                            && !desk.busy
                            && desk.retry_at.is_none()
                            && self.status.connectivity != Connectivity::Offline,
                        |view| {
                            view.child(self.render_staff_photo_actions(
                                member,
                                desk.confirming_removal,
                                photos.preview.is_some(),
                                desk.draft.is_some(),
                                cx,
                            ))
                        },
                    )
                })
            });
        let width = (viewport.width - px(32.)).clamp(px(260.), px(640.));
        let height = (viewport.height - px(32.)).max(px(180.));
        self.modal_with_height(
            div().child(
                div()
                    .id("staff-photos-panel")
                    .overflow_y_scroll()
                    .max_h((height - px(40.)).max(px(140.)))
                    .child(content),
            ),
            width,
            height,
            Some(cx),
        )
    }

    fn choose_staff_photo(&mut self, version: Option<String>, cx: &mut Context<Self>) {
        let prompt = self.t(Key::StaffPortraitUpload);
        let Overlay::StaffPortraits(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy || self.status.connectivity == Connectivity::Offline {
            return;
        }
        desk.busy = true;
        desk.notice = None;
        desk.confirming_removal = false;
        let instance = desk.instance.clone();
        let session = self.svc.session.clone();
        let picker = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(prompt.into()),
        });
        cx.notify();
        cx.spawn(async move |root, cx| {
            let selected = match picker.await {
                Ok(Ok(paths)) => match paths.and_then(|paths| paths.into_iter().next()) {
                    None => Ok(None),
                    Some(path) => {
                        cx.background_executor()
                            .spawn(async move {
                                prepare_photo(&path)
                                    .map(Some)
                                    .ok_or(Key::StaffPortraitInvalid)
                            })
                            .await
                    }
                },
                _ => Err(Key::StaffPortraitInvalid),
            };
            let _ = root.update(cx, |root, cx| {
                let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&desk.instance, &instance)
                    || !Arc::ptr_eq(&root.svc.session, &session)
                {
                    return;
                }
                desk.busy = false;
                match selected {
                    Ok(Some(jpeg)) => desk.draft = Some(PortraitUpdate::Upload { version, jpeg }),
                    Ok(None) => {}
                    Err(error) => desk.notice = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn render_staff_photo_actions(
        &self,
        member: &PortraitStaff,
        confirming: bool,
        previewed: bool,
        has_draft: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let version = member.portrait_version.clone();
        let upload_version = member.upload_version().map(str::to_owned);
        div()
            .flex()
            .flex_wrap()
            .gap_2()
            .child(self.button(
                "staff-photo-upload",
                self.t(Key::StaffPortraitUpload),
                Kind::Primary,
                cx.listener(move |root, _, _, cx| {
                    root.choose_staff_photo(upload_version.clone(), cx)
                }),
            ))
            .when(has_draft, |row| {
                row.child(self.button(
                    "staff-photo-save",
                    self.t(Key::StaffPortraitSave),
                    Kind::Primary,
                    cx.listener(|root, _, _, cx| {
                        let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                            return;
                        };
                        if let Some(update) = desk.draft.take() {
                            root.staff_portrait_request(None, Action::Change(update), cx);
                        }
                    }),
                ))
                .child(self.button(
                    "staff-photo-discard",
                    self.t(Key::Cancel),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        if let Overlay::StaffPortraits(desk) = &mut root.overlay {
                            desk.draft = None;
                            cx.notify();
                        }
                    }),
                ))
            })
            .when_some(version, |row, version| {
                let publication = version.clone();
                let published = !member.portrait_published;
                row.when(previewed || !published, |row| {
                    row.child(self.button(
                        "staff-photo-publish",
                        self.t(if published {
                            Key::StaffPortraitPublish
                        } else {
                            Key::StaffPortraitUnpublish
                        }),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            root.staff_portrait_request(
                                None,
                                Action::Change(PortraitUpdate::Publish {
                                    version: publication.clone(),
                                    published,
                                }),
                                cx,
                            )
                        }),
                    ))
                })
                .child(
                    self.button(
                        "staff-photo-remove",
                        self.t(if confirming {
                            Key::StaffPortraitRemoveConfirm
                        } else {
                            Key::StaffPortraitRemove
                        }),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            if confirming {
                                root.staff_portrait_request(
                                    None,
                                    Action::Change(PortraitUpdate::Remove {
                                        version: version.clone(),
                                    }),
                                    cx,
                                );
                            } else if let Overlay::StaffPortraits(desk) = &mut root.overlay {
                                desk.confirming_removal = true;
                                cx.notify();
                            }
                        }),
                    )
                    .debug_selector(|| "staff-photo-remove".to_owned()),
                )
                .when(confirming, |row| {
                    row.child(self.button(
                        "staff-photo-keep",
                        self.t(Key::Cancel),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            if let Overlay::StaffPortraits(desk) = &mut root.overlay {
                                desk.confirming_removal = false;
                                cx.notify();
                            }
                        }),
                    ))
                })
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn live_staff_refresh_waits_for_an_unsaved_photo_or_removal_confirmation(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            assert!(root.svc.transport().is_none());
            root.open_staff_portraits(cx);
            let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                panic!("missing portrait desk");
            };
            desk.notice = None;
            desk.draft = Some(PortraitUpdate::Upload {
                version: Some("reviewed-version".into()),
                jpeg: vec![],
            });
            root.refresh_staff_portraits(true, cx);
            let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                panic!("missing portrait desk");
            };
            assert!(
                matches!(&desk.draft, Some(PortraitUpdate::Upload { version, .. })
                if version.as_deref() == Some("reviewed-version"))
            );
            assert!(desk.notice.is_none());
            desk.draft = None;
            desk.confirming_removal = true;
            root.refresh_staff_portraits(true, cx);
            let Overlay::StaffPortraits(desk) = &mut root.overlay else {
                panic!("missing portrait desk");
            };
            assert!(desk.confirming_removal);
            assert!(desk.notice.is_none());
            desk.confirming_removal = false;
            root.refresh_staff_portraits(false, cx);
            assert!(matches!(&root.overlay, Overlay::StaffPortraits(desk)
                if desk.notice == Some(Key::StaffPortraitOffline)));
        });
    }

    #[gpui::test]
    async fn staff_portrait_removal_stays_available_without_preview_but_requires_confirmation(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(620.), px(440.)));
        root.update(cx, |root, cx| {
            root.status.connectivity = Connectivity::Online;
            root.overlay = Overlay::StaffPortraits(Box::new(Desk {
                instance: Arc::new(()),
                photos: Some(Photos {
                    directory: PortraitDirectory {
                        can_edit: true,
                        staff: vec![PortraitStaff {
                            id: "member".to_owned(),
                            display_name: "Team member".to_owned(),
                            active: true,
                            portrait_version: Some("version".to_owned()),
                            portrait_absence_version: None,
                            portrait_published: true,
                        }],
                    },
                    selected: Some("member".to_owned()),
                    preview: None,
                    unavailable: true,
                }),
                busy: false,
                notice: None,
                confirming_removal: false,
                draft: None,
                preview_scope: None,
                observed_revision: 0,
                refresh_pending: false,
                retry_at: None,
            }));
            cx.notify();
        });
        cx.run_until_parked();
        let remove = cx.debug_bounds("staff-photo-remove").unwrap();
        cx.simulate_click(remove.center(), Default::default());
        root.update(cx, |root, cx| {
            assert!(
                matches!(&root.overlay, Overlay::StaffPortraits(desk) if desk.confirming_removal)
            );
            root.dismiss_overlay(cx);
            assert!(
                matches!(&root.overlay, Overlay::StaffPortraits(desk) if !desk.confirming_removal)
            );
            root.status.connectivity = Connectivity::Offline;
            cx.notify();
        });
        cx.run_until_parked();
        cx.simulate_click(remove.center(), Default::default());
        root.update(cx, |root, _| {
            assert!(
                !matches!(&root.overlay, Overlay::StaffPortraits(desk) if desk.confirming_removal)
            );
        });
    }
}
