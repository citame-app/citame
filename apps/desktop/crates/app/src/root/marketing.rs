use super::*;
use chrono::{NaiveDateTime, TimeZone};
use sob_core::http::marketing::{
    Campaign, CampaignAction, CampaignPage, Capabilities, Channel, DeliveryPage, DeliveryStatus,
    LIVE_TOPIC, MutationError, Preview, Status, Trigger,
};
use sob_core::sync::TransportError;

mod draft;
use draft::{Editor, EditorMode};

pub(super) struct Desk {
    identity: Arc<()>,
    request: Option<Arc<()>>,
    refreshing: bool,
    retry_after: Option<std::time::Instant>,
    list: Option<CampaignPage>,
    detail: Option<(Campaign, DeliveryPage)>,
    review: Option<(Preview, Capabilities)>,
    search: Entity<TextField>,
    applied_search: String,
    schedule: Entity<TextField>,
    status: Option<Status>,
    action: Option<CampaignAction>,
    editor: Option<Editor>,
    choose_template: bool,
    uncertain: bool,
    confirm_exit: bool,
    busy: bool,
    observed: Option<i64>,
    generation: Option<String>,
    error: Option<Key>,
}

impl Desk {
    fn install_write_result(
        &mut self,
        campaign: Campaign,
        generation: Option<String>,
        cx: &mut Context<Root>,
    ) {
        if let Some((current, _)) = &mut self.detail
            && current.id == campaign.id
            && self.generation == generation
        {
            *current = campaign;
        } else if campaign.status == Status::Draft {
            let deliveries = DeliveryPage {
                deliveries: Vec::new(),
                pagination: sob_core::http::marketing::Pagination {
                    page: 1,
                    page_size: 20,
                    total: 0,
                },
            };
            self.install_detail(campaign, deliveries, generation, cx);
        } else {
            self.detail = None;
        }
    }

    fn install_detail(
        &mut self,
        campaign: Campaign,
        deliveries: DeliveryPage,
        generation: Option<String>,
        cx: &mut Context<Root>,
    ) {
        if self.generation != generation
            || self.detail.as_ref().is_none_or(|(previous, _)| {
                previous.id != campaign.id || previous.version != campaign.version
            })
        {
            self.review = None;
            self.schedule.update(cx, |field, cx| field.set_text("", cx));
        }
        self.detail = Some((campaign, deliveries));
        self.generation = generation;
    }
}

enum Request {
    List(u32),
    Detail(String, u32),
    Review(String),
    Write(CampaignAction),
    SaveDraft(sob_core::http::marketing::DraftWrite),
}

enum Loaded {
    List(CampaignPage),
    Detail(Campaign, DeliveryPage),
    Review(Preview, Capabilities),
    Written(Campaign),
}

fn status_key(status: Status) -> Key {
    match status {
        Status::Draft => Key::MarketingDraft,
        Status::Scheduled => Key::MarketingScheduled,
        Status::Active => Key::MarketingActive,
        Status::Completed => Key::Completed,
        Status::Cancelled => Key::CalendarCancelled,
    }
}

fn channel_key(channel: Channel) -> Key {
    match channel {
        Channel::Email => Key::Email,
        Channel::Sms => Key::MarketingSms,
        Channel::Optimized => Key::MarketingOptimized,
    }
}

fn trigger_key(trigger: Trigger) -> Key {
    match trigger {
        Trigger::Manual => Key::MarketingManual,
        Trigger::FirstVisit => Key::MarketingFirstVisit,
        Trigger::Inactive => Key::MarketingInactive,
        Trigger::Birthday => Key::MarketingBirthday,
    }
}

fn delivery_key(status: DeliveryStatus) -> Key {
    match status {
        DeliveryStatus::Pending => Key::MarketingPending,
        DeliveryStatus::Processing => Key::MarketingProcessing,
        DeliveryStatus::Sent => Key::MarketingSent,
        DeliveryStatus::Skipped => Key::MarketingSkipped,
        DeliveryStatus::Failed => Key::MarketingFailed,
        DeliveryStatus::Unknown => Key::MarketingUnknown,
        DeliveryStatus::Cancelled => Key::CalendarCancelled,
    }
}

