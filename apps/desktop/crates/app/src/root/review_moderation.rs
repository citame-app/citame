use super::*;
use sob_core::reviews::{
    LIVE_TOPIC, ManagedReview, ModerationMode as Mode, ReviewPage, ReviewStatus,
};
use sob_core::sync::TransportError;

fn action_label(mode: Mode) -> Key {
    match mode {
        Mode::Publish => Key::ReviewPublish,
        Mode::Hide => Key::ReviewHide,
        Mode::Reply => Key::ReviewSaveReply,
    }
}

struct Editor {
    review: ManagedReview,
    mode: Mode,
    original: String,
    fields: Vec<ReviewLine>,
}

struct ReviewLine {
    field: Entity<TextField>,
    _subscription: Subscription,
}

impl Editor {
    fn text(&self, cx: &App) -> String {
        self.fields
            .iter()
            .map(|line| line.field.read(cx).text())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub(super) struct Desk {
    filter: Option<ReviewStatus>,
    cursors: Vec<Option<String>>,
    page: Option<ReviewPage>,
    editor: Option<Editor>,
    discard: bool,
    busy: bool,
    saving: bool,
    error: Option<Key>,
    observed_revision: i64,
    retry_after: Option<Instant>,
}

impl Desk {
    pub(super) fn dismiss_editor(&mut self, cx: &App) -> bool {
        let Some(editor) = &self.editor else {
            return false;
        };
        if self.busy {
            return true;
        }
        if self.discard {
            self.discard = false;
        } else if editor.text(cx) != editor.original {
            self.discard = true;
        } else {
            self.editor = None;
            self.error = None;
        }
        true
    }
}

fn status_key(status: Option<ReviewStatus>) -> Key {
    match status {
        None => Key::ReviewAll,
        Some(ReviewStatus::Pending) => Key::ReviewPending,
        Some(ReviewStatus::Published) => Key::ReviewPublished,
        Some(ReviewStatus::Hidden) => Key::ReviewHidden,
        Some(ReviewStatus::Withdrawn) => Key::ReviewWithdrawn,
    }
}

enum Action {
    Read,
    Save {
        id: String,
        version: u32,
        mode: Mode,
        text: String,
    },
}

enum ResultPage {
    Read(Result<ReviewPage, TransportError>),
    Saved(Result<(), TransportError>),
}

fn review_line(value: &str, cx: &mut Context<Root>) -> ReviewLine {
    let field = cx.new(|cx| {
        let mut field = TextField::new("", false, cx).with_line_paste(1000);
        field.set_text(value, cx);
        field
    });
    let subscription = cx.subscribe(&field, |root, field, event, cx| {
        let Overlay::ReviewModeration(desk) = &mut root.overlay else {
            return;
        };
        let Some(editor) = desk.editor.as_mut() else {
            return;
        };
        match event {
            FieldEvent::PasteLines(lines) => {
                if let Some(position) = editor.fields.iter().position(|line| line.field == field) {
                    editor.fields.splice(
                        position + 1..position + 1,
                        lines.iter().map(|line| review_line(line, cx)),
                    );
                    cx.notify();
                }
            }
            FieldEvent::PasteTooLong => {
                desk.error = Some(if editor.mode == Mode::Hide {
                    Key::ReviewInvalidReason
                } else {
                    Key::ReviewInvalidReply
                });
                cx.notify();
            }
            _ => {}
        }
    });
    ReviewLine {
        field,
        _subscription: subscription,
    }
}

impl Root {
    pub(super) fn open_review_moderation(&mut self, cx: &mut Context<Self>) {
        self.review_generation = self.review_generation.wrapping_add(1);
        self.overlay = Overlay::ReviewModeration(Box::new(Desk {
            filter: Some(ReviewStatus::Pending),
            cursors: vec![None],
            page: None,
            editor: None,
            discard: false,
            busy: false,
            saving: false,
            error: None,
            observed_revision: 0,
            retry_after: None,
        }));
        self.run_moderation(Action::Read, cx);
    }

    pub(super) fn refresh_review_moderation(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        if matches!(&self.overlay, Overlay::ReviewModeration(desk)
        if !desk.busy && match desk.retry_after {
            Some(after) => reconnected || Instant::now() >= after,
            None => reconnected || self.svc.store.live_view_revision(LIVE_TOPIC).ok()
                .is_some_and(|revision| revision != desk.observed_revision),
        }) {
            self.run_moderation(Action::Read, cx);
        }
    }

    fn run_moderation(&mut self, action: Action, cx: &mut Context<Self>) {
        let Overlay::ReviewModeration(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy {
            return;
        }
        if self.svc.status().connectivity == Connectivity::Offline {
            desk.error = Some(Key::ReviewModerationOffline);
            cx.notify();
            return;
        }
        let Some(transport) = self.svc.transport() else {
            desk.error = Some(Key::ReviewModerationOffline);
            cx.notify();
            return;
        };
        let filter = desk.filter;
        let before = desk.cursors.last().cloned().flatten();
        let generation = self.review_generation;
        let session = self.svc.session.clone();
        if matches!(&action, Action::Read) {
            desk.observed_revision = self
                .svc
                .store
                .live_view_revision(LIVE_TOPIC)
                .unwrap_or_default();
            desk.retry_after = None;
        }
        desk.busy = true;
        desk.saving = matches!(&action, Action::Save { .. });
        if matches!(&action, Action::Save { .. }) || desk.editor.is_none() {
            desk.error = None;
        }
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match action {
                        Action::Read => {
                            ResultPage::Read(transport.managed_reviews(filter, before.as_deref()))
                        }
                        Action::Save {
                            id,
                            version,
                            mode,
                            text,
                        } => {
                            let result = mode
                                .command(&text)
                                .ok_or_else(|| {
                                    TransportError::BadRequest("Invalid moderation text".into())
                                })
                                .and_then(|command| {
                                    transport.update_managed_review(&id, version, command)
                                });
                            ResultPage::Saved(result.map(|_| ()))
                        }
                    }
                })
                .await;
            let _ = view.update(cx, |root, cx| {
                if generation != root.review_generation
                    || !Arc::ptr_eq(&session, &root.svc.session)
                    || root.svc.current_session().is_none()
                {
                    return;
                }
                let Overlay::ReviewModeration(desk) = &mut root.overlay else {
                    return;
                };
                desk.busy = false;
                desk.saving = false;
                let (error, saving) = match result {
                    ResultPage::Read(Ok(page)) => {
                        desk.page = Some(page);
                        cx.notify();
                        return;
                    }
                    ResultPage::Saved(Ok(())) => {
                        desk.editor = None;
                        desk.page = None;
                        root.run_moderation(Action::Read, cx);
                        return;
                    }
                    ResultPage::Read(Err(error)) => (error, false),
                    ResultPage::Saved(Err(error)) => (error, true),
                };
                desk.error = Some(match error {
                    TransportError::Unauthorized | TransportError::Forbidden(_) => {
                        desk.page = None;
                        desk.editor = None;
                        desk.discard = false;
                        Key::ReviewModerationDenied
                    }
                    _ if saving => Key::ReviewChanged,
                    TransportError::Offline(_)
                    | TransportError::Server(_)
                    | TransportError::RateLimited(_) => {
                        let delay = match error {
                            TransportError::RateLimited(Some(delay)) => {
                                delay.max(Duration::from_secs(3))
                            }
                            _ => Duration::from_secs(3),
                        };
                        desk.retry_after = Instant::now().checked_add(delay);
                        Key::ReviewModerationUnavailable
                    }
                    _ => Key::ReviewModerationUnavailable,
                });
                cx.notify();
            });
        })
        .detach();
    }

    fn filter_reviews(&mut self, filter: Option<ReviewStatus>, cx: &mut Context<Self>) {
        let Overlay::ReviewModeration(desk) = &mut self.overlay else {
            return;
        };
        if !desk.busy && desk.editor.is_none() {
            desk.filter = filter;
            desk.cursors = vec![None];
            desk.page = None;
            self.run_moderation(Action::Read, cx);
        }
    }

    fn page_reviews(&mut self, next: bool, cx: &mut Context<Self>) {
        let Overlay::ReviewModeration(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy || desk.editor.is_some() {
            return;
        }
        if next {
            let Some(cursor) = desk.page.as_ref().and_then(|page| page.next_before.clone()) else {
                return;
            };
            desk.cursors.push(Some(cursor));
        } else if desk.cursors.len() > 1 {
            desk.cursors.pop();
        } else {
            return;
        }
        desk.page = None;
        self.run_moderation(Action::Read, cx);
    }

    fn edit_managed_review(&mut self, id: &str, mode: Mode, cx: &mut Context<Self>) {
        let Overlay::ReviewModeration(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy || desk.editor.is_some() {
            return;
        }
        let Some(review) = desk
            .page
            .as_ref()
            .and_then(|page| page.reviews.iter().find(|review| review.id == id))
            .cloned()
        else {
            return;
        };
        if !mode.allows(&review) {
            return;
        }
        let original = mode
            .draft(&review)
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        let fields = if mode == Mode::Publish {
            Vec::new()
        } else {
            original
                .split('\n')
                .map(|line| review_line(line, cx))
                .collect()
        };
        desk.editor = Some(Editor {
            review,
            mode,
            original,
            fields,
        });
        desk.error = None;
        cx.notify();
    }

    fn edit_review_lines(&mut self, add: bool, cx: &mut Context<Self>) {
        let Overlay::ReviewModeration(desk) = &mut self.overlay else {
            return;
        };
        if let Some(editor) = desk.editor.as_mut().filter(|_| !desk.busy && !desk.discard) {
            if add {
                editor.fields.push(review_line("", cx));
            } else if editor.fields.len() > 1 {
                editor.fields.pop();
            }
            cx.notify();
        }
    }

    fn save_managed_review(&mut self, cx: &mut Context<Self>) {
        let Overlay::ReviewModeration(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = desk.editor.as_ref().filter(|_| !desk.busy && !desk.discard) else {
            return;
        };
        let text = editor.text(cx);
        if editor.mode.command(&text).is_none() {
            desk.error = Some(if editor.mode == Mode::Hide {
                Key::ReviewInvalidReason
            } else {
                Key::ReviewInvalidReply
            });
            cx.notify();
            return;
        }
        let action = Action::Save {
            id: editor.review.id.clone(),
            version: editor.review.version,
            mode: editor.mode,
            text,
        };
        self.run_moderation(action, cx);
    }

    pub(super) fn render_review_moderation(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let width = (viewport.width - px(32.)).clamp(px(280.), px(760.));
        let height = (viewport.height - px(32.)).clamp(px(180.), px(760.));
        let connected = self.status.connectivity != Connectivity::Offline;
        let heading = div()
            .flex()
            .flex_wrap()
            .gap_2()
            .items_center()
            .justify_between()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::BOLD)
                    .child(self.t(Key::ReviewModeration)),
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .when(desk.editor.is_none(), |row| {
                        row.child(self.button(
                            "moderation-requests",
                            self.t(Key::ReviewRequests),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.open_review_requests(cx)),
                        ))
                    })
                    .child(self.button(
                        "moderation-close",
                        self.t(Key::Close),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                    )),
            );
        let mut body = div().child(heading).when_some(desk.error, |body, error| {
            body.child(div().text_sm().child(self.t(error)))
        });
        body = body
            .when(!connected && desk.error.is_none(), |body| {
                body.child(div().text_sm().child(self.t(Key::ReviewModerationOffline)))
            })
            .when(desk.busy, |body| {
                body.child(div().text_sm().child(self.t(Key::ReviewModerationLoading)))
            });
        let mut content = div()
            .id("moderation-scroll")
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_3();
        if let Some(editor) = &desk.editor {
            content = content.child(self.render_review_editor(editor, desk, connected, cx));
        } else {
            content = content.child(
                div().flex().flex_wrap().gap_2().children(
                    [
                        None,
                        Some(ReviewStatus::Pending),
                        Some(ReviewStatus::Published),
                        Some(ReviewStatus::Hidden),
                        Some(ReviewStatus::Withdrawn),
                    ]
                    .into_iter()
                    .map(|filter| {
                        self.button(
                            SharedString::from(format!("review-filter-{filter:?}")),
                            self.t(status_key(filter)),
                            if filter == desk.filter {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |root, _, _, cx| root.filter_reviews(filter, cx)),
                        )
                    }),
                ),
            );
            if let Some(page) = &desk.page {
                content = content
                    .when(page.reviews.is_empty(), |d| {
                        d.child(div().text_sm().child(self.t(Key::ReviewModerationEmpty)))
                    })
                    .children(page.reviews.iter().map(|review| {
                        let card = self.render_managed_review(review);
                        if !connected {
                            return card;
                        }
                        card.child(
                            div().flex().flex_wrap().gap_2().children(
                                [Mode::Publish, Mode::Hide, Mode::Reply]
                                    .into_iter()
                                    .filter(|mode| mode.allows(review))
                                    .map(|mode| {
                                        let id = review.id.clone();
                                        self.button(
                                            SharedString::from(format!(
                                                "moderate-{}-{}",
                                                id, mode as u8
                                            )),
                                            self.t(if mode == Mode::Reply {
                                                Key::ReviewReply
                                            } else {
                                                action_label(mode)
                                            }),
                                            Kind::Ghost,
                                            cx.listener(move |root, _, _, cx| {
                                                root.edit_managed_review(&id, mode, cx)
                                            }),
                                        )
                                    }),
                            ),
                        )
                    }));
            }
            if connected {
                body = body.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(self.button(
                            "moderation-refresh",
                            self.t(Key::InboxRefresh),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.run_moderation(Action::Read, cx)),
                        ))
                        .when(desk.cursors.len() > 1, |row| {
                            row.child(self.button(
                                "moderation-prev",
                                self.t(Key::InboxPrevious),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| root.page_reviews(false, cx)),
                            ))
                        })
                        .when(
                            desk.page
                                .as_ref()
                                .is_some_and(|page| page.next_before.is_some()),
                            |row| {
                                row.child(self.button(
                                    "moderation-next",
                                    self.t(Key::InboxNext),
                                    Kind::Ghost,
                                    cx.listener(|root, _, _, cx| root.page_reviews(true, cx)),
                                ))
                            },
                        ),
                );
            }
        }
        self.modal_with_height(body.child(content), width, height, Some(cx))
    }

    fn render_managed_review(&self, review: &ManagedReview) -> gpui::Div {
        let day = review.created_at.with_timezone(&self.tz).date_naive();
        div()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .child(div().text_sm().text_color(theme::muted()).child(format!(
                "{} · {}",
                self.t(status_key(Some(review.status))),
                i18n::date_label(self.locale, day),
            )))
            .when_some(review.public_name.as_ref(), |row, name| {
                row.child(div().font_weight(FontWeight::SEMIBOLD).child(name.clone()))
            })
            .when_some(review.rating, |row, rating| {
                row.child(div().text_sm().child(format!("{rating}/5")))
            })
            .when_some(review.body.as_ref(), |row, body| {
                row.child(div().child(body.clone()))
            })
            .when(!review.services.is_empty(), |row| {
                row.child(
                    div().text_sm().text_color(theme::muted()).child(
                        review
                            .services
                            .iter()
                            .map(|service| service.name.as_str())
                            .collect::<Vec<_>>()
                            .join(" · "),
                    ),
                )
            })
            .when_some(review.moderation_reason.as_ref(), |row, reason| {
                row.child(div().text_sm().child(self.t(Key::ReviewHideReason)))
                    .child(div().child(reason.clone()))
            })
            .when_some(review.reply.as_ref(), |row, reply| {
                row.child(div().text_sm().child(self.t(Key::ReviewReply)))
                    .child(div().child(reply.clone()))
            })
            .when(!review.source_eligible, |row| {
                row.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::ReviewSourceInvalid)),
                )
            })
    }

    fn render_review_editor(
        &self,
        editor: &Editor,
        desk: &Desk,
        connected: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let mut form = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.render_managed_review(&editor.review));
        if desk.discard {
            return form
                .child(div().child(self.t(Key::ReviewDiscardConfirm)))
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .child(self.button(
                            "moderation-keep",
                            self.t(Key::ReviewKeepEditing),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                        ))
                        .child(self.button(
                            "moderation-discard",
                            self.t(Key::ReviewDiscard),
                            Kind::Danger,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::ReviewModeration(desk) = &mut root.overlay {
                                    desk.editor = None;
                                    desk.discard = false;
                                    desk.error = None;
                                    cx.notify();
                                }
                            }),
                        )),
                );
        }
        let label = match editor.mode {
            Mode::Publish => Key::ReviewPublishConfirm,
            Mode::Hide => Key::ReviewHideReason,
            Mode::Reply => Key::ReviewReply,
        };
        form = form
            .child(div().font_weight(FontWeight::MEDIUM).child(self.t(label)))
            .when(editor.mode == Mode::Reply, |row| {
                row.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::ReviewReplyHint)),
                )
            })
            .when(desk.saving, |row| {
                row.child(div().text_sm().child(editor.text(cx)))
            })
            .when(!desk.saving, |row| {
                row.children(editor.fields.iter().map(|line| line.field.clone()))
            });
        if !editor.fields.is_empty() && !desk.busy {
            form = form.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.button(
                        "moderation-add-line",
                        self.t(Key::ReviewAddLine),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.edit_review_lines(true, cx)),
                    ))
                    .when(editor.fields.len() > 1, |row| {
                        row.child(self.button(
                            "moderation-remove-line",
                            self.t(Key::ReviewRemoveLine),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.edit_review_lines(false, cx)),
                        ))
                    }),
            );
        }
        form.when(connected && !desk.busy, |row| {
            row.child(self.button(
                "moderation-save",
                self.t(action_label(editor.mode)),
                Kind::Primary,
                cx.listener(|root, _, _, cx| root.save_managed_review(cx)),
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn a_multiline_reply_stays_in_the_editor_until_discard_is_confirmed(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.open_review_moderation(cx);
            let review = serde_json::from_value(serde_json::json!({
                "reviews": [{
                    "id": "0198f5a0-7b1c-7000-8000-000000000001",
                    "publicName": "Synthetic client",
                    "body": "A complete synthetic review",
                    "rating": 4,
                    "services": [],
                    "status": "published",
                    "reply": "First line\nSecond line",
                    "version": 4,
                    "sourceEligible": true,
                    "createdAt": "2026-03-01T10:00:00Z"
                }],
                "nextBefore": null
            }))
            .unwrap();
            let Overlay::ReviewModeration(desk) = &mut root.overlay else {
                panic!("missing moderation")
            };
            desk.page = Some(review);
            root.edit_managed_review("0198f5a0-7b1c-7000-8000-000000000001", Mode::Reply, cx);
            let Overlay::ReviewModeration(desk) = &root.overlay else {
                panic!("missing moderation")
            };
            let editor = desk.editor.as_ref().unwrap();
            assert_eq!(editor.text(cx), "First line\nSecond line");
            editor.fields[1]
                .field
                .clone()
                .update(cx, |field, cx| field.set_text("Edited line", cx));
            root.dismiss_overlay(cx);
            let Overlay::ReviewModeration(desk) = &root.overlay else {
                panic!("closed moderation with a draft")
            };
            assert!(desk.discard);
            assert_eq!(
                desk.editor.as_ref().unwrap().text(cx),
                "First line\nEdited line"
            );
            root.dismiss_overlay(cx);
            let Overlay::ReviewModeration(desk) = &root.overlay else {
                panic!("closed moderation with a draft")
            };
            assert!(!desk.discard);
            assert_eq!(desk.editor.as_ref().unwrap().review.version, 4);
        });
    }
}
