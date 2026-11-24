use super::*;
use chrono::NaiveTime;
use sob_core::store::CalendarCacheScope;
use sob_core::sync::TransportError;
use sob_core::waitlist::{
    AcceptOffer, AcceptOfferError, BookedAppointment, ImportedRequest, WaitlistPage,
    WaitlistPolicy, WaitlistRange, WaitlistRequest, WaitlistState, WaitlistView,
};
use std::sync::Arc;

mod review;
#[cfg(test)]
pub(super) use review::show_intake_test_offer;

const COUNT_REFRESH_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Default)]
pub(super) struct WaitlistCount {
    query: Option<(WaitlistRange, CalendarCacheScope)>,
    total: Option<u32>,
    revision: Option<i64>,
    requested_at: Option<Instant>,
    request: Option<Arc<()>>,
}

pub(super) struct Desk {
    view: WaitlistView,
    page: u32,
    scope: Option<CalendarCacheScope>,
    data: Option<WaitlistPage>,
    busy: bool,
    cached: bool,
    saved_pages: Vec<u32>,
    error: Option<Key>,
    confirm: Option<String>,
    form: Option<Draft>,
    offer_review: Option<review::OfferReview>,
    policy_review: Option<review::PolicyReview>,
    booked: Option<BookedAppointment>,
    observed_revision: i64,
    requested_at: Instant,
}

impl Desk {
    fn reject_scope(&mut self) {
        self.clear_private_data();
        self.saved_pages.clear();
        self.busy = false;
        self.error = Some(Key::WaitlistError);
    }

    fn clear_private_data(&mut self) {
        self.data = None;
        self.cached = false;
        self.form = None;
        self.offer_review = None;
        self.policy_review = None;
        self.confirm = None;
        self.booked = None;
    }

    fn adjacent_pages(&self, online: bool) -> (Option<u32>, Option<u32>) {
        if self.busy {
            return (None, None);
        }
        if online && !self.cached {
            let previous = (self.page > 1).then(|| self.page - 1);
            let next = self
                .data
                .as_ref()
                .filter(|data| self.page.saturating_mul(data.page_size) < data.total)
                .and_then(|_| self.page.checked_add(1));
            return (previous, next);
        }
        (
            self.saved_pages
                .iter()
                .copied()
                .rfind(|&page| page < self.page),
            self.saved_pages
                .iter()
                .copied()
                .find(|&page| page > self.page),
        )
    }

    pub(super) fn editable_intake(
        &mut self,
    ) -> Option<&mut Vec<super::intake_editor::IntakeDraft>> {
        self.offer_review.as_mut()?.editable_intake()
    }

    pub(super) fn set_intake_error(&mut self, key: Key) {
        self.error = Some(key);
    }
}

struct Draft {
    client: Option<String>,
    staff: Option<String>,
    staff_confirmed: bool,
    services: Vec<String>,
    imported: Option<ImportedRequest>,
    client_search: Entity<TextField>,
    service_search: Entity<TextField>,
    from_date: Entity<TextField>,
    to_date: Entity<TextField>,
    from_time: Entity<TextField>,
    to_time: Entity<TextField>,
    request: Option<WaitlistRequest>,
    _subs: Vec<Subscription>,
}

impl Draft {
    fn import_block(&self, today: NaiveDate, offers_enabled: bool) -> Option<Key> {
        let imported = self.imported.as_ref()?;
        if imported.requested_date < today {
            Some(Key::WaitlistImportedPast)
        } else if offers_enabled {
            Some(Key::WaitlistImportNeedsPause)
        } else if !self.staff_confirmed {
            Some(Key::WaitlistConfirmProfessional)
        } else {
            None
        }
    }
}

enum Action {
    Read,
    Join(WaitlistRequest),
    Cancel(String, u32),
    Decline(String, u32, String),
    Policy(WaitlistPolicy),
    Accept(String, AcceptOffer),
}

enum ReloadNotice {
    ImportedRejected,
    IntakeChanged,
    OfferRejected(Key),
}

impl Root {
    fn calendar_waitlist_range(&self) -> WaitlistRange {
        if !matches!(
            self.calendar_mode,
            CalendarMode::Day | CalendarMode::Resources
        ) && let Some((first, last)) = self.period_views.first().zip(self.period_views.last())
        {
            return WaitlistRange {
                from: first.date,
                to: last.date,
            };
        }
        WaitlistRange {
            from: self.date,
            to: self.date,
        }
    }

    pub(super) fn can_view_waitlist(&self) -> bool {
        self.calendar_edits_allowed && self.directory_enabled()
    }

