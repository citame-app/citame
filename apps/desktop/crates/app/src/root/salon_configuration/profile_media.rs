use super::*;
use sob_core::http::{
    PROFILE_GALLERY_LIMIT, ProfileImage, ProfileImageAction, ProfileImageKind, ProfileImageSnapshot,
};
use sob_core::staff_portrait_image::prepare_photo;
use uuid::Uuid;

const KINDS: [ProfileImageKind; 3] = [
    ProfileImageKind::Logo,
    ProfileImageKind::Cover,
    ProfileImageKind::Gallery,
];

fn label(kind: ProfileImageKind) -> Key {
    match kind {
        ProfileImageKind::Logo => Key::ProfileMediaLogo,
        ProfileImageKind::Cover => Key::ProfileMediaCover,
        ProfileImageKind::Gallery => Key::ProfileMediaGallery,
    }
}

#[derive(Default)]
pub(super) struct MediaDesk {
    pub open: bool,
    busy: bool,
    snapshot: Option<ProfileImageSnapshot>,
    selected: Option<Uuid>,
    preview: Option<Entity<Arc<gpui::RenderImage>>>,
    draft: Option<ImageDraft>,
    remove: Option<(ProfileImageSnapshot, Uuid)>,
    notice: Option<Key>,
    requires_review: bool,
    observed: Option<DateTime<Utc>>,
}

struct ImageDraft {
    jpeg: Vec<u8>,
    alt: Entity<TextField>,
    kind: ProfileImageKind,
    replace: Option<Uuid>,
    base: ProfileImageSnapshot,
}

impl ImageDraft {
    fn description<'a>(&'a self, cx: &'a App) -> Option<&'a str> {
        let alt = self.alt.read(cx).text().trim();
        (!alt.is_empty() && alt.encode_utf16().count() <= 160 && !alt.chars().any(char::is_control))
            .then_some(alt)
    }

    fn missing_replacement(&self, snapshot: Option<&ProfileImageSnapshot>) -> bool {
        self.replace.is_some_and(|id| {
            snapshot.is_none_or(|snapshot| !snapshot.images.iter().any(|image| image.id == id))
        })
    }
}

fn can_add_image(snapshot: &ProfileImageSnapshot, kind: ProfileImageKind) -> bool {
    let count = snapshot
        .images
        .iter()
        .filter(|image| image.kind == kind)
        .count();
    count
        < if kind == ProfileImageKind::Gallery {
            PROFILE_GALLERY_LIMIT
        } else {
            1
        }
}

enum Request {
    Load,
    Review,
    Write(ProfileImageSnapshot, ProfileImageAction),
}

impl MediaDesk {
    pub fn busy(&self) -> bool {
        self.busy
    }

    pub fn dirty(&self) -> bool {
        self.draft.is_some()
    }

    pub fn reset_request(&mut self) {
        self.busy = false;
        self.requires_review = true;
    }
}

impl Root {
    fn profile_media(&mut self) -> Option<&mut MediaDesk> {
        match &mut self.overlay {
            Overlay::SalonConfiguration(desk) if desk.media.open => Some(&mut desk.media),
            _ => None,
        }
    }

    pub(super) fn open_profile_images(&mut self, cx: &mut Context<Self>) {
        if let Overlay::SalonConfiguration(desk) = &mut self.overlay {
            desk.media.open = true;
            cx.notify();
            self.request_profile_images(Request::Load, cx);
        }
    }

    pub(super) fn refresh_profile_images(
        &mut self,
        observed: Option<DateTime<Utc>>,
        reconnect: bool,
        cx: &mut Context<Self>,
    ) {
        let online = self.status.connectivity == Connectivity::Online;
        let Some(media) = self.profile_media() else {
            return;
        };
        if online && !media.busy && (reconnect || media.observed != observed) {
            media.observed = observed;
            if media.draft.is_some() {
                media.requires_review = true;
                cx.notify();
            } else if media.remove.is_none() {
                self.request_profile_images(Request::Load, cx);
            }
        }
    }

