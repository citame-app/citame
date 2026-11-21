use super::*;
use sob_core::sync::TransportError;
use std::sync::Arc;

pub(super) struct Inbox {
    archived: bool,
    requested_page: u32,
    page: Option<CalendarInbox>,
    observed_cursor: i64,
    observed_online: bool,
    busy: bool,
    cached: bool,
    error: Option<Key>,
}

impl Root {
    pub(super) fn update_inbox_connectivity(
        &mut self,
        status: &SyncStatus,
        cx: &mut Context<Self>,
    ) {
        let Overlay::Inbox(inbox) = &mut self.overlay else {
            return;
        };
        if status.connectivity != Connectivity::Online {
            inbox.observed_online = false;
        } else if !inbox.busy && (!inbox.observed_online || inbox.observed_cursor != status.cursor)
        {
            self.refresh_inbox(None, cx);
        }
    }

    pub(super) fn open_inbox(
        &mut self,
        archived: bool,
        requested_page: u32,
        cx: &mut Context<Self>,
    ) {
        if matches!(&self.overlay, Overlay::Inbox(inbox) if inbox.busy) {
            return;
        }
        let page = (requested_page == 1)
            .then(|| self.svc.store.calendar_inbox_cache(archived).ok().flatten())
            .flatten();
        self.overlay = Overlay::Inbox(Inbox {
            archived,
            requested_page,
            cached: page.is_some(),
            page,
            observed_cursor: self.svc.status().cursor,
            observed_online: false,
            busy: false,
            error: None,
        });
        self.refresh_inbox(None, cx);
    }

