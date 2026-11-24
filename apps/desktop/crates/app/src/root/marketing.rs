use super::*;
use chrono::{NaiveDateTime, TimeZone};
use sob_core::http::marketing::{
    Campaign, CampaignAction, CampaignComparison, CampaignPage, Capabilities, Channel, Counts,
    DeliveryPage, DeliveryStatus, LIVE_TOPIC, MutationError, Preview, Status, TestChannel,
    TestDeliveryMode, TestDeliveryStatus, TestTarget, Trigger,
};
use sob_core::sync::TransportError;

mod draft;
mod links;
mod peak_prices;
mod promotions;
use draft::{Editor, EditorMode};
use links::LinkDesk;
use promotions::PromoDesk;

// Matches CAMPAIGN_COMPARISON_MAX in the shared campaign contract.
const MAX_COMPARISON_CAMPAIGNS: usize = 4;

struct CampaignSelection {
    id: String,
    name: String,
}

pub(super) struct Desk {
    identity: Arc<()>,
    request: Option<Arc<()>>,
    refreshing: bool,
    retry_after: Option<std::time::Instant>,
    list: Option<CampaignPage>,
    selected: Vec<CampaignSelection>,
    comparing: bool,
    comparison: Option<CampaignComparison>,
    detail: Option<(Campaign, DeliveryPage)>,
    review: Option<(Preview, Capabilities)>,
    test_deliveries: TestDeliveries,
    search: Entity<TextField>,
    applied_search: String,
    schedule: Entity<TextField>,
    status: Option<Status>,
    action: Option<CampaignAction>,
    editor: Option<Editor>,
    links: Option<LinkDesk>,
    promotions: Option<PromoDesk>,
    peak_prices: Option<peak_prices::PeakPriceDesk>,
    choose_template: bool,
    uncertain: bool,
    confirm_exit: bool,
    busy: bool,
    observed: Option<i64>,
    generation: Option<String>,
    error: Option<Key>,
}

impl Desk {
    fn reviewed_delivery_test(&self, channel: TestChannel) -> Option<(&Campaign, &str)> {
        let (campaign, _) = self.detail.as_ref()?;
        let (preview, capability) = self.review.as_ref()?;
        let generation = self.generation.as_deref()?;
        let allowed = match channel {
            TestChannel::Email => capability.can_test_email && campaign.channel != Channel::Sms,
            TestChannel::Sms => {
                campaign.channel != Channel::Email
                    && preview
                        .sms_test
                        .as_ref()
                        .is_some_and(|test| test.generation == generation)
            }
        };
        (allowed
            && campaign.status == Status::Draft
            && campaign.id == preview.campaign_id
            && campaign.version == preview.version)
            .then_some((campaign, generation))
    }

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
            self.test_deliveries = TestDeliveries::default();
            self.schedule.update(cx, |field, cx| field.set_text("", cx));
        }
        self.detail = Some((campaign, deliveries));
        self.generation = generation;
    }
}

enum Request {
    List(u32),
    Compare(Vec<String>),
    Detail(String, u32),
    Review(String),
    TestDelivery {
        campaign_id: String,
        generation: String,
        version: u32,
        mode: TestDeliveryMode,
        sms_review_token: Option<String>,
        replaces_request_id: Option<uuid::Uuid>,
        test: TestDeliveryResult,
    },
    Write(CampaignAction),
    SaveDraft(sob_core::http::marketing::DraftWrite),
}

enum Loaded {
    List(CampaignPage),
    Comparison(CampaignComparison),
    Detail(Campaign, DeliveryPage),
    Review(Preview, Capabilities),
    TestDelivery(TestDeliveryResult),
    Written(Campaign),
}

#[derive(Clone, Copy)]
struct TestDeliveryResult {
    channel: TestChannel,
    request_id: uuid::Uuid,
    status: Option<TestDeliveryStatus>,
}