fn parse_schedule(tz: chrono_tz::Tz, text: &str) -> Option<Option<DateTime<Utc>>> {
    let text = text.trim();
    if text.is_empty() {
        return Some(None);
    }
    let local = NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M").ok()?;
    tz.from_local_datetime(&local)
        .single()
        .map(|value| Some(value.with_timezone(&Utc)))
}

impl Root {
    pub(super) fn open_marketing(&mut self, cx: &mut Context<Self>) {
        let search = self.t(Key::MarketingSearch);
        let schedule = self.t(Key::MarketingDateHint);
        self.overlay = Overlay::Marketing(Box::new(Desk {
            identity: Arc::new(()),
            request: None,
            refreshing: false,
            retry_after: None,
            list: None,
            detail: None,
            review: None,
            action: None,
            editor: None,
            choose_template: false,
            search: cx.new(|cx| TextField::new(search, false, cx)),
            applied_search: String::new(),
            schedule: cx.new(|cx| TextField::new(schedule, false, cx)),
            status: None,
            uncertain: false,
            confirm_exit: false,
            busy: false,
            observed: None,
            generation: None,
            error: None,
        }));
        self.request_marketing(Request::List(1), cx);
        cx.notify();
    }

    fn marketing_desk(&mut self) -> Option<&mut Desk> {
        let Overlay::Marketing(desk) = &mut self.overlay else {
            return None;
        };
        Some(desk)
    }

    pub(super) fn refresh_marketing(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let observed = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let Some(desk) = self.marketing_desk() else {
            return;
        };
        if desk.busy
            || desk.refreshing
            || desk.action.is_some()
            || desk.editor.is_some()
            || desk
                .retry_after
                .is_some_and(|retry| retry > std::time::Instant::now())
            || (!reconnected && desk.observed == observed)
        {
            return;
        }
        let request = match &desk.detail {
            Some((campaign, deliveries)) => {
                Request::Detail(campaign.id.clone(), deliveries.pagination.page)
            }
            None => Request::List(desk.list.as_ref().map_or(1, |list| list.pagination.page)),
        };
        self.load_marketing(request, true, cx);
    }

    pub(super) fn dismiss_marketing(&mut self, cx: &mut Context<Self>) {
        let Some(desk) = self.marketing_desk() else {
            return;
        };
        if desk.busy {
            return;
        }
        if desk.choose_template {
            desk.choose_template = false;
            cx.notify();
            return;
        }
        if let Some(editor) = &mut desk.editor
            && editor.close_preview()
        {
            cx.notify();
            return;
        }
        if desk.editor.is_some() {
            desk.confirm_exit = !desk.confirm_exit;
            cx.notify();
            return;
        }
        if desk.uncertain && !desk.confirm_exit {
            desk.confirm_exit = true;
            desk.error = Some(Key::MarketingExitCheck);
            cx.notify();
        } else {
            self.open_web_management(cx);
        }
    }

    fn request_marketing(&mut self, request: Request, cx: &mut Context<Self>) {
        self.load_marketing(request, false, cx);
    }