    fn request_profile_images(&mut self, request: Request, cx: &mut Context<Self>) {
        let transport = self.svc.transport();
        let session = self.svc.session.clone();
        let online = self.status.connectivity == Connectivity::Online;
        let Overlay::SalonConfiguration(desk) = &mut self.overlay else {
            return;
        };
        let media = &mut desk.media;
        if !media.open || media.busy || !online {
            return;
        }
        let Some(transport) = transport else { return };
        let instance = desk.instance.clone();
        let selected = media.selected;
        let svg = cx.svg_renderer();
        media.busy = true;
        media.notice = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let reviewed = matches!(request, Request::Review);
            let writing = matches!(request, Request::Write(..));
            let (snapshot, preview, written) = cx
                .background_executor()
                .spawn(async move {
                    let (snapshot, written) = match request {
                        Request::Write(base, action) => {
                            match transport.update_profile_image(&base, action) {
                                Ok(saved) => (Some(saved), true),
                                Err(_) => (transport.profile_images().ok(), false),
                            }
                        }
                        _ => (transport.profile_images().ok(), false),
                    };
                    let preview = snapshot.as_ref().and_then(|snapshot| {
                        let asset = snapshot
                            .images
                            .iter()
                            .find(|row| Some(row.id) == selected)?;
                        let bytes = transport.profile_image(asset).ok()?;
                        gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, bytes)
                            .to_image_data(svg)
                            .ok()
                    });
                    (snapshot, preview, written)
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) {
                    return;
                }
                let Overlay::SalonConfiguration(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&desk.instance, &instance) {
                    return;
                }
                let media = &mut desk.media;
                media.busy = false;
                if written {
                    media.draft = None;
                    media.remove = None;
                    media.requires_review = false;
                } else if writing {
                    media.remove = None;
                    media.requires_review = true;
                }
                media.notice = match (writing, written, snapshot.is_some()) {
                    (_, true, _) => Some(Key::StaffPortraitSaved),
                    (true, false, _) => Some(Key::StaffPortraitChangeFailed),
                    (_, _, false) => Some(Key::StaffPortraitFailure),
                    _ => None,
                };
                if let Some(snapshot) = snapshot {
                    if reviewed {
                        media.requires_review = false;
                        if let Some(draft) = &mut media.draft {
                            draft.base = snapshot.clone();
                        }
                    }
                    media.snapshot = Some(snapshot);
                    media.preview = preview.map(|image| {
                        cx.new(|cx| {
                            cx.on_release(|image: &mut Arc<gpui::RenderImage>, app| {
                                app.drop_image(image.clone(), None)
                            })
                            .detach();
                            image
                        })
                    });
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn choose_profile_image(
        &mut self,
        kind: ProfileImageKind,
        replace: Option<Uuid>,
        cx: &mut Context<Self>,
    ) {
        let caption = self.t(Key::StaffPortraitUpload);
        let placeholder = self.t(Key::ProfileMediaDescription);
        let session = self.svc.session.clone();
        let Overlay::SalonConfiguration(desk) = &mut self.overlay else {
            return;
        };
        let media = &mut desk.media;
        let Some(base) = media.snapshot.clone() else {
            return;
        };
        if media.busy || media.draft.is_some() {
            return;
        }
        let alt = replace
            .and_then(|id| base.images.iter().find(|row| row.id == id))
            .map(|row| row.alt.clone())
            .unwrap_or_default();
        let instance = desk.instance.clone();
        media.busy = true;
        let picker = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(caption.into()),
        });
        cx.notify();
        cx.spawn(async move |root, cx| {
            let image = match picker.await {
                Ok(Ok(paths)) => match paths.and_then(|paths| paths.into_iter().next()) {
                    Some(path) => {
                        cx.background_executor()
                            .spawn(async move {
                                prepare_photo(&path)
                                    .map(Some)
                                    .ok_or(Key::StaffPortraitInvalid)
                            })
                            .await
                    }
                    None => Ok(None),
                },
                _ => Err(Key::StaffPortraitInvalid),
            };
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) {
                    return;
                }
                let Overlay::SalonConfiguration(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&desk.instance, &instance) {
                    return;
                }
                let media = &mut desk.media;
                media.busy = false;
                match image {
                    Ok(Some(jpeg)) => {
                        let alt = cx.new(|cx| {
                            let mut field = TextField::new(placeholder, false, cx);
                            field.set_text(&alt, cx);
                            field
                        });
                        cx.observe(&alt, |_, _, cx| cx.notify()).detach();
                        media.draft = Some(ImageDraft {
                            jpeg,
                            alt,
                            kind,
                            replace,
                            base,
                        });
                    }
                    Ok(None) => {}
                    Err(notice) => media.notice = Some(notice),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn save_profile_image(&mut self, cx: &mut Context<Self>) {
        let Some(media) = self.profile_media() else {
            return;
        };
        let Some(draft) = &media.draft else { return };
        let Some(alt) = draft.description(cx) else {
            return;
        };
        if media.requires_review || draft.missing_replacement(media.snapshot.as_ref()) {
            return;
        }
        let request = Request::Write(
            draft.base.clone(),
            ProfileImageAction::Upload {
                jpeg: draft.jpeg.clone(),
                kind: draft.kind,
                replace_id: draft.replace,
                alt: alt.into(),
            },
        );
        self.request_profile_images(request, cx);
    }

    pub(super) fn render_profile_images(
        &self,
        media: &MediaDesk,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let editing = media.busy || media.dirty() || media.remove.is_some();
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::BOLD)
                    .child(self.t(Key::ProfileMediaTitle)),
            )
            .when_some(media.notice, |view, notice| view.child(self.t(notice)))
            .when(media.busy, |view| {
                view.child(self.t(Key::CloudWorkspacesLoading))
            })
            .when(!online, |view| {
                view.child(self.t(Key::SalonNeedsConnection))
            })
            .when_some(media.snapshot.as_ref(), |view, snapshot| {
                view.children(KINDS.map(|kind| {
                    let images: Vec<_> = snapshot
                        .images
                        .iter()
                        .filter(|row| row.kind == kind)
                        .collect();
                    let can_add = can_add_image(snapshot, kind);
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .rounded_md()
                        .border_1()
                        .border_color(theme::line())
                        .p_3()
                        .child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(self.t(label(kind))),
                        )
                        .children(images.into_iter().map(|image| {
                            let id = image.id;
                            let publish = !image.published;
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .child(div().text_sm().child(image.alt.clone()).child(" · ").child(
                                    self.t(if publish {
                                        Key::ProfileMediaDraft
                                    } else {
                                        Key::ProfileMediaPublished
                                    }),
                                ))
                                .when_some(
                                    media
                                        .preview
                                        .as_ref()
                                        .filter(|_| media.selected == Some(id)),
                                    |view, preview| {
                                        view.child(
                                            gpui::img(preview.read(cx).clone())
                                                .w_full()
                                                .h(px(140.))
                                                .object_fit(gpui::ObjectFit::Contain),
                                        )
                                    },
                                )
                                .when(!editing, |view| {
                                    view.child(
                                        self.profile_image_actions(snapshot, image, online, cx),
                                    )
                                })
                        }))
                        .when(can_add && !editing, |view| {
                            view.child(self.button(
                                self.t(label(kind)),
                                self.t(Key::StaffPortraitUpload),
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    root.choose_profile_image(kind, None, cx)
                                }),
                            ))
                        })
                }))
            })
            .when_some(media.draft.as_ref(), |view, draft| {
                let missing = draft.missing_replacement(media.snapshot.as_ref());
                let can_save =
                    draft.description(cx).is_some() && !media.requires_review && !missing;
                let can_keep_new = missing
                    && !media.requires_review
                    && media
                        .snapshot
                        .as_ref()
                        .is_some_and(|snapshot| can_add_image(snapshot, draft.kind));
                view.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(self.t(label(draft.kind)))
                        .child(self.t(Key::ProfileMediaDescription))
                        .when(!media.busy, |view| view.child(draft.alt.clone()))
                        .when(media.busy, |view| {
                            view.child(draft.alt.read(cx).text().to_owned())
                        })
                        .when(missing, |view| view.child(self.t(Key::ProfileMediaMissing)))
                        .when(!media.busy, |view| {
                            view.child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .gap_2()
                                    .when(can_save && online, |actions| {
                                        actions.child(self.button(
                                            "profile-image-save",
                                            self.t(Key::ProfileMediaSaveDraft),
                                            Kind::Primary,
                                            cx.listener(|root, _, _, cx| {
                                                root.save_profile_image(cx)
                                            }),
                                        ))
                                    })
                                    .when(media.requires_review && online, |actions| {
                                        actions.child(self.button(
                                            "profile-image-review",
                                            self.t(Key::ProfileMediaReview),
                                            Kind::Ghost,
                                            cx.listener(|root, _, _, cx| {
                                                root.request_profile_images(Request::Review, cx)
                                            }),
                                        ))
                                    })
                                    .when(can_keep_new, |actions| {
                                        actions.child(self.button(
                                            "profile-image-keep-new",
                                            self.t(Key::ProfileMediaKeepNew),
                                            Kind::Ghost,
                                            cx.listener(|root, _, _, cx| {
                                                if let Some(draft) = root
                                                    .profile_media()
                                                    .and_then(|media| media.draft.as_mut())
                                                {
                                                    draft.replace = None;
                                                }
                                                cx.notify();
                                            }),
                                        ))
                                    })
                                    .child(self.button(
                                        "profile-image-cancel",
                                        self.t(Key::Cancel),
                                        Kind::Ghost,
                                        cx.listener(|root, _, _, cx| {
                                            if let Some(media) = root.profile_media() {
                                                media.draft = None;
                                            }
                                            cx.notify();
                                        }),
                                    )),
                            )
                        }),
                )
            })
            .when_some(media.remove.as_ref(), |view, _| {
                view.child(self.t(Key::ProfileMediaConfirmRemove))
                    .when(!media.busy, |view| {
                        view.child(
                            div()
                                .flex()
                                .flex_wrap()
                                .gap_2()
                                .when(online, |actions| {
                                    actions.child(self.button(
                                        "profile-image-confirm-remove",
                                        self.t(Key::StaffPortraitRemoveConfirm),
                                        Kind::Primary,
                                        cx.listener(|root, _, _, cx| {
                                            if let Some((base, id)) = root
                                                .profile_media()
                                                .and_then(|media| media.remove.clone())
                                            {
                                                root.request_profile_images(
                                                    Request::Write(
                                                        base,
                                                        ProfileImageAction::Remove { id },
                                                    ),
                                                    cx,
                                                );
                                            }
                                        }),
                                    ))
                                })
                                .child(self.button(
                                    "profile-image-cancel-remove",
                                    self.t(Key::Cancel),
                                    Kind::Ghost,
                                    cx.listener(|root, _, _, cx| {
                                        if let Some(media) = root.profile_media() {
                                            media.remove = None;
                                        }
                                        cx.notify();
                                    }),
                                )),
                        )
                    })
            })
            .when(!editing, |view| {
                view.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .when(online, |actions| {
                            actions.child(self.button(
                                "profile-image-reload",
                                self.t(Key::FormReload),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| {
                                    root.request_profile_images(Request::Load, cx)
                                }),
                            ))
                        })
                        .child(
                            self.button(
                                "profile-image-back",
                                self.t(Key::Back),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| {
                                    if let Some(media) = root.profile_media() {
                                        media.open = false;
                                        media.preview = None;
                                    }
                                    cx.notify();
                                }),
                            )
                            .debug_selector(|| "profile-image-back".to_string()),
                        ),
                )
            })
    }

    fn profile_image_actions(
        &self,
        base: &ProfileImageSnapshot,
        image: &ProfileImage,
        online: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let id = image.id;
        let kind = image.kind;
        let publish = !image.published;
        let publication_base = base.clone();
        let removal_base = base.clone();
        div()
            .flex()
            .flex_wrap()
            .gap_2()
            .when(online, |view| {
                view.child(self.button(
                    SharedString::from(format!("profile-image-preview-{id}")),
                    self.t(Key::ProfileMediaPreview),
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| {
                        if let Some(media) = root.profile_media() {
                            media.selected = Some(id);
                            media.preview = None;
                        }
                        root.request_profile_images(Request::Load, cx);
                    }),
                ))
                .child(self.button(
                    SharedString::from(format!("profile-image-publish-{id}")),
                    self.t(if publish {
                        Key::StaffPortraitPublish
                    } else {
                        Key::StaffPortraitUnpublish
                    }),
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| {
                        root.request_profile_images(
                            Request::Write(
                                publication_base.clone(),
                                ProfileImageAction::Publish {
                                    id,
                                    published: publish,
                                },
                            ),
                            cx,
                        )
                    }),
                ))
                .child(self.button(
                    SharedString::from(format!("profile-image-remove-{id}")),
                    self.t(Key::StaffPortraitRemove),
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| {
                        if let Some(media) = root.profile_media() {
                            media.remove = Some((removal_base.clone(), id));
                        }
                        cx.notify();
                    }),
                ))
            })
            .child(self.button(
                SharedString::from(format!("profile-image-replace-{id}")),
                self.t(Key::ProfileMediaReplace),
                Kind::Ghost,
                cx.listener(move |root, _, _, cx| root.choose_profile_image(kind, Some(id), cx)),
            ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn twelve_centre_photos_can_scroll_to_the_bottom_of_a_short_window(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(640.), px(420.)));
        root.update(cx, |root, cx| {
            root.status.connectivity = Connectivity::Offline;
            root.open_salon_configuration(cx);
            root.open_profile_images(cx);
            let media = root.profile_media().expect("profile image panel");
            media.snapshot = Some(ProfileImageSnapshot {
                generation: "initial".into(),
                revision: "2026-11-22T00:00:00Z".parse().unwrap(),
                images: (0..PROFILE_GALLERY_LIMIT)
                    .map(|index| ProfileImage {
                        id: Uuid::from_u128(index as u128 + 1),
                        version: Uuid::from_u128(index as u128 + 100),
                        alt: format!("Centre photo {index}"),
                        kind: ProfileImageKind::Gallery,
                        published: false,
                    })
                    .collect(),
            });
            cx.notify();
        });
        cx.run_until_parked();
        let scroll = cx.debug_bounds("profile-image-scroll").unwrap();
        let before = cx.debug_bounds("profile-image-back").unwrap();
        assert!(before.bottom() > scroll.bottom());
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: scroll.center(),
            delta: gpui::ScrollDelta::Lines(gpui::point(0., -100.)),
            ..Default::default()
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("profile-image-back").unwrap().bottom() <= scroll.bottom());
    }
}