    pub(super) fn refresh_inbox(&mut self, action: Option<String>, cx: &mut Context<Self>) {
        let Overlay::Inbox(inbox) = &mut self.overlay else {
            return;
        };
        if inbox.busy {
            return;
        }
        self.inbox_generation = self.inbox_generation.wrapping_add(1);
        let generation = self.inbox_generation;
        let status = self.svc.status();
        inbox.observed_cursor = status.cursor;
        inbox.observed_online = status.connectivity == Connectivity::Online;
        let Some(transport) = self.svc.transport() else {
            inbox.error = Some(Key::InboxUnavailable);
            cx.notify();
            return;
        };
        let archived = inbox.archived;
        let mut requested_page = inbox.requested_page;
        let session = self.svc.session.clone();
        inbox.busy = true;
        inbox.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let (changed, result, error_key) = cx
                .background_executor()
                .spawn(async move {
                    let changed = if let Some(id) = action {
                        if let Err(error) = transport.set_calendar_notice_archived(&id, !archived) {
                            return (false, Err(error), Key::InboxArchiveFailed);
                        }
                        true
                    } else {
                        false
                    };
                    let mut result = transport.calendar_inbox(archived, requested_page);
                    if requested_page > 1
                        && result.as_ref().is_ok_and(|page| page.entries.is_empty())
                    {
                        requested_page = 1;
                        result = transport.calendar_inbox(archived, requested_page);
                    }
                    (changed, result, Key::InboxUnavailable)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if !Arc::ptr_eq(&session, &this.svc.session) || this.svc.current_session().is_none()
                {
                    return;
                }
                let invalidated = changed
                    || matches!(
                        &result,
                        Err(TransportError::Unauthorized | TransportError::Forbidden(_))
                    );
                if invalidated {
                    let _ = this.svc.store.clear_calendar_inbox_cache();
                }
                if generation != this.inbox_generation {
                    return;
                }
                let Overlay::Inbox(inbox) = &mut this.overlay else {
                    return;
                };
                inbox.busy = false;
                if invalidated {
                    inbox.page = None;
                    inbox.cached = false;
                }
                match result {
                    Ok(page) => {
                        if page.page == 1 {
                            let _ = this.svc.store.cache_calendar_inbox(archived, &page);
                        }
                        inbox.cached = false;
                        inbox.requested_page = page.page;
                        inbox.page = Some(page);
                    }
                    Err(_) => {
                        inbox.error = Some(error_key);
                        inbox.cached = inbox.page.is_some();
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_inbox(&self, inbox: &Inbox, cx: &mut Context<Self>) -> gpui::Div {
        let show_archived = inbox.archived;
        let page = inbox.requested_page;
        let enabled = !inbox.busy;
        let can_archive =
            enabled && !inbox.cached && self.status.connectivity == Connectivity::Online;
        let more = inbox
            .page
            .as_ref()
            .is_some_and(|data| page.saturating_mul(data.page_size) < data.total);
        let rows = inbox
            .page
            .as_ref()
            .into_iter()
            .flat_map(|data| &data.entries);
        let empty = inbox
            .page
            .as_ref()
            .is_some_and(|data| data.entries.is_empty());
        self.modal(
            div()
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::BOLD)
                        .child(self.t(Key::CalendarInbox)),
                )
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .child(self.button(
                            "inbox-active",
                            self.t(Key::InboxActive),
                            if show_archived {
                                Kind::Ghost
                            } else {
                                Kind::Primary
                            },
                            cx.listener(|this, _, _, cx| this.open_inbox(false, 1, cx)),
                        ))
                        .child(self.button(
                            "inbox-archived",
                            self.t(Key::InboxArchived),
                            if show_archived {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(|this, _, _, cx| this.open_inbox(true, 1, cx)),
                        ))
                        .when(enabled, |d| {
                            d.child(self.button(
                                "inbox-refresh",
                                self.t(Key::InboxRefresh),
                                Kind::Ghost,
                                cx.listener(|this, _, _, cx| this.refresh_inbox(None, cx)),
                            ))
                        }),
                )
                .when(inbox.cached, |d| {
                    d.child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.t(Key::InboxCached)),
                    )
                })
                .when(inbox.busy, |d| {
                    d.child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.t(Key::InboxLoading)),
                    )
                })
                .when_some(inbox.error, |d, key| {
                    d.child(
                        div()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(self.t(key)),
                    )
                })
                .when(empty, |d| {
                    d.child(div().text_sm().child(self.t(Key::InboxEmpty)))
                })
                .child(
                    div()
                        .id("calendar-inbox-list")
                        .min_h_0()
                        .max_h(px(420.))
                        .overflow_y_scroll()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .children(rows.map(|notice| {
                            let kind = self.t(match notice.kind {
                                CalendarNoticeKind::New => Key::NewBookingNotice,
                                CalendarNoticeKind::Rescheduled => Key::InboxRescheduled,
                                CalendarNoticeKind::Cancelled => Key::InboxCancelled,
                            });
                            let id = notice.id.clone();
                            let appointment_id = notice.appointment_id.clone();
                            let starts = notice.appointment_starts_at;
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .p_3()
                                .rounded_lg()
                                .border_1()
                                .border_color(theme::line())
                                .child(
                                    div()
                                        .text_sm()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(kind),
                                )
                                .child(
                                    div()
                                        .truncate()
                                        .child(SharedString::from(notice.client_name.clone())),
                                )
                                .child(div().truncate().text_sm().text_color(theme::muted()).child(
                                    SharedString::from(format!(
                                        "{} · {}",
                                        self.date_time_label(notice.starts_at),
                                        notice.service_names.join(", ")
                                    )),
                                ))
                                .child(div().text_xs().text_color(theme::muted()).child(
                                    SharedString::from(self.date_time_label(notice.created_at)),
                                ))
                                .child(
                                    div()
                                        .flex()
                                        .gap_2()
                                        .child(self.button(
                                            SharedString::from(format!("inbox-open-{id}")),
                                            self.t(Key::ViewBookingNotice),
                                            Kind::Ghost,
                                            cx.listener(move |this, _, _, cx| {
                                                this.overlay = Overlay::None;
                                                this.calendar_mode = CalendarMode::Day;
                                                this.overview_staff.clear();
                                                this.pending_local_today = false;
                                                this.date =
                                                    starts.with_timezone(&this.tz).date_naive();
                                                this.reload(cx);
                                                this.open_details(&appointment_id, cx);
                                            }),
                                        ))
                                        .when(can_archive, |d| {
                                            d.child(self.button(
                                                SharedString::from(format!("inbox-change-{id}")),
                                                self.t(if show_archived {
                                                    Key::InboxRestore
                                                } else {
                                                    Key::InboxArchive
                                                }),
                                                Kind::Ghost,
                                                cx.listener(move |this, _, _, cx| {
                                                    this.refresh_inbox(Some(id.clone()), cx)
                                                }),
                                            ))
                                        }),
                                )
                        })),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .when(enabled && page > 1, |d| {
                            d.child(self.button(
                                "inbox-prev",
                                self.t(Key::InboxPrevious),
                                Kind::Ghost,
                                cx.listener(move |this, _, _, cx| {
                                    this.open_inbox(show_archived, page - 1, cx)
                                }),
                            ))
                        })
                        .child(SharedString::from(
                            self.t(Key::InboxPage).replace("{n}", &page.to_string()),
                        ))
                        .when(enabled && more, |d| {
                            d.child(self.button(
                                "inbox-next",
                                self.t(Key::InboxNext),
                                Kind::Ghost,
                                cx.listener(move |this, _, _, cx| {
                                    this.open_inbox(show_archived, page + 1, cx)
                                }),
                            ))
                        })
                        .child(div().flex_1())
                        .child(self.button(
                            "inbox-close",
                            self.t(Key::Close),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| {
                                this.overlay = Overlay::None;
                                cx.notify();
                            }),
                        )),
                ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn native_inbox_opens_its_private_cache_without_a_connection(cx: &mut TestAppContext) {
        let (_dir, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.svc.stop_sync();
                let now = Utc::now();
                let cache = CalendarInbox {
                    page: 1,
                    page_size: 25,
                    total: 1,
                    entries: vec![CalendarNotice {
                        id: "notice-a".into(),
                        kind: CalendarNoticeKind::New,
                        created_at: now,
                        appointment_id: "appointment-a".into(),
                        staff_id: "staff-a".into(),
                        starts_at: now,
                        appointment_starts_at: now,
                        client_name: "Lucia".into(),
                        service_names: vec!["Haircut".into()],
                    }],
                };
                root.svc.store.cache_calendar_inbox(true, &cache).unwrap();
                root.open_inbox(true, 1, cx);
                let Overlay::Inbox(inbox) = &root.overlay else {
                    panic!("inbox must be open");
                };
                assert!(inbox.archived && inbox.cached && !inbox.busy);
                assert_eq!(inbox.page, Some(cache));
                assert!(matches!(inbox.error, Some(Key::InboxUnavailable)));
            })
            .unwrap();
    }
}