    fn load_marketing(&mut self, request: Request, background: bool, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let session = self.svc.session.clone();
        let observed = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let Some(desk) = self.marketing_desk().filter(|desk| !desk.busy) else {
            return;
        };
        let identity = desk.identity.clone();
        let token = Arc::new(());
        desk.request = Some(token.clone());
        if !background && matches!(request, Request::List(_)) {
            desk.applied_search = desk.search.read(cx).text().trim().to_owned();
        }
        let search = desk.applied_search.clone();
        let status = desk.status;
        let saving = matches!(request, Request::SaveDraft(_));
        let writing = saving || matches!(request, Request::Write(_));
        if matches!(request, Request::Review(_)) {
            desk.review = None;
        }
        desk.busy = !background;
        desk.refreshing = background;
        desk.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    Ok::<Loaded, MutationError>(match request {
                        Request::List(page) => {
                            Loaded::List(transport.marketing_campaigns(page, &search, status)?)
                        }
                        Request::Detail(id, page) => Loaded::Detail(
                            transport.marketing_campaign(&id)?,
                            transport.marketing_deliveries(&id, page)?,
                        ),
                        Request::Review(id) => Loaded::Review(
                            transport.marketing_preview(&id)?,
                            transport.marketing_capabilities()?,
                        ),
                        Request::Write(action) => {
                            Loaded::Written(transport.act_on_campaign(&action)?)
                        }
                        Request::SaveDraft(write) => {
                            Loaded::Written(transport.save_campaign_draft(&write)?)
                        }
                    })
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let Some(desk) = root.marketing_desk().filter(|desk| {
                    Arc::ptr_eq(&identity, &desk.identity)
                        && desk
                            .request
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(&token, current))
                }) else {
                    return;
                };
                desk.busy = false;
                desk.refreshing = false;
                desk.request = None;
                if matches!(&result, Ok(Loaded::List(_) | Loaded::Detail(_, _))) {
                    desk.observed = observed;
                    desk.retry_after = None;
                } else if background && result.is_err() {
                    desk.retry_after =
                        Some(std::time::Instant::now() + std::time::Duration::from_secs(3));
                }
                let reload = match result {
                    Ok(Loaded::List(list)) => {
                        desk.list = Some(list);
                        desk.detail = None;
                        desk.review = None;
                        None
                    }
                    Ok(Loaded::Detail(campaign, deliveries)) => {
                        desk.install_detail(campaign, deliveries, generation, cx);
                        None
                    }
                    Ok(Loaded::Review(preview, capabilities)) => {
                        if desk.detail.as_ref().is_some_and(|(campaign, _)| {
                            campaign.id == preview.campaign_id
                                && campaign.version == preview.version
                        }) && desk.generation == generation
                        {
                            desk.review = Some((preview, capabilities));
                        } else {
                            desk.error = Some(Key::MarketingChanged);
                        }
                        None
                    }
                    Ok(Loaded::Written(campaign)) => {
                        desk.editor = None;
                        desk.action = None;
                        desk.uncertain = false;
                        desk.review = None;
                        let id = campaign.id.clone();
                        desk.install_write_result(campaign, generation, cx);
                        Some(id)
                    }
                    Err(MutationError::Changed) => {
                        if saving && let Some(editor) = &mut desk.editor {
                            editor.mark_stale();
                        }
                        desk.error = Some(if saving {
                            Key::MarketingDraftConflict
                        } else {
                            Key::MarketingChanged
                        });
                        desk.review = None;
                        desk.action = None;
                        desk.uncertain = false;
                        None
                    }
                    Err(MutationError::Rejected) => {
                        if saving && let Some(editor) = &mut desk.editor {
                            editor.unlock();
                        }
                        desk.error = Some(if saving {
                            Key::MarketingDraftInvalid
                        } else {
                            Key::MarketingRejected
                        });
                        desk.action = None;
                        desk.review = None;
                        desk.uncertain = false;
                        None
                    }
                    Err(MutationError::Transport(TransportError::ReplicaGenerationChanged)) => {
                        if saving && let Some(editor) = &mut desk.editor {
                            editor.mark_stale();
                        }
                        desk.error = Some(Key::BookingIntakeRestore);
                        desk.review = None;
                        desk.action = None;
                        desk.uncertain = false;
                        None
                    }
                    Err(MutationError::Transport(error)) => {
                        if matches!(error, TransportError::Forbidden(_)) {
                            desk.editor = None;
                            desk.list = None;
                            desk.detail = None;
                            desk.review = None;
                            desk.observed = observed;
                        }
                        desk.uncertain |= writing
                            && matches!(
                                error,
                                TransportError::Offline(_)
                                    | TransportError::Server(_)
                                    | TransportError::Unauthorized
                            );
                        desk.error = Some(if desk.uncertain {
                            Key::MarketingUnconfirmed
                        } else {
                            Key::MarketingUnavailable
                        });
                        if writing
                            && !desk.uncertain
                            && !matches!(error, TransportError::RateLimited(_))
                        {
                            desk.action = None;
                            if let Some(editor) = &mut desk.editor {
                                editor.unlock();
                            }
                        }
                        None
                    }
                };
                if let Some(id) = reload {
                    root.svc.wake(Wake::Manual);
                    root.request_marketing(Request::Detail(id, 1), cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn prepare_marketing_action(&mut self, cancel: bool, cx: &mut Context<Self>) {
        let tz = self.tz;
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let Some(desk) = self
            .marketing_desk()
            .filter(|desk| !desk.busy && desk.action.is_none())
        else {
            return;
        };
        let Some((campaign, _)) = &desk.detail else {
            return;
        };
        let Some(generation) = generation.filter(|value| Some(value) == desk.generation.as_ref())
        else {
            desk.error = Some(Key::BookingIntakeRestore);
            cx.notify();
            return;
        };
        if cancel {
            desk.action = CampaignAction::cancel(campaign, generation);
        } else if let Some((preview, capabilities)) = &desk.review
            && capabilities.can_deliver(campaign.channel)
        {
            let Some(scheduled) = parse_schedule(tz, desk.schedule.read(cx).text())
                .filter(|time| time.is_none_or(|date| date > Utc::now()))
            else {
                desk.error = Some(Key::MarketingDateInvalid);
                cx.notify();
                return;
            };
            desk.action = CampaignAction::queue(campaign, preview, generation, scheduled);
        }
        if desk.action.is_some() {
            desk.error = None;
            desk.confirm_exit = false;
            desk.request = None;
            desk.refreshing = false;
        }
        cx.notify();
    }

    fn execute_marketing_action(&mut self, cx: &mut Context<Self>) {
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let Some(desk) = self.marketing_desk() else {
            return;
        };
        let Some(action) = desk.action.clone() else {
            return;
        };
        if generation.as_deref() != Some(action.generation.as_str()) {
            desk.error = Some(Key::BookingIntakeRestore);
            cx.notify();
            return;
        }
        if !desk.uncertain
            && action
                .scheduled_for()
                .is_some_and(|date| date <= Utc::now())
        {
            desk.action = None;
            desk.error = Some(Key::MarketingDateInvalid);
            cx.notify();
            return;
        }
        self.request_marketing(Request::Write(action), cx);
    }

    fn marketing_button(
        &self,
        id: impl Into<ElementId>,
        key: Key,
        kind: Kind,
        action: impl Fn(&mut Root, &mut Context<Root>) + 'static,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        self.button(
            id,
            self.t(key),
            kind,
            cx.listener(move |root, _, _, cx| action(root, cx)),
        )
        .tab_index(0)
        .focus(|style| style.border_color(theme::text()))
    }

    pub(super) fn render_marketing(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let ready = self.status.connectivity == Connectivity::Online && !desk.busy;
        let body = if desk.choose_template {
            self.campaign_templates(ready, desk.editor.is_some(), cx)
        } else if let Some(editor) = &desk.editor {
            self.render_campaign_editor(desk, editor, ready, cx)
        } else if let Some((campaign, deliveries)) = &desk.detail {
            self.render_campaign(desk, campaign, deliveries, ready, cx)
        } else {
            self.render_campaign_list(desk, ready, cx)
        };
        let footer = div().flex().flex_wrap().gap_2().when(!desk.busy, |row| {
            let close = if desk.choose_template {
                Key::Back
            } else if desk.editor.is_some() {
                if desk.confirm_exit {
                    Key::MarketingDiscardDraft
                } else {
                    Key::Back
                }
            } else if desk.confirm_exit {
                Key::MarketingExitConfirm
            } else {
                Key::Close
            };
            row.child(
                self.marketing_button(
                    "close-marketing",
                    close,
                    Kind::Ghost,
                    if !desk.choose_template
                        && desk
                            .editor
                            .as_ref()
                            .is_some_and(|editor| !editor.in_preview())
                    {
                        Root::leave_campaign_editor
                    } else {
                        Root::dismiss_marketing
                    },
                    cx,
                ),
            )
        });
        self.modal_with_height(
            div()
                .tab_group()
                .child(
                    div()
                        .text_xl()
                        .font_weight(FontWeight::BOLD)
                        .child(self.t(Key::CloudMarketing)),
                )
                .when(!ready && !desk.busy, |panel| {
                    panel.child(self.t(Key::MarketingOffline))
                })
                .when(desk.busy, |panel| {
                    panel.child(self.t(Key::MarketingLoading))
                })
                .when_some(desk.error, |panel, error| {
                    panel.child(
                        div()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(self.t(error)),
                    )
                })
                .child(
                    div()
                        .id("marketing-body")
                        .min_h_0()
                        .overflow_y_scroll()
                        .child(body),
                )
                .child(footer),
            (viewport.width - px(24.)).clamp(px(0.), px(820.)),
            (viewport.height - px(24.)).clamp(px(0.), px(760.)),
            None,
        )
    }

    fn render_campaign_list(&self, desk: &Desk, ready: bool, cx: &mut Context<Self>) -> gpui::Div {
        let statuses = [
            None,
            Some(Status::Draft),
            Some(Status::Scheduled),
            Some(Status::Active),
            Some(Status::Completed),
            Some(Status::Cancelled),
        ];
        let mut body = div().flex().flex_col().gap_3();
        if ready {
            body = body
                .child(self.marketing_button(
                    "create-campaign-draft",
                    Key::MarketingCreateDraft,
                    Kind::Primary,
                    |root, cx| {
                        if let Some(desk) = root.marketing_desk() {
                            desk.choose_template = true;
                            cx.notify();
                        }
                    },
                    cx,
                ))
                .child(div().flex().gap_2().child(desk.search.clone()).child(
                    self.marketing_button(
                        "search-marketing",
                        Key::MarketingSearch,
                        Kind::Ghost,
                        |root, cx| root.request_marketing(Request::List(1), cx),
                        cx,
                    ),
                ))
                .child(div().flex().flex_wrap().gap_2().children(
                    statuses.into_iter().enumerate().map(|(index, filter)| {
                        self.chip(
                            ("marketing-filter", index),
                            self.t(filter.map_or(Key::MarketingAll, status_key)),
                            desk.status == filter,
                            cx.listener(move |root, _, _, cx| {
                                if let Some(desk) = root.marketing_desk() {
                                    desk.status = filter;
                                }
                                root.request_marketing(Request::List(1), cx);
                            }),
                        )
                        .tab_index(0)
                        .focus(|style| style.border_color(theme::text()))
                    }),
                ));
        }
        if let Some(list) = &desk.list {
            if list.campaigns.is_empty() {
                body = body.child(self.t(Key::MarketingEmpty));
            }
            body = body.children(list.campaigns.iter().map(|campaign| {
                let id = campaign.id.clone();
                let row = div()
                    .id(SharedString::from(format!("campaign-{id}")))
                    .flex()
                    .flex_col()
                    .gap_1()
                    .p_2()
                    .rounded_md()
                    .border_1()
                    .border_color(theme::line())
                    .child(campaign.name.clone())
                    .child(div().text_sm().text_color(theme::muted()).child(format!(
                        "{} · {} · {}",
                        self.t(status_key(campaign.status)),
                        self.t(channel_key(campaign.channel)),
                        self.t(trigger_key(campaign.trigger))
                    )));
                row.when(ready, |row| {
                    row.tab_index(0)
                        .cursor_pointer()
                        .focus(|style| style.bg(theme::accent_soft()))
                        .hover(|style| style.bg(theme::accent_soft()))
                        .on_click(cx.listener(move |root, _, _, cx| {
                            root.request_marketing(Request::Detail(id.clone(), 1), cx)
                        }))
                })
            }));
            if ready {
                let page = list.pagination.page;
                body = body.child(self.marketing_pages(
                    "campaigns",
                    page,
                    list.pagination.has_next(),
                    Request::List,
                    cx,
                ));
            }
        }
        body.when(ready, |body| {
            body.child(self.marketing_button(
                "marketing-web",
                Key::MarketingWeb,
                Kind::Ghost,
                |root, cx| {
                    root.open_web_management(cx);
                    root.open_web_workspace(Some(sob_core::auth::BrowserWorkspace::Marketing), cx);
                },
                cx,
            ))
        })
    }

    fn marketing_pages(
        &self,
        scope: &'static str,
        page: u32,
        next: bool,
        request: impl Fn(u32) -> Request + Clone + 'static,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let previous = request.clone();
        div()
            .flex()
            .flex_wrap()
            .gap_2()
            .when(page > 1, |row| {
                row.child(self.marketing_button(
                    SharedString::from(format!("{scope}-previous")),
                    Key::MarketingPreviousPage,
                    Kind::Ghost,
                    move |root, cx| root.request_marketing(previous(page - 1), cx),
                    cx,
                ))
            })
            .when(next, |row| {
                row.child(self.marketing_button(
                    SharedString::from(format!("{scope}-next")),
                    Key::MarketingNextPage,
                    Kind::Ghost,
                    move |root, cx| root.request_marketing(request(page + 1), cx),
                    cx,
                ))
            })
    }

    fn render_campaign(
        &self,
        desk: &Desk,
        campaign: &Campaign,
        deliveries: &DeliveryPage,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let counts = &campaign.counts;
        let mut body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(campaign.name.clone()),
            )
            .child(format!(
                "{} · {} · {}",
                self.t(status_key(campaign.status)),
                self.t(channel_key(campaign.channel)),
                self.t(trigger_key(campaign.trigger))
            ))
            .when_some(campaign.scheduled_for, |panel, date| {
                panel.child(self.date_time_label(date))
            })
            .children(
                [
                    campaign.subject.as_str(),
                    campaign.email_body.as_str(),
                    campaign.sms_body.as_str(),
                ]
                .into_iter()
                .filter(|text| !text.is_empty())
                .map(|text| div().text_sm().child(text.to_owned())),
            )
            .when(!campaign.audience.tags.is_empty(), |panel| {
                panel.child(campaign.audience.tags.join(", "))
            })
            .when_some(campaign.audience.inactive_days, |panel, days| {
                panel.child(i18n::fill(
                    self.t(Key::MarketingInactiveDays),
                    &[("days", &days.to_string())],
                ))
            })
            .when(campaign.audience.no_future_appointments, |panel| {
                panel.child(self.t(Key::MarketingNoFuture))
            })
            .child(
                div().flex().flex_wrap().gap_2().children(
                    [
                        (Key::MarketingPending, counts.pending),
                        (Key::MarketingProcessing, counts.processing),
                        (Key::MarketingSent, counts.sent),
                        (Key::MarketingSkipped, counts.skipped),
                        (Key::MarketingFailed, counts.failed),
                        (Key::MarketingUnknown, counts.unknown),
                        (Key::CalendarCancelled, counts.cancelled),
                    ]
                    .into_iter()
                    .map(|(key, count)| {
                        div().text_sm().child(format!("{} · {count}", self.t(key)))
                    }),
                ),
            );
        if let Some((preview, capabilities)) = &desk.review {
            body = body
                .child(self.label(Key::MarketingAudience))
                .child(i18n::fill(
                    self.t(Key::MarketingAudienceSummary),
                    &[
                        ("eligible", &preview.eligible.to_string()),
                        ("email", &preview.email.to_string()),
                        ("sms", &preview.sms.to_string()),
                        ("excluded", &preview.excluded.to_string()),
                    ],
                ))
                .children(preview.sample.iter().map(|sample| {
                    div().text_sm().child(format!(
                        "{} · {}",
                        sample.name,
                        self.t(channel_key(sample.channel))
                    ))
                }))
                .when(campaign.trigger != Trigger::Manual, |panel| {
                    panel.child(self.t(Key::MarketingAutomationAudience))
                })
                .when(!capabilities.can_deliver(campaign.channel), |panel| {
                    panel.child(self.t(Key::MarketingDeliveryDisabled))
                });
            if ready
                && desk.action.is_none()
                && capabilities.can_deliver(campaign.channel)
                && (campaign.trigger != Trigger::Manual || preview.eligible > 0)
            {
                body = body
                    .child(self.label(if campaign.trigger == Trigger::Manual {
                        Key::MarketingDateHint
                    } else {
                        Key::MarketingActivationDateHint
                    }))
                    .child(desk.schedule.clone())
                    .child(self.marketing_button(
                        "prepare-marketing-send",
                        if campaign.trigger == Trigger::Manual {
                            Key::MarketingReviewSend
                        } else {
                            Key::MarketingReviewActivation
                        },
                        Kind::Primary,
                        |root, cx| root.prepare_marketing_action(false, cx),
                        cx,
                    ));
            }
        }
        if let Some(action) = &desk.action {
            body = body.child(
                div()
                    .p_3()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme::accent())
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(self.t(if action.is_cancel() {
                        Key::MarketingConfirmCancel
                    } else if campaign.trigger == Trigger::Manual {
                        Key::MarketingConfirmSend
                    } else {
                        Key::MarketingConfirmActivation
                    }))
                    .when(!action.is_cancel(), |box_| {
                        box_.child(
                            action
                                .scheduled_for()
                                .map(|date| self.date_time_label(date))
                                .unwrap_or_else(|| self.t(Key::MarketingImmediate).into()),
                        )
                    })
                    .when(ready, |box_| {
                        box_.child(self.marketing_button(
                            "confirm-marketing-write",
                            if desk.uncertain {
                                Key::MarketingRetry
                            } else {
                                Key::MarketingConfirm
                            },
                            if action.is_cancel() {
                                Kind::Danger
                            } else {
                                Kind::Primary
                            },
                            Root::execute_marketing_action,
                            cx,
                        ))
                    })
                    .when(ready && !desk.uncertain, |box_| {
                        box_.child(self.marketing_button(
                            "leave-marketing-confirm",
                            Key::Back,
                            Kind::Ghost,
                            |root, cx| {
                                if let Some(desk) = root.marketing_desk() {
                                    desk.action = None;
                                }
                                cx.notify();
                            },
                            cx,
                        ))
                    }),
            );
        } else if ready {
            let id = campaign.id.clone();
            let page = deliveries.pagination.page;
            body = body.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.marketing_button(
                        "back-marketing-list",
                        Key::Back,
                        Kind::Ghost,
                        |root, cx| {
                            let page = root
                                .marketing_desk()
                                .and_then(|desk| {
                                    desk.list.as_ref().map(|list| list.pagination.page)
                                })
                                .unwrap_or(1);
                            root.request_marketing(Request::List(page), cx);
                        },
                        cx,
                    ))
                    .child(self.marketing_button(
                        "refresh-marketing-detail",
                        Key::MarketingRefresh,
                        Kind::Ghost,
                        move |root, cx| {
                            root.request_marketing(Request::Detail(id.clone(), page), cx)
                        },
                        cx,
                    ))
                    .child(self.marketing_button(
                        "duplicate-campaign-draft",
                        Key::MarketingDuplicateDraft,
                        Kind::Ghost,
                        |root, cx| root.open_campaign_editor(EditorMode::Duplicate, cx),
                        cx,
                    ))
                    .when(campaign.status == Status::Draft, |row| {
                        let id = campaign.id.clone();
                        row.child(self.marketing_button(
                            "edit-campaign-draft",
                            Key::MarketingEditDraft,
                            Kind::Ghost,
                            |root, cx| root.open_campaign_editor(EditorMode::Edit, cx),
                            cx,
                        ))
                        .child(self.marketing_button(
                            "preview-marketing-audience",
                            Key::MarketingAudience,
                            Kind::Ghost,
                            move |root, cx| root.request_marketing(Request::Review(id.clone()), cx),
                            cx,
                        ))
                    })
                    .when(
                        matches!(campaign.status, Status::Active | Status::Scheduled),
                        |row| {
                            row.child(self.marketing_button(
                                "prepare-marketing-cancel",
                                Key::MarketingStop,
                                Kind::Danger,
                                |root, cx| root.prepare_marketing_action(true, cx),
                                cx,
                            ))
                        },
                    ),
            );
        }
        if !deliveries.deliveries.is_empty() {
            body = body.child(self.label(Key::MarketingDeliveries)).children(
                deliveries.deliveries.iter().map(|row| {
                    div()
                        .id(SharedString::from(format!("delivery-{}", row.id)))
                        .text_sm()
                        .child(format!(
                            "{} · {} · {} · {}",
                            row.client_name,
                            self.t(channel_key(row.channel)),
                            self.t(delivery_key(row.status)),
                            self.date_time_label(row.sent_at.unwrap_or(row.created_at))
                        ))
                }),
            );
            if ready && desk.action.is_none() {
                let id = campaign.id.clone();
                body = body.child(self.marketing_pages(
                    "deliveries",
                    deliveries.pagination.page,
                    deliveries.pagination.has_next(),
                    move |page| Request::Detail(id.clone(), page),
                    cx,
                ));
            }
        }
        body
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn campaign_scheduling_rejects_ambiguous_and_missing_local_times() {
        let madrid = chrono_tz::Europe::Madrid;
        assert_eq!(parse_schedule(madrid, ""), Some(None));
        assert_eq!(parse_schedule(madrid, "2026-03-29 02:30"), None);
        assert_eq!(parse_schedule(madrid, "2026-10-25 02:30"), None);
        assert_eq!(
            parse_schedule(madrid, "2026-11-30 10:00").unwrap().unwrap(),
            "2026-11-30T09:00:00Z".parse::<DateTime<Utc>>().unwrap(),
        );
    }

    #[gpui::test]
    async fn a_native_send_requires_the_reviewed_revision_and_freezes_the_chosen_time(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (view, cx) = cx.add_window_view(|window, cx| {
            let mut root = Root::new(config, window, cx);
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Offline;
            root.open_marketing(cx);
            root
        });
        view.update(cx, |root, cx| {
            let generation = root.svc.store.verified_reviewed_generation().unwrap();
            let tz = root.tz;
            let desk = root.marketing_desk().unwrap();
            desk.generation = Some(generation);
            let campaign = serde_json::from_value(json!({
                "id": "synthetic", "name": "Synthetic draft", "channel": "email", "trigger": "manual",
                "status": "draft", "version": 2, "subject": "Subject", "emailBody": "Body",
                "smsBody": "", "delayMinutes": 0, "birthdayLeadDays": 0,
                "scheduledFor": null, "audience": {
                    "tags":[],"inactiveDays":null,"noFutureAppointments":false
                }, "counts": {"pending":0,"processing":0,"sent":0,"skipped":0,"failed":0,"unknown":0,"cancelled":0}
            })).unwrap();
            let deliveries = serde_json::from_value(json!({
                "deliveries": [], "pagination": {"page":1,"pageSize":20,"total":0}
            })).unwrap();
            let preview = serde_json::from_value(json!({
                "campaignId":"synthetic","version":1,"audienceHash":"a".repeat(64),"eligible":1,
                "email":1,"sms":0,"excluded":0,"sample":[]
            })).unwrap();
            desk.detail = Some((campaign, deliveries));
            desk.review = Some((preview, Capabilities { email:true, sms:false, worker:true }));
            root.prepare_marketing_action(false, cx);
            let desk = root.marketing_desk().unwrap();
            assert!(desk.action.is_none());
            desk.review.as_mut().unwrap().0.version = 2;
            let first = format!("{} 10:00", (Utc::now() + Span::days(2)).with_timezone(&tz).date_naive());
            let second = format!("{} 10:00", (Utc::now() + Span::days(3)).with_timezone(&tz).date_naive());
            desk.schedule.update(cx, |field, cx| field.set_text(&first, cx));
            root.prepare_marketing_action(false, cx);
            let desk = root.marketing_desk().unwrap();
            desk.schedule.update(cx, |field, cx| field.set_text(&second, cx));
            assert_eq!(desk.action.as_ref().unwrap().scheduled_for(), parse_schedule(tz, &first).unwrap());
            assert!(!desk.uncertain);
            desk.action = None;
            let same_campaign = desk.detail.as_ref().unwrap().0.clone();
            let new_deliveries = serde_json::from_value(json!({
                "deliveries": [], "pagination": {"page":1,"pageSize":20,"total":0}
            })).unwrap();
            desk.install_detail(same_campaign, new_deliveries, Some("restored".into()), cx);
            assert!(desk.review.is_none());
            assert!(root.svc.store.outbox(5).unwrap().is_empty());
        });
    }
}
