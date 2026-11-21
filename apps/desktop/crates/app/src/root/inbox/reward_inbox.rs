use super::*;
use sob_core::loyalty::{
    LIVE_TOPIC,
    stamps::{NOTICE_REFRESH_INTERVAL, RewardNoticeRead, RewardNotices, notice_retry_delay},
};
use std::time::Instant;

#[derive(Default)]
pub(in crate::root) struct RewardBadge {
    count: u32,
    revision: Option<i64>,
    next_read: Option<Instant>,
    retry: Option<Instant>,
    request: Option<Arc<()>>,
}

pub(super) struct RewardInbox {
    identity: Arc<()>,
    listing: Option<RewardNotices>,
    page: u32,
    unread: bool,
    busy: bool,
    error: Option<Key>,
    revision: Option<i64>,
    online: bool,
    next_read: Instant,
    retry: Option<Instant>,
}

fn retry_at(error: Option<&TransportError>) -> Option<Instant> {
    Instant::now().checked_add(notice_retry_delay(error)?)
}

impl Root {
    fn reward_inbox(&mut self) -> Option<&mut RewardInbox> {
        match &mut self.overlay {
            Overlay::Inbox(inbox) => inbox.rewards.as_mut(),
            _ => None,
        }
    }

    pub(super) fn refresh_reward_badge(&mut self, status: &SyncStatus, cx: &mut Context<Self>) {
        if !self.directory_enabled() {
            if self.reward_badge.count > 0 {
                cx.notify();
            }
            self.reward_badge = RewardBadge::default();
            return;
        }
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let revision = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let reconnect = self.status.connectivity != Connectivity::Online;
        let badge = &mut self.reward_badge;
        if badge.request.is_some()
            || badge
                .retry
                .is_some_and(|deadline| Instant::now() < deadline)
            || (!reconnect
                && badge.revision == revision
                && badge
                    .next_read
                    .is_some_and(|deadline| Instant::now() < deadline))
        {
            return;
        }
        badge.revision = revision;
        let request = Arc::new(());
        badge.request = Some(request.clone());
        let session = self.svc.session.clone();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.stamp_notices(1, true, true) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session)
                    || !root.directory_enabled()
                    || !root
                        .reward_badge
                        .request
                        .as_ref()
                        .is_some_and(|active| Arc::ptr_eq(active, &request))
                {
                    return;
                }
                let badge = &mut root.reward_badge;
                badge.request = None;
                badge.next_read = Instant::now().checked_add(NOTICE_REFRESH_INTERVAL);
                badge.retry = retry_at(result.as_ref().err());
                let count = match result {
                    Ok(page) => page.unread_count,
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized) => 0,
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