impl TestDeliveryResult {
    fn mode(previous: Option<Self>) -> TestDeliveryMode {
        match previous {
            Some(Self {
                status: None | Some(TestDeliveryStatus::Pending),
                ..
            }) => TestDeliveryMode::Check,
            Some(Self {
                status: Some(TestDeliveryStatus::Unconfirmed),
                ..
            }) => TestDeliveryMode::ReplaceUnconfirmed,
            _ => TestDeliveryMode::Send,
        }
    }
}

#[derive(Default)]
struct TestDeliveries {
    email: Option<TestDeliveryResult>,
    sms: Option<TestDeliveryResult>,
    sms_review_token: Option<String>,
}

impl TestDeliveries {
    fn update_sms_review(&mut self, token: Option<&str>) {
        if self.sms_review_token.as_deref() != token {
            self.sms = None;
            self.sms_review_token = token.map(str::to_owned);
        }
    }

    fn get(&self, channel: TestChannel) -> Option<TestDeliveryResult> {
        match channel {
            TestChannel::Email => self.email,
            TestChannel::Sms => self.sms,
        }
    }

    fn set(&mut self, test: TestDeliveryResult) {
        match test.channel {
            TestChannel::Email => self.email = Some(test),
            TestChannel::Sms => self.sms = Some(test),
        }
    }
}

