use super::*;
use sob_core::store::CalendarCacheScope;
use sob_core::sync::TransportError;
use std::sync::Arc;

mod reward_inbox;
pub(super) use reward_inbox::RewardBadge;

const REFRESH_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(super) struct CalendarBadge {
    count: u32,
    requested_cursor: Option<i64>,
    next_poll: Option<Instant>,
    request: Option<Arc<()>>,
    scope: Option<CalendarCacheScope>,
}

pub(super) struct Inbox {
    rewards: Option<reward_inbox::RewardInbox>,
    archived: bool,
    kind: Option<CalendarNoticeKind>,
    requested_page: u32,
    page: Option<CalendarInbox>,
    observed_cursor: i64,
    observed_online: bool,
    next_poll: Instant,
    scope: Option<CalendarCacheScope>,
    busy: bool,
    refreshing: bool,
    cached: bool,
    error: Option<Key>,
}

impl Root {
    fn refresh_calendar_badge(&mut self, status: &SyncStatus, cx: &mut Context<Self>) {
        let scope = self.svc.store.calendar_cache_scope().ok();
        let badge = &mut self.calendar_badge;
        if scope != badge.scope {
            *badge = CalendarBadge {
                count: scope
                    .as_ref()
                    .and_then(|_| {
                        self.svc
                            .store
                            .calendar_inbox_cache(false, None)
                            .ok()
                            .flatten()
                    })
                    .map_or(0, |page| page.total),
                scope,
                ..Default::default()
            };
            cx.notify();
        }
        if status.connectivity != Connectivity::Online {
            badge.requested_cursor = None;
            return;
        }
        if badge.scope.is_none()
            || badge.request.is_some()
            || (badge.requested_cursor == Some(status.cursor)
                && badge
                    .next_poll
                    .is_some_and(|deadline| Instant::now() < deadline))
        {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let cursor = status.cursor;
        let request = Arc::new(());
        badge.request = Some(request.clone());
        let session = self.svc.session.clone();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.calendar_inbox(false, None, 1) })
                .await;
            let _ = root.update(cx, |root, cx| {
                let badge = &mut root.calendar_badge;
                if !Arc::ptr_eq(&session, &root.svc.session)
                    || !badge
                        .request
                        .as_ref()
                        .is_some_and(|pending| Arc::ptr_eq(&request, pending))
                {
                    return;
                }
                badge.request = None;
                if root.svc.store.calendar_cache_scope().ok() != badge.scope {
                    return;
                }
                badge.requested_cursor = Some(cursor);
                badge.next_poll = Some(Instant::now() + REFRESH_INTERVAL);
                let count = match result {
                    Ok(page) => page.total,
                    Err(TransportError::Unauthorized | TransportError::Forbidden(_)) => 0,
                    Err(_) => badge.count,
                };
                if count != badge.count {
                    badge.count = count;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(super) fn update_inbox_connectivity(
        &mut self,
        status: &SyncStatus,
        cx: &mut Context<Self>,
    ) {
        self.refresh_calendar_badge(status, cx);
        self.refresh_reward_badge(status, cx);
        if matches!(&self.overlay, Overlay::Inbox(inbox) if inbox.rewards.is_some()) {
            self.refresh_reward_inbox_if_changed(status, cx);
            return;
        }
        let Overlay::Inbox(inbox) = &mut self.overlay else {
            return;
        };
        if self.svc.store.calendar_cache_scope().ok().as_ref() != inbox.scope.as_ref() {
            self.overlay = Overlay::None;
            cx.notify();
            return;
        }
        if status.connectivity != Connectivity::Online {
            inbox.observed_online = false;
        } else if !inbox.refreshing
            && (!inbox.observed_online
                || inbox.observed_cursor != status.cursor
                || Instant::now() >= inbox.next_poll)
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
        self.open_inbox_view(archived, None, requested_page, cx);
    }

    fn open_inbox_view(
        &mut self,
        archived: bool,
        kind: Option<CalendarNoticeKind>,
        requested_page: u32,
        cx: &mut Context<Self>,
    ) {
        if matches!(&self.overlay, Overlay::Inbox(inbox) if inbox.busy) {
            return;
        }
        let scope = self.svc.store.calendar_cache_scope().ok();
        let page = (scope.is_some() && requested_page == 1)
            .then(|| {
                self.svc
                    .store
                    .calendar_inbox_cache(archived, kind)
                    .ok()
                    .flatten()
            })
            .flatten();
        self.overlay = Overlay::Inbox(Box::new(Inbox {
            rewards: None,
            archived,
            kind,
            requested_page,
            cached: page.is_some(),
            page,
            observed_cursor: self.svc.status().cursor,
            observed_online: false,
            next_poll: Instant::now(),
            scope,
            busy: false,
            refreshing: false,
            error: None,
        }));
        self.refresh_inbox(None, cx);
    }

    fn refresh_inbox(&mut self, action: Option<Vec<String>>, cx: &mut Context<Self>) {
        let Overlay::Inbox(inbox) = &mut self.overlay else {
            return;
        };
        if inbox.busy || (inbox.refreshing && action.is_none()) {
            return;
        }
        self.inbox_generation = self.inbox_generation.wrapping_add(1);
        let generation = self.inbox_generation;
        let status = self.svc.status();
        inbox.observed_cursor = status.cursor;
        inbox.observed_online = status.connectivity == Connectivity::Online;
        inbox.next_poll = Instant::now() + REFRESH_INTERVAL;
        let Ok(scope) = self.svc.store.calendar_cache_scope() else {
            inbox.error = Some(Key::InboxUnavailable);
            cx.notify();
            return;
        };
        if inbox.scope.as_ref() != Some(&scope) {
            self.overlay = Overlay::None;
            cx.notify();
            return;
        }
        let Some(transport) = self.svc.transport() else {
            inbox.error = Some(Key::InboxUnavailable);
            cx.notify();
            return;
        };
        let archived = inbox.archived;
        let kind = inbox.kind;
        let mut requested_page = inbox.requested_page;
        let session = self.svc.session.clone();
        let affected: Vec<_> = inbox
            .page
            .iter()
            .flat_map(|page| &page.entries)
            .filter_map(|notice| {
                action
                    .as_ref()
                    .is_some_and(|ids| ids.contains(&notice.id))
                    .then_some(notice.kind)
            })
            .collect();
        inbox.busy = action.is_some();
        inbox.refreshing = true;
        inbox.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let (changed, result, error_key) = cx
                .background_executor()
                .spawn(async move {
                    let changed = if let Some(ids) = action {
                        if let Err(error) = transport.set_calendar_notices_archived(&ids, !archived)
                        {
                            return (false, Err(error), Key::InboxArchiveFailed);
                        }
                        requested_page = 1;
                        true
                    } else {
                        false
                    };
                    let mut result = transport.calendar_inbox(archived, kind, requested_page);
                    if requested_page > 1
                        && result.as_ref().is_ok_and(|page| page.entries.is_empty())
                    {
                        requested_page = 1;
                        result = transport.calendar_inbox(archived, kind, requested_page);
                    }
                    (changed, result, Key::InboxUnavailable)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if !Arc::ptr_eq(&session, &this.svc.session) || this.svc.current_session().is_none()
                {
                    return;
                }
                if this.svc.store.calendar_cache_scope().ok().as_ref() != Some(&scope) {
                    return;
                }
                let access_denied = matches!(
                    &result,
                    Err(TransportError::Unauthorized | TransportError::Forbidden(_))
                );
                if access_denied {
                    let _ = this.svc.store.clear_calendar_inbox_cache();
                } else if changed {
                    let _ = this.svc.store.invalidate_calendar_inbox_filters(&affected);
                }
                if generation != this.inbox_generation {
                    return;
                }
                let Overlay::Inbox(inbox) = &mut this.overlay else {
                    return;
                };
                inbox.busy = false;
                inbox.refreshing = false;
                if access_denied || changed {
                    inbox.page = None;
                    inbox.cached = false;
                }
                match result {
                    Ok(page) => {
                        if page.page == 1
                            && !this
                                .svc
                                .store
                                .cache_calendar_inbox(&scope, archived, kind, &page)
                                .unwrap_or(true)
                        {
                            this.overlay = Overlay::None;
                            cx.notify();
                            return;
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

    pub(super) fn render_inbox(
        &self,
        inbox: &Inbox,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if let Some(rewards) = inbox.rewards.as_ref() {
            return self.render_reward_inbox(rewards, cx);
        }
        let show_archived = inbox.archived;
        let kind = inbox.kind;
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
            .map_or(&[][..], |data| data.entries.as_slice());
        let local_date =
            |notice: &CalendarNotice| notice.created_at.with_timezone(&self.tz).date_naive();
        let empty = inbox
            .page
            .as_ref()
            .is_some_and(|data| data.entries.is_empty());
        self.modal_with_height(
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
                        .flex_wrap()
                        .gap_2()
                        .child(self.button(
                            "inbox-active",
                            self.t(Key::InboxActive),
                            if show_archived {
                                Kind::Ghost
                            } else {
                                Kind::Primary
                            },
                            cx.listener(move |this, _, _, cx| {
                                this.open_inbox_view(false, kind, 1, cx)
                            }),
                        ))
                        .child(self.button(
                            "inbox-archived",
                            self.t(Key::InboxArchived),
                            if show_archived {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |this, _, _, cx| {
                                this.open_inbox_view(true, kind, 1, cx)
                            }),
                        ))
                        .when(enabled && self.directory_enabled(), |row| {
                            row.child(self.loyalty_button(
                                "inbox-rewards",
                                Key::RewardNoticeTitle,
                                Kind::Ghost,
                                Root::open_reward_inbox,
                                cx,
                            ))
                        })
                        .when(enabled, |d| {
                            d.child(self.button(
                                "inbox-refresh",
                                self.t(Key::InboxRefresh),
                                Kind::Ghost,
                                cx.listener(|this, _, _, cx| this.refresh_inbox(None, cx)),
                            ))
                        }),
                )
                .child(
                    div().flex().flex_wrap().gap_2().children(
                        [
                            None,
                            Some(CalendarNoticeKind::New),
                            Some(CalendarNoticeKind::Rescheduled),
                            Some(CalendarNoticeKind::Cancelled),
                        ]
                        .into_iter()
                        .map(|filter| {
                            self.chip(
                                filter.map_or("inbox-kind-all", CalendarNoticeKind::as_str),
                                self.t(filter.map_or(Key::InboxAllKinds, notices::title_key)),
                                kind == filter,
                                cx.listener(move |this, _, _, cx| {
                                    this.open_inbox_view(show_archived, filter, 1, cx)
                                }),
                            )
                        }),
                    ),
                )
                .when(inbox.cached, |d| {
                    d.child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.t(Key::InboxCached)),
                    )
                })
                .when(inbox.busy || (inbox.refreshing && inbox.page.is_none()), |d| {
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
                        .children(rows.chunk_by(|a, b| local_date(a) == local_date(b)).map(
                            |group| {
                                let date = local_date(&group[0]);
                                let ids: Vec<_> =
                                    group.iter().map(|notice| notice.id.clone()).collect();
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_2()
                                    .child(
                                        div()
                                            .flex()
                                            .flex_wrap()
                                            .gap_2()
                                            .items_center()
                                            .justify_between()
                                            .child(
                                                div()
                                                    .text_sm()
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .child(i18n::date_label(self.locale, date)),
                                            )
                                            .when(can_archive && !show_archived, |d| {
                                                d.child(self.button(
                                                    SharedString::from(format!(
                                                        "inbox-archive-date-{date}"
                                                    )),
                                                    self.t(Key::InboxArchiveDay),
                                                    Kind::Ghost,
                                                    cx.listener(move |this, _, _, cx| {
                                                        this.refresh_inbox(Some(ids.clone()), cx)
                                                    }),
                                                ))
                                            }),
                                    )
                                    .children(group.iter().map(|notice| {
                                        let kind = self.t(notices::title_key(notice.kind));
                                        let id = notice.id.clone();
                                        let appointment_id = notice.appointment_id.clone();
                                        let starts = notice.appointment_starts_at;
                                        let staff = notice.staff_id.clone();
                                        let cached = inbox.cached;
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
                                            .child(div().truncate().child(SharedString::from(
                                                notice.client_name.clone(),
                                            )))
                                            .child(
                                                div()
                                                    .truncate()
                                                    .text_sm()
                                                    .text_color(theme::muted())
                                                    .child(SharedString::from(format!(
                                                        "{} · {}",
                                                        self.date_time_label(notice.starts_at),
                                                        notice.service_names.join(", ")
                                                    ))),
                                            )
                                            .child(
                                                div().text_xs().text_color(theme::muted()).child(
                                                    SharedString::from(
                                                        self.date_time_label(notice.created_at),
                                                    ),
                                                ),
                                            )
                                            .child(
                                                div()
                                                    .flex()
                                                    .gap_2()
                                                    .child(self.button(
                                                        SharedString::from(format!(
                                                            "inbox-open-{id}"
                                                        )),
                                                        self.t(Key::ViewBookingNotice),
                                                        Kind::Ghost,
                                                        cx.listener(move |this, _, _, cx| {
                                                            if !this.open_notice_appointment(&appointment_id, (!cached).then_some((starts, staff.as_str())), cx) {
                                                                if let Overlay::Inbox(inbox) = &mut this.overlay {
                                                                    inbox.error = Some(Key::InboxAppointmentUnavailable);
                                                                }
                                                                this.svc.wake(Wake::Manual);
                                                                cx.notify();
                                                            }
                                                        }),
                                                    ))
                                                    .when(can_archive, |d| {
                                                        d.child(self.button(
                                                            SharedString::from(format!(
                                                                "inbox-change-{id}"
                                                            )),
                                                            self.t(if show_archived {
                                                                Key::InboxRestore
                                                            } else {
                                                                Key::InboxArchive
                                                            }),
                                                            Kind::Ghost,
                                                            cx.listener(move |this, _, _, cx| {
                                                                this.refresh_inbox(
                                                                    Some(vec![id.clone()]),
                                                                    cx,
                                                                )
                                                            }),
                                                        ))
                                                    }),
                                            )
                                    }))
                            },
                        )),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap_2()
                        .when(enabled && page > 1, |d| {
                            d.child(self.button(
                                "inbox-prev",
                                self.t(Key::InboxPrevious),
                                Kind::Ghost,
                                cx.listener(move |this, _, _, cx| {
                                    this.open_inbox_view(show_archived, kind, page - 1, cx)
                                }),
                            ))
                        })
                        .child(SharedString::from(
                            self.t(Key::InboxPage).replace("{n}", &page.to_string()),
                        ))
                        .when(enabled && !inbox.cached && more, |d| {
                            d.child(self.button(
                                "inbox-next",
                                self.t(Key::InboxNext),
                                Kind::Ghost,
                                cx.listener(move |this, _, _, cx| {
                                    this.open_inbox_view(show_archived, kind, page + 1, cx)
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
            (viewport.width - px(24.)).clamp(px(240.), px(560.)),
            (viewport.height - px(24.)).clamp(px(240.), px(720.)),
            None,
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
                let scope = root.svc.store.calendar_cache_scope().unwrap();
                root.svc
                    .store
                    .cache_calendar_inbox(&scope, true, Some(CalendarNoticeKind::New), &cache)
                    .unwrap();
                root.open_inbox(true, 1, cx);
                assert!(matches!(&root.overlay, Overlay::Inbox(inbox) if inbox.page.is_none()));
                root.open_inbox_view(true, Some(CalendarNoticeKind::New), 1, cx);
                let Overlay::Inbox(inbox) = &root.overlay else {
                    panic!("inbox must be open");
                };
                assert!(inbox.archived && inbox.cached && !inbox.busy);
                assert_eq!(inbox.kind, Some(CalendarNoticeKind::New));
                assert_eq!(inbox.page, Some(cache));
                assert!(matches!(inbox.error, Some(Key::InboxUnavailable)));
            })
            .unwrap();
    }
}