    pub(super) fn waitlist_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let range = self.calendar_waitlist_range();
        let total = self
            .waitlist_count
            .query
            .as_ref()
            .filter(|(shown, _)| *shown == range)
            .and(self.waitlist_count.total);
        let label = total.map_or_else(
            || self.t(Key::Waitlist).to_owned(),
            |total| {
                i18n::fill(
                    self.t(Key::WaitlistCalendarCount),
                    &[("n", &total.to_string())],
                )
            },
        );
        self.button(
            "waitlist",
            label,
            Kind::Ghost,
            cx.listener(move |root, _, _, cx| {
                root.open_waitlist(WaitlistView::Calendar(range), 1, cx)
            }),
        )
    }

    pub(super) fn refresh_waitlist_count(&mut self, status: &SyncStatus, cx: &mut Context<Self>) {
        let range = self.calendar_waitlist_range();
        let query = self
            .can_view_waitlist()
            .then(|| self.svc.store.calendar_cache_scope().ok())
            .flatten()
            .map(|scope| (range, scope));
        let count = &mut self.waitlist_count;
        if count.query != query {
            *count = WaitlistCount {
                total: query.as_ref().and_then(|(_, scope)| {
                    self.svc
                        .store
                        .waitlist_cache(WaitlistView::Calendar(range), 1)
                        .ok()
                        .filter(|saved| saved.scope.as_ref() == Some(scope))
                        .and_then(|saved| saved.current.map(|page| page.total))
                }),
                query,
                ..Default::default()
            };
            cx.notify();
        }
        if status.connectivity != Connectivity::Online {
            count.revision = None;
            return;
        }
        let Some(transport) = self.svc.transport().filter(|_| count.query.is_some()) else {
            return;
        };
        let revision = self.svc.store.live_view_revision("waitlist").ok();
        if count.request.is_some()
            || (count.revision == revision
                && count
                    .requested_at
                    .is_some_and(|last| last.elapsed() < COUNT_REFRESH_INTERVAL))
        {
            return;
        }
        let request = Arc::new(());
        count.request = Some(request.clone());
        count.revision = revision;
        count.requested_at = Some(Instant::now());
        let session = self.svc.session.clone();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.waitlist_count(range) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session)
                    || !root
                        .waitlist_count
                        .request
                        .as_ref()
                        .is_some_and(|pending| Arc::ptr_eq(pending, &request))
                {
                    return;
                }
                root.waitlist_count.request = None;
                if !root.can_view_waitlist()
                    || root.calendar_waitlist_range() != range
                    || root.waitlist_count.query.as_ref().is_none_or(|(_, scope)| {
                        root.svc.store.calendar_cache_scope().ok().as_ref() != Some(scope)
                    })
                {
                    return;
                }
                match result {
                    Ok(total) => root.waitlist_count.total = Some(total),
                    Err(TransportError::Unauthorized | TransportError::Forbidden(_)) => {
                        root.waitlist_count.total = None;
                        let _ = root.svc.store.clear_waitlist_cache();
                    }
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn refresh_open_waitlist_scope(&mut self) {
        if let Overlay::Waitlist(desk) = &self.overlay
            && (!self.can_view_waitlist()
                || self.svc.store.calendar_cache_scope().ok() != desk.scope)
        {
            self.waitlist_generation = self.waitlist_generation.wrapping_add(1);
            self.overlay = Overlay::None;
        }
    }

    pub(super) fn refresh_waitlist_if_changed(
        &mut self,
        reconnected: bool,
        cx: &mut Context<Self>,
    ) {
        if matches!(&self.overlay, Overlay::Waitlist(desk)
            if !desk.busy && (reconnected
                || self.svc.store.live_view_revision("waitlist").ok()
                    .is_some_and(|revision| revision != desk.observed_revision)
                || ((desk.cached || desk.data.is_none()) && desk.requested_at.elapsed() >= Duration::from_secs(15))))
        {
            self.waitlist_request(Action::Read, cx);
        }
    }

    pub(super) fn open_waitlist(&mut self, view: WaitlistView, page: u32, cx: &mut Context<Self>) {
        if matches!(&self.overlay, Overlay::Waitlist(d) if d.busy) {
            return;
        }
        self.waitlist_generation = self.waitlist_generation.wrapping_add(1);
        let saved = self
            .svc
            .store
            .waitlist_cache(view, page)
            .unwrap_or_default();
        self.overlay = Overlay::Waitlist(Box::new(Desk {
            view,
            page,
            scope: saved
                .scope
                .or_else(|| self.svc.store.calendar_cache_scope().ok()),
            busy: false,
            cached: saved.current.is_some(),
            data: saved.current,
            saved_pages: saved.pages,
            error: None,
            confirm: None,
            form: None,
            offer_review: None,
            policy_review: None,
            booked: None,
            observed_revision: 0,
            requested_at: Instant::now(),
        }));
        if self.status.connectivity == Connectivity::Offline {
            cx.notify();
        } else {
            self.waitlist_request(Action::Read, cx);
        }
    }

    fn waitlist_request(&mut self, action: Action, cx: &mut Context<Self>) {
        let Overlay::Waitlist(d) = &mut self.overlay else {
            return;
        };
        if d.busy {
            return;
        }
        d.requested_at = Instant::now();
        let Ok(scope) = self.svc.store.calendar_cache_scope() else {
            d.reject_scope();
            cx.notify();
            return;
        };
        if !scope.permits_read() || Some(&scope) != d.scope.as_ref() {
            d.reject_scope();
            cx.notify();
            return;
        }
        if !matches!(action, Action::Read)
            && (self.status.connectivity != Connectivity::Online
                || (d.cached
                    && !d
                        .offer_review
                        .as_ref()
                        .is_some_and(|review| review.is_acceptance_retry(&action))))
        {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            d.error = Some(Key::WaitlistError);
            cx.notify();
            return;
        };
        self.waitlist_generation = self.waitlist_generation.wrapping_add(1);
        let generation = self.waitlist_generation;
        let session = self.svc.session.clone();
        let (view, page) = (d.view, d.page);
        d.observed_revision = self
            .svc
            .store
            .live_view_revision("waitlist")
            .unwrap_or_default();
        d.busy = true;
        d.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let (changed, booked, result, notice) = cx
                .background_executor()
                .spawn(async move {
                    let changed = !matches!(action, Action::Read);
                    let change = match &action {
                        Action::Read => Ok(None),
                        Action::Join(input) => transport.join_waitlist(input).map(|_| None),
                        Action::Cancel(id, version) => {
                            transport.cancel_waitlist(id, *version).map(|_| None)
                        }
                        Action::Decline(id, version, offer) => transport
                            .requeue_waitlist_offer(id, *version, offer)
                            .map(|_| None),
                        Action::Policy(policy) => {
                            transport.update_waitlist_policy(policy).map(|_| None)
                        }
                        Action::Accept(id, input) => match transport.accept_waitlist_offer(id, input) {
                            Ok(response) => Ok(Some(response.appointment)),
                            Err(AcceptOfferError::Transport(error)) => Err(error),
                            Err(AcceptOfferError::IntakeChanged) => {
                                return (false, None, transport.waitlist(page, view), Some(ReloadNotice::IntakeChanged));
                            }
                            Err(AcceptOfferError::ResponseLimit) => {
                                return (false, None, transport.waitlist(page, view), Some(ReloadNotice::OfferRejected(Key::WaitlistResponseLimit)));
                            }
                            Err(AcceptOfferError::Rejected) => {
                                return (false, None, transport.waitlist(page, view), Some(ReloadNotice::OfferRejected(Key::WaitlistOfferRejected)));
                            }
                        },
                    };
                    let booked = match change {
                        Ok(booked) => booked,
                        Err(TransportError::BadRequest(_))
                            if matches!(&action, Action::Join(input) if input.imported_entry_id.is_some()) =>
                        {
                            return (false, None, transport.waitlist(page, view), Some(ReloadNotice::ImportedRejected));
                        }
                        Err(e) => return (false, None, Err(e), None),
                    };
                    let mut result = transport.waitlist(page, view);
                    if page > 1 && result.as_ref().is_ok_and(|page| page.entries.is_empty()) {
                        result = transport.waitlist(1, view);
                    }
                    (changed, booked, result, None)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                if !Arc::ptr_eq(&session, &this.svc.session) || this.svc.current_session().is_none()
                {
                    return;
                }
                if this.svc.store.calendar_cache_scope().ok().as_ref() != Some(&scope) {
                    if generation == this.waitlist_generation
                        && let Overlay::Waitlist(d) = &mut this.overlay
                    {
                        d.reject_scope();
                        cx.notify();
                    }
                    return;
                }
                let denied = matches!(
                    &result,
                    Err(TransportError::Unauthorized | TransportError::Forbidden(_))
                );
                if denied {
                    let _ = this.svc.store.clear_waitlist_cache();
                }
                if booked.is_some() {
                    this.svc.wake(Wake::Manual);
                }
                if generation != this.waitlist_generation {
                    return;
                }
                let Overlay::Waitlist(d) = &mut this.overlay else {
                    return;
                };
                d.busy = false;
                match notice {
                    Some(ReloadNotice::IntakeChanged) => {
                        if let Some(review) = &mut d.offer_review {
                            review.require_intake_review();
                        }
                        d.error = Some(Key::WaitlistFormsChanged);
                    }
                    Some(ReloadNotice::OfferRejected(message)) => {
                        let current = d.offer_review.as_ref().is_some_and(|review| {
                            result.as_ref().is_ok_and(|page| page.entries.iter().any(|entry| review.is_same_offer(entry)))
                        });
                        if current && let Some(review) = &mut d.offer_review {
                            review.clear_request();
                        } else {
                            d.offer_review = None;
                        }
                        d.error = Some(message);
                    }
                    _ => {}
                }
                if changed || denied {
                    d.clear_private_data();
                    d.booked = booked;
                    if denied {
                        d.saved_pages.clear();
                    }
                }
                match result {
                    Ok(data) => {
                        match this.svc.store.cache_waitlist(&scope, view, &data) {
                            Ok(Some(pages)) => d.saved_pages = pages,
                            Ok(None) => {
                                d.reject_scope();
                                cx.notify();
                                return;
                            }
                            Err(_) => {}
                        }
                        d.page = data.page;
                        if d.form.as_ref().and_then(|draft| draft.imported.as_ref()).is_some_and(
                            |row| !data.imported.iter().any(|item| item.id == row.id),
                        ) {
                            d.form = None;
                        }
                        d.data = Some(data);
                        d.cached = false;
                        if matches!(notice, Some(ReloadNotice::ImportedRejected)) {
                            d.error = Some(Key::WaitlistError);
                        }
                    }
                    Err(_) => {
                        d.error = Some(Key::WaitlistError);
                        d.cached = d.data.is_some();
                        d.confirm = None;
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn start_waitlist_draft(&mut self, imported: Option<ImportedRequest>, cx: &mut Context<Self>) {
        let today = self.calendar_now.with_timezone(&self.tz).date_naive();
        if imported
            .as_ref()
            .is_some_and(|row| row.requested_date < today)
        {
            return;
        }
        let date = imported
            .as_ref()
            .map_or_else(
                || match &self.overlay {
                    Overlay::Waitlist(desk) => desk
                        .view
                        .range()
                        .map_or(self.date, |range| range.from.max(today)),
                    _ => self.date,
                },
                |row| row.requested_date,
            )
            .to_string();
        let client_search = cx.new(|cx| TextField::new(self.t(Key::SearchClients), false, cx));
        let service_search =
            cx.new(|cx| TextField::new(self.t(Key::WaitlistFindService), false, cx));
        let field = |label, value: &str, cx: &mut Context<Self>| {
            cx.new(|cx| {
                let mut field = TextField::new(self.t(label), false, cx);
                field.set_text(value, cx);
                field
            })
        };
        let from_date = field(Key::WaitlistFromDate, &date, cx);
        let to_date = field(Key::WaitlistToDate, &date, cx);
        let from_time = field(Key::WaitlistFromTime, "", cx);
        let to_time = field(Key::WaitlistToTime, "", cx);
        let subs = [&client_search, &service_search]
            .map(|search| cx.subscribe(search, |_, _, _, cx| cx.notify()))
            .into();
        if let Overlay::Waitlist(d) = &mut self.overlay {
            d.confirm = None;
            d.error = None;
            d.form = Some(Draft {
                client: imported.as_ref().map(|row| row.client_id.clone()),
                staff_confirmed: imported.is_none(),
                imported,
                staff: None,
                services: vec![],
                client_search,
                service_search,
                from_date,
                to_date,
                from_time,
                to_time,
                request: None,
                _subs: subs,
            });
        }
        cx.notify();
    }

    fn submit_waitlist(&mut self, cx: &mut Context<Self>) {
        let today = self.calendar_now.with_timezone(&self.tz).date_naive();
        let Overlay::Waitlist(d) = &mut self.overlay else {
            return;
        };
        let Some(f) = d.form.as_mut() else {
            return;
        };
        if d.busy
            || d.cached
            || self.status.connectivity != Connectivity::Online
            || d.data
                .as_ref()
                .is_none_or(|data| !data.policy.enabled && f.imported.is_none())
        {
            return;
        }
        if let Some(reason) = f.import_block(
            today,
            d.data.as_ref().is_some_and(|data| data.policy.enabled),
        ) {
            d.error = Some(reason);
            cx.notify();
            return;
        }
        let value = |input: &Entity<TextField>| input.read(cx).text().trim();
        let request = (|| {
            let from_date = NaiveDate::parse_from_str(value(&f.from_date), "%Y-%m-%d").ok()?;
            let to_date = NaiveDate::parse_from_str(value(&f.to_date), "%Y-%m-%d").ok()?;
            let from = NaiveTime::parse_from_str(value(&f.from_time), "%H:%M").ok()?;
            let to = NaiveTime::parse_from_str(value(&f.to_time), "%H:%M").ok()?;
            if from >= to
                || !(0..30).contains(&(to_date - from_date).num_days())
                || !(1..=8).contains(&f.services.len())
            {
                return None;
            }
            Some(WaitlistRequest {
                client_id: f.client.clone()?,
                staff_id: f.staff.clone(),
                service_ids: f.services.clone(),
                from_date,
                to_date,
                from_time: from.format("%H:%M").to_string(),
                to_time: to.format("%H:%M").to_string(),
                imported_entry_id: f.imported.as_ref().map(|row| row.id.clone()),
                idempotency_key: f
                    .request
                    .as_ref()
                    .map_or_else(WaitlistRequest::new_key, |old| old.idempotency_key.clone()),
            })
        })();
        let Some(mut request) = request else {
            d.error = Some(Key::WaitlistInvalid);
            cx.notify();
            return;
        };
        if let Some(imported) = &f.imported {
            let required = self
                .services
                .iter()
                .filter(|s| f.services.contains(&s.id))
                .map(|s| s.duration_minutes + s.buffer_minutes)
                .sum::<i64>();
            if required != i64::from(imported.duration_minutes) {
                d.error = Some(Key::WaitlistDuration);
                cx.notify();
                return;
            }
        }
        if f.request
            .as_ref()
            .is_some_and(|previous| previous != &request)
        {
            request.idempotency_key = WaitlistRequest::new_key();
        }
        f.request = Some(request.clone());
        self.waitlist_request(Action::Join(request), cx);
    }

    pub(super) fn render_waitlist(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let can_write = !desk.busy && !desk.cached && online;
        let can_join = can_write && desk.data.as_ref().is_some_and(|data| data.policy.enabled);
        let today = self.calendar_now.with_timezone(&self.tz).date_naive();
        let view = desk.view;
        let calendar_view = WaitlistView::Calendar(self.calendar_waitlist_range());
        let active = view.active();
        let page = desk.page;
        let (previous, next) = desk.adjacent_pages(online);
        let rows = div()
            .id("waitlist-entries")
            .min_h_0()
            .max_h(px(395.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_2();
        let body = if let Some(review) = &desk.offer_review {
            self.render_waitlist_offer(review, can_write, cx)
        } else if let Some(review) = &desk.policy_review {
            self.render_waitlist_policy(review, can_write, cx)
        } else if let Some(form) = &desk.form {
            let offers_enabled = desk.data.as_ref().is_some_and(|data| data.policy.enabled);
            let import_block = form.import_block(today, offers_enabled);
            self.render_waitlist_draft(
                form,
                can_join || (can_write && form.imported.is_some()),
                import_block,
                cx,
            )
        } else {
            div()
                .flex()
                .flex_col()
                .min_h_0()
                .gap_2()
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(self.button(
                            "wl-calendar",
                            self.t(Key::WaitlistThisPeriod),
                            if view.range().is_some() {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |this, _, _, cx| {
                                this.open_waitlist(calendar_view, 1, cx)
                            }),
                        ))
                        .child(self.button(
                            "wl-active",
                            self.t(Key::WaitlistActive),
                            if view == WaitlistView::Active {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(|this, _, _, cx| {
                                this.open_waitlist(WaitlistView::Active, 1, cx)
                            }),
                        ))
                        .child(self.button(
                            "wl-all",
                            self.t(Key::WaitlistAll),
                            if view == WaitlistView::History {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(|this, _, _, cx| {
                                this.open_waitlist(WaitlistView::History, 1, cx)
                            }),
                        ))
                        .when(can_join, |d| {
                            d.child(self.button(
                                "wl-new",
                                self.t(Key::WaitlistNew),
                                Kind::Ghost,
                                cx.listener(|this, _, _, cx| this.start_waitlist_draft(None, cx)),
                            ))
                        })
                        .when(
                            can_write
                                && desk.data.is_some()
                                && self
                                    .svc
                                    .current_session()
                                    .is_some_and(|s| s.role == "owner"),
                            |d| {
                                d.child(self.button(
                                    "wl-policy",
                                    self.t(Key::WaitlistPolicySettings),
                                    Kind::Ghost,
                                    cx.listener(|this, _, _, cx| this.begin_waitlist_policy(cx)),
                                ))
                            },
                        ),
                )
                .child(rows.when_some(desk.data.as_ref(), |r, data| {
                    r.when(active && page == 1, |r| {
                        r.children(data.imported.iter().map(|row| {
                            let selected = row.clone();
                            let expired = row.requested_date < today;
                            div()
                                .p_3()
                                .rounded_lg()
                                .bg(theme::accent_soft())
                                .flex()
                                .flex_col()
                                .gap_2()
                                .child(if expired {
                                    div()
                                        .debug_selector(|| format!("wl-source-past-{}", row.id))
                                        .child(self.t(Key::WaitlistImportedPast))
                                } else {
                                    div().child(self.t(Key::WaitlistReview))
                                })
                                .child(SharedString::from(format!(
                                    "{} · {} · {} min{}",
                                    row.client_name,
                                    row.requested_date,
                                    row.duration_minutes,
                                    if row.flexible {
                                        format!(" · {}", self.t(Key::WaitlistFlexible))
                                    } else {
                                        String::new()
                                    }
                                )))
                                .when(can_write && !expired, |d| {
                                    d.child(
                                        self.button(
                                            SharedString::from(format!("wl-import-{}", row.id)),
                                            self.t(Key::WaitlistReview),
                                            Kind::Ghost,
                                            cx.listener(move |this, _, _, cx| {
                                                this.start_waitlist_draft(
                                                    Some(selected.clone()),
                                                    cx,
                                                )
                                            }),
                                        )
                                        .debug_selector(|| format!("wl-import-{}", row.id)),
                                    )
                                })
                        }))
                    })
                    .when(data.entries.is_empty(), |r| {
                        r.child(div().p_2().child(self.t(Key::WaitlistEmpty)))
                    })
                    .children(data.entries.iter().map(|entry| {
                        let id = entry.id.clone();
                        let review = entry.clone();
                        let version = entry.version;
                        let confirm = desk.confirm.as_ref() == Some(&entry.id);
                        let pending =
                            matches!(entry.state, WaitlistState::Waiting | WaitlistState::Offered);
                        let state = self.t(match entry.state {
                            WaitlistState::Waiting => Key::WaitlistWaiting,
                            WaitlistState::Offered => Key::WaitlistOffered,
                            WaitlistState::Booked => Key::WaitlistBooked,
                            WaitlistState::Cancelled => Key::WaitlistCancelled,
                            WaitlistState::Expired => Key::WaitlistExpired,
                            WaitlistState::Unavailable => Key::WaitlistUnavailable,
                        });
                        div()
                            .p_3()
                            .border_1()
                            .border_color(theme::line())
                            .rounded_lg()
                            .flex()
                            .flex_col()
                            .gap_2()
                            .child(
                                div()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(SharedString::from(
                                        entry
                                            .client_name
                                            .as_deref()
                                            .unwrap_or(self.t(Key::UnknownClient))
                                            .to_owned(),
                                    )),
                            )
                            .child(div().text_sm().child(SharedString::from(format!(
                                "{state} · {}",
                                entry.service_names.join(", ")
                            ))))
                            .child(div().text_sm().text_color(theme::muted()).child(
                                SharedString::from(format!(
                                    "{} – {} · {}–{}",
                                    entry.from_date, entry.to_date, entry.from_time, entry.to_time
                                )),
                            ))
                            .when_some(entry.staff_id.as_ref(), |d, id| {
                                d.child(
                                    div()
                                        .text_sm()
                                        .child(SharedString::from(self.staff_name(id))),
                                )
                            })
                            .when_some(entry.offer.as_ref(), |d, offer| {
                                d.child(div().text_sm().child(SharedString::from(format!(
                                    "{} · {}",
                                    self.date_time_label(offer.starts_at),
                                    self.date_time_label(offer.expires_at)
                                ))))
                            })
                            .when(
                                can_write && entry.can_manage && entry.offer.is_some(),
                                |d| {
                                    d.child(self.button(
                                        SharedString::from(format!("wl-offer-{}", entry.id)),
                                        self.t(Key::WaitlistReviewOffer),
                                        Kind::Primary,
                                        cx.listener(move |this, _, _, cx| {
                                            this.begin_waitlist_offer(review.clone(), cx)
                                        }),
                                    ))
                                },
                            )
                            .when_some(entry.booked_appointment.clone(), |d, booked| {
                                d.child(self.button(
                                    SharedString::from(format!("wl-booked-{}", entry.id)),
                                    self.t(Key::ViewBookingNotice),
                                    Kind::Ghost,
                                    cx.listener(move |this, _, _, cx| {
                                        this.open_waitlist_booking(&booked, cx)
                                    }),
                                ))
                            })
                            .when(can_write && pending && entry.can_manage, |d| {
                                d.child(self.button(
                                    SharedString::from(format!("wl-cancel-{}", entry.id)),
                                    self.t(if confirm {
                                        Key::WaitlistConfirm
                                    } else {
                                        Key::WaitlistRemove
                                    }),
                                    Kind::Danger,
                                    cx.listener(move |this, _, _, cx| {
                                        if confirm {
                                            this.waitlist_request(
                                                Action::Cancel(id.clone(), version),
                                                cx,
                                            );
                                        } else if let Overlay::Waitlist(d) = &mut this.overlay {
                                            d.confirm = Some(id.clone());
                                            cx.notify();
                                        }
                                    }),
                                ))
                            })
                    }))
                }))
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .items_center()
                        .when_some(previous, |d, previous| {
                            d.child(self.button(
                                "wl-prev",
                                self.t(Key::InboxPrevious),
                                Kind::Ghost,
                                cx.listener(move |this, _, _, cx| {
                                    this.open_waitlist(view, previous, cx)
                                }),
                            ))
                        })
                        .child(SharedString::from(
                            self.t(Key::InboxPage).replace("{n}", &page.to_string()),
                        ))
                        .when_some(next, |d, next| {
                            d.child(self.button(
                                "wl-next",
                                self.t(Key::InboxNext),
                                Kind::Ghost,
                                cx.listener(move |this, _, _, cx| {
                                    this.open_waitlist(view, next, cx)
                                }),
                            ))
                        }),
                )
        };
        self.modal_with_height(
            div()
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::BOLD)
                        .child(self.t(Key::Waitlist)),
                )
                .when_some(view.range(), |d, range| {
                    let start = i18n::date_label(self.locale, range.from);
                    let label = if range.from == range.to {
                        start
                    } else {
                        format!("{start} – {}", i18n::date_label(self.locale, range.to))
                    };
                    d.child(div().text_sm().text_color(theme::muted()).child(label))
                })
                .when(
                    desk.data.as_ref().is_some_and(|data| !data.policy.enabled),
                    |d| d.child(div().text_sm().child(self.t(Key::WaitlistPaused))),
                )
                .when((desk.cached || !online) && desk.data.is_some(), |d| {
                    d.child(div().text_sm().child(self.t(Key::WaitlistSavedPage)))
                })
                .when(
                    !online && !desk.busy && desk.data.is_none() && desk.error.is_none(),
                    |d| d.child(div().text_sm().child(self.t(Key::WaitlistPageNotSaved))),
                )
                .when(desk.busy, |d| {
                    d.child(div().text_sm().child(self.t(Key::WaitlistLoading)))
                })
                .when_some(desk.error, |d, error| {
                    d.child(
                        div()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(self.t(error)),
                    )
                })
                .when_some(desk.booked.clone(), |d, booked| {
                    d.child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(self.t(Key::WaitlistBookingConfirmed))
                            .child(self.button(
                                "wl-open-booked",
                                self.t(Key::ViewBookingNotice),
                                Kind::Primary,
                                cx.listener(move |this, _, _, cx| {
                                    this.open_waitlist_booking(&booked, cx)
                                }),
                            )),
                    )
                })
                .child(body)
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap_2()
                        .when(online && !desk.busy, |d| {
                            d.child(self.button(
                                "wl-refresh",
                                self.t(Key::InboxRefresh),
                                Kind::Ghost,
                                cx.listener(|this, _, _, cx| {
                                    this.waitlist_request(Action::Read, cx)
                                }),
                            ))
                        })
                        .child(self.button(
                            "wl-close",
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

    fn render_waitlist_draft(
        &self,
        f: &Draft,
        can_join: bool,
        import_block: Option<Key>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let name = f.client_search.read(cx).text().trim().to_lowercase();
        let search = f.service_search.read(cx).text().trim().to_lowercase();
        let performed = f
            .staff
            .as_ref()
            .map(|id| ops::performed_services(&self.svc.store, id).unwrap_or_default());
        let label = |key: Key, field: &Entity<TextField>| {
            div()
                .flex_1()
                .flex()
                .flex_col()
                .gap_1()
                .child(div().text_sm().child(self.t(key)))
                .child(field.clone())
        };
        div()
            .flex()
            .flex_col()
            .gap_2()
            .when_some(f.imported.as_ref(), |d, row| {
                d.child(SharedString::from(format!(
                    "{} · {} · {} min",
                    row.client_name, row.requested_date, row.duration_minutes
                )))
            })
            .when(f.imported.is_none(), |d| {
                d.child(f.client_search.clone()).child(
                    div()
                        .id("wl-clients")
                        .max_h(px(75.))
                        .overflow_y_scroll()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .children(
                            self.clients
                                .iter()
                                .filter(|(id, title)| {
                                    f.client.as_ref() == Some(id)
                                        || title.to_lowercase().contains(&name)
                                })
                                .take(12)
                                .map(|(id, title)| {
                                    let id = id.clone();
                                    self.chip(
                                        SharedString::from(format!("wl-client-{id}")),
                                        SharedString::from(title.clone()),
                                        f.client.as_ref() == Some(&id),
                                        cx.listener(move |this, _, _, cx| {
                                            if let Overlay::Waitlist(d) = &mut this.overlay
                                                && let Some(f) = &mut d.form
                                            {
                                                f.client = Some(id.clone());
                                                cx.notify();
                                            }
                                        }),
                                    )
                                }),
                        ),
                )
            })
            .child(
                div()
                    .id("wl-staff")
                    .max_h(px(70.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(
                        self.chip(
                            "wl-any",
                            self.t(Key::WaitlistAnyStaff),
                            f.staff.is_none() && f.staff_confirmed,
                            cx.listener(|this, _, _, cx| this.set_waitlist_staff(None, cx)),
                        )
                        .debug_selector(|| "wl-any".to_string()),
                    )
                    .children(self.staff.iter().filter(|s| s.active).map(|staff| {
                        let id = staff.id.clone();
                        self.chip(
                            SharedString::from(format!("wl-staff-{id}")),
                            SharedString::from(staff.display_name.clone()),
                            f.staff.as_ref() == Some(&id),
                            cx.listener(move |this, _, _, cx| {
                                this.set_waitlist_staff(Some(id.clone()), cx)
                            }),
                        )
                    })),
            )
            .child(f.service_search.clone())
            .child(
                div()
                    .id("wl-services")
                    .max_h(px(110.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(
                        self.services
                            .iter()
                            .filter(|s| {
                                s.active
                                    && performed.as_ref().is_none_or(|rows| rows.contains(&s.id))
                                    && (f.services.contains(&s.id)
                                        || s.name.to_lowercase().contains(&search))
                            })
                            .take(20)
                            .map(|s| {
                                let id = s.id.clone();
                                self.chip(
                                    SharedString::from(format!("wl-svc-{id}")),
                                    SharedString::from(format!(
                                        "{} ({} min)",
                                        s.name,
                                        s.duration_minutes + s.buffer_minutes
                                    )),
                                    f.services.contains(&id),
                                    cx.listener(move |this, _, _, cx| {
                                        if let Overlay::Waitlist(d) = &mut this.overlay
                                            && let Some(f) = &mut d.form
                                        {
                                            if let Some(i) =
                                                f.services.iter().position(|v| v == &id)
                                            {
                                                f.services.remove(i);
                                            } else if f.services.len() < 8 {
                                                f.services.push(id.clone());
                                            }
                                            cx.notify();
                                        }
                                    }),
                                )
                            }),
                    ),
            )
            .when(f.imported.is_none(), |d| {
                d.child(
                    div()
                        .flex()
                        .gap_2()
                        .child(label(Key::WaitlistFromDate, &f.from_date))
                        .child(label(Key::WaitlistToDate, &f.to_date)),
                )
            })
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(label(Key::WaitlistFromTime, &f.from_time))
                    .child(label(Key::WaitlistToTime, &f.to_time)),
            )
            .when_some(import_block, |d, reason| {
                d.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(reason)),
                )
            })
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        self.button(
                            "wl-cancel-draft",
                            self.t(Key::Cancel),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| {
                                if let Overlay::Waitlist(d) = &mut this.overlay
                                    && !d.busy
                                {
                                    d.form = None;
                                    d.error = None;
                                    cx.notify();
                                }
                            }),
                        )
                        .debug_selector(|| "wl-cancel-draft".to_string()),
                    )
                    .when(can_join && import_block.is_none(), |d| {
                        d.child(
                            self.button(
                                "wl-submit",
                                self.t(Key::WaitlistNew),
                                Kind::Primary,
                                cx.listener(|this, _, _, cx| this.submit_waitlist(cx)),
                            )
                            .debug_selector(|| "wl-submit".to_string()),
                        )
                    }),
            )
    }

    fn set_waitlist_staff(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        let performed = id
            .as_ref()
            .map(|id| ops::performed_services(&self.svc.store, id).unwrap_or_default());
        if let Overlay::Waitlist(d) = &mut self.overlay
            && let Some(f) = d.form.as_mut()
        {
            f.staff = id;
            f.staff_confirmed = true;
            if d.error == Some(Key::WaitlistConfirmProfessional) {
                d.error = None;
            }
            if let Some(performed) = performed {
                f.services.retain(|s| performed.contains(s));
            }
            cx.notify();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use sob_core::waitlist::WaitlistPolicy;

    #[gpui::test]
    async fn imported_review_controls_follow_the_centre_date_and_offer_policy(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (entity, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        let row = ImportedRequest {
            id: "review".into(),
            client_id: "client".into(),
            client_name: "Synthetic client".into(),
            requested_date: "2026-03-10".parse().unwrap(),
            duration_minutes: 60,
            flexible: false,
        };
        entity.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.tz = chrono_tz::Europe::Madrid;
            root.calendar_now = "2026-03-09T23:30:00Z".parse().unwrap();
            root.status.connectivity = Connectivity::Online;
            root.overlay = Overlay::Waitlist(Box::new(Desk {
                view: WaitlistView::Active,
                page: 1,
                scope: root.svc.store.calendar_cache_scope().ok(),
                data: Some(WaitlistPage {
                    page: 1,
                    page_size: 15,
                    total: 0,
                    policy: WaitlistPolicy {
                        enabled: true,
                        offer_minutes: 30,
                        version: 1,
                    },
                    imported: vec![row],
                    entries: vec![],
                }),
                busy: false,
                cached: false,
                saved_pages: vec![],
                error: None,
                confirm: None,
                form: None,
                offer_review: None,
                policy_review: None,
                booked: None,
                observed_revision: 0,
                requested_at: Instant::now(),
            }));
            cx.notify();
        });
        let click = |cx: &mut gpui::VisualTestContext, selector| {
            cx.run_until_parked();
            let bounds = cx
                .debug_bounds(selector)
                .unwrap_or_else(|| panic!("missing {selector}"));
            cx.simulate_click(bounds.center(), Default::default());
            cx.run_until_parked();
        };
        click(cx, "wl-import-review");
        click(cx, "wl-any");
        assert!(cx.debug_bounds("wl-submit").is_none());
        entity.update(cx, |root, cx| {
            let Overlay::Waitlist(desk) = &mut root.overlay else {
                panic!("missing waitlist");
            };
            desk.data.as_mut().unwrap().policy.enabled = false;
            cx.notify();
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("wl-submit").is_some());
        click(cx, "wl-cancel-draft");
        entity.update(cx, |root, cx| {
            root.calendar_now = "2026-03-10T23:30:00Z".parse().unwrap();
            cx.notify();
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("wl-source-past-review").is_some());
    }

    #[gpui::test]
    async fn the_waitlist_uses_the_visible_calendar_period_and_its_saved_pages(
        cx: &mut TestAppContext,
    ) {
        let (_dir, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.svc.stop_sync();
                root.date = "2026-03-11".parse().unwrap();
                root.calendar_mode = CalendarMode::Week;
                root.reload(cx);
                root.status.connectivity = Connectivity::Offline;
                let range = root.calendar_waitlist_range();
                assert_eq!(range.from.to_string(), "2026-03-09");
                assert_eq!(range.to.to_string(), "2026-03-15");
                let view = WaitlistView::Calendar(range);
                let data = WaitlistPage {
                    page: 1,
                    page_size: 15,
                    total: 3,
                    policy: WaitlistPolicy {
                        enabled: true,
                        offer_minutes: 20,
                        version: 1,
                    },
                    imported: vec![],
                    entries: vec![],
                };
                let scope = root.svc.store.calendar_cache_scope().unwrap();
                root.svc.store.cache_waitlist(&scope, view, &data).unwrap();
                root.open_waitlist(view, 1, cx);
                let Overlay::Waitlist(desk) = &root.overlay else {
                    panic!("missing calendar waitlist")
                };
                assert_eq!(desk.view, view);
                assert!(desk.cached);
                assert_eq!(desk.data, Some(data));
                root.open_waitlist(WaitlistView::Active, 1, cx);
                assert!(matches!(&root.overlay, Overlay::Waitlist(desk) if desk.data.is_none()));
            })
            .unwrap();
    }

    #[gpui::test]
    async fn an_offline_desk_opens_a_previously_saved_history_page(cx: &mut TestAppContext) {
        let (_dir, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.svc.stop_sync();
                root.status.connectivity = Connectivity::Offline;
                let history = WaitlistPage {
                    page: 3,
                    page_size: 15,
                    total: 33,
                    policy: WaitlistPolicy {
                        enabled: true,
                        offer_minutes: 30,
                        version: 1,
                    },
                    imported: vec![],
                    entries: vec![],
                };
                let scope = root.svc.store.calendar_cache_scope().unwrap();
                let mut first_page = history.clone();
                first_page.page = 1;
                root.svc
                    .store
                    .cache_waitlist(&scope, WaitlistView::History, &first_page)
                    .unwrap();
                root.svc
                    .store
                    .cache_waitlist(&scope, WaitlistView::History, &history)
                    .unwrap();
                root.open_waitlist(WaitlistView::History, 1, cx);
                let Overlay::Waitlist(desk) = &root.overlay else {
                    panic!("missing waitlist");
                };
                assert_eq!(desk.adjacent_pages(false), (None, Some(3)));
                let previous_request = root.waitlist_generation;
                root.open_waitlist(WaitlistView::History, 3, cx);
                assert_ne!(root.waitlist_generation, previous_request);
                let Overlay::Waitlist(desk) = &root.overlay else {
                    panic!("missing waitlist");
                };
                assert!(desk.cached);
                assert_eq!(desk.data.as_ref(), Some(&history));
                assert_eq!(desk.adjacent_pages(false), (Some(1), None));
                assert!(!desk.busy);
                root.waitlist_request(Action::Cancel("stale".into(), 1), cx);
                let Overlay::Waitlist(desk) = &root.overlay else {
                    panic!("missing waitlist");
                };
                assert!(!desk.busy);
            })
            .unwrap();
    }

    #[gpui::test]
    async fn directory_revocation_closes_an_open_waitlist_without_changing_the_calendar(
        cx: &mut TestAppContext,
    ) {
        let (_dir, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.svc.stop_sync();
                root.svc
                    .store
                    .set_meta("client_directory", "allowed")
                    .unwrap();
                root.reload(cx);
                show_intake_test_offer(root, cx);
                assert!(matches!(root.overlay, Overlay::Waitlist(_)));
                let calendar_scope = root.calendar_scope.clone();

                root.svc
                    .store
                    .set_meta("client_directory", "denied")
                    .unwrap();
                root.reload(cx);
                assert_eq!(root.calendar_scope, calendar_scope);
                assert!(matches!(root.overlay, Overlay::None));
            })
            .unwrap();
    }

    #[gpui::test]
    async fn imported_request_keeps_the_known_date_and_does_not_invent_preferences(
        cx: &mut TestAppContext,
    ) {
        let (_dir, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.svc.stop_sync();
                root.calendar_now = "2026-03-09T15:00:00Z".parse().unwrap();
                let row = ImportedRequest {
                    id: "import-1".into(),
                    client_id: "client-1".into(),
                    client_name: "Test client".into(),
                    requested_date: "2026-03-10".parse().unwrap(),
                    duration_minutes: 60,
                    flexible: true,
                };
                let scope = root.svc.store.calendar_cache_scope().unwrap();
                root.svc
                    .store
                    .cache_waitlist(
                        &scope,
                        WaitlistView::Active,
                        &WaitlistPage {
                            page: 1,
                            page_size: 15,
                            total: 0,
                            policy: WaitlistPolicy {
                                enabled: false,
                                offer_minutes: 30,
                                version: 1,
                            },
                            imported: vec![row.clone()],
                            entries: vec![],
                        },
                    )
                    .unwrap();
                root.open_waitlist(WaitlistView::Active, 1, cx);
                let Overlay::Waitlist(desk) = &root.overlay else {
                    panic!("missing waitlist");
                };
                assert!(desk.cached);
                assert_eq!(desk.data.as_ref().unwrap().imported, vec![row.clone()]);
                root.start_waitlist_draft(Some(row), cx);
                let Overlay::Waitlist(desk) = &root.overlay else {
                    panic!("missing waitlist");
                };
                let form = desk.form.as_ref().unwrap();
                assert_eq!(form.from_date.read(cx).text(), "2026-03-10");
                assert_eq!(form.to_date.read(cx).text(), "2026-03-10");
                assert!(form.from_time.read(cx).text().is_empty());
                assert!(form.to_time.read(cx).text().is_empty());
                assert!(form.staff.is_none() && !form.staff_confirmed && form.services.is_empty());
                let today = root.calendar_now.with_timezone(&root.tz).date_naive();
                assert_eq!(
                    form.import_block(today, false),
                    Some(Key::WaitlistConfirmProfessional)
                );
                assert_eq!(
                    form.import_block(today, true),
                    Some(Key::WaitlistImportNeedsPause)
                );
                root.set_waitlist_staff(None, cx);
                let Overlay::Waitlist(desk) = &root.overlay else {
                    panic!("missing waitlist");
                };
                let form = desk.form.as_ref().unwrap();
                assert!(form.staff.is_none() && form.staff_confirmed);
                assert_eq!(form.import_block(today, false), None);
                assert_eq!(
                    form.import_block("2026-03-11".parse().unwrap(), false),
                    Some(Key::WaitlistImportedPast)
                );
            })
            .unwrap();
    }
}