fn delivery_totals(counts: &Counts, sent_label: Key) -> [(Key, u32); 7] {
    [
        (Key::MarketingPending, counts.pending),
        (Key::MarketingProcessing, counts.processing),
        (sent_label, counts.sent),
        (Key::MarketingSkipped, counts.skipped),
        (Key::MarketingFailed, counts.failed),
        (Key::MarketingUnknown, counts.unknown),
        (Key::CalendarCancelled, counts.cancelled),
    ]
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
            selected: Vec::new(),
            comparing: false,
            comparison: None,
            detail: None,
            review: None,
            test_deliveries: TestDeliveries::default(),
            action: None,
            editor: None,
            links: None,
            promotions: None,
            peak_prices: None,
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
        if matches!(&self.overlay, Overlay::Marketing(desk) if desk.peak_prices.is_some()) {
            self.refresh_peak_prices(reconnected, cx);
            return;
        }
        if matches!(&self.overlay, Overlay::Marketing(desk) if desk.promotions.is_some()) {
            self.refresh_promotions(reconnected, cx);
            return;
        }
        if matches!(&self.overlay, Overlay::Marketing(desk) if desk.links.is_some()) {
            self.refresh_booking_links(reconnected, cx);
            return;
        }
        let observed = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let can_compare = self.svc.store.cached_catalogue_access();
        let Some(desk) = self.marketing_desk() else {
            return;
        };
        if !can_compare && (desk.comparing || !desk.selected.is_empty()) {
            desk.selected.clear();
            if desk.comparing {
                desk.comparing = false;
                desk.comparison = None;
                desk.list = None;
                desk.request = None;
                desk.refreshing = false;
                desk.busy = false;
                desk.error = Some(Key::MarketingUnavailable);
            }
            cx.notify();
            return;
        }
        if desk.busy
            || desk.refreshing
            || desk.action.is_some()
            || desk.editor.is_some()
            || desk
                .retry_after
                .is_some_and(|retry| retry > std::time::Instant::now())
            || (!reconnected
                && desk.observed == observed
                && !(desk.comparing && desk.error.is_some()))
        {
            return;
        }
        let request = if desk.comparing {
            Request::Compare(desk.selected.iter().map(|item| item.id.clone()).collect())
        } else if let Some((campaign, deliveries)) = &desk.detail {
            Request::Detail(campaign.id.clone(), deliveries.pagination.page)
        } else {
            Request::List(desk.list.as_ref().map_or(1, |list| list.pagination.page))
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
        if desk.peak_prices.is_some() {
            self.back_from_peak_prices(cx);
            return;
        }
        if desk.promotions.is_some() {
            self.back_from_promotions(false, cx);
            return;
        }
        if desk.links.take().is_some() {
            cx.notify();
            return;
        }
        if desk.comparing {
            desk.comparing = false;
            desk.comparison = None;
            desk.request = None;
            desk.refreshing = false;
            desk.observed = None;
            desk.error = None;
            self.refresh_marketing(true, cx);
            cx.notify();
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
        if matches!(request, Request::Compare(_)) && !self.svc.store.cached_catalogue_access() {
            return;
        }
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
        let comparing = matches!(request, Request::Compare(_));
        if comparing {
            desk.comparing = true;
        }
        let saving = matches!(request, Request::SaveDraft(_));
        let writing = saving || matches!(request, Request::Write(_));
        let test_request = match &request {
            Request::TestDelivery { test, .. } => Some(*test),
            _ => None,
        };
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
                        Request::Compare(ids) => {
                            Loaded::Comparison(transport.marketing_campaign_comparison(&ids)?)
                        }
                        Request::Detail(id, page) => Loaded::Detail(
                            transport.marketing_campaign(&id)?,
                            transport.marketing_deliveries(&id, page)?,
                        ),
                        Request::Review(id) => Loaded::Review(
                            transport.marketing_preview(&id)?,
                            transport.marketing_capabilities()?,
                        ),
                        Request::TestDelivery {
                            campaign_id,
                            generation,
                            version,
                            mode,
                            sms_review_token,
                            replaces_request_id,
                            mut test,
                        } => {
                            let receipt = transport.send_campaign_test(
                                &campaign_id,
                                &generation,
                                version,
                                test.request_id,
                                mode,
                                match test.channel {
                                    TestChannel::Email => TestTarget::Email,
                                    TestChannel::Sms => TestTarget::Sms {
                                        replaces_request_id,
                                        review_token: sms_review_token
                                            .as_deref()
                                            .ok_or(MutationError::Changed)?,
                                    },
                                },
                            )?;
                            test.status = Some(receipt.status);
                            test.request_id = receipt.request_id;
                            Loaded::TestDelivery(test)
                        }
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
                if comparing && !root.svc.store.cached_catalogue_access() {
                    root.refresh_marketing(false, cx);
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
                if matches!(
                    &result,
                    Ok(Loaded::List(_) | Loaded::Detail(_, _) | Loaded::Comparison(_))
                ) {
                    desk.observed = observed;
                    desk.retry_after = None;
                } else if background && result.is_err() {
                    desk.retry_after =
                        Some(std::time::Instant::now() + std::time::Duration::from_secs(3));
                }
                let reload = match result {
                    Ok(Loaded::List(list)) => {
                        desk.comparing = false;
                        desk.comparison = None;
                        desk.list = Some(list);
                        desk.detail = None;
                        desk.review = None;
                        desk.test_deliveries = TestDeliveries::default();
                        None
                    }
                    Ok(Loaded::Comparison(result)) => {
                        desk.comparison = Some(result);
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
                            desk.test_deliveries.update_sms_review(
                                preview
                                    .sms_test
                                    .as_ref()
                                    .map(|review| review.review_token.as_str()),
                            );
                            desk.review = Some((preview, capabilities));
                        } else {
                            desk.error = Some(Key::MarketingChanged);
                        }
                        None
                    }
                    Ok(Loaded::TestDelivery(test)) => {
                        desk.test_deliveries.set(test);
                        None
                    }
                    Err(error) if let Some(test) = test_request => {
                        if matches!(
                            error,
                            MutationError::Changed
                                | MutationError::Transport(
                                    TransportError::ReplicaGenerationChanged
                                )
                        ) {
                            desk.review = None;
                            desk.test_deliveries = TestDeliveries::default();
                            desk.error = Some(Key::MarketingChanged);
                        } else {
                            desk.test_deliveries.set(TestDeliveryResult {
                                status: None,
                                ..test
                            });
                        }
                        None
                    }
                    Ok(Loaded::Written(mut campaign)) => {
                        if !saving
                            && let Some((current, _)) = &desk.detail
                            && current.id == campaign.id
                            && desk.generation == generation
                        {
                            campaign.email_layout.clone_from(&current.email_layout);
                        }
                        desk.editor = None;
                        desk.action = None;
                        desk.uncertain = false;
                        desk.review = None;
                        desk.test_deliveries = TestDeliveries::default();
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
                        if comparing {
                            desk.comparison = None;
                            desk.retry_after =
                                Some(std::time::Instant::now() + std::time::Duration::from_secs(3));
                        }
                        if matches!(error, TransportError::Forbidden(_))
                            || (comparing && matches!(error, TransportError::Unauthorized))
                        {
                            desk.selected.clear();
                            desk.comparing = false;
                            desk.comparison = None;
                        }
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

    fn send_marketing_test(&mut self, channel: TestChannel, cx: &mut Context<Self>) {
        let Some(desk) = self
            .marketing_desk()
            .filter(|desk| !desk.busy && desk.action.is_none())
        else {
            return;
        };
        let Some((campaign, generation)) = desk.reviewed_delivery_test(channel) else {
            return;
        };
        let previous = desk.test_deliveries.get(channel);
        let mode = TestDeliveryResult::mode(previous);
        let request_id = match (mode, previous) {
            (TestDeliveryMode::Check, Some(previous)) => previous.request_id,
            _ => uuid::Uuid::now_v7(),
        };
        let sms_review_token = if let TestChannel::Sms = channel {
            desk.review
                .as_ref()
                .and_then(|(preview, _)| preview.sms_test.as_ref())
                .map(|review| review.review_token.clone())
        } else {
            None
        };
        let request = Request::TestDelivery {
            campaign_id: campaign.id.clone(),
            generation: generation.to_owned(),
            version: campaign.version,
            mode,
            sms_review_token,
            replaces_request_id: match (channel, mode, previous) {
                (TestChannel::Sms, TestDeliveryMode::ReplaceUnconfirmed, Some(previous)) => {
                    Some(previous.request_id)
                }
                _ => None,
            },
            test: TestDeliveryResult {
                channel,
                request_id,
                status: None,
            },
        };
        self.request_marketing(request, cx);
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
        let body = if let Some(peak) = &desk.peak_prices {
            self.render_peak_prices(peak, ready, cx)
        } else if let Some(promotions) = &desk.promotions {
            self.render_promotions(promotions, ready, cx)
        } else if let Some(links) = &desk.links {
            self.render_booking_links(links, ready, cx)
        } else if desk.choose_template {
            self.campaign_templates(ready, desk.editor.is_some(), cx)
        } else if let Some(editor) = &desk.editor {
            self.render_campaign_editor(desk, editor, ready, cx)
        } else if desk.comparing {
            self.render_campaign_comparison(desk.comparison.as_ref())
        } else if let Some((campaign, deliveries)) = &desk.detail {
            self.render_campaign(desk, campaign, deliveries, ready, cx)
        } else {
            self.render_campaign_list(desk, ready, cx)
        };
        let footer = div().flex().flex_wrap().gap_2().when(!desk.busy, |row| {
            if let Some(peak) = &desk.peak_prices {
                return row.when(!peak.busy, |row| {
                    row.child(self.marketing_button(
                        "back-from-peak-prices",
                        if peak.confirm_exit {
                            Key::MarketingDiscardDraft
                        } else {
                            Key::Back
                        },
                        Kind::Ghost,
                        Root::back_from_peak_prices,
                        cx,
                    ))
                });
            }
            if let Some(promotions) = &desk.promotions {
                return row.when_some(self.promotion_back_key(promotions), |row, label| {
                    row.child(
                        self.marketing_button(
                            "back-from-promotions",
                            label,
                            Kind::Ghost,
                            |root, cx| root.back_from_promotions(true, cx),
                            cx,
                        )
                        .debug_selector(|| "back-from-promotions".to_owned()),
                    )
                });
            }
            let close = if desk.choose_template || desk.links.is_some() || desk.comparing {
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
                        .debug_selector(|| "marketing-body".into())
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
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
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
                        .when(
                            self.directory_enabled()
                                && desk
                                    .list
                                    .as_ref()
                                    .is_some_and(|page| page.booking_invitations),
                            |row| {
                                row.child(self.marketing_button(
                                    "create-booking-invitation",
                                    Key::MarketingInvite,
                                    Kind::Ghost,
                                    |root, cx| root.open_campaign_editor(EditorMode::Invite, cx),
                                    cx,
                                ))
                            },
                        )
                        .child(self.marketing_button(
                            "marketing-booking-links",
                            Key::BookingLinkTitle,
                            Kind::Ghost,
                            Root::open_booking_links,
                            cx,
                        ))
                        .child(
                            self.marketing_button(
                                "marketing-promotions",
                                Key::PromoTitle,
                                Kind::Ghost,
                                Root::open_promotions,
                                cx,
                            )
                            .debug_selector(|| "marketing-promotions".to_owned()),
                        )
                        .when(self.svc.store.cached_catalogue_access(), |row| {
                            row.child(self.marketing_button(
                                "marketing-peak-prices",
                                Key::PeakPriceTitle,
                                Kind::Ghost,
                                Root::open_peak_prices,
                                cx,
                            ))
                        })
                        .child(
                            self.marketing_button(
                                "marketing-loyalty",
                                Key::LoyaltyTitle,
                                Kind::Ghost,
                                Root::open_loyalty,
                                cx,
                            )
                            .debug_selector(|| "marketing-loyalty".to_owned()),
                        ),
                )
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
        let can_compare = self.svc.store.cached_catalogue_access();
        body = body.when(can_compare, |body| {
            body.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .items_center()
                    .child(i18n::fill(
                        self.t(Key::MarketingComparisonSelection),
                        &[
                            ("count", &desk.selected.len().to_string()),
                            ("max", &MAX_COMPARISON_CAMPAIGNS.to_string()),
                        ],
                    ))
                    .when(ready && desk.selected.len() >= 2, |row| {
                        let ids: Vec<String> =
                            desk.selected.iter().map(|item| item.id.clone()).collect();
                        row.child(self.marketing_button(
                            "compare-campaigns",
                            Key::MarketingCompare,
                            Kind::Primary,
                            move |root, cx| {
                                root.request_marketing(Request::Compare(ids.clone()), cx)
                            },
                            cx,
                        ))
                    })
                    .children(desk.selected.iter().map(|item| {
                        let id = item.id.clone();
                        let name = &item.name;
                        let key = SharedString::from(format!("remove-selected-{id}"));
                        self.button(
                            key,
                            format!("{name} ×"),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                if let Some(desk) = root.marketing_desk().filter(|desk| !desk.busy)
                                {
                                    desk.selected.retain(|item| item.id != id);
                                    cx.notify();
                                }
                            }),
                        )
                        .tab_index(0)
                    })),
            )
        });
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
                let id_to_open = id.clone();
                let row = row.when(ready, |row| {
                    row.tab_index(0)
                        .cursor_pointer()
                        .focus(|style| style.bg(theme::accent_soft()))
                        .hover(|style| style.bg(theme::accent_soft()))
                        .on_click(cx.listener(move |root, _, _, cx| {
                            root.request_marketing(Request::Detail(id_to_open.clone(), 1), cx)
                        }))
                });
                let selected = desk.selected.iter().any(|item| item.id == id);
                let name = campaign.name.clone();
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(row.flex_1())
                    .when(
                        can_compare
                            && ready
                            && (selected || desk.selected.len() < MAX_COMPARISON_CAMPAIGNS),
                        |row| {
                            row.child(self.marketing_button(
                                SharedString::from(format!("select-comparison-{id}")),
                                if selected {
                                    Key::MarketingRemoveComparison
                                } else {
                                    Key::MarketingSelectComparison
                                },
                                Kind::Ghost,
                                move |root, cx| {
                                    if let Some(desk) =
                                        root.marketing_desk().filter(|desk| !desk.busy)
                                    {
                                        if let Some(index) =
                                            desk.selected.iter().position(|item| item.id == id)
                                        {
                                            desk.selected.remove(index);
                                        } else if desk.selected.len() < MAX_COMPARISON_CAMPAIGNS {
                                            desk.selected.push(CampaignSelection {
                                                id: id.clone(),
                                                name: name.clone(),
                                            });
                                        }
                                        cx.notify();
                                    }
                                },
                                cx,
                            ))
                        },
                    )
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

    fn render_campaign_comparison(&self, comparison: Option<&CampaignComparison>) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::MarketingCompare)),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::MarketingComparisonHelp)),
            )
            .child(
                div().flex().flex_wrap().gap_2().children(
                    comparison
                        .into_iter()
                        .flat_map(|comparison| &comparison.campaigns)
                        .map(|campaign| {
                            div()
                                .flex()
                                .flex_col()
                                .flex_1()
                                .min_w(px(240.))
                                .gap_2()
                                .p_3()
                                .rounded_md()
                                .border_1()
                                .border_color(theme::line())
                                .child(
                                    div()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(campaign.name.clone()),
                                )
                                .child(div().text_sm().text_color(theme::muted()).child(format!(
                                    "{} · {}",
                                    self.t(status_key(campaign.status)),
                                    self.t(channel_key(campaign.channel)),
                                )))
                                .children(
                                    delivery_totals(
                                        &campaign.counts,
                                        Key::MarketingProviderAccepted,
                                    )
                                    .into_iter()
                                    .map(|(key, count)| {
                                        div()
                                            .flex()
                                            .justify_between()
                                            .gap_2()
                                            .text_sm()
                                            .child(self.t(key))
                                            .child(count.to_string())
                                    }),
                                )
                        }),
                ),
            )
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
            .when(!campaign.subject.is_empty(), |panel| {
                panel.child(div().text_sm().child(campaign.subject.clone()))
            })
            .when_some(campaign.email_layout.as_ref(), |panel, layout| {
                panel.child(self.render_email_layout_preview(layout))
            })
            .when(
                campaign.email_layout.is_none() && !campaign.email_body.is_empty(),
                |panel| panel.child(div().text_sm().child(campaign.email_body.clone())),
            )
            .when(!campaign.sms_body.is_empty(), |panel| {
                panel.child(div().text_sm().child(campaign.sms_body.clone()))
            })
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
                    delivery_totals(counts, Key::MarketingSent)
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
            for channel in [TestChannel::Email, TestChannel::Sms] {
                if desk.reviewed_delivery_test(channel).is_none() {
                    continue;
                }
                let (button, send, check, again, accepted, rejected, unconfirmed) = match channel {
                    TestChannel::Email => (
                        "send-marketing-test-email",
                        Key::MarketingTestEmail,
                        Key::MarketingTestEmailCheck,
                        Key::MarketingTestEmailAgain,
                        Key::MarketingTestEmailSent,
                        Key::MarketingTestEmailRejected,
                        Key::MarketingTestEmailFailed,
                    ),
                    TestChannel::Sms => (
                        "send-marketing-test-sms",
                        Key::MarketingTestSms,
                        Key::MarketingTestSmsCheck,
                        Key::MarketingTestSmsAgain,
                        Key::MarketingTestSmsSent,
                        Key::MarketingTestSmsRejected,
                        Key::MarketingTestSmsFailed,
                    ),
                };
                let result = desk.test_deliveries.get(channel);
                if let TestChannel::Sms = channel
                    && let Some(review) = &preview.sms_test
                {
                    body =
                        body.child(div().text_sm().text_color(theme::muted()).child(i18n::fill(
                            self.t(Key::MarketingTestSmsTarget),
                            &[("lastFour", &review.last_four)],
                        )));
                    body = body.child(
                        div()
                            .rounded_md()
                            .border_1()
                            .border_color(theme::line())
                            .p_3()
                            .text_sm()
                            .child(review.message.clone()),
                    );
                }
                body = body
                    .when(ready && desk.action.is_none(), |panel| {
                        let label = match TestDeliveryResult::mode(result) {
                            TestDeliveryMode::Check => check,
                            TestDeliveryMode::ReplaceUnconfirmed => again,
                            TestDeliveryMode::Send => send,
                        };
                        panel.child(self.marketing_button(
                            button,
                            label,
                            Kind::Ghost,
                            move |root, cx| root.send_marketing_test(channel, cx),
                            cx,
                        ))
                    })
                    .when_some(result, |panel, result| {
                        panel.child(self.t(match result.status {
                            Some(TestDeliveryStatus::Accepted) => accepted,
                            Some(TestDeliveryStatus::Pending) => Key::MarketingTestEmailPending,
                            Some(TestDeliveryStatus::Rejected) => rejected,
                            Some(TestDeliveryStatus::NotRequested) => {
                                Key::MarketingTestEmailNotRequested
                            }
                            Some(TestDeliveryStatus::Unconfirmed) | None => unconfirmed,
                        }))
                    });
            }
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
    fn changing_the_sms_review_clears_only_the_old_sms_outcome() {
        let mut tests = TestDeliveries::default();
        tests.update_sms_review(Some("initial"));
        for channel in [TestChannel::Email, TestChannel::Sms] {
            tests.set(TestDeliveryResult {
                channel,
                request_id: uuid::Uuid::now_v7(),
                status: Some(TestDeliveryStatus::Unconfirmed),
            });
        }
        tests.update_sms_review(Some("initial"));
        assert!(tests.get(TestChannel::Sms).is_some());
        tests.update_sms_review(Some("rotated"));
        assert!(tests.get(TestChannel::Sms).is_none());
        assert!(tests.get(TestChannel::Email).is_some());
    }

    #[gpui::test]
    async fn comparison_clears_when_catalogue_access_is_revoked_without_a_marketing_event(
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
            root.svc.store.remember_catalogue_access(&generation).unwrap();
            let desk = root.marketing_desk().unwrap();
            desk.selected = vec![
                CampaignSelection { id: "first".into(), name: "First".into() },
                CampaignSelection { id: "second".into(), name: "Second".into() },
            ];
            desk.comparing = true;
            desk.comparison = Some(serde_json::from_value(json!({
                "campaigns": [{
                    "name": "First", "channel": "email", "status": "active",
                    "counts": {"pending":1,"processing":2,"sent":3,"skipped":4,"failed":5,"unknown":6,"cancelled":7}
                }]
            })).unwrap());

            root.dismiss_marketing(cx);
            let desk = root.marketing_desk().unwrap();
            assert!(!desk.comparing);
            assert_eq!(desk.selected.len(), 2);

            desk.comparing = true;
            desk.request = Some(Arc::new(()));
            desk.refreshing = true;
            root.svc.store.forget_catalogue_access().unwrap();
            root.refresh_marketing(false, cx);
            let desk = root.marketing_desk().unwrap();
            assert!(!desk.comparing);
            assert!(!desk.refreshing);
            assert!(desk.selected.is_empty());
            assert!(desk.comparison.is_none());
            assert!(desk.request.is_none());
        });
    }

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
                "email":1,"sms":0,"excluded":0,"sample":[],
                "smsTest": {"lastFour":"3210","message":"Example","reviewToken":"a".repeat(64),"generation":desk.generation}
            })).unwrap();
            desk.detail = Some((campaign, deliveries));
            desk.review = Some((preview, Capabilities { email:true, sms:false, worker:true, can_test_email: true }));
            assert!(desk.reviewed_delivery_test(TestChannel::Email).is_none());
            root.prepare_marketing_action(false, cx);
            let desk = root.marketing_desk().unwrap();
            assert!(desk.action.is_none());
            desk.review.as_mut().unwrap().0.version = 2;
            assert!(desk.reviewed_delivery_test(TestChannel::Email).is_some());
            assert!(desk.reviewed_delivery_test(TestChannel::Sms).is_none());
            desk.detail.as_mut().unwrap().0.channel = Channel::Optimized;
            assert!(desk.reviewed_delivery_test(TestChannel::Sms).is_some());
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