    pub(in crate::root) fn inbox_toolbar_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let count = self.reward_badge.count;
        self.button(
            "calendar-inbox",
            self.t(Key::CalendarInbox),
            Kind::Ghost,
            cx.listener(|root, _, _, cx| root.open_inbox(false, 1, cx)),
        )
        .relative()
        .when(count > 0 && self.directory_enabled(), |button| {
            button.child(
                div()
                    .absolute()
                    .top(px(-5.))
                    .right(px(-5.))
                    .min_w(px(16.))
                    .rounded_full()
                    .px_1()
                    .text_xs()
                    .text_center()
                    .bg(theme::accent_soft())
                    .child(if count > 99 {
                        "99+".to_owned()
                    } else {
                        count.to_string()
                    }),
            )
        })
    }

    pub(super) fn open_reward_inbox(&mut self, cx: &mut Context<Self>) {
        if !self.directory_enabled() {
            return;
        }
        let Overlay::Inbox(inbox) = &mut self.overlay else {
            return;
        };
        if inbox.busy {
            return;
        }
        inbox.rewards = Some(RewardInbox {
            identity: Arc::new(()),
            listing: None,
            page: 1,
            unread: false,
            busy: false,
            error: None,
            revision: None,
            online: false,
            next_read: Instant::now(),
            retry: None,
        });
        self.load_reward_inbox(1, false, None, cx);
        cx.notify();
    }

    pub(super) fn refresh_reward_inbox_if_changed(
        &mut self,
        status: &SyncStatus,
        cx: &mut Context<Self>,
    ) {
        let revision = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        if !self.directory_enabled() {
            if let Overlay::Inbox(inbox) = &mut self.overlay {
                inbox.rewards = None;
                cx.notify();
            }
            return;
        }
        let Some(view) = self.reward_inbox() else {
            return;
        };
        if status.connectivity != Connectivity::Online {
            view.online = false;
            return;
        }
        if view.busy
            || (view.online && revision == view.revision && Instant::now() < view.next_read)
        {
            return;
        }
        let (page, unread) = (view.page, view.unread);
        self.load_reward_inbox(page, unread, None, cx);
    }

    fn load_reward_inbox(
        &mut self,
        page: u32,
        unread: bool,
        read: Option<RewardNoticeRead>,
        cx: &mut Context<Self>,
    ) {
        let revision = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let online = self.svc.status().connectivity == Connectivity::Online;
        let transport = self
            .svc
            .transport()
            .filter(|_| online && self.directory_enabled());
        let session = self.svc.session.clone();
        let Some(view) = self.reward_inbox().filter(|view| {
            !view.busy && !view.retry.is_some_and(|deadline| Instant::now() < deadline)
        }) else {
            return;
        };
        let Some(transport) = transport else {
            return;
        };
        let identity = view.identity.clone();
        view.busy = true;
        view.online = true;
        view.revision = revision;
        view.error = None;
        if unread != view.unread {
            view.listing = None;
        }
        view.unread = unread;
        view.page = page;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let reply = cx
                .background_executor()
                .spawn(async move { transport.refresh_stamp_notices(page, unread, read.as_ref()) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) || !root.directory_enabled() {
                    return;
                }
                let Some(view) = root
                    .reward_inbox()
                    .filter(|view| Arc::ptr_eq(&view.identity, &identity))
                else {
                    return;
                };
                view.busy = false;
                view.next_read = Instant::now() + NOTICE_REFRESH_INTERVAL;
                view.retry = retry_at(reply.listing.as_ref().err())
                    .or_else(|| retry_at(reply.read_error.as_ref()));
                match reply.listing {
                    Ok(listing) => {
                        view.page = listing.page;
                        view.listing = Some(listing);
                        view.error = reply.read_error.map(|_| Key::RewardNoticeReadFailed);
                    }
                    Err(error) => {
                        if matches!(
                            error,
                            TransportError::Forbidden(_) | TransportError::Unauthorized
                        ) {
                            view.listing = None;
                        }
                        view.error = Some(Key::InboxUnavailable);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_reward_inbox(
        &self,
        view: &RewardInbox,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let listing = view.listing.as_ref();
        let online = self.status.connectivity == Connectivity::Online;
        let can_act = online && !view.busy;
        let page = view.page;
        let unread = view.unread;
        let mut list = div()
            .id("reward-inbox-list")
            .min_h_0()
            .max_h(px(420.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_2();
        if let Some(listing) = listing {
            list = list.when(listing.entries.is_empty(), |list| {
                list.child(self.t(Key::RewardNoticeEmpty))
            });
            for notice in &listing.entries {
                let id = notice.card_id;
                let client = notice.client_id.zip(notice.client_name.clone());
                let date = self.date_time_label(notice.earned_at);
                let generation = listing.generation.clone();
                let notice_revision = notice.revision;
                list = list.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .rounded_lg()
                        .p_3()
                        .border_1()
                        .border_color(theme::line())
                        .child(self.label(if notice.issued {
                            Key::RewardNoticeIssued
                        } else {
                            Key::StampCompleted
                        }))
                        .child(notice.reward_name.clone())
                        .child(
                            div()
                                .text_sm()
                                .text_color(theme::muted())
                                .child(format!("{} · {}", notice.card_name, date)),
                        )
                        .when_some(notice.reward_expires_at, |row, expiry| {
                            let day = (expiry - chrono::Duration::milliseconds(1))
                                .with_timezone(&self.tz)
                                .format("%d/%m/%Y");
                            row.child(self.t(Key::StampExpiry).replace("{date}", &day.to_string()))
                        })
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .gap_2()
                                .when_some(client, |row, (client_id, name)| {
                                    row.child(
                                        self.button(
                                            SharedString::from(format!("reward-notice-open-{id}")),
                                            name.clone(),
                                            Kind::Ghost,
                                            cx.listener(move |root, _, _, cx| {
                                                root.open_reward_notice_client(
                                                    client_id,
                                                    name.clone(),
                                                    cx,
                                                )
                                            }),
                                        )
                                        .tab_index(0)
                                        .focus(|style| style.border_color(theme::text())),
                                    )
                                })
                                .when(notice.read, |row| {
                                    row.child(div().text_sm().child(self.t(Key::RewardNoticeRead)))
                                })
                                .when(!notice.read && can_act, |row| {
                                    row.child(self.loyalty_button(
                                        SharedString::from(format!("reward-notice-read-{id}")),
                                        Key::RewardNoticeMarkRead,
                                        Kind::Ghost,
                                        move |root, cx| {
                                            root.load_reward_inbox(
                                                page,
                                                unread,
                                                Some(RewardNoticeRead {
                                                    generation: generation.clone(),
                                                    card_id: id,
                                                    revision: notice_revision,
                                                }),
                                                cx,
                                            )
                                        },
                                        cx,
                                    ))
                                }),
                        ),
                );
            }
        }
        self.modal(
            div()
                .tab_group()
                .flex()
                .flex_col()
                .gap_3()
                .child(self.label(Key::RewardNoticeTitle))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(self.loyalty_button(
                            "reward-inbox-appointments",
                            Key::RewardNoticeAppointments,
                            Kind::Ghost,
                            |root, cx| root.open_inbox(false, 1, cx),
                            cx,
                        ))
                        .when(can_act, |row| {
                            row.child(self.loyalty_button(
                                "reward-inbox-all",
                                Key::RewardNoticeAll,
                                if unread { Kind::Ghost } else { Kind::Primary },
                                |root, cx| root.load_reward_inbox(1, false, None, cx),
                                cx,
                            ))
                            .child(self.loyalty_button(
                                "reward-inbox-unread",
                                Key::RewardNoticeUnread,
                                if unread { Kind::Primary } else { Kind::Ghost },
                                |root, cx| root.load_reward_inbox(1, true, None, cx),
                                cx,
                            ))
                            .child(self.loyalty_button(
                                "reward-inbox-refresh",
                                Key::InboxRefresh,
                                Kind::Ghost,
                                move |root, cx| root.load_reward_inbox(page, unread, None, cx),
                                cx,
                            ))
                        }),
                )
                .when(!online, |body| body.child(self.t(Key::StampOffline)))
                .when(view.busy, |body| body.child(self.t(Key::InboxLoading)))
                .when_some(view.error, |body, key| {
                    body.child(div().text_color(theme::conflict_fg()).child(self.t(key)))
                })
                .child(list)
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .when(can_act && page > 1, |row| {
                            row.child(self.loyalty_button(
                                "reward-notice-prev",
                                Key::MarketingPreviousPage,
                                Kind::Ghost,
                                move |root, cx| root.load_reward_inbox(page - 1, unread, None, cx),
                                cx,
                            ))
                        })
                        .when(
                            can_act
                                && listing.is_some_and(|value| {
                                    page.saturating_mul(value.page_size) < value.total
                                }),
                            |row| {
                                row.child(self.loyalty_button(
                                    "reward-notice-next",
                                    Key::MarketingNextPage,
                                    Kind::Ghost,
                                    move |root, cx| {
                                        root.load_reward_inbox(page + 1, unread, None, cx)
                                    },
                                    cx,
                                ))
                            },
                        )
                        .child(self.loyalty_button(
                            "reward-notice-close",
                            Key::Close,
                            Kind::Ghost,
                            |root, cx| {
                                root.overlay = Overlay::None;
                                cx.notify();
                            },
                            cx,
                        )),
                ),
        )
    }
}
