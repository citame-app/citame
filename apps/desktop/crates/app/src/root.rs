//! The application view: login, the day calendar, the booking and detail dialogs and the
//! conflict review. All state transitions go through `sob_core` (store, ops, runner); this file
//! only renders and forwards user intent.

use std::cell::OnceCell;
use std::collections::{BTreeSet, HashMap};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use chrono::{DateTime, Datelike, Duration as Span, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use gpui::prelude::*;
use gpui::{
    App, ClickEvent, Context, ElementId, Entity, FontWeight, IntoElement, Render, SharedString,
    Stateful, Subscription, Window, div, px, relative,
};
use sob_core::auth::{AuthError, Session, TokenStore};
use sob_core::calendar::{self, CalendarItem, DayView, SyncSummary};
use sob_core::error::CoreError;
use sob_core::i18n::{self, Key, Locale};
use sob_core::model::*;
use sob_core::ops::{self, NewAppointment, Resolution};
use sob_core::runner::{Connectivity, SyncStatus, Wake};

use crate::config::Config;
use crate::field::{FieldEvent, TextField};
use crate::services::Services;
use crate::theme;

mod account_roles;
mod annotations;
mod appointment_badges;
mod billing;
mod blocks;
mod booking_intake;
mod booking_policy;
mod calendar_date;
mod calendar_overview;
mod commissions;
mod visit_booking;
mod visit_group;
use calendar_overview::CalendarMode;
mod cash;
mod checkout;
mod combinations;
mod connection;
mod directory;
mod email_delivery;
mod form_admin;
mod inbox;
mod intake_editor;
mod intake_live;
mod intake_record;
mod inventory;
mod loyalty;
mod marketing;
mod notices;
mod reports;
mod resource_pools;
mod resource_requirements;
mod review_moderation;
mod reviews;
mod salon_configuration;
mod scrollbar;
mod service_assignments;
mod service_catalog;
mod settlement;
use settlement::SettlementMode;
mod slots;
mod staff_access;
mod staff_portraits;
mod team_calendar;
mod team_shifts;
mod transactions;
mod unpaid;
mod waitlist;
mod walk_in;
mod whatsapp;
mod workspaces;

const HOUR_PX: f32 = 60.0;
const GUTTER_PX: f32 = 56.0;

fn prompt_csv_export(
    filename: &str,
    still_allowed: impl FnOnce(&Root) -> bool + 'static,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()> + Send + 'static,
    finish: impl FnOnce(&mut Root, Option<Key>, &mut Context<Root>) + 'static,
    cx: &mut Context<Root>,
) {
    let directory = std::env::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"));
    let picker = cx.prompt_for_new_path(&directory, Some(filename));
    cx.spawn(async move |root, cx| {
        let notice = match picker.await {
            Ok(Ok(Some(_)))
                if !root
                    .update(cx, |root, _| still_allowed(root))
                    .unwrap_or(false) =>
            {
                Some(Key::ReportExportChanged)
            }
            Ok(Ok(Some(path))) => {
                let result = cx
                    .background_executor()
                    .spawn(async move { sob_core::csv_file::save(&path, write) })
                    .await;
                Some(if result.is_ok() {
                    Key::ReportExported
                } else {
                    Key::ReportExportFailed
                })
            }
            Ok(Ok(None)) => None,
            _ => Some(Key::ReportExportFailed),
        };
        let _ = root.update(cx, |root, cx| finish(root, notice, cx));
    })
    .detach();
}

fn salon_local_instant(tz: Tz, date: NaiveDate, minutes: i64) -> Option<DateTime<Utc>> {
    let day = date.checked_add_signed(Span::days(minutes.div_euclid(1440)))?;
    let minute = minutes.rem_euclid(1440) as u32;
    let wall = day.and_hms_opt(minute / 60, minute % 60, 0)?;
    tz.from_local_datetime(&wall)
        .single()
        .map(|time| time.to_utc())
}

fn step_appointment_time(tz: Tz, start: DateTime<Utc>, minutes: i64) -> Option<DateTime<Utc>> {
    let local = start.with_timezone(&tz);
    let day = chrono::Days::new(1);
    match minutes {
        -1440 => local.checked_sub_days(day).map(|time| time.to_utc()),
        1440 => local.checked_add_days(day).map(|time| time.to_utc()),
        _ => start.checked_add_signed(Span::minutes(minutes)),
    }
}

fn conflict_requested_start(conflict: &Conflict) -> Option<DateTime<Utc>> {
    conflict.payload.get("startsAt")?.as_str()?.parse().ok()
}

fn appointment_bounds(item: &CalendarItem, day: NaiveDate, tz: Tz) -> (f32, f32) {
    let appointment = &item.appointment;
    let wall_minute = |instant: DateTime<Utc>| {
        let local = instant.with_timezone(&tz);
        match local.date_naive().cmp(&day) {
            std::cmp::Ordering::Less => 0,
            std::cmp::Ordering::Greater => 1440,
            std::cmp::Ordering::Equal => local.hour() * 60 + local.minute(),
        }
    };
    let from = wall_minute(appointment.starts_at);
    let to = wall_minute(appointment.ends_at);
    let start = from as f32 * HOUR_PX / 60.;
    let height = (to.saturating_sub(from) as f32 * HOUR_PX / 60. - 2.).max(22.);
    (start, start + height)
}

fn appointment_lanes(bounds: &[(f32, f32)]) -> Vec<(usize, usize)> {
    let mut placement = Vec::with_capacity(bounds.len());
    let mut lane_ends = Vec::new();
    let mut component_start = 0;
    let mut indices: Vec<_> = (0..bounds.len()).collect();
    indices.sort_by(|&left, &right| bounds[left].0.total_cmp(&bounds[right].0));
    for &index in &indices {
        let (start, end) = bounds[index];
        if lane_ends
            .iter()
            .all(|&occupied_until| occupied_until <= start)
        {
            for (_, count) in &mut placement[component_start..] {
                *count = lane_ends.len();
            }
            component_start = placement.len();
            lane_ends.clear();
        }
        let lane = lane_ends
            .iter()
            .position(|&occupied_until| occupied_until <= start)
            .unwrap_or(lane_ends.len());
        if lane == lane_ends.len() {
            lane_ends.push(end);
        } else {
            lane_ends[lane] = end;
        }
        placement.push((lane, 1));
    }
    for (_, count) in &mut placement[component_start..] {
        *count = lane_ends.len();
    }
    let mut lanes = vec![(0, 1); bounds.len()];
    for (index, lane) in indices.into_iter().zip(placement) {
        lanes[index] = lane;
    }
    lanes
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Primary,
    Ghost,
    Danger,
}

enum Screen {
    Login,
    Main,
}

struct LoginForm {
    browser_attempt: Option<Arc<AtomicBool>>,
    server: Entity<TextField>,
    server_editor: bool,
    server_error: Option<Key>,
    busy: bool,
    error: Option<Key>,
}

struct NewForm {
    date: NaiveDate,
    minutes: i64,
    selected_end: Option<i64>,
    staff_id: Option<String>,
    services: Vec<String>,
    selected_quotes: std::collections::BTreeMap<String, String>,
    client_id: Option<String>,
    client_search: Entity<TextField>,
    _client_search_sub: Subscription,
    service_search: Entity<TextField>,
    _service_search_sub: Subscription,
    service_scroll: gpui::ScrollHandle,
    new_client: Entity<TextField>,
    new_client_phone: Entity<TextField>,
    notes: Entity<TextField>,
    recurrence: Option<sob_core::booking::Recurrence>,
    series_override: bool,
    visit_parts: Vec<sob_core::booking::visit::VisitPartSelection>,
    visit_quotes: std::collections::BTreeMap<String, String>,
    visit_review: Option<Box<visit_booking::VisitDesk>>,
    intake: Option<booking_intake::BookingReview>,
    error: Option<Key>,
}

enum AppointmentReturn {
    TeamShifts(Box<team_shifts::Desk>),
    Unpaid(Box<unpaid::Desk>),
    Conflict(String),
}

struct Details {
    return_to: Option<AppointmentReturn>,
    id: String,
    reviewed: ops::ReviewedAppointment,
    start: DateTime<Utc>,
    staff_id: String,
    confirm_cancel: bool,
    error: Option<String>,
    price_review: Option<billing::PriceReview>,
    settlement_review: Option<settlement::SettlementReview>,
    checkout: Option<checkout::CheckoutReview>,
    annotations: Option<annotations::Annotations>,
    annotations_requested_version: Option<i64>,
}

impl Details {
    fn conflict_to_resolve(&self) -> Option<&str> {
        if let Some(AppointmentReturn::Conflict(mutation_id)) = &self.return_to {
            Some(mutation_id)
        } else {
            None
        }
    }
}

struct ConflictDraft {
    mutation_id: String,
    start: DateTime<Utc>,
    staff_id: String,
}

enum Overlay {
    None,
    Cloud(workspaces::CloudDesk),
    SalonConfiguration(Box<salon_configuration::Desk>),
    EmailDelivery(Box<email_delivery::Desk>),
    Marketing(Box<marketing::Desk>),
    Loyalty(Box<loyalty::Desk>),
    Whatsapp(Box<whatsapp::Desk>),
    BookingPolicy(Box<booking_policy::Desk>),
    IntakeForms(Box<form_admin::Desk>),
    New(Box<NewForm>),
    Slot(slots::SelectedSlot),
    Details(Box<Details>),
    Block(Box<blocks::BlockForm>),
    Blocks,
    Inbox(inbox::Inbox),
    Cash(cash::RegisterDesk),
    WalkIn(Box<walk_in::SaleDesk>),
    WalkInReceipt(checkout::CheckoutReview),
    SalesHistory(Box<transactions::History>),
    Unpaid(Box<unpaid::Desk>),
    Inventory(Box<inventory::Desk>),
    Reports(Box<reports::Desk>),
    Commissions(Box<commissions::Desk>),
    CalendarDate(calendar_date::DatePicker),
    TeamShifts(Box<team_shifts::Desk>),
    StaffPortraits(Box<staff_portraits::Desk>),
    StaffAccess(Box<staff_access::Desk>),
    AccountRoles(Box<account_roles::Desk>),
    ServiceAssignments(Box<service_assignments::Desk>),
    ServiceCatalog(Box<service_catalog::Desk>),
    ResourceRequirements(Box<resource_requirements::Desk>),
    ResourcePools(Box<resource_pools::Desk>),
    Combinations(Box<combinations::Desk>),
    Reviews(Box<reviews::Desk>),
    ReviewModeration(Box<review_moderation::Desk>),
    Waitlist(Box<waitlist::Desk>),
    Directory(Box<directory::Directory>),
    Conflicts {
        editing: Option<ConflictDraft>,
        error: Option<String>,
    },
}

struct CalendarLayout {
    first: u32,
    last: u32,
    columns_width: f32,
    columns: Vec<CalendarColumnLayout>,
}

struct CalendarColumnLayout {
    bounds: Vec<(f32, f32)>,
    lanes: Vec<(usize, usize)>,
    width: f32,
}

pub struct Root {
    svc: Services,
    locale: Locale,
    screen: Screen,
    login: LoginForm,
    disconnecting: bool,
    disconnect_failed: bool,
    date: NaiveDate,
    calendar_now: DateTime<Utc>,
    tz: Tz,
    view: Option<DayView>,
    calendar_mode: CalendarMode,
    period_views: Vec<DayView>,
    overview_staff: BTreeSet<String>,
    overview_search: Entity<TextField>,
    overview_status: Option<AppointmentStatus>,
    overview_show_cancelled: bool,

    calendar_layout: OnceCell<CalendarLayout>,
    slot_drag: Option<slots::SlotDrag>,
    horizontal_scroll: scrollbar::Scrollbar,
    vertical_scroll: scrollbar::Scrollbar,
    week_staff_id: String,
    week_layout: team_calendar::WeekLayout,
    week_working_only: bool,
    team_calendar_scroll: gpui::ScrollHandle,
    time_off_scope: String,
    calendar_scope: Option<String>,
    replica_generation: Option<String>,
    theme_override: Option<bool>,
    pending_local_today: bool,
    status: SyncStatus,
    summary: SyncSummary,
    conflicts: Vec<Conflict>,
    clients: Vec<(String, String)>,
    client_search_names: Vec<String>,
    staff: Vec<Staff>,
    report_staff_options: Vec<Staff>,
    services: Vec<Service>,
    service_colors: HashMap<String, String>,
    focus: gpui::FocusHandle,
    overlay: Overlay,
    pending_loyalty: Option<loyalty::Pending>,
    data_version: Option<i64>,
    notice_cursor: i64,
    notices: Vec<(Appointment, Instant)>,
    inbox_generation: u64,
    waitlist_generation: u64,
    review_generation: u64,
    _subs: Vec<Subscription>,
}

impl Root {
    pub fn new(config: Config, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let locale = config.locale;
        let theme_override = match std::env::var("SOB_THEME").ok().as_deref() {
            Some("dark") => Some(true),
            Some("light") => Some(false),
            Some("system") => None,
            _ => config.saved_theme(),
        };
        let start_date = config.start_date;
        let start_view = config.start_view.clone();
        let svc = Services::open(config).expect("open the local database");
        let tz = calendar::salon_tz(&svc.store).unwrap_or(Tz::UTC);
        let pending_local_today =
            start_date.is_none() && svc.store.salon_settings().ok().flatten().is_none();
        let server = cx.new(|cx| TextField::new("https://citame.example", false, cx));
        let server_editor = svc.config.needs_server_setup();
        let mut subs = vec![];
        subs.push(
            cx.subscribe(&server, |this: &mut Root, _, ev: &FieldEvent, cx| {
                if matches!(ev, FieldEvent::Submit) {
                    this.save_server(cx);
                }
            }),
        );
        let overview_search =
            cx.new(|cx| TextField::new(i18n::t(locale, Key::CalendarOverviewSearch), false, cx));
        subs.push(cx.observe(&overview_search, |_, _, cx| cx.notify()));
        let mut root = Self {
            svc,
            locale,
            screen: Screen::Login,
            login: LoginForm {
                browser_attempt: None,
                server: server.clone(),
                server_editor,
                server_error: None,
                busy: false,
                error: None,
            },
            disconnecting: false,
            disconnect_failed: false,
            date: start_date.unwrap_or_else(|| Utc::now().with_timezone(&tz).date_naive()),
            calendar_now: Utc::now(),
            tz,
            view: None,
            calendar_mode: CalendarMode::Day,
            period_views: vec![],
            overview_staff: BTreeSet::new(),
            overview_search,
            overview_status: None,
            overview_show_cancelled: false,
            calendar_layout: OnceCell::new(),
            slot_drag: None,
            horizontal_scroll: scrollbar::Scrollbar::default(),
            vertical_scroll: scrollbar::Scrollbar::default(),
            week_staff_id: String::new(),
            week_layout: team_calendar::WeekLayout::Timeline,
            week_working_only: false,
            team_calendar_scroll: gpui::ScrollHandle::new(),
            time_off_scope: String::new(),
            calendar_scope: None,
            replica_generation: None,
            theme_override,
            pending_local_today,
            status: SyncStatus::default(),
            summary: SyncSummary::default(),
            conflicts: vec![],
            clients: vec![],
            client_search_names: vec![],
            staff: vec![],
            report_staff_options: vec![],
            services: vec![],
            service_colors: HashMap::new(),
            focus: cx.focus_handle(),
            overlay: Overlay::None,
            pending_loyalty: None,
            data_version: None,
            notice_cursor: 0,
            notices: vec![],
            inbox_generation: 0,
            waitlist_generation: 0,
            review_generation: 0,
            _subs: subs,
        };
        if let Some(saved) = root.svc.load_saved_session() {
            root.login.server_editor = false;
            // Offline-first: a saved session opens the app at once; validity is checked in the
            // background and only a definite "no" signs the user out.
            root.enter_main(cx);
            root.validate_saved(saved, cx);
            root.open_start_view(start_view.as_deref(), window, cx);
        } else if server_editor {
            server.read(cx).focus(window);
        }
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(400))
                    .await;
                if this.update(cx, |this, cx| this.tick(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        root
    }

    fn open_start_view(&mut self, view: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        match view {
            Some("team-week") => {
                self.week_layout = team_calendar::WeekLayout::Team;
                self.set_calendar_mode(CalendarMode::Week, cx);
            }
            Some("month") => self.set_calendar_mode(CalendarMode::Month, cx),
            Some("list") => self.set_calendar_mode(CalendarMode::List, cx),
            Some("new") => self.open_new(window, cx),
            Some("block") => self.open_block(None, self.date, cx),
            Some("reports") => self.open_reports(cx),
            Some("inventory") => self.open_inventory(cx),
            Some("reviews") => self.open_review_requests(cx),
            Some("review-moderation") => self.open_review_moderation(cx),
            Some("reports-cancelled") => {
                self.open_outcome_report(sob_core::reports::Outcome::Cancelled, cx)
            }
            Some("reports-no-show") => {
                self.open_outcome_report(sob_core::reports::Outcome::NoShow, cx)
            }
            Some("conflicts") => {
                self.overlay = Overlay::Conflicts {
                    editing: None,
                    error: None,
                };
                cx.notify();
            }
            Some("details") => {
                let id = self.view.as_ref().and_then(|v| {
                    v.columns
                        .iter()
                        .flat_map(|c| c.items.first())
                        .next()
                        .map(|i| i.appointment.id.clone())
                });
                if let Some(id) = id {
                    self.open_details(&id, cx);
                }
            }
            _ => {}
        }
    }

    fn t(&self, key: Key) -> &'static str {
        i18n::t(self.locale, key)
    }

    // ---------------------------------------------------------------- session

    fn submit_login(&mut self, cx: &mut Context<Self>) {
        if self.login.busy || self.login.server_editor || !matches!(self.screen, Screen::Login) {
            return;
        }
        let auth = self.svc.auth.clone();
        let Ok(flow) = auth.begin_browser_sign_in() else {
            self.login.error = Some(Key::ErrNetwork);
            cx.notify();
            return;
        };
        let cancel = Arc::new(AtomicBool::new(false));
        self.login.browser_attempt = Some(cancel.clone());
        self.login.busy = true;
        self.login.error = None;
        cx.open_url(&flow.url);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let attempt = cancel.clone();
            let res = cx
                .background_executor()
                .spawn(async move { auth.complete_browser_sign_in(flow, &attempt) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this
                    .login
                    .browser_attempt
                    .as_ref()
                    .is_some_and(|active| Arc::ptr_eq(active, &cancel))
                {
                    this.login.browser_attempt = None;
                    this.finish_login(res, cx);
                }
            });
        })
        .detach();
    }

    fn cancel_browser_login(&mut self, cx: &mut Context<Self>) {
        if let Some(attempt) = self.login.browser_attempt.take() {
            attempt.store(true, Ordering::Relaxed);
        }
        self.login.busy = false;
        cx.notify();
    }

    fn finish_login(&mut self, res: Result<Session, AuthError>, cx: &mut Context<Self>) {
        self.login.busy = false;
        match res {
            Ok(session) => {
                if self.svc.open_session(session.clone()).is_err() {
                    self.login.error = Some(Key::ErrGeneric);
                    cx.notify();
                    return;
                }
                if let Err(error) = self.svc.tokens.save(&session) {
                    eprintln!("could not save the session: {error}");
                }
                self.enter_main(cx);
            }
            Err(e) => {
                self.login.error = Some(match e {
                    AuthError::WrongRole(_) => Key::ErrWrongRole,
                    AuthError::Network(_) => Key::ErrNetwork,
                    AuthError::Unexpected(_) => Key::ErrServerResponse,
                    _ => Key::ErrGeneric,
                });
            }
        }
        cx.notify();
    }

    fn enter_main(&mut self, cx: &mut Context<Self>) {
        self.screen = Screen::Main;
        self.tz = calendar::salon_tz(&self.svc.store).unwrap_or(Tz::UTC);
        self.pending_local_today = self.svc.config.start_date.is_none()
            && self.svc.store.salon_settings().ok().flatten().is_none();
        self.date = self
            .svc
            .config
            .start_date
            .unwrap_or_else(|| Utc::now().with_timezone(&self.tz).date_naive());
        self.calendar_mode = CalendarMode::Day;
        self.week_staff_id.clear();
        self.week_layout = team_calendar::WeekLayout::Timeline;
        self.overview_staff.clear();
        self.overview_search
            .update(cx, |field, cx| field.set_text("", cx));
        self.overview_status = None;
        self.overview_show_cancelled = false;
        self.notices.clear();
        self.notice_cursor = self.svc.store.booking_notice_head().unwrap_or_default();
        if let Err(e) = self.svc.start_sync() {
            eprintln!("could not start sync: {e}");
        }
        self.reload(cx);
    }

    fn validate_saved(&mut self, session: Session, cx: &mut Context<Self>) {
        let auth = self.svc.auth.clone();
        let handle = self.svc.session.clone();
        cx.spawn(async move |this, cx| {
            let validated = session.clone();
            let ok = cx
                .background_executor()
                .spawn(async move { sob_core::auth::AuthProvider::validate(&*auth, &validated) })
                .await;
            if let Ok(false) = ok {
                let _ = this.update(cx, |this, cx| {
                    if std::sync::Arc::ptr_eq(&handle, &this.svc.session)
                        && this.svc.current_session().as_ref() == Some(&session)
                    {
                        this.sign_out(cx);
                    }
                });
            }
        })
        .detach();
    }

    fn request_sign_out(&mut self, cx: &mut Context<Self>) {
        if self.disconnecting {
            return;
        }
        let Some(session) = self.svc.current_session().filter(Session::has_device_link) else {
            self.sign_out(cx);
            return;
        };
        self.disconnecting = true;
        self.disconnect_failed = false;
        let auth = self.svc.auth.clone();
        let handle = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { auth.disconnect_device(&session) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if !Arc::ptr_eq(&handle, &this.svc.session) || !this.disconnecting {
                    return;
                }
                if result.is_ok() {
                    this.sign_out(cx);
                } else {
                    this.disconnecting = false;
                    this.disconnect_failed = true;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn sign_out(&mut self, cx: &mut Context<Self>) {
        self.pending_loyalty = None;
        if let Some(session) = self.svc.sign_out() {
            let auth = self.svc.auth.clone();
            cx.background_executor()
                .spawn(async move {
                    sob_core::auth::AuthProvider::sign_out(&*auth, &session);
                })
                .detach();
        }
        self.screen = Screen::Login;
        self.disconnecting = false;
        self.disconnect_failed = false;
        self.overlay = Overlay::None;
        self.notices.clear();
        cx.notify();
    }

    // ---------------------------------------------------------------- data

    fn tick(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.screen, Screen::Main) {
            return;
        }
        let before = self.notices.len();
        let now = Instant::now();
        let wall_now = Utc::now();
        let minute_changed =
            wall_now.timestamp().div_euclid(60) != self.calendar_now.timestamp().div_euclid(60);
        if minute_changed {
            self.calendar_now = wall_now;
        }
        self.notices.retain(|(_, deadline)| *deadline > now);
        let status = self.svc.status();
        let reconnected = status.connectivity == Connectivity::Online
            && self.status.connectivity != Connectivity::Online;
        if status.connectivity == Connectivity::AuthRequired {
            let linked = self
                .svc
                .current_session()
                .is_some_and(|s| s.has_device_link());
            self.sign_out(cx);
            self.login.error = Some(if linked {
                Key::DeviceDisconnected
            } else {
                Key::SessionExpired
            });
            return;
        }
        self.update_inbox_connectivity(&status, cx);
        self.refresh_open_report(&status, cx);
        self.refresh_commissions(&status, cx);
        if status.connectivity == Connectivity::Online {
            self.refresh_register_if_changed(cx);
            self.refresh_inventory(reconnected, cx);
            self.refresh_checkout_if_changed(cx);
            self.refresh_waitlist_if_changed(reconnected, cx);
            self.refresh_review_requests(reconnected, cx);
            self.refresh_review_moderation(reconnected, cx);
            self.refresh_staff_portraits(reconnected, cx);
        }
        if self.svc.store.data_version().ok() != self.data_version {
            self.reload(cx);
        } else if minute_changed || self.status != status || self.notices.len() != before {
            self.status = status;
            cx.notify();
        }
        self.refresh_unpaid_if_changed(reconnected, cx);
        self.refresh_sales_history(reconnected, cx);
        self.refresh_salon_configuration(reconnected, cx);
        self.refresh_booking_policy(reconnected, cx);
        self.refresh_staff_access(reconnected, cx);
        self.refresh_open_service_catalog(reconnected, cx);
        self.refresh_service_resources(reconnected, cx);
        self.refresh_resource_pools(cx);
        self.refresh_combinations(cx);
        self.refresh_email_delivery(reconnected, cx);
        self.refresh_marketing(reconnected, cx);
        self.refresh_loyalty(reconnected, cx);
        self.refresh_whatsapp_desk(reconnected, cx);
        if reconnected {
            self.refresh_weekly_conflicts_if_ready(cx);
            self.refresh_open_annotations(true, cx);
            self.refresh_private_record(cx);
        }
        if self.status.connectivity == Connectivity::Online {
            self.refresh_live_intake_forms(reconnected, cx);
            self.refresh_live_intake_history(cx);
        }
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        self.calendar_layout.take();
        // Capture the version before reading the view. A sync commit during the reads must
        // still trigger a refresh on the next tick.
        self.data_version = self.svc.store.data_version().ok();
        let generation = self.svc.store.refresh_reviewed_generation().ok();
        let scope = self.svc.store.get_meta("calendar_scope").ok().flatten();
        if (self.calendar_scope.is_some() && self.calendar_scope != scope)
            || self.replica_generation != generation
        {
            if !self.preserve_open_salon_draft(cx)
                && !self.preserve_open_booking_policy_draft(cx)
                && !self.preserve_open_assignment_draft()
                && !self.preserve_open_staff_access(cx)
                && !self.preserve_open_catalogue()
                && !self.preserve_open_resource_requirements()
                && !self.preserve_open_resource_pools(generation.as_deref())
                && !self.preserve_open_combinations(generation.as_deref())
                && !self.preserve_open_product_form(generation.as_deref())
                && !self.preserve_open_product_photo()
                && !self.preserve_open_inventory_documents()
                && !self.preserve_warehouse_panel()
                && !self.preserve_inventory_classifications()
                && !self.preserve_open_points_policy(cx)
            {
                self.overlay = Overlay::None;
            }
            self.notices.clear();
            self.notice_cursor = self.svc.store.booking_notice_head().unwrap_or_default();
        }
        self.calendar_scope = scope;
        self.replica_generation = generation;
        self.refresh_notices();
        let store = &self.svc.store;
        let previous_time_off_scope = std::mem::take(&mut self.time_off_scope);
        self.time_off_scope = store
            .get_meta("time_off_scope")
            .ok()
            .flatten()
            .unwrap_or_else(|| {
                if self
                    .svc
                    .current_session()
                    .is_some_and(|s| s.role == "owner")
                {
                    "all".into()
                } else {
                    "none".into()
                }
            });
        self.tz = calendar::salon_tz(store).unwrap_or(Tz::UTC);
        if self.pending_local_today && store.salon_settings().ok().flatten().is_some() {
            self.date = Utc::now().with_timezone(&self.tz).date_naive();
            self.pending_local_today = false;
        }
        self.period_views = self
            .calendar_mode
            .period(store, self.date, self.week_layout)
            .unwrap_or_default();
        self.view = if self.calendar_mode == CalendarMode::Day {
            calendar::day_view(store, self.date).ok()
        } else {
            self.period_views
                .iter()
                .find(|day| day.date == self.date)
                .cloned()
        };

        if !self.view.as_ref().is_some_and(|view| {
            view.columns
                .iter()
                .any(|col| col.staff.id == self.week_staff_id)
        }) {
            self.week_staff_id = self
                .view
                .as_ref()
                .and_then(|view| view.columns.first())
                .map(|col| col.staff.id.clone())
                .unwrap_or_default();
        }
        self.status = self.svc.status();
        self.summary = calendar::sync_summary(store).unwrap_or_default();
        self.conflicts = store.conflicts().unwrap_or_default();
        self.clients = calendar::known_clients(store).unwrap_or_default();
        self.client_search_names = self
            .clients
            .iter()
            .map(|(_, name)| name.to_lowercase())
            .collect();
        self.report_staff_options = store.staff_including_inactive().unwrap_or_default();
        self.staff = self
            .report_staff_options
            .iter()
            .filter(|member| member.active)
            .cloned()
            .collect();
        let visible_staff = self.team_calendar_visible().then(|| {
            self.team_calendar_staff()
                .map(|staff| staff.id.clone())
                .collect::<BTreeSet<_>>()
        });
        self.overview_staff.retain(|id| {
            self.staff.iter().any(|member| &member.id == id)
                && visible_staff
                    .as_ref()
                    .is_none_or(|visible| visible.contains(id.as_str()))
        });
        let catalogue = store.services().unwrap_or_default();
        self.service_colors = catalogue
            .iter()
            .filter_map(|service| {
                service
                    .color
                    .as_ref()
                    .map(|color| (service.id.clone(), color.clone()))
            })
            .collect();
        self.refresh_service_assignments(&catalogue);
        self.services = catalogue.into_iter().filter(|s| s.active).collect();
        self.reload_directory();
        self.refresh_client_controls(cx);
        self.reload_team_shifts();
        self.refresh_weekly_conflicts_if_ready(cx);
        self.refresh_open_annotations(previous_time_off_scope != self.time_off_scope, cx);
        cx.notify();
    }

    /// After a local edit: show it now, and tell the worker.
    fn edited(&mut self, cx: &mut Context<Self>) {
        self.svc.wake(Wake::Local);
        self.reload(cx);
    }

    fn shift_day(&mut self, days: i64, cx: &mut Context<Self>) {
        self.pending_local_today = false;
        self.date = self.calendar_mode.shift(self.date, days);
        self.reload(cx);
    }

    fn today(&mut self, cx: &mut Context<Self>) {
        self.date = Utc::now().with_timezone(&self.tz).date_naive();
        self.reload(cx);
    }

    fn set_calendar_mode(&mut self, mode: CalendarMode, cx: &mut Context<Self>) {
        if self.calendar_mode == mode {
            return;
        }
        self.calendar_mode = mode;
        self.reload(cx);
    }

    fn set_week_staff(&mut self, id: String, cx: &mut Context<Self>) {
        self.calendar_layout.take();
        self.week_staff_id = id;
        if self.team_calendar_visible() {
            self.week_layout = team_calendar::WeekLayout::Timeline;
            self.reload(cx);
        } else {
            cx.notify();
        }
    }

    fn set_theme(&mut self, dark: bool, cx: &mut Context<Self>) {
        self.theme_override = Some(dark);
        theme::set_dark(dark);
        if let Err(error) = self.svc.config.save_theme(dark) {
            eprintln!("could not save theme preference: {error}");
        }
        cx.notify();
    }

    fn calendar_columns(&self) -> Vec<(NaiveDate, &calendar::StaffColumn)> {
        if self.team_calendar_visible() {
            self.period_views
                .iter()
                .flat_map(|day| {
                    day.columns
                        .iter()
                        .filter(|column| self.includes_team_calendar_staff(&column.staff.id))
                        .map(|column| (day.date, column))
                })
                .collect()
        } else if self.calendar_mode == CalendarMode::Week {
            self.period_views
                .iter()
                .filter_map(|view| {
                    view.columns
                        .iter()
                        .find(|col| col.staff.id == self.week_staff_id)
                        .map(|col| (view.date, col))
                })
                .collect()
        } else {
            self.view
                .as_ref()
                .map(|view| {
                    view.columns
                        .iter()
                        .filter(|column| self.includes_calendar_staff(&column.staff.id))
                        .map(|col| (view.date, col))
                        .collect()
                })
                .unwrap_or_default()
        }
    }

    // ---------------------------------------------------------------- time helpers

    fn hhmm(&self, dt: DateTime<Utc>) -> String {
        let l = dt.with_timezone(&self.tz);
        format!("{:02}:{:02}", l.hour(), l.minute())
    }

    fn date_time_label(&self, dt: DateTime<Utc>) -> String {
        let l = dt.with_timezone(&self.tz);
        let mut label = format!(
            "{} {}",
            i18n::date_label(self.locale, l.date_naive()),
            self.hhmm(dt)
        );
        if matches!(
            self.tz.from_local_datetime(&l.naive_local()),
            chrono::LocalResult::Ambiguous(_, _)
        ) {
            label.push_str(&l.format(" (UTC%:z)").to_string());
        }
        label
    }

    fn staff_name(&self, id: &str) -> String {
        self.report_staff_options
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.display_name.clone())
            .unwrap_or_default()
    }

    fn appointment_client_name(&self, appointment: &Appointment) -> String {
        self.clients
            .iter()
            .find(|(cid, _)| cid == &appointment.client_id)
            .map(|(_, n)| n.clone())
            .or_else(|| appointment.client_name.clone())
            .unwrap_or_else(|| self.t(Key::UnknownClient).to_owned())
    }

    // ---------------------------------------------------------------- dialogs: new

    fn open_new(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let t = |k| i18n::t(self.locale, k);
        let new_client = cx.new(|cx| TextField::new(t(Key::ClientName), false, cx));
        let new_client_phone = cx.new(|cx| TextField::new(t(Key::ClientPhone), false, cx));
        let notes = cx.new(|cx| TextField::new(t(Key::Notes), false, cx));
        let client_search = cx.new(|cx| TextField::new(t(Key::SearchClients), false, cx));
        let client_search_sub = cx.subscribe(&client_search, |_, _, event, cx| {
            if matches!(event, FieldEvent::Changed) {
                cx.notify();
            }
        });
        let service_search = cx.new(|cx| TextField::new(t(Key::SearchServices), false, cx));
        let service_search_sub = cx.subscribe(&service_search, |this, _, event, cx| {
            if matches!(event, FieldEvent::Changed) {
                if let Overlay::New(form) = &this.overlay {
                    form.service_scroll.set_offset(gpui::point(px(0.), px(0.)));
                }
                cx.notify();
            }
        });
        let _ = window;
        self.overlay = Overlay::New(Box::new(NewForm {
            date: self.date,
            minutes: 10 * 60,
            selected_end: None,
            staff_id: self
                .preferred_calendar_staff()
                .or_else(|| {
                    if self.team_calendar_visible() {
                        None
                    } else {
                        self.staff.first().map(|member| member.id.as_str())
                    }
                })
                .map(str::to_owned),
            services: vec![],
            selected_quotes: Default::default(),
            client_id: None,
            client_search,
            _client_search_sub: client_search_sub,
            service_search,
            _service_search_sub: service_search_sub,
            service_scroll: gpui::ScrollHandle::new(),
            new_client,
            new_client_phone,
            notes,
            recurrence: None,
            series_override: false,
            visit_parts: Vec::new(),
            visit_quotes: Default::default(),
            visit_review: None,
            intake: None,
            error: None,
        }));
        cx.notify();
    }

    /// Choosing a staff member drops selected services they do not perform.
    fn pick_new_staff(&mut self, id: String, cx: &mut Context<Self>) {
        let performed = ops::performed_services(&self.svc.store, &id).unwrap_or_default();
        if let Overlay::New(f) = &mut self.overlay {
            f.services.retain(|s| performed.contains(s));
            f.selected_quotes.retain(|id, _| performed.contains(id));
            f.staff_id = Some(id);
            f.service_scroll.set_offset(gpui::point(px(0.), px(0.)));
        }
        cx.notify();
    }

    fn book(&mut self, cx: &mut Context<Self>) {
        if matches!(&self.overlay, Overlay::New(form) if !form.visit_parts.is_empty()) {
            self.review_grouped_visit(cx);
            return;
        }
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        if form.intake.is_some() {
            return;
        }
        if form.recurrence.is_some()
            && (self.status.connectivity != Connectivity::Online || self.svc.transport().is_none())
        {
            form.error = Some(Key::SeriesOffline);
            cx.notify();
            return;
        }
        let name = form.new_client.read(cx).text().trim().to_owned();
        let phone = form.new_client_phone.read(cx).text().trim().to_owned();
        let notes = form.notes.read(cx).text().trim().to_owned();
        let Some(staff_id) = form.staff_id.clone() else {
            form.error = Some(Key::ErrPickStaff);
            cx.notify();
            return;
        };
        if form.services.is_empty() {
            form.error = Some(Key::ErrPickService);
            cx.notify();
            return;
        }
        if form.services.iter().any(|id| {
            self.services
                .iter()
                .find(|row| &row.id == id)
                .and_then(|row| row.quote_hash.as_ref())
                .is_none()
        }) {
            form.error = Some(Key::ErrRefreshCatalog);
            cx.notify();
            return;
        }
        let Some(starts_at) = salon_local_instant(self.tz, form.date, form.minutes) else {
            form.error = Some(Key::ErrInvalidLocalStart);
            cx.notify();
            return;
        };
        if let Some(end) = form.selected_end {
            let Some(end) =
                salon_local_instant(self.tz, form.date, end).filter(|end| *end > starts_at)
            else {
                form.error = Some(Key::SelectedSlotInvalid);
                cx.notify();
                return;
            };
            let duration: i64 = self
                .services
                .iter()
                .filter(|service| form.services.contains(&service.id))
                .map(|service| service.duration_minutes + service.buffer_minutes)
                .sum();
            if end.signed_duration_since(starts_at).num_minutes() < duration {
                form.error = Some(Key::SelectedSlotTooShort);
                cx.notify();
                return;
            }
        }
        if form.client_id.is_none() && name.is_empty() {
            form.error = Some(Key::ErrPickClient);
            cx.notify();
            return;
        }
        let (services, chosen) = (form.services.clone(), form.client_id.clone());
        let has_client = chosen.is_some();
        let booking = NewAppointment {
            staff_id,
            service_ids: services,
            starts_at,
            client_id: chosen.unwrap_or_default(),
            notes: (!notes.is_empty()).then_some(notes),
            override_notice: form.recurrence.is_some() && form.series_override,
        };
        if self.status.connectivity == Connectivity::Online && self.svc.transport().is_some() {
            let inline = (!has_client)
                .then_some((name.as_str(), (!phone.is_empty()).then_some(phone.as_str())));
            match sob_core::booking::BookingTerms::prepare(&self.svc.store, booking, inline) {
                Ok(terms)
                    if terms.service_ids().iter().all(|id| {
                        form.selected_quotes
                            .get(id)
                            .is_some_and(|shown| terms.matches_service_quote(id, shown))
                    }) =>
                {
                    self.start_booking_intake(terms, cx)
                }
                Ok(_) => {
                    form.error = Some(Key::ErrRefreshCatalog);
                    self.svc.wake(Wake::Manual);
                    cx.notify();
                }
                Err(error) => self.show_new_booking_error(error, cx),
            }
            return;
        }
        let result = if has_client {
            ops::create_appointment(&mut self.svc.store, booking)
        } else {
            ops::create_appointment_for_new_client(
                &mut self.svc.store,
                booking,
                &name,
                (!phone.is_empty()).then_some(phone.as_str()),
            )
        };
        match result {
            Ok(_) => self.finish_new_booking(starts_at, cx),
            Err(error) => self.show_new_booking_error(error, cx),
        }
    }

    fn finish_new_booking(&mut self, starts_at: DateTime<Utc>, cx: &mut Context<Self>) {
        self.overlay = Overlay::None;
        self.date = starts_at.with_timezone(&self.tz).date_naive();
        self.edited(cx);
    }

    fn show_new_booking_error(&mut self, error: CoreError, cx: &mut Context<Self>) {
        if matches!(
            error,
            CoreError::PendingClient | CoreError::CalendarGenerationChanged
        ) {
            self.svc.wake(Wake::Manual);
        }
        if let Overlay::New(form) = &mut self.overlay {
            form.error = Some(match error {
                CoreError::TimeOffOverlap => Key::TimeOffOverlap,
                CoreError::StaffCapacityExceeded => Key::ConflictSlotTaken,
                CoreError::PendingClient => Key::BookingIntakeClientSync,
                CoreError::CalendarGenerationChanged => Key::BookingIntakeRestore,
                CoreError::IncompatibleServices => Key::ErrIncompatibleServices,
                CoreError::CatalogueEditPending => Key::ErrCatalogueEditPending,
                _ => Key::ErrGeneric,
            });
        }
        cx.notify();
    }

    // ---------------------------------------------------------------- dialogs: details

    fn open_details(&mut self, id: &str, cx: &mut Context<Self>) {
        let Ok(Some(a)) = calendar::effective_appointment(&self.svc.store, id) else {
            return;
        };
        self.show_appointment_details(a, None, cx);
    }

    fn show_appointment_details(
        &mut self,
        a: Appointment,
        return_to: Option<AppointmentReturn>,
        cx: &mut Context<Self>,
    ) {
        let synced = a.version > 0;
        self.overlay = Overlay::Details(Box::new(Details {
            return_to,
            id: a.id.clone(),
            reviewed: (&a).into(),
            start: a.starts_at,
            staff_id: a.staff_id,
            confirm_cancel: false,
            error: None,
            price_review: None,
            settlement_review: None,
            checkout: None,
            annotations: None,
            annotations_requested_version: None,
        }));
        if synced {
            self.open_annotations(cx);
        } else {
            cx.notify();
        }
    }

    fn close_appointment_details(&mut self, edited_appointment: bool) {
        let Overlay::Details(details) = &mut self.overlay else {
            return;
        };
        self.overlay = match details.return_to.take() {
            Some(AppointmentReturn::TeamShifts(mut desk)) => {
                if edited_appointment {
                    desk.appointment_edited(&details.id);
                }
                Overlay::TeamShifts(desk)
            }
            Some(AppointmentReturn::Unpaid(mut desk)) => {
                desk.needs_refresh = true;
                Overlay::Unpaid(desk)
            }
            Some(AppointmentReturn::Conflict(_)) => Overlay::Conflicts {
                editing: None,
                error: None,
            },
            None => Overlay::None,
        };
        self.reload_team_shifts();
    }

    fn apply_move(&mut self, cx: &mut Context<Self>) {
        let Overlay::Details(d) = &mut self.overlay else {
            return;
        };
        let start = (d.start != d.reviewed.starts_at).then_some(d.start);
        let staff = (d.staff_id != d.reviewed.staff_id).then(|| d.staff_id.clone());
        let result = ops::queue_reviewed_appointment_edit(
            &mut self.svc.store,
            &d.id,
            &d.reviewed,
            ops::AppointmentEdit::Move {
                starts_at: start,
                staff_id: staff.as_deref(),
            },
            d.conflict_to_resolve(),
        );
        self.finish_appointment_edit(result, cx);
    }

    fn review_updated_appointment(&mut self, cx: &mut Context<Self>) {
        let Overlay::Details(d) = &mut self.overlay else {
            return;
        };
        let Ok(Some(current)) = calendar::effective_appointment(&self.svc.store, &d.id) else {
            return;
        };
        if d.start == d.reviewed.starts_at {
            d.start = current.starts_at;
        }
        if d.staff_id == d.reviewed.staff_id {
            d.staff_id = current.staff_id.clone();
        }
        d.reviewed = (&current).into();
        d.confirm_cancel = false;
        d.error = None;
        cx.notify();
    }

    fn cancel_appointment(&mut self, cx: &mut Context<Self>) {
        let Overlay::Details(d) = &mut self.overlay else {
            return;
        };
        if !d.confirm_cancel {
            d.confirm_cancel = true;
            cx.notify();
            return;
        }
        let result = ops::queue_reviewed_appointment_edit(
            &mut self.svc.store,
            &d.id,
            &d.reviewed,
            ops::AppointmentEdit::Cancel,
            d.conflict_to_resolve(),
        );
        self.finish_appointment_edit(result, cx);
    }

    fn set_outcome(
        &mut self,
        status: AppointmentStatus,
        now: DateTime<Utc>,
        cx: &mut Context<Self>,
    ) {
        let Overlay::Details(d) = &mut self.overlay else {
            return;
        };
        let result = ops::queue_reviewed_appointment_edit(
            &mut self.svc.store,
            &d.id,
            &d.reviewed,
            ops::AppointmentEdit::Outcome { status, now },
            d.conflict_to_resolve(),
        );
        self.finish_appointment_edit(result, cx);
    }

    fn finish_appointment_edit(
        &mut self,
        result: sob_core::error::Result<()>,
        cx: &mut Context<Self>,
    ) {
        match result {
            Ok(()) => {
                self.close_appointment_details(true);
                self.edited(cx);
            }
            Err(error) => {
                let message = match error {
                    CoreError::TimeOffOverlap => self.t(Key::TimeOffOverlap).to_owned(),
                    CoreError::StaffCapacityExceeded => self.t(Key::ConflictSlotTaken).to_owned(),
                    CoreError::AppointmentChanged => self.t(Key::AppointmentChanged).to_owned(),
                    other => other.to_string(),
                };
                if let Overlay::Details(d) = &mut self.overlay {
                    d.error = Some(message);
                    cx.notify();
                }
            }
        }
    }

    // ---------------------------------------------------------------- dialogs: conflicts

    fn resolve(&mut self, mutation_id: &str, resolution: Resolution, cx: &mut Context<Self>) {
        match ops::resolve_conflict(&mut self.svc.store, mutation_id, resolution) {
            Ok(()) => {
                self.overlay = Overlay::Conflicts {
                    editing: None,
                    error: None,
                };
                self.edited(cx);
            }
            Err(e) => {
                let message = match e {
                    CoreError::TimeOffOverlap => self.t(Key::TimeOffOverlap).to_owned(),
                    CoreError::StaffCapacityExceeded => self.t(Key::ConflictSlotTaken).to_owned(),
                    other => other.to_string(),
                };
                if let Overlay::Conflicts { error, .. } = &mut self.overlay {
                    *error = Some(message);
                }
                cx.notify();
            }
        }
    }

    fn start_conflict_edit(&mut self, c: &Conflict, cx: &mut Context<Self>) {
        if c.kind != "appointment.create" {
            let appointment_changed = self.t(Key::AppointmentChanged);
            let Ok(Some(current)) = calendar::effective_appointment(&self.svc.store, &c.entity_id)
            else {
                if let Overlay::Conflicts { error, .. } = &mut self.overlay {
                    *error = Some(appointment_changed.into());
                }
                cx.notify();
                return;
            };
            self.show_appointment_details(
                current,
                Some(AppointmentReturn::Conflict(c.mutation_id.clone())),
                cx,
            );
            if c.kind == "appointment.reschedule"
                && let Overlay::Details(d) = &mut self.overlay
            {
                if let Some(start) = conflict_requested_start(c) {
                    d.start = start;
                }
                if let Some(staff) = c.payload.get("staffId").and_then(|value| value.as_str()) {
                    d.staff_id = staff.into();
                }
            }
            cx.notify();
            return;
        }
        let start = conflict_requested_start(c).unwrap_or_else(Utc::now);
        let staff_id = c
            .payload
            .get("staffId")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .or_else(|| self.staff.first().map(|s| s.id.clone()))
            .unwrap_or_default();
        self.overlay = Overlay::Conflicts {
            editing: Some(ConflictDraft {
                mutation_id: c.mutation_id.clone(),
                start,
                staff_id,
            }),
            error: None,
        };
        cx.notify();
    }

    fn conflict_reason(&self, reason: &str) -> &'static str {
        self.t(match reason {
            "slot_taken" => Key::ConflictSlotTaken,
            "slot_unavailable" => Key::ConflictSlotUnavailable,
            "conflict" => Key::ConflictStale,
            "not_found" => Key::ConflictNotFound,
            "invalid_state" => Key::ConflictInvalidState,
            "sync_generation_changed" => Key::ConflictRestoredHistory,
            "intake_required" => Key::ConflictIntakeRequired,
            "booking_intent_conflict" => Key::ConflictBookingIntent,
            "forbidden" => Key::ConflictForbidden,
            _ => Key::ConflictInvalid,
        })
    }

    // ---------------------------------------------------------------- widgets

    fn button(
        &self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        kind: Kind,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Stateful<gpui::Div> {
        let (bg, fg, hover, border) = match kind {
            Kind::Primary => (
                theme::accent(),
                theme::on_accent(),
                theme::accent_hover(),
                theme::accent(),
            ),
            Kind::Ghost => (
                theme::panel(),
                theme::text(),
                theme::accent_soft(),
                theme::line(),
            ),
            Kind::Danger => (
                theme::panel(),
                theme::conflict_fg(),
                theme::conflict_bg(),
                theme::conflict_fg(),
            ),
        };
        div()
            .id(id)
            .flex()
            .items_center()
            .justify_center()
            .h(px(34.))
            .px_3()
            .rounded_md()
            .border_1()
            .border_color(border)
            .bg(bg)
            .text_color(fg)
            .text_sm()
            .font_weight(FontWeight::MEDIUM)
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(on_click)
            .child(label.into())
    }

    fn chip(
        &self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        selected: bool,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Stateful<gpui::Div> {
        div()
            .id(id)
            .px_3()
            .h(px(30.))
            .flex()
            .items_center()
            .rounded_full()
            .border_1()
            .border_color(if selected {
                theme::accent()
            } else {
                theme::line()
            })
            .bg(if selected {
                theme::accent_soft()
            } else {
                theme::panel()
            })
            .text_color(if selected {
                theme::accent()
            } else {
                theme::text()
            })
            .text_sm()
            .cursor_pointer()
            .hover(|s| s.bg(theme::accent_soft()))
            .on_click(on_click)
            .child(label.into())
    }

    fn badge(&self, label: &str, fg: gpui::Rgba, bg: gpui::Rgba) -> gpui::Div {
        div()
            .px_2()
            .h(px(20.))
            .flex()
            .items_center()
            .rounded_full()
            .bg(bg)
            .text_color(fg)
            .text_xs()
            .font_weight(FontWeight::MEDIUM)
            .child(SharedString::from(label.to_owned()))
    }

    fn service_indicators(&self, badge: &CalendarServiceBadge) -> gpui::Div {
        div().flex().flex_wrap().gap_1().children(
            appointment_badges::service(badge)
                .into_iter()
                .flatten()
                .map(|badge| badge.chip(self.t(badge.1), false)),
        )
    }

    fn label(&self, key: Key) -> gpui::Div {
        div()
            .text_xs()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(theme::muted())
            .child(self.t(key))
    }

    // ---------------------------------------------------------------- render: login

    fn render_login(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let t = |k| self.t(k);
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(theme::bg())
            .child(
                div()
                    .w(px(380.))
                    .p_6()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme::line())
                    .bg(theme::panel())
                    .child(
                        div()
                            .text_xl()
                            .font_weight(FontWeight::BOLD)
                            .text_color(theme::accent())
                            .child(t(Key::AppTitle)),
                    )
                    .child(
                        div()
                            .text_color(theme::muted())
                            .text_sm()
                            .child(t(Key::BrowserSignInHelp)),
                    )
                    .when_some(self.login.error, |d, e| {
                        d.child(div().text_sm().text_color(theme::conflict_fg()).child(t(e)))
                    })
                    .child(
                        self.button(
                            "sign-in",
                            if self.login.busy {
                                t(Key::BrowserSignInWaiting)
                            } else {
                                t(Key::BrowserSignIn)
                            },
                            Kind::Primary,
                            cx.listener(|this, _, _, cx| this.submit_login(cx)),
                        )
                        .mt_2(),
                    )
                    .when(self.login.busy, |d| {
                        d.child(self.button(
                            "cancel-browser-login",
                            t(Key::Cancel),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| this.cancel_browser_login(cx)),
                        ))
                    })
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_xs()
                                    .text_color(theme::muted())
                                    .child(SharedString::from(self.svc.config.api_url.clone())),
                            )
                            .when(!self.svc.config.api_url_locked && !self.login.busy, |d| {
                                d.child(self.button(
                                    "login-server",
                                    t(Key::ChangeServer),
                                    Kind::Ghost,
                                    cx.listener(|this, _, window, cx| {
                                        this.open_server_editor(window, cx)
                                    }),
                                ))
                            }),
                    ),
            )
            .into_any_element()
    }

    // ---------------------------------------------------------------- render: main

    fn status_cluster(&self, cx: &mut Context<Self>) -> gpui::Div {
        let s = &self.status;
        let (dot, label) = match s.connectivity {
            Connectivity::Online => (theme::online(), Key::Online),
            Connectivity::Offline => (theme::offline(), Key::Offline),
            Connectivity::Connecting => (theme::warn(), Key::Connecting),
            Connectivity::AuthRequired => (theme::conflict_fg(), Key::SessionExpired),
        };
        let detail = if s.syncing {
            self.t(Key::Syncing).to_owned()
        } else if let Some(wait) = s
            .retry_in
            .filter(|_| s.connectivity == Connectivity::Offline)
        {
            i18n::fill(
                self.t(Key::RetryIn),
                &[("n", &wait.as_secs().max(1).to_string())],
            )
        } else if let Some(at) = s.last_sync_at {
            i18n::fill(self.t(Key::LastSync), &[("time", &self.hhmm(at))])
        } else {
            self.t(Key::NeverSynced).to_owned()
        };
        let pending = self.summary.pending;
        let conflicts = self.summary.conflicts;
        div()
            .flex()
            .items_center()
            .gap_3()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(div().size(px(10.)).rounded_full().bg(dot))
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child(self.t(label)),
                    ),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme::muted())
                    .child(SharedString::from(detail)),
            )
            .child(if pending > 0 {
                self.badge(
                    &i18n::fill(self.t(Key::PendingCount), &[("n", &pending.to_string())]),
                    theme::pending_fg(),
                    theme::pending_bg(),
                )
            } else {
                self.badge(self.t(Key::AllSynced), theme::muted(), theme::line_soft())
            })
            .when(conflicts > 0, |d| {
                d.child(
                    div()
                        .id("conflict-badge")
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.overlay = Overlay::Conflicts {
                                editing: None,
                                error: None,
                            };
                            cx.notify();
                        }))
                        .child(self.badge(
                            &i18n::fill(
                                self.t(Key::ConflictCount),
                                &[("n", &conflicts.to_string())],
                            ),
                            theme::conflict_fg(),
                            theme::conflict_bg(),
                        )),
                )
            })
            .child(self.button(
                "sync-now",
                self.t(Key::SyncNow),
                Kind::Ghost,
                cx.listener(|this, _, _, _| this.svc.wake(Wake::Manual)),
            ))
    }

    fn cloud_calendar_url(&self) -> Option<url::Url> {
        let origin = self.svc.config.network_origin();
        let mut link = url::Url::parse(&origin)
            .ok()?
            .join("/admin/calendar")
            .ok()?;
        let mut query = link.query_pairs_mut();
        query
            .append_pair("date", &self.date.to_string())
            .append_pair("view", self.calendar_mode.route_name());
        if self.calendar_mode == CalendarMode::Week
            && !self.team_calendar_visible()
            && !self.week_staff_id.is_empty()
        {
            query.append_pair("staff", &self.week_staff_id);
        } else if !self.overview_staff.is_empty() {
            query.append_pair(
                "staff",
                &self
                    .overview_staff
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        drop(query);
        Some(link)
    }

    fn render_header(&self, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .min_h(px(60.))
            .py_2()
            .px_4()
            .border_b_1()
            .border_color(theme::line())
            .bg(theme::panel())
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::BOLD)
                    .text_color(theme::accent())
                    .child(self.t(Key::AppTitle)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(self.button(
                        "prev",
                        "<",
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| this.shift_day(-1, cx)),
                    ))
                    .child(self.button(
                        "today",
                        self.t(Key::Today),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| this.today(cx)),
                    ))
                    .child(self.button(
                        "next",
                        ">",
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| this.shift_day(1, cx)),
                    ))
                    .child(self.calendar_date_button(cx)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .children(CalendarMode::ALL.map(|mode| {
                        self.button(
                            mode.button_id(),
                            self.t(mode.label()),
                            if self.calendar_mode == mode {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |this, _, _, cx| this.set_calendar_mode(mode, cx)),
                        )
                        .px_2()
                    })),
            )
            .when(self.cloud_calendar_url().is_some(), |d| {
                d.child(
                    self.button(
                        "open-cloud-management",
                        self.t(Key::CloudManagement),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| this.open_web_management(cx)),
                    )
                    .gap_2()
                    .child(appointment_badges::Icon::External.element(theme::muted())),
                )
            })
            .child(div().flex_1())
            .child(self.status_cluster(cx))
            .when(self.directory_enabled(), |d| {
                d.child(self.button(
                    "directory",
                    self.t(Key::ClientDirectory),
                    Kind::Ghost,
                    cx.listener(|this, _, _, cx| this.open_directory(cx)),
                ))
            })
            .child(self.button(
                "waitlist",
                self.t(Key::Waitlist),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| this.open_waitlist(true, 1, cx)),
            ))
            .child(self.button(
                "cash-register",
                self.t(Key::CashRegister),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| this.load_register(cx)),
            ))
            .child(self.button(
                "inventory",
                self.t(Key::Inventory),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| this.open_inventory(cx)),
            ))
            .child(self.button(
                "reports",
                self.t(Key::Reports),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| this.open_reports(cx)),
            ))
            .child(
                self.button(
                    "team-shifts",
                    self.t(Key::TeamShifts),
                    Kind::Ghost,
                    cx.listener(|this, _, _, cx| this.open_team_shifts(cx)),
                )
                .debug_selector(|| "team-shifts".to_owned()),
            )
            .child(self.button(
                "staff-portraits",
                self.t(Key::StaffPortraits),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| this.open_staff_portraits(cx)),
            ))
            .child(self.button(
                "review-requests",
                self.t(Key::Reputation),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| this.open_review_requests(cx)),
            ))
            .child(self.button(
                "calendar-inbox",
                self.t(Key::CalendarInbox),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| this.open_inbox(false, 1, cx)),
            ))
            .child(self.button(
                "toggle-theme",
                self.t(if theme::is_dark() {
                    Key::ThemeLight
                } else {
                    Key::ThemeDark
                }),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| this.set_theme(!theme::is_dark(), cx)),
            ))
            .child(self.button(
                "new",
                self.t(Key::NewAppointment),
                Kind::Primary,
                cx.listener(|this, _, window, cx| this.open_new(window, cx)),
            ))
            .when(
                self.staff
                    .iter()
                    .any(|staff| staff.active && self.can_manage_block(staff)),
                |d| {
                    d.child(self.button(
                        "new-time-off",
                        self.t(Key::BlockTime),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| this.open_block(None, this.date, cx)),
                    ))
                },
            )
            .when(
                self.calendar_columns()
                    .iter()
                    .any(|(_, col)| !col.blocks.is_empty()),
                |d| {
                    d.child(self.button(
                        "list-time-off",
                        self.t(Key::TimeOffList),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| {
                            this.overlay = Overlay::Blocks;
                            cx.notify();
                        }),
                    ))
                },
            )
            .when(!self.svc.config.api_url_locked, |d| {
                d.child(self.button(
                    "change-server",
                    self.t(Key::ServerUrl),
                    Kind::Ghost,
                    cx.listener(|this, _, window, cx| this.open_server_editor(window, cx)),
                ))
            })
            .when(self.disconnect_failed, |d| {
                d.child(
                    div()
                        .text_sm()
                        .text_color(theme::conflict_fg())
                        .child(self.t(Key::DeviceDisconnectFailed)),
                )
            })
            .child(self.button(
                "sign-out",
                self.t(if self.disconnecting {
                    Key::DeviceDisconnecting
                } else {
                    Key::SignOut
                }),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| this.request_sign_out(cx)),
            ))
    }

    fn visible_hours(&self, view: &DayView) -> (u32, u32) {
        let (mut first, mut last) = (8u32, 20u32);
        for col in &view.columns {
            for block in &col.blocks {
                let (start, end) = blocks::wall_minutes(&block.time_off, view.date, self.tz);
                if start != 0 || end != 1440 {
                    first = first.min(start / 60);
                    last = last.max(end.div_ceil(60));
                }
            }
            for item in &col.items {
                let s = item.appointment.starts_at.with_timezone(&self.tz);
                let e = item.appointment.ends_at.with_timezone(&self.tz);
                if s.date_naive() == view.date {
                    first = first.min(s.hour());
                }
                let end_h = if e.date_naive() == view.date {
                    e.hour() + u32::from(e.minute() > 0)
                } else {
                    24
                };
                last = last.max(end_h.min(24));
            }
        }
        (first, last.max(first + 1))
    }

    fn calendar_item_colors(&self, item: &CalendarItem) -> (gpui::Rgba, gpui::Rgba) {
        if item.conflict {
            (theme::conflict_bg(), theme::conflict_fg())
        } else if item.pending {
            (theme::pending_bg(), theme::warn())
        } else if let Some(service) = item.appointment.services.first() {
            let color = service
                .service_id
                .as_ref()
                .and_then(|id| self.service_colors.get(id));
            theme::service_color(color.map(String::as_str), &service.name)
        } else {
            (theme::accent_soft(), theme::accent())
        }
    }

    fn render_block(
        &self,
        item: &CalendarItem,
        (start, end): (f32, f32),
        (lane, lane_count): (usize, usize),
        first_hour: u32,
        total_h: f32,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let a = &item.appointment;
        let top = start - first_hour as f32 * HOUR_PX;
        let (bg, edge) = self.calendar_item_colors(item);
        let id = a.id.clone();
        let services = a
            .services
            .iter()
            .map(|s| s.name.clone())
            .collect::<Vec<_>>()
            .join(", ");
        let indicators = appointment_badges::calendar(item);
        let card = div()
            .id(SharedString::from(format!("appt-{}", a.id)))
            .debug_selector(|| format!("calendar-appointment-{}", a.id))
            .h_full()
            .px_2()
            .py_1()
            .overflow_hidden()
            .rounded_md()
            .border_l_4()
            .border_color(edge)
            .bg(bg)
            .text_xs()
            .cursor_pointer()
            .hover(|s| s.opacity(0.85))
            .on_click(cx.listener(move |this, _, _, cx| {
                if matches!(this.overlay, Overlay::None) {
                    this.open_details(&id, cx);
                }
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_1()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .font_weight(FontWeight::SEMIBOLD)
                            .truncate()
                            .child(SharedString::from(item.client_name.clone())),
                    )
                    .when(indicators.iter().any(Option::is_some), |d| {
                        d.child(
                            div()
                                .flex()
                                .flex_none()
                                .flex_wrap()
                                .h(px(16.))
                                .max_w(relative(0.65))
                                .overflow_hidden()
                                .gap(px(2.))
                                .children(
                                    indicators
                                        .into_iter()
                                        .flatten()
                                        .map(|badge| badge.chip(self.t(badge.1), true)),
                                ),
                        )
                    }),
            )
            .child(
                div()
                    .text_color(theme::text())
                    .truncate()
                    .child(SharedString::from(format!(
                        "{}-{}  {}",
                        self.hhmm(a.starts_at),
                        self.hhmm(a.ends_at),
                        services
                    ))),
            )
            .when(a.services.iter().any(|s| s.processing.is_some()), |d| {
                let minutes: i64 = a
                    .services
                    .iter()
                    .filter_map(|s| s.processing.as_ref().map(|p| p.minutes))
                    .sum();
                d.child(div().text_xs().text_color(theme::text()).truncate().child(
                    SharedString::from(i18n::fill(
                        self.t(Key::ProcessingDuration),
                        &[("minutes", &minutes.to_string())],
                    )),
                ))
            });
        div()
            .absolute()
            .top(relative(top / total_h))
            .left(relative(lane as f32 / lane_count as f32))
            .w(relative(1.0 / lane_count as f32))
            .h(relative((end - start) / total_h))
            .px(px(3.0))
            .child(card)
            .into_any_element()
    }

    fn render_calendar(
        &self,
        viewport_height: gpui::Pixels,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let Some(view) = &self.view else {
            return div().into_any_element();
        };
        if view.columns.is_empty() {
            return div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .text_color(theme::muted())
                .child(self.t(Key::NoStaff))
                .into_any_element();
        }
        let visible_columns = self.calendar_columns();
        let CalendarLayout {
            first,
            last,
            columns_width,
            columns: layouts,
        } = self.calendar_layout.get_or_init(|| {
            let (first, last) = if self.calendar_mode == CalendarMode::Week {
                self.period_views
                    .iter()
                    .map(|view| self.visible_hours(view))
                    .fold((8, 20), |(a, b), (c, d)| (a.min(c), b.max(d)))
            } else {
                self.visible_hours(view)
            };
            let columns: Vec<_> = visible_columns
                .iter()
                .map(|(date, column)| {
                    let bounds: Vec<_> = column
                        .items
                        .iter()
                        .map(|item| appointment_bounds(item, *date, self.tz))
                        .collect();
                    let lanes = appointment_lanes(&bounds);
                    let width =
                        lanes.iter().map(|&(_, count)| count).max().unwrap_or(1) as f32 * 104.0;
                    CalendarColumnLayout {
                        bounds,
                        lanes,
                        width: width.max(160.0),
                    }
                })
                .collect();
            let columns_width = columns.iter().map(|layout| layout.width).sum();
            CalendarLayout {
                first,
                last,
                columns_width,
                columns,
            }
        });
        let (first, last) = (*first, *last);
        let total_h = (last - first) as f32 * HOUR_PX;
        // Keep an hour of cards beyond the viewport. Lane placement still uses the whole column.
        let height = f32::from(viewport_height);
        let handle = &self.vertical_scroll.handle;
        let last_body_height = f32::from(handle.bounds().size.height).min(height);
        let scroll_y =
            (-f32::from(handle.offset().y)).clamp(0., (total_h - last_body_height).max(0.));
        let visible_start = first as f32 * HOUR_PX + scroll_y;
        let visible_end = visible_start + height;
        let local_now = self.calendar_now.with_timezone(&self.tz);
        let today = local_now.date_naive();
        let minute = local_now.hour() * 60 + local_now.minute();
        let time_position = (first * 60..last * 60)
            .contains(&minute)
            .then(|| relative((minute - first * 60) as f32 / ((last - first) * 60) as f32));
        let hours = div()
            .w(px(GUTTER_PX))
            .flex_none()
            .relative()
            .h_full()
            .min_h(px(total_h))
            .children((first..last).map(|h| {
                div()
                    .absolute()
                    .debug_selector(|| format!("calendar-hour-{h}"))
                    .top(relative((h - first) as f32 / (last - first) as f32))
                    .mt(px(if h == first { 1. } else { -7. }))
                    .right(px(8.))
                    .text_xs()
                    .text_color(theme::muted())
                    .child(SharedString::from(format!("{h:02}:00")))
            }))
            .when_some(
                time_position.filter(|_| visible_columns.iter().any(|(date, _)| *date == today)),
                |rail, top| {
                    rail.child(
                        div()
                            .absolute()
                            .debug_selector(|| "calendar-now-label".to_string())
                            .top(top)
                            .mt(px(-9.))
                            .right(px(2.))
                            .px_1()
                            .rounded_sm()
                            .bg(theme::conflict_fg())
                            .text_color(theme::conflict_bg())
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(local_now.format("%H:%M").to_string()),
                    )
                },
            );
        let selected_slot = self
            .slot_drag
            .as_ref()
            .and_then(|drag| drag.selection(self.vertical_scroll.handle.offset().y));
        let root = cx.entity().downgrade();
        let columns = visible_columns
            .iter()
            .enumerate()
            .map(|(index, (date, col))| {
                let CalendarColumnLayout {
                    bounds,
                    lanes,
                    width,
                } = &layouts[index];
                let weak = root.clone();
                let preview = selected_slot
                    .as_ref()
                    .filter(|slot| slot.date == *date && slot.staff_id == col.staff.id);
                div()
                    .debug_selector(|| format!("calendar-col-{index}"))
                    .flex_1()
                    .min_w(px(*width))
                    .relative()
                    .h_full()
                    .border_l_1()
                    .border_color(theme::line())
                    .child(
                        gpui::canvas(
                            |_, _, _| (),
                            move |bounds, (), window, _| {
                                let clip = window.content_mask().bounds;
                                let weak = weak.clone();
                                window.on_mouse_event(
                                    move |event: &gpui::MouseDownEvent, phase, _, app| {
                                        if phase.bubble()
                                            && bounds.contains(&event.position)
                                            && clip.contains(&event.position)
                                        {
                                            let _ = weak.update(app, |root, _| {
                                                root.start_slot_drag(
                                                    index, bounds, first, last, event,
                                                )
                                            });
                                        }
                                    },
                                );
                                for hour in first..last {
                                    let y = bounds.top()
                                        + bounds.size.height
                                            * ((hour - first) as f32 / (last - first) as f32);
                                    if y >= clip.top() && y < clip.bottom() {
                                        window.paint_quad(gpui::fill(
                                            gpui::Bounds::new(
                                                gpui::point(bounds.left(), y),
                                                gpui::size(bounds.size.width, px(1.)),
                                            ),
                                            theme::line_soft(),
                                        ));
                                    }
                                }
                            },
                        )
                        .absolute()
                        .size_full(),
                    )
                    .when_some(preview, |column, slot| {
                        column.child(
                            div()
                                .absolute()
                                .debug_selector(|| "calendar-slot-selection".to_string())
                                .top(relative(
                                    (slot.start - i64::from(first) * 60) as f32 / total_h * HOUR_PX
                                        / 60.,
                                ))
                                .h(relative(
                                    (slot.end - slot.start) as f32 / total_h * HOUR_PX / 60.,
                                ))
                                .left_0()
                                .right_0()
                                .bg(theme::accent_soft())
                                .border_1()
                                .border_color(theme::accent()),
                        )
                    })
                    .children(
                        col.blocks
                            .iter()
                            .map(|block| self.render_time_off(block, *date, first, last, cx)),
                    )
                    .children(
                        col.items
                            .iter()
                            .zip(bounds.iter().copied().zip(lanes.iter().copied()))
                            .filter(|(_, ((start, end), _))| {
                                *end >= visible_start - HOUR_PX && *start <= visible_end + HOUR_PX
                            })
                            .map(|(item, (bounds, lanes))| {
                                self.render_block(item, bounds, lanes, first, total_h, cx)
                            }),
                    )
                    .when_some(time_position.filter(|_| *date == today), |column, top| {
                        column.child(
                            div()
                                .debug_selector(|| format!("calendar-now-line-{date}-{index}"))
                                .absolute()
                                .top(top)
                                .left_0()
                                .right_0()
                                .h(px(2.))
                                .bg(theme::conflict_fg()),
                        )
                    })
            });
        let heads = visible_columns
            .iter()
            .enumerate()
            .map(|(index, (date, col))| {
                div()
                    .debug_selector(|| format!("calendar-head-{index}"))
                    .flex_1()
                    .min_w(px(layouts[index].width))
                    .h(px(36.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .border_l_1()
                    .border_color(theme::line())
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(SharedString::from(
                        if self.calendar_mode == CalendarMode::Week {
                            format!(
                                "{} {}",
                                i18n::weekday_short(self.locale, date.weekday()),
                                date.format("%d/%m")
                            )
                        } else {
                            col.staff.display_name.clone()
                        },
                    ))
                    .when(col.staff.max_concurrent > 1, |d| {
                        d.child(div().ml_1().text_xs().text_color(theme::muted()).child(
                            SharedString::from(i18n::fill(
                                self.t(Key::ConcurrentClients),
                                &[("n", &col.staff.max_concurrent.to_string())],
                            )),
                        ))
                    })
            });
        let mut time_view = div()
            .id("calendar-scroll")
            .debug_selector(|| "calendar-scroll".to_string())
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.vertical_scroll.handle)
            .bg(theme::panel())
            .child(
                div()
                    .h_full()
                    .min_h(px(total_h))
                    .flex_none()
                    .flex()
                    .children(columns),
            );
        time_view.style().restrict_scroll_to_axis = Some(true);
        let mut days_view = div()
            .id("calendar-horizontal-scroll")
            .flex_1()
            .min_w_0()
            .min_h_0()
            .overflow_x_scroll()
            .track_scroll(&self.horizontal_scroll.handle)
            .child(
                div()
                    .w_full()
                    .h_full()
                    .min_w(px(*columns_width))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .border_b_1()
                            .border_color(theme::line())
                            .bg(theme::panel())
                            .children(heads),
                    )
                    .child(time_view),
            );
        days_view.style().restrict_scroll_to_axis = Some(true);
        // The time labels and calendar have identical vertical viewports. Sharing their offset
        // keeps the labels aligned even when the wheel is over the fixed left rail.
        let mut hour_view = div()
            .id("calendar-hours-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.vertical_scroll.handle)
            .child(hours);
        hour_view.style().restrict_scroll_to_axis = Some(true);
        let hour_rail = div()
            .debug_selector(|| "calendar-hour-rail".to_string())
            .flex()
            .flex_col()
            .flex_none()
            .w(px(GUTTER_PX))
            .min_h_0()
            .bg(theme::panel())
            .child(
                div()
                    .flex_none()
                    .h(px(37.))
                    .border_b_1()
                    .border_color(theme::line()),
            )
            .child(hour_view);
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(hour_rail)
                    .child(days_view)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_none()
                            .w(px(scrollbar::WIDTH))
                            .child(div().flex_none().h(px(37.)))
                            .child(self.vertical_scroll.render(scrollbar::Axis::Vertical, cx)),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .pl(px(GUTTER_PX))
                    .pr(px(scrollbar::WIDTH))
                    .child(
                        self.horizontal_scroll
                            .render(scrollbar::Axis::Horizontal, cx),
                    ),
            )
            .into_any_element()
    }

    // ---------------------------------------------------------------- render: overlays

    fn dismiss_overlay(&mut self, cx: &mut Context<Self>) {
        if let Overlay::Directory(desk) = &mut self.overlay
            && desk.close_group_picker()
        {
            cx.notify();
            return;
        }
        if self.saving_service_annotations() {
            return;
        }
        if self.dismiss_inventory_document_panel(cx) {
            return;
        }
        if self.dismiss_sales_history(cx) {
            return;
        }
        match &mut self.overlay {
            Overlay::None => return,
            Overlay::New(form)
                if form
                    .intake
                    .as_ref()
                    .is_some_and(booking_intake::BookingReview::blocks_dismissal) =>
            {
                return;
            }
            Overlay::New(form)
                if form
                    .visit_review
                    .as_ref()
                    .is_some_and(|review| review.blocks_dismissal()) =>
            {
                return;
            }
            Overlay::WalkIn(sale) if !sale.can_dismiss() => return,
            Overlay::WalkInReceipt(review) if !review.can_go_back() => return,
            Overlay::WalkIn(_) | Overlay::WalkInReceipt(_) => {
                self.load_register(cx);
                return;
            }
            Overlay::IntakeForms(_) => self.close_intake_forms(cx),
            Overlay::SalonConfiguration(_) => self.close_salon_configuration(cx),
            Overlay::EmailDelivery(_) => self.dismiss_email_delivery(cx),
            Overlay::Marketing(_) => self.dismiss_marketing(cx),
            Overlay::Loyalty(_) => self.dismiss_loyalty(false, cx),
            Overlay::Whatsapp(_) => self.close_whatsapp_desk(cx),
            Overlay::BookingPolicy(_) => self.dismiss_booking_policy(cx),
            Overlay::ServiceAssignments(_) => self.close_service_assignment(cx),
            Overlay::ServiceCatalog(_) => self.close_service_catalog(cx),
            Overlay::ResourceRequirements(_) => self.close_resource_requirements(cx),
            Overlay::ResourcePools(_) => self.close_resource_pools(cx),
            Overlay::Combinations(_) => self.close_combinations(cx),
            Overlay::StaffAccess(_) => self.close_staff_access(cx),
            Overlay::AccountRoles(_) => self.close_account_roles(cx),
            Overlay::Directory(desk) if desk.intake.is_some() => self.back_record(cx),
            Overlay::Directory(desk) if desk.has_controls() => self.back_client_controls(cx),
            Overlay::ReviewModeration(desk) => {
                if !desk.dismiss_editor(cx) {
                    self.overlay = Overlay::None;
                }
            }
            Overlay::Inventory(desk) => {
                if !desk.dismiss_editor(cx) {
                    self.overlay = Overlay::None;
                }
            }
            Overlay::TeamShifts(desk) => {
                if !desk.dismiss_editor(cx) {
                    self.overlay = Overlay::None;
                }
            }
            Overlay::Reviews(desk) if desk.confirm.is_some() && !desk.busy => {
                desk.confirm = None;
            }
            Overlay::StaffPortraits(desk) if desk.confirming_removal => {
                desk.confirming_removal = false;
            }
            Overlay::Details(details) if details.price_review.is_some() => {
                details.price_review = None;
            }
            Overlay::Details(details) if details.settlement_review.is_some() => {
                details.settlement_review = None;
            }
            Overlay::Details(details) if details.checkout.is_some() => {
                if !details
                    .checkout
                    .as_ref()
                    .is_some_and(|review| review.can_go_back())
                {
                    return;
                }
                details.checkout = None;
            }
            Overlay::Details(_) => self.close_appointment_details(false),
            _ => self.overlay = Overlay::None,
        }
        self.refresh_weekly_conflicts_if_ready(cx);
        cx.notify();
    }

    fn modal(&self, body: gpui::Div) -> gpui::Div {
        self.modal_with_height(body, px(560.), px(720.), None)
    }

    fn modal_with_height(
        &self,
        body: gpui::Div,
        width: gpui::Pixels,
        max_height: gpui::Pixels,
        backdrop_context: Option<&mut Context<Self>>,
    ) -> gpui::Div {
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(theme::backdrop())
            .occlude()
            .when_some(backdrop_context, |frame, cx| {
                frame.child(
                    div()
                        .id("appointment-details-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .on_click(cx.listener(|this, _, _, cx| this.dismiss_overlay(cx))),
                )
            })
            .child(
                body.w(width)
                    .max_h(max_height)
                    .p_5()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme::line())
                    .bg(theme::panel())
                    .shadow_lg()
                    .occlude(),
            )
    }

    fn stepper(
        &self,
        prefix: &'static str,
        label: String,
        cx: &mut Context<Self>,
        step: fn(&mut Root, i64, &mut Context<Root>),
    ) -> gpui::Div {
        let mk = |suffix: &'static str, label: Key, minutes: i64, cx: &mut Context<Self>| {
            self.button(
                SharedString::from(format!("{prefix}-{suffix}")),
                self.t(label),
                Kind::Ghost,
                cx.listener(move |this, _, _, cx| step(this, minutes, cx)),
            )
        };
        div()
            .flex()
            .items_center()
            .gap_2()
            .child(mk("d-", Key::MovePrevDay, -1440, cx))
            .child(mk("m-", Key::MoveEarlier, -15, cx))
            .child(
                div()
                    .px_2()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(SharedString::from(label)),
            )
            .child(mk("m+", Key::MoveLater, 15, cx))
            .child(mk("d+", Key::MoveNextDay, 1440, cx))
    }

    fn staff_chips(
        &self,
        staff: &[Staff],
        prefix: &'static str,
        selected: &str,
        cx: &mut Context<Self>,
        pick: fn(&mut Root, String, &mut Context<Root>),
    ) -> gpui::Div {
        div()
            .flex()
            .flex_wrap()
            .gap_2()
            .children(staff.iter().enumerate().map(|(i, s)| {
                let id = s.id.clone();
                self.chip(
                    (prefix, i),
                    SharedString::from(s.display_name.clone()),
                    s.id == selected,
                    cx.listener(move |this, _, _, cx| pick(this, id.clone(), cx)),
                )
                .tab_index(0)
                .focus(|style| style.border_color(theme::text()))
            }))
    }

    fn render_new(
        &self,
        f: &NewForm,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if let Some(review) = &f.visit_review {
            return self.render_visit_review(review, viewport, cx);
        }
        if let Some(review) = &f.intake {
            return self.render_booking_intake(f, review, viewport, cx);
        }
        const CLIENT_LIMIT: usize = 12;
        let wide = viewport.width >= px(850.);
        let start_label = format!(
            "{} {:02}:{:02}",
            i18n::date_label(self.locale, f.date),
            f.minutes / 60,
            f.minutes % 60,
        );
        let staff = f.staff_id.as_deref().unwrap_or_default();
        let search = f.client_search.read(cx).text().trim().to_lowercase();
        let selected_client = self
            .clients
            .iter()
            .find(|(id, _)| f.client_id.as_ref() == Some(id));
        let mut candidates: Vec<_> = if search.is_empty() {
            Vec::new()
        } else {
            self.clients
                .iter()
                .zip(&self.client_search_names)
                .filter(|((id, _), name)| {
                    f.client_id.as_ref() != Some(id) && name.contains(&search)
                })
                .map(|(client, _)| client)
                .take(CLIENT_LIMIT + 1)
                .collect()
        };
        let has_more = candidates.len() > CLIENT_LIMIT;
        candidates.truncate(CLIENT_LIMIT);
        if let Some(selected) = selected_client {
            candidates.insert(0, selected);
        }
        let clients = div()
            .id("new-clients")
            .max_h(px(120.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_1()
            .children(candidates.iter().map(|(id, name)| {
                let cid = id.clone();
                self.chip(
                    SharedString::from(format!("client-{id}")),
                    SharedString::from(name.clone()),
                    f.client_id.as_deref() == Some(id.as_str()),
                    cx.listener(move |this, _, _, cx| {
                        if let Overlay::New(form) = &mut this.overlay {
                            form.client_id =
                                (form.client_id.as_deref() != Some(&cid)).then(|| cid.clone());
                            form.error = None;
                        }
                        cx.notify();
                    }),
                )
                .tab_index(0)
                .flex_none()
            }));
        let booking_fields = div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(self.label(Key::Staff))
                    .child(self.staff_chips(
                        &self.staff,
                        "new-staff",
                        staff,
                        cx,
                        Root::pick_new_staff,
                    )),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(self.label(Key::Client))
                    .child(f.client_search.clone())
                    .when(!candidates.is_empty(), |section| section.child(clients))
                    .when(candidates.is_empty() && !search.is_empty(), |section| {
                        section.child(
                            div()
                                .text_sm()
                                .text_color(theme::muted())
                                .child(self.t(Key::NoMatchingClients)),
                        )
                    })
                    .when(has_more, |section| {
                        section.child(
                            div()
                                .text_sm()
                                .text_color(theme::muted())
                                .child(self.t(Key::RefineClientSearch)),
                        )
                    })
                    .when(f.client_id.is_none(), |section| {
                        section.child(self.label(Key::NewClient)).child(
                            div()
                                .flex()
                                .flex_wrap()
                                .gap_2()
                                .child(div().flex_1().min_w(px(120.)).child(f.new_client.clone()))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w(px(120.))
                                        .child(f.new_client_phone.clone()),
                                ),
                        )
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(self.label(Key::Start))
                    .child(
                        self.stepper("new-start", start_label, cx, |this, minutes, cx| {
                            if let Overlay::New(form) = &mut this.overlay {
                                let total = form.minutes + minutes;
                                form.date += Span::days(total.div_euclid(1440));
                                form.minutes = total.rem_euclid(1440);
                                form.selected_end = None;
                                form.error = None;
                            }
                            cx.notify();
                        })
                        .flex_wrap(),
                    )
                    .when_some(f.selected_end, |section, end| {
                        section.child(div().text_sm().text_color(theme::muted()).child(i18n::fill(
                            self.t(Key::SelectedSlotEnd),
                            &[("time", &format!("{:02}:{:02}", end / 60, end % 60))],
                        )))
                    }),
            )
            .child(f.notes.clone())
            .when(f.visit_parts.is_empty(), |fields| {
                fields.child(self.render_recurrence(f.recurrence, f.series_override, cx))
            })
            .when(!f.visit_parts.is_empty(), |fields| {
                fields.child(self.render_visit_parts(f, cx))
            });

        let performed: std::collections::HashSet<_> =
            ops::performed_services(&self.svc.store, staff)
                .unwrap_or_default()
                .into_iter()
                .collect();
        let search = f.service_search.read(cx).text().trim().to_lowercase();
        let offered: Vec<_> = self
            .services
            .iter()
            .filter(|service| {
                service.active
                    && performed.contains(&service.id)
                    && service.name.to_lowercase().contains(&search)
                    && !f
                        .visit_parts
                        .iter()
                        .any(|part| part.service_ids.contains(&service.id))
                    && (f.services.contains(&service.id)
                        || ops::validate_catalogue_selection(
                            &self.services,
                            f.services
                                .iter()
                                .map(String::as_str)
                                .chain(std::iter::once(service.id.as_str())),
                        )
                        .is_ok())
            })
            .collect();
        let selected_minutes: i64 = self
            .services
            .iter()
            .filter(|service| f.services.contains(&service.id))
            .map(|service| service.duration_minutes)
            .sum();
        let service_picker = div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .rounded_lg()
            .border_1()
            .border_color(theme::line())
            .bg(theme::bg())
            .child(
                div()
                    .text_base()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::Services)),
            )
            .child(f.service_search.clone())
            .when(
                f.recurrence.is_none() && !f.services.is_empty() && f.visit_parts.len() < 7,
                |list| {
                    list.child(
                        self.button(
                            "visit-add-step",
                            self.t(Key::VisitAddStep),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.add_visit_part(cx)),
                        )
                        .tab_index(0)
                        .focus(|style| style.border_color(theme::text())),
                    )
                },
            )
            .when(offered.is_empty(), |section| {
                section.child(
                    div()
                        .p_2()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(if search.is_empty() {
                            Key::NoStaffServices
                        } else {
                            Key::NoMatchingServices
                        })),
                )
            })
            .child(
                div()
                    .id("new-service-list")
                    .debug_selector(|| "new-service-list".to_string())
                    .track_scroll(&f.service_scroll)
                    .max_h((viewport.height * 0.53).clamp(px(144.), px(440.)))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .children(
                        offered
                            .into_iter()
                            .map(|service| self.new_service_row(f, service, cx)),
                    ),
            );

        let footer = div()
            .debug_selector(|| "new-appointment-footer".to_string())
            .flex_none()
            .flex()
            .flex_wrap()
            .justify_between()
            .items_center()
            .gap_2()
            .pt_3()
            .border_t_1()
            .border_color(theme::line())
            .child(div().text_sm().text_color(theme::muted()).child(i18n::fill(
                self.t(Key::ServiceSelection),
                &[
                    ("count", &f.services.len().to_string()),
                    ("minutes", &selected_minutes.to_string()),
                ],
            )))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(self.button(
                        "new-cancel",
                        self.t(Key::Cancel),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| this.dismiss_overlay(cx)),
                    ))
                    .child(
                        self.button(
                            "new-book",
                            self.t(if !f.visit_parts.is_empty() {
                                Key::VisitReview
                            } else if f.recurrence.is_some() {
                                Key::SeriesReview
                            } else {
                                Key::Book
                            }),
                            Kind::Primary,
                            cx.listener(|this, _, _, cx| this.book(cx)),
                        )
                        .tab_index(0)
                        .focus(|style| style.border_color(theme::text())),
                    ),
            );
        self.modal_with_height(
            div()
                .debug_selector(|| "new-appointment-panel".to_string())
                .tab_group()
                .overflow_hidden()
                .child(
                    div()
                        .flex_none()
                        .text_xl()
                        .font_weight(FontWeight::BOLD)
                        .child(self.t(Key::NewAppointment)),
                )
                .child(
                    div()
                        .id("new-appointment-body")
                        .min_h_0()
                        .overflow_y_scroll()
                        .child(
                            div()
                                .flex()
                                .gap_4()
                                .when(wide, |body| body.items_start())
                                .when(!wide, |body| body.flex_col())
                                .child(booking_fields)
                                .child(service_picker),
                        ),
                )
                .when_some(f.error, |panel, error| {
                    panel.child(
                        div()
                            .flex_none()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(self.t(error)),
                    )
                })
                .child(footer),
            (viewport.width - px(24.)).clamp(px(0.), px(if wide { 900. } else { 560. })),
            (viewport.height - px(24.)).clamp(px(0.), px(720.)),
            None,
        )
    }

    fn new_service_row(
        &self,
        form: &NewForm,
        service: &Service,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        let id = service.id.clone();
        let displayed_quote = service.quote_hash.clone();
        let selected = form.services.contains(&id);
        let mut duration = format!("{} min", service.duration_minutes);
        if let Some(processing) = &service.processing {
            duration.push_str(" · ");
            duration.push_str(&i18n::fill(
                self.t(Key::ProcessingDuration),
                &[("minutes", &processing.minutes.to_string())],
            ));
        }
        div()
            .id(SharedString::from(format!("new-service-{id}")))
            .tab_index(0)
            .focus(|row| row.border_color(theme::text()))
            .flex_none()
            .flex()
            .items_center()
            .gap_2()
            .min_h(px(44.))
            .px_2()
            .py_1()
            .rounded_md()
            .border_1()
            .border_color(if selected {
                theme::accent()
            } else {
                theme::line()
            })
            .bg(if selected {
                theme::accent_soft()
            } else {
                theme::panel()
            })
            .hover(|row| row.bg(theme::accent_soft()))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Overlay::New(form) = &mut this.overlay {
                    if let Some(index) = form.services.iter().position(|service| *service == id) {
                        form.services.remove(index);
                        form.selected_quotes.remove(&id);
                    } else {
                        form.services.push(id.clone());
                        if let Some(quote) = &displayed_quote {
                            form.selected_quotes.insert(id.clone(), quote.clone());
                        }
                    }
                    form.error = None;
                }
                cx.notify();
            }))
            .child(
                div()
                    .size(px(22.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .bg(if selected {
                        theme::accent()
                    } else {
                        theme::line_soft()
                    })
                    .text_color(if selected {
                        theme::on_accent()
                    } else {
                        theme::muted()
                    })
                    .child(if selected { "✓" } else { "+" }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child(service.name.clone()),
                    )
                    .child(div().text_xs().text_color(theme::muted()).child(duration)),
            )
            .child(
                div()
                    .flex_none()
                    .text_xs()
                    .text_color(theme::muted())
                    .child(self.amount_label(service.price_cents, &service.currency)),
            )
    }

    fn amount_label(&self, cents: i64, currency: &str) -> String {
        i18n::amount_label(self.locale, cents, currency)
    }

    fn render_details(
        &self,
        d: &Details,
        viewport_height: gpui::Pixels,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if let Some(review) = &d.price_review {
            return self.render_price_review(review, cx);
        }
        if let Some(review) = &d.settlement_review {
            return self.render_settlement_review(review, cx);
        }
        if let Some(checkout) = &d.checkout {
            return self.render_checkout(checkout, cx);
        }
        let current = calendar::effective_appointment(&self.svc.store, &d.id)
            .ok()
            .flatten();
        let pending = self.summary.pending > 0
            && self
                .svc
                .store
                .outbox(usize::MAX)
                .map(|q| q.iter().any(|e| e.entity_id == d.id))
                .unwrap_or(false);
        let client = current
            .as_ref()
            .map(|a| self.appointment_client_name(a))
            .unwrap_or_default();
        let stale = current.as_ref().is_none_or(|a| !d.reviewed.matches(a));
        let editable = !stale
            && current
                .as_ref()
                .is_some_and(|a| a.status == AppointmentStatus::Booked);
        let can_set_outcome =
            editable && current.as_ref().is_some_and(|a| a.starts_at <= Utc::now());
        let changed =
            editable && (d.start != d.reviewed.starts_at || d.staff_id != d.reviewed.staff_id);
        let content = div()
            .id("appointment-details")
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::BOLD)
                            .child(self.t(Key::Details)),
                    )
                    .when(pending, |x| {
                        x.child(self.badge(
                            self.t(Key::PendingBadge),
                            theme::pending_fg(),
                            theme::pending_bg(),
                        ))
                    }),
            )
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(SharedString::from(client)),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(SharedString::from(self.staff_name(&d.reviewed.staff_id))),
            )
            .child(div().text_sm().child(SharedString::from(
                self.date_time_label(d.reviewed.starts_at),
            )))
            .when_some(current.as_ref(), |x, appointment| {
                x.child(
                    div()
                        .debug_selector(|| "appointment-details-services".to_string())
                        .flex()
                        .flex_col()
                        .gap_1()
                        .children(appointment.services.iter().enumerate().map(
                            |(position, service)| {
                                let amount = if service.source_unpriced {
                                    self.t(Key::ImportedPriceUnknown).to_owned()
                                } else {
                                    self.amount_label(service.price_cents, &service.currency)
                                };
                                let line = div()
                                    .flex()
                                    .flex_wrap()
                                    .justify_between()
                                    .gap_2()
                                    .child(SharedString::from(service.name.clone()))
                                    .child(
                                        div()
                                            .text_color(theme::muted())
                                            .child(SharedString::from(amount)),
                                    );
                                div().text_sm().child(line).when_some(
                                    appointment
                                        .service_badges
                                        .iter()
                                        .find(|badge| badge.service_position == position),
                                    |line, badge| line.child(self.service_indicators(badge)),
                                )
                            },
                        ))
                        .when(appointment.externally_settled, |list| {
                            list.child(self.badge(
                                self.t(Key::SettlementSaved),
                                theme::text(),
                                theme::line_soft(),
                            ))
                        })
                        .when_some(appointment.external_balance, |list, balance| {
                            list.child(div().text_sm().child(self.external_balance_label(balance)))
                        })
                        .when(appointment.booksy_unpaid_confirmed, |list| {
                            list.child(div().text_sm().child(self.t(Key::BooksyUnpaidConfirmed)))
                        })
                        .when(
                            appointment.status != AppointmentStatus::Cancelled
                                && !appointment.externally_settled
                                && appointment.external_balance.is_none(),
                            |list| {
                                list.children(appointment.billing_review_reasons().filter_map(
                                    |reason| {
                                        let label = match reason {
                                            BillingReviewReason::PaidInBooksy => Key::ImportedPaid,
                                            BillingReviewReason::InvoicedInBooksy => {
                                                Key::ImportedInvoiced
                                            }
                                            BillingReviewReason::UnknownBooksyPayment => {
                                                Key::DueUnknownBooksyPayment
                                            }
                                            BillingReviewReason::UnknownAmount => {
                                                return None;
                                            }
                                        };
                                        Some(self.badge(
                                            self.t(label),
                                            theme::pending_fg(),
                                            theme::pending_bg(),
                                        ))
                                    },
                                ))
                            },
                        ),
                )
            })
            .when_some(current.as_ref(), |body, appointment| {
                body.child(self.render_annotations(appointment, d.annotations.as_ref(), cx))
                    .children(self.render_related_visit(appointment, d, cx))
            })
            .when(
                !pending
                    && current
                        .as_ref()
                        .is_some_and(|a| self.can_open_appointment_checkout(a)),
                |view| {
                    view.child(self.button(
                        "open-appointment-checkout",
                        self.t(Key::OpenAppointmentCheckout),
                        Kind::Primary,
                        cx.listener(|this, _, _, cx| this.open_appointment_checkout(cx)),
                    ))
                },
            )
            .when(
                !pending
                    && current
                        .as_ref()
                        .is_some_and(|a| self.can_open_price_review(a)),
                |x| {
                    x.child(self.button(
                        "open-imported-price-review",
                        self.t(Key::ReviewImportedPrice),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| this.open_price_review(cx)),
                    ))
                },
            )
            .when(!pending, |view| {
                view.children(
                    [
                        ("open-imported-settlement", SettlementMode::Full),
                        ("open-imported-partial-payment", SettlementMode::Partial),
                        ("open-imported-unpaid", SettlementMode::Unpaid),
                    ]
                    .into_iter()
                    .filter(|(_, mode)| {
                        current
                            .as_ref()
                            .is_some_and(|a| self.can_open_settlement_review(a, *mode))
                    })
                    .map(|(id, mode)| {
                        self.button(
                            id,
                            self.t(mode.title()),
                            Kind::Ghost,
                            cx.listener(move |this, _, _, cx| {
                                this.open_settlement_review(mode, cx)
                            }),
                        )
                    }),
                )
            })
            .when(editable, |x| {
                x.child(self.label(Key::MoveTo))
                    .child(self.stepper(
                        "move",
                        self.date_time_label(d.start),
                        cx,
                        |this, minutes, cx| {
                            let invalid = this.t(Key::ErrInvalidLocalStart);
                            if let Overlay::Details(d) = &mut this.overlay {
                                if let Some(start) =
                                    step_appointment_time(this.tz, d.start, minutes)
                                {
                                    d.start = start;
                                    d.error = None;
                                } else {
                                    d.error = Some(invalid.into());
                                }
                            }
                            cx.notify();
                        },
                    ))
                    .child(self.staff_chips(
                        &self.staff,
                        "move-staff",
                        &d.staff_id,
                        cx,
                        |this, id, cx| {
                            if let Overlay::Details(d) = &mut this.overlay {
                                d.staff_id = id;
                            }
                            cx.notify();
                        },
                    ))
            })
            .when_some(
                current.as_ref().and_then(|a| match a.status {
                    AppointmentStatus::Completed => Some(Key::Completed),
                    AppointmentStatus::NoShow => Some(Key::NoShow),
                    _ => None,
                }),
                |x, key| x.child(self.badge(self.t(key), theme::text(), theme::line_soft())),
            )
            .when(can_set_outcome, |x| {
                x.child(
                    div()
                        .flex()
                        .gap_2()
                        .child(self.button(
                            "mark-completed",
                            self.t(Key::MarkCompleted),
                            Kind::Primary,
                            cx.listener(|this, _, _, cx| {
                                this.set_outcome(AppointmentStatus::Completed, Utc::now(), cx)
                            }),
                        ))
                        .child(self.button(
                            "mark-no-show",
                            self.t(Key::MarkNoShow),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| {
                                this.set_outcome(AppointmentStatus::NoShow, Utc::now(), cx)
                            }),
                        )),
                )
            })
            .when(stale, |x| {
                x.child(
                    div()
                        .text_sm()
                        .text_color(theme::conflict_fg())
                        .child(self.t(Key::AppointmentChanged)),
                )
                .when(current.is_some(), |x| {
                    x.child(self.button(
                        "review-current-appointment",
                        self.t(Key::ReviewCurrentAppointment),
                        Kind::Ghost,
                        cx.listener(|this, _, _, cx| this.review_updated_appointment(cx)),
                    ))
                })
            })
            .when_some(d.error.clone().filter(|_| !stale), |x, e| {
                x.child(
                    div()
                        .text_sm()
                        .text_color(theme::conflict_fg())
                        .child(SharedString::from(e)),
                )
            });
        let footer = div()
            .flex()
            .flex_none()
            .flex_wrap()
            .justify_between()
            .gap_2()
            .when(editable, |x| {
                x.child(self.button(
                    "cancel-appointment",
                    if d.confirm_cancel {
                        "Confirm: ".to_owned() + self.t(Key::CancelAppointment)
                    } else {
                        self.t(Key::CancelAppointment).to_owned()
                    },
                    Kind::Danger,
                    cx.listener(|this, _, _, cx| this.cancel_appointment(cx)),
                ))
            })
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        self.button(
                            "details-close",
                            self.t(match d.return_to {
                                Some(AppointmentReturn::TeamShifts(_)) => Key::ShiftBackToSchedule,
                                Some(AppointmentReturn::Unpaid(_)) => Key::DueBack,
                                Some(AppointmentReturn::Conflict(_)) => Key::Back,
                                None => Key::Close,
                            }),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| this.dismiss_overlay(cx)),
                        )
                        .debug_selector(|| "calendar-details-close".to_string()),
                    )
                    .when(changed, |x| {
                        x.child(self.button(
                            "apply-move",
                            self.t(Key::ApplyMove),
                            Kind::Primary,
                            cx.listener(|this, _, _, cx| this.apply_move(cx)),
                        ))
                    }),
            );
        self.modal_with_height(
            div().tab_group().child(content).child(footer),
            px(560.),
            (viewport_height - px(24.)).clamp(px(0.), px(720.)),
            (!changed && !matches!(d.annotations, Some(annotations::Annotations::Editing(_))))
                .then_some(cx),
        )
    }

    fn render_conflicts(
        &self,
        editing: &Option<ConflictDraft>,
        error: &Option<String>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let cards = self.conflicts.iter().enumerate().map(|(i, c)| {
            let kind = self.t(match c.kind.as_str() {
                "appointment.create" => Key::ConflictCreate,
                "appointment.reschedule" => Key::ConflictReschedule,
                "appointment.cancel" => Key::ConflictCancel,
                "time_off.create" | "time_off.update" | "time_off.delete" => Key::TimeOff,
                "settings.update" => Key::SalonConfiguration,
                "service.staff_replace" => Key::ServiceAssignments,
                sob_core::store::SERVICE_CREATION_KIND => Key::CatalogNew,
                sob_core::http::PORTFOLIO_UPLOAD => Key::CatalogPhotos,
                sob_core::store::SERVICE_EDIT_KIND => Key::CatalogTitle,
                sob_core::service_resources::MUTATION_KIND => Key::ResourceRequirements,
                sob_core::resource_pools::CREATE | sob_core::resource_pools::UPDATE => {
                    Key::PoolManagement
                }
                sob_core::combinations::CREATE | sob_core::combinations::UPDATE => {
                    Key::CombinationManagement
                }
                sob_core::product_editor::CREATE | sob_core::product_editor::UPDATE => {
                    Key::InventoryProductDetails
                }
                sob_core::product_editor::PHOTO => Key::InventoryProductPhoto,
                sob_core::inventory_documents::SUPPLIER_SAVE => Key::InventorySuppliers,
                sob_core::inventory_documents::RECEIVE_STOCK => Key::InventoryReceipts,
                sob_core::purchase_orders::PURCHASE_ORDER_WRITE => Key::InventoryOrders,
                sob_core::warehouses::SAVE => Key::InventoryWarehouses,
                sob_core::inventory_classifications::SAVE => Key::InventoryClassifications,
                sob_core::warehouses::TRANSFER => Key::InventoryWarehouseTransfer,
                sob_core::warehouses::ADJUST => Key::InventoryWarehouseAdjust,
                _ => Key::ConflictOther,
            });
            let when = c
                .payload
                .get("startsAt")
                .and_then(|v| v.as_str())
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| self.date_time_label(d.with_timezone(&Utc)))
                .unwrap_or_default();
            let description = if c.kind == sob_core::warehouses::ADJUST
                && self.svc.store.can_read_cached_orders()
            {
                serde_json::from_value(c.payload.clone())
                    .ok()
                    .map_or_else(String::new, |command| {
                        self.warehouse_adjustment_description(&command)
                    })
            } else if matches!(
                c.kind.as_str(),
                sob_core::store::SERVICE_CREATION_KIND | sob_core::store::SERVICE_EDIT_KIND
            ) {
                c.payload
                    .pointer("/service/name")
                    .or_else(|| c.payload.pointer("/_reviewed/name"))
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_owned()
            } else {
                when
            };
            let staff = c
                .payload
                .get("staffId")
                .and_then(|v| v.as_str())
                .map(|s| self.staff_name(s))
                .unwrap_or_default();
            let mid = c.mutation_id.clone();
            let draft = editing.as_ref().filter(|e| e.mutation_id == c.mutation_id);
            let card = div()
                .flex()
                .flex_col()
                .gap_2()
                .p_3()
                .rounded_md()
                .border_1()
                .border_color(theme::conflict_fg())
                .bg(theme::conflict_bg())
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .items_center()
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(kind))
                        .child(
                            div()
                                .text_sm()
                                .text_color(theme::muted())
                                .child(SharedString::from(format!("{description} {staff}"))),
                        ),
                )
                .child(div().text_sm().child(
                    if c.kind == "appointment.create" && c.reason == "conflict" {
                        self.t(Key::ConflictReviewedTerms)
                    } else if matches!(
                        c.kind.as_str(),
                        sob_core::warehouses::SAVE
                            | sob_core::warehouses::TRANSFER
                            | sob_core::warehouses::ADJUST
                    ) && matches!(
                        c.reason.as_str(),
                        "conflict" | "replica_generation_changed" | "generation_changed"
                    ) {
                        self.t(Key::InventoryWarehouseChanged)
                    } else {
                        self.conflict_reason(&c.reason)
                    },
                ));
            if !c.is_appointment() || c.requires_restored_review() {
                let m = mid.clone();
                return card.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .when(
                            c.kind == "settings.update"
                                && c.payload.get("expectedRevision").is_some()
                                && self.can_configure_salon(),
                            |row| {
                                row.child(self.button(
                                    ("c-settings", i),
                                    self.t(Key::SalonConfiguration),
                                    Kind::Primary,
                                    cx.listener(|root, _, _, cx| root.open_salon_configuration(cx)),
                                ))
                            },
                        )
                        .when(
                            (c.requires_restored_review()
                                && !matches!(
                                    c.kind.as_str(),
                                    sob_core::inventory_documents::SUPPLIER_SAVE
                                        | sob_core::inventory_documents::RECEIVE_STOCK
                                        | sob_core::purchase_orders::PURCHASE_ORDER_WRITE
                                ))
                                || matches!(
                                    c.kind.as_str(),
                                    "service.staff_replace"
                                        | sob_core::store::SERVICE_CREATION_KIND
                                ),
                            |row| {
                                let details = serde_json::json!({
                                    "kind": c.kind,
                                    "createdAt": c.created_at,
                                    "entityId": c.entity_id,
                                    "payload": c.payload,
                                });
                                row.child(self.button(
                                    ("c-copy", i),
                                    self.t(Key::ConflictCopyChange),
                                    Kind::Ghost,
                                    move |_, _, cx| {
                                        if let Ok(text) = serde_json::to_string_pretty(&details) {
                                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                                text,
                                            ));
                                        }
                                    },
                                ))
                            },
                        )
                        .when(
                            c.kind == "service.staff_replace" && self.can_configure_salon(),
                            |row| {
                                let id = c.entity_id.clone();
                                let mutation_id = c.mutation_id.clone();
                                row.child(self.button(
                                    ("c-service-assignments", i),
                                    self.t(Key::AssignmentReview),
                                    Kind::Primary,
                                    cx.listener(move |root, _, _, cx| {
                                        root.open_service_assignments(Some((&id, &mutation_id)), cx)
                                    }),
                                ))
                            },
                        )
                        .when(c.kind == sob_core::store::SERVICE_CREATION_KIND, |row| {
                            let id = c.mutation_id.clone();
                            row.child(self.button(
                                ("c-service-create", i),
                                self.t(Key::CatalogReview),
                                Kind::Primary,
                                cx.listener(move |root, _, _, cx| {
                                    root.open_catalog_creation(Some(&id), cx)
                                }),
                            ))
                        })
                        .when(
                            c.kind == sob_core::store::SERVICE_EDIT_KIND
                                && self.can_create_catalogue_item(),
                            |row| {
                                let id = c.mutation_id.clone();
                                row.child(self.button(
                                    ("c-service-edit", i),
                                    self.t(Key::CatalogReview),
                                    Kind::Primary,
                                    cx.listener(move |root, _, _, cx| {
                                        root.open_catalog_edit_conflict(&id, cx)
                                    }),
                                ))
                            },
                        )
                        .when(
                            c.kind == sob_core::service_resources::MUTATION_KIND
                                && self.can_create_catalogue_item(),
                            |row| {
                                let id = c.mutation_id.clone();
                                row.child(self.button(
                                    ("review-resource-configuration", i),
                                    self.t(Key::CatalogReview),
                                    Kind::Primary,
                                    cx.listener(move |root, _, _, cx| {
                                        root.open_resource_conflict(&id, cx)
                                    }),
                                ))
                            },
                        )
                        .when(
                            matches!(
                                c.kind.as_str(),
                                sob_core::resource_pools::CREATE | sob_core::resource_pools::UPDATE
                            ) && self.can_create_catalogue_item(),
                            |row| {
                                let id = c.mutation_id.clone();
                                row.child(self.button(
                                    ("review-resource-pool", i),
                                    self.t(Key::CatalogReview),
                                    Kind::Primary,
                                    cx.listener(move |root, _, _, cx| {
                                        root.open_resource_pools(Some(&id), cx)
                                    }),
                                ))
                            },
                        )
                        .when(
                            matches!(
                                c.kind.as_str(),
                                sob_core::combinations::CREATE | sob_core::combinations::UPDATE
                            ) && self.can_create_catalogue_item(),
                            |row| {
                                let id = c.mutation_id.clone();
                                row.child(self.button(
                                    ("review-combination", i),
                                    self.t(Key::CatalogReview),
                                    Kind::Primary,
                                    cx.listener(move |root, _, _, cx| {
                                        root.open_combinations(Some(&id), cx)
                                    }),
                                ))
                            },
                        )
                        .when(
                            matches!(
                                c.kind.as_str(),
                                sob_core::product_editor::CREATE | sob_core::product_editor::UPDATE
                            ) && self.svc.store.can_queue_product_edits(),
                            |row| {
                                let id = c.mutation_id.clone();
                                row.child(self.button(
                                    ("review-product", i),
                                    self.t(Key::InventoryReviewLatest),
                                    Kind::Primary,
                                    cx.listener(move |root, _, _, cx| {
                                        root.open_product_conflict(&id, cx)
                                    }),
                                ))
                            },
                        )
                        .when(c.kind == sob_core::product_editor::PHOTO, |row| {
                            let id = c.mutation_id.clone();
                            row.child(self.button(
                                ("review-product-photo", i),
                                self.t(Key::InventoryPhotoReview),
                                Kind::Primary,
                                cx.listener(move |root, _, _, cx| {
                                    root.open_product_photo_conflict(&id, cx)
                                }),
                            ))
                        })
                        .when(
                            matches!(
                                c.kind.as_str(),
                                sob_core::inventory_documents::SUPPLIER_SAVE
                                    | sob_core::inventory_documents::RECEIVE_STOCK
                                    | sob_core::purchase_orders::PURCHASE_ORDER_WRITE
                            ) && self.svc.store.can_queue_product_edits(),
                            |row| {
                                let id = c.mutation_id.clone();
                                row.child(self.button(
                                    ("review-inventory-document", i),
                                    self.t(Key::InventoryDocumentReview),
                                    Kind::Primary,
                                    cx.listener(move |root, _, _, cx| {
                                        root.open_inventory_document_conflict(&id, cx)
                                    }),
                                ))
                            },
                        )
                        .when(
                            matches!(
                                c.kind.as_str(),
                                sob_core::warehouses::SAVE
                                    | sob_core::warehouses::TRANSFER
                                    | sob_core::warehouses::ADJUST
                            ) && self.svc.store.can_read_cached_orders()
                                && self.status.connectivity == Connectivity::Online,
                            |row| {
                                let id = c.mutation_id.clone();
                                row.child(self.button(
                                    ("review-warehouse", i),
                                    self.t(Key::InventoryDocumentReview),
                                    Kind::Primary,
                                    cx.listener(move |root, _, _, cx| {
                                        root.open_warehouse_conflict(&id, cx)
                                    }),
                                ))
                            },
                        )
                        .when(
                            c.kind == sob_core::inventory_classifications::SAVE
                                && self.svc.store.can_queue_product_edits(),
                            |row| {
                                let id = c.mutation_id.clone();
                                row.child(self.button(
                                    ("review-classification", i),
                                    self.t(Key::InventoryDocumentReview),
                                    Kind::Primary,
                                    cx.listener(move |root, _, _, cx| {
                                        root.open_classification_conflict(&id, cx)
                                    }),
                                ))
                            },
                        )
                        .when(
                            c.kind == sob_core::http::PORTFOLIO_UPLOAD
                                && self.svc.store.cached_catalogue_access(),
                            |row| {
                                let id = mid.clone();
                                row.child(self.button(
                                    ("c-portfolio", i),
                                    self.t(Key::CatalogPhotosCurrent),
                                    Kind::Primary,
                                    cx.listener(move |root, _, _, cx| {
                                        root.open_portfolio_upload_conflict(&id, cx)
                                    }),
                                ))
                            },
                        )
                        .when(
                            c.kind != sob_core::product_editor::PHOTO
                                && c.kind != sob_core::http::PORTFOLIO_UPLOAD,
                            |row| {
                                row.child(self.button(
                                    ("c-dismiss", i),
                                    self.t(Key::ConflictDismiss),
                                    Kind::Ghost,
                                    cx.listener(move |this, _, _, cx| {
                                        this.resolve(&m, Resolution::Dismiss, cx)
                                    }),
                                ))
                            },
                        ),
                );
            }
            if let Some(dr) = draft {
                let m = mid.clone();
                let (start, staff_id) = (dr.start, dr.staff_id.clone());
                return card
                    .child(self.stepper(
                        "c-step",
                        self.date_time_label(dr.start),
                        cx,
                        |this, minutes, cx| {
                            let invalid = this.t(Key::ErrInvalidLocalStart);
                            if let Overlay::Conflicts {
                                editing: Some(e),
                                error,
                            } = &mut this.overlay
                            {
                                if let Some(start) =
                                    step_appointment_time(this.tz, e.start, minutes)
                                {
                                    e.start = start;
                                    *error = None;
                                } else {
                                    *error = Some(invalid.into());
                                }
                            }
                            cx.notify();
                        },
                    ))
                    .child(self.staff_chips(
                        &self.staff,
                        "c-staff",
                        &dr.staff_id,
                        cx,
                        |this, id, cx| {
                            if let Overlay::Conflicts {
                                editing: Some(e), ..
                            } = &mut this.overlay
                            {
                                e.staff_id = id;
                            }
                            cx.notify();
                        },
                    ))
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap_2()
                            .child(self.button(
                                ("c-back", i),
                                self.t(Key::Back),
                                Kind::Ghost,
                                cx.listener(|this, _, _, cx| {
                                    this.overlay = Overlay::Conflicts {
                                        editing: None,
                                        error: None,
                                    };
                                    cx.notify();
                                }),
                            ))
                            .child(self.button(
                                ("c-apply", i),
                                self.t(Key::ApplyMove),
                                Kind::Primary,
                                cx.listener(move |this, _, _, cx| {
                                    this.resolve(
                                        &m,
                                        Resolution::Reschedule {
                                            starts_at: start,
                                            staff_id: Some(staff_id.clone()),
                                        },
                                        cx,
                                    )
                                }),
                            )),
                    );
            }
            let (m1, m2, m3) = (mid.clone(), mid.clone(), c.clone());
            let new_booking = c.kind == "appointment.create";
            card.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .when(!new_booking || c.reason != "conflict", |x| {
                        x.child(self.button(
                            ("c-resched", i),
                            self.t(if new_booking {
                                Key::ConflictPickNewTime
                            } else {
                                Key::ReviewCurrentAppointment
                            }),
                            Kind::Primary,
                            cx.listener(move |this, _, _, cx| this.start_conflict_edit(&m3, cx)),
                        ))
                    })
                    .when(new_booking, |x| {
                        x.child(self.button(
                            ("c-cancel", i),
                            self.t(Key::ConflictDropBooking),
                            Kind::Danger,
                            cx.listener(move |this, _, _, cx| {
                                this.resolve(&m1, Resolution::Cancel, cx)
                            }),
                        ))
                    })
                    .child(self.button(
                        ("c-dismiss", i),
                        self.t(Key::ConflictDismiss),
                        Kind::Ghost,
                        cx.listener(move |this, _, _, cx| {
                            this.resolve(&m2, Resolution::Dismiss, cx)
                        }),
                    )),
            )
        });
        self.modal(
            div()
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::BOLD)
                        .child(self.t(Key::Conflicts)),
                )
                .when(self.conflicts.is_empty(), |x| {
                    x.child(
                        div()
                            .text_color(theme::muted())
                            .child(self.t(Key::NoConflicts)),
                    )
                })
                .child(
                    div()
                        .id("conflict-list")
                        .flex()
                        .flex_col()
                        .gap_3()
                        .overflow_y_scroll()
                        .children(cards),
                )
                .when_some(error.clone(), |x, e| {
                    x.child(
                        div()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(SharedString::from(e)),
                    )
                })
                .child(div().flex().justify_end().child(self.button(
                    "conflicts-close",
                    self.t(Key::Close),
                    Kind::Ghost,
                    cx.listener(|this, _, _, cx| {
                        this.overlay = Overlay::None;
                        cx.notify();
                    }),
                ))),
        )
    }
}

impl Render for Root {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if matches!(self.screen, Screen::Main)
            && !self.login.server_editor
            && !matches!(self.overlay, Overlay::None)
            && window.focused(cx).is_none()
        {
            self.focus.focus(window);
        }
        theme::set_dark(self.theme_override.unwrap_or(matches!(
            window.appearance(),
            gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark
        )));
        let base = div()
            .flex_1()
            .w_full()
            .min_h_0()
            .relative()
            .bg(theme::bg())
            .text_color(theme::text());
        let content = if self.login.server_editor {
            base.child(self.render_server_editor(cx))
        } else {
            match self.screen {
                Screen::Login => base.child(self.render_login(cx)),
                Screen::Main => {
                    let overlay = match &self.overlay {
                        Overlay::None => None,
                        Overlay::Cloud(desk) => {
                            Some(self.render_web_management(desk, window.viewport_size(), cx))
                        }
                        Overlay::SalonConfiguration(desk) => {
                            Some(self.render_salon_configuration(desk, window.viewport_size(), cx))
                        }
                        Overlay::Whatsapp(desk) => {
                            Some(self.render_whatsapp_desk(desk, window.viewport_size(), cx))
                        }
                        Overlay::EmailDelivery(desk) => {
                            Some(self.render_email_delivery(desk, window.viewport_size(), cx))
                        }
                        Overlay::Marketing(desk) => {
                            Some(self.render_marketing(desk, window.viewport_size(), cx))
                        }
                        Overlay::BookingPolicy(desk) => {
                            Some(self.render_booking_policy(desk, window.viewport_size(), cx))
                        }
                        Overlay::IntakeForms(desk) => {
                            Some(self.render_intake_forms(desk, window.viewport_size(), cx))
                        }
                        Overlay::New(f) => Some(self.render_new(f, window.viewport_size(), cx)),
                        Overlay::Slot(slot) => Some(self.render_slot_actions(slot, cx)),
                        Overlay::Details(d) => {
                            Some(self.render_details(d, window.viewport_size().height, cx))
                        }
                        Overlay::Block(f) => Some(self.render_block_form(f, cx)),
                        Overlay::Blocks => Some(self.render_time_off_list(cx)),
                        Overlay::Inbox(inbox) => Some(self.render_inbox(inbox, cx)),
                        Overlay::Cash(desk) => Some(self.render_cash_register(desk, cx)),
                        Overlay::Loyalty(desk) => {
                            Some(self.render_loyalty(desk, window.viewport_size(), cx))
                        }
                        Overlay::WalkIn(sale) => {
                            Some(self.render_walk_in(sale, window.viewport_size(), cx))
                        }
                        Overlay::WalkInReceipt(review) => Some(self.render_checkout(review, cx)),
                        Overlay::SalesHistory(history) => {
                            Some(self.render_sales_history(history, window.viewport_size(), cx))
                        }
                        Overlay::Unpaid(desk) => {
                            Some(self.render_unpaid(desk, window.viewport_size(), cx))
                        }
                        Overlay::Inventory(desk) => {
                            Some(self.render_inventory(desk, window.viewport_size(), cx))
                        }
                        Overlay::Reports(desk) => {
                            Some(self.render_reports(desk, window.viewport_size(), cx))
                        }
                        Overlay::Commissions(desk) => {
                            Some(self.render_commissions(desk, window.viewport_size(), cx))
                        }
                        Overlay::CalendarDate(picker) => {
                            Some(self.render_calendar_date(picker, window.viewport_size(), cx))
                        }
                        Overlay::TeamShifts(desk) => {
                            Some(self.render_team_shifts(desk, window.viewport_size(), cx))
                        }
                        Overlay::StaffPortraits(desk) => {
                            Some(self.render_staff_portraits(desk, window.viewport_size(), cx))
                        }
                        Overlay::AccountRoles(desk) => {
                            Some(self.render_account_roles(desk, window.viewport_size(), cx))
                        }
                        Overlay::StaffAccess(desk) => {
                            Some(self.render_staff_access(desk, window.viewport_size(), cx))
                        }
                        Overlay::ServiceAssignments(desk) => {
                            Some(self.render_service_assignments(desk, window.viewport_size(), cx))
                        }
                        Overlay::ServiceCatalog(desk) => {
                            Some(self.render_service_catalog(desk, window.viewport_size(), cx))
                        }
                        Overlay::ResourceRequirements(desk) => Some(
                            self.render_resource_requirements(desk, window.viewport_size(), cx),
                        ),
                        Overlay::ResourcePools(desk) => {
                            Some(self.render_resource_pools(desk, window.viewport_size(), cx))
                        }
                        Overlay::Combinations(desk) => {
                            Some(self.render_combinations(desk, window.viewport_size(), cx))
                        }
                        Overlay::Reviews(desk) => {
                            Some(self.render_review_requests(desk, window.viewport_size(), cx))
                        }
                        Overlay::ReviewModeration(desk) => {
                            Some(self.render_review_moderation(desk, window.viewport_size(), cx))
                        }
                        Overlay::Waitlist(desk) => Some(self.render_waitlist(desk, cx)),
                        Overlay::Directory(directory) => {
                            Some(self.render_directory(directory, window.viewport_size(), cx))
                        }
                        Overlay::Conflicts { editing, error } => {
                            Some(self.render_conflicts(editing, error, cx))
                        }
                    };
                    base.flex()
                        .flex_col()
                        .child(self.render_header(cx))
                        .when(self.calendar_mode == CalendarMode::Week, |frame| {
                            frame.child(self.render_week_controls(cx))
                        })
                        .when(self.team_calendar_visible(), |frame| {
                            frame
                                .child(self.render_overview_filter(cx))
                                .child(self.render_team_calendar(window.viewport_size().width, cx))
                        })
                        .when(self.calendar_mode.is_overview(), |frame| {
                            frame
                                .child(self.render_overview_filter(cx))
                                .child(self.render_calendar_overview(cx))
                        })
                        .when(
                            !self.calendar_mode.is_overview() && !self.team_calendar_visible(),
                            |frame| {
                                frame
                                    .when(
                                        self.calendar_mode == CalendarMode::Day
                                            && !self.overview_staff.is_empty(),
                                        |frame| frame.child(self.render_overview_staff_filter(cx)),
                                    )
                                    .child(self.render_calendar(window.viewport_size().height, cx))
                            },
                        )
                        .when(!self.notices.is_empty(), |d| {
                            d.child(self.render_notices(cx))
                        })
                        .children(self.render_slot_tooltip(window.viewport_size()))
                        .children(overlay)
                }
            }
        };
        div()
            .size_full()
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .text_color(theme::text())
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                if event.keystroke.key == "tab"
                    && (matches!(
                        this.overlay,
                        Overlay::Directory(_)
                            | Overlay::Details(_)
                            | Overlay::New(_)
                            | Overlay::Marketing(_)
                            | Overlay::Loyalty(_)
                    ) || this.checkout_review_mut().is_some())
                {
                    if event.keystroke.modifiers.shift {
                        window.focus_prev();
                    } else {
                        window.focus_next();
                    }
                    cx.stop_propagation();
                    return;
                }
                if event.keystroke.key == "escape"
                    && matches!(this.screen, Screen::Main)
                    && !this.login.server_editor
                    && !matches!(this.overlay, Overlay::None)
                {
                    if !event.is_held {
                        this.dismiss_overlay(cx);
                    }
                    cx.stop_propagation();
                }
            }))
            .on_mouse_move(
                cx.listener(|this, event: &gpui::MouseMoveEvent, _, cx| this.drag_slot(event, cx)),
            )
            .capture_any_mouse_up(cx.listener(|this, event: &gpui::MouseUpEvent, _, cx| {
                this.finish_slot_drag(event, cx)
            }))
            .child(content)
    }
}

#[cfg(test)]
mod tests {
    //! Interaction tests: real `Root` view, real SQLite replica, GPUI's deterministic test
    //! runtime. The API URL points at a closed port, so everything here is the offline path.

    use gpui::TestAppContext;
    use serde_json::json;
    use sob_core::auth::{FileTokenStore, TokenStore};
    use sob_core::store::Store;

    #[test]
    fn calendar_lanes_keep_overlapping_cards_separate_and_reclaim_width() {
        assert_eq!(
            super::appointment_lanes(&[(0.0, 22.0), (10.0, 32.0), (22.0, 36.0), (60.0, 90.0)]),
            vec![(0, 2), (1, 2), (0, 2), (0, 1)],
        );
    }

    use super::*;

    const ANA: &str = "01a1d81e-0000-7000-8000-000000000001";
    const BEA: &str = "01a1d81e-0000-7000-8000-000000000002";
    const CUT: &str = "01a1d81e-0000-7000-8000-0000000000a1";
    const NAILS: &str = "01a1d81e-0000-7000-8000-0000000000a2";
    const LUCIA: &str = "01a1d81e-0000-7000-8000-0000000000c1";
    pub(super) const EXISTING: &str = "01a1d81e-0000-7000-8000-0000000000e1";
    const T0: &str = "2026-03-01T10:00:00.000Z";

    fn up(seq: i64, entity: &str, id: &str, data: serde_json::Value) -> RawChange {
        RawChange {
            seq,
            entity: entity.into(),
            id: id.into(),
            op: "upsert".into(),
            data: Some(data),
        }
    }

    /// A signed-in desk with a synced replica: two stylists, services, one client, one booking.
    pub(super) fn desk() -> (tempfile::TempDir, Config) {
        let dir = tempfile::tempdir().unwrap();
        let config = Config {
            api_url: "http://127.0.0.1:9".into(),
            api_url_locked: false,
            data_dir: dir.path().to_path_buf(),
            locale: Locale::En,
            start_date: Some("2026-03-09".parse().unwrap()),
            start_view: None,
        };
        let session = Session {
            cookie: "better-auth.session_token=x".into(),
            oauth: None,
            user_id: "u".into(),
            name: "Owner".into(),
            email: "o@x.test".into(),
            role: "owner".into(),
        };
        let mut store = Store::open(&config.db_path(&session)).unwrap();
        store
            .apply_page(
                &[
                    up(1, "salon_settings", "1", json!({"name": "SoB", "timezone": "America/Argentina/Buenos_Aires",
                        "slotGranularityMinutes": 15, "minNoticeMinutes": 60, "maxDaysAhead": 60, "updatedAt": T0})),
                    up(2, "staff", ANA, json!({"id": ANA, "displayName": "Ana", "active": true, "userId": null, "updatedAt": T0})),
                    up(3, "staff", BEA, json!({"id": BEA, "displayName": "Bea", "active": true, "userId": null, "updatedAt": T0})),
                    up(4, "service", CUT, json!({"id": CUT, "name": "Haircut", "description": null, "durationMinutes": 45, "bufferMinutes": 15, "priceCents": 1, "currency": "ARS", "active": true, "updatedAt": T0, "quoteHash": "a".repeat(64)})),
                    up(5, "service", NAILS, json!({"id": NAILS, "name": "Manicure", "description": null, "durationMinutes": 45, "bufferMinutes": 0, "priceCents": 1, "currency": "ARS", "active": true, "updatedAt": T0, "quoteHash": "a".repeat(64)})),
                    up(6, "service_staff", "l1", json!({"id": "l1", "serviceId": CUT, "staffId": ANA})),
                    up(7, "service_staff", "l2", json!({"id": "l2", "serviceId": NAILS, "staffId": BEA})),
                    up(8, "client", LUCIA, json!({"id": LUCIA, "name": "Lucia", "phone": null, "email": null, "notes": null, "createdAt": T0, "updatedAt": T0})),
                    up(9, "appointment", EXISTING, json!({"id": EXISTING, "staffId": ANA, "clientId": LUCIA,
                        "startsAt": "2026-03-09T15:00:00.000Z", "endsAt": "2026-03-09T16:00:00.000Z", "status": "booked",
                        "notes": null, "version": 3, "services": [{"serviceId": CUT, "name": "Haircut", "durationMinutes": 45, "bufferMinutes": 15, "priceCents": 1, "currency": "ARS"}],
                        "createdAt": T0, "updatedAt": T0})),
                ],
                9,
            )
            .unwrap();
        FileTokenStore::new(config.session_path())
            .save(&session)
            .unwrap();
        (dir, config)
    }

    pub(super) fn open(cx: &mut TestAppContext) -> (tempfile::TempDir, gpui::WindowHandle<Root>) {
        let (dir, config) = desk();
        let win = cx.add_window(|window, cx| Root::new(config, window, cx));
        cx.run_until_parked();
        (dir, win)
    }

    fn outbox_kinds(root: &Root) -> Vec<String> {
        root.svc
            .store
            .outbox(50)
            .unwrap()
            .into_iter()
            .map(|e| e.kind)
            .collect()
    }

    #[gpui::test]
    async fn a_saved_session_opens_the_calendar_straight_away_even_offline(
        cx: &mut TestAppContext,
    ) {
        let (_d, win) = open(cx);
        win.update(cx, |root, _, _| {
            assert!(matches!(root.screen, Screen::Main));
            let view = root.view.as_ref().expect("day view");
            assert_eq!(
                view.columns
                    .iter()
                    .map(|c| c.staff.display_name.as_str())
                    .collect::<Vec<_>>(),
                ["Ana", "Bea"]
            );
            assert_eq!(view.columns[0].items.len(), 1);
            assert_eq!(view.columns[0].items[0].client_name, "Lucia");
        })
        .unwrap();
    }

    #[gpui::test]
    async fn appointment_badges_distinguish_partial_billing_and_keep_note_flags(
        cx: &mut TestAppContext,
    ) {
        let (_dir, window) = open(cx);
        window
            .update(cx, |root, _, _| {
                let mut item = root.view.as_ref().unwrap().columns[0].items[0].clone();
                let service = item.appointment.services[0].clone();
                item.appointment.services.push(service);
                item.appointment.service_badges.push(CalendarServiceBadge {
                    service_position: 0,
                    paid: true,
                    invoiced: true,
                    billing_source: Some(CalendarBillingSource::Booksy),
                    requested: true,
                    internal_note: true,
                    customer_comment: true,
                });
                item.pending = true;
                let labels = appointment_badges::calendar(&item)
                    .into_iter()
                    .flatten()
                    .map(|badge| root.t(badge.1))
                    .collect::<Vec<_>>();
                assert_eq!(
                    labels,
                    [
                        root.t(Key::PendingBadge),
                        root.t(Key::AppointmentPartialBillingBadge),
                        root.t(Key::RequestedProfessional),
                        root.t(Key::AppointmentInternalNote),
                        root.t(Key::AppointmentCustomerComment),
                    ]
                );
                let tooltip =
                    appointment_badges::service(&item.appointment.service_badges[0])[0].unwrap();
                assert_eq!(root.t(tooltip.1), root.t(Key::ImportedPaid));
            })
            .unwrap();
    }

    #[gpui::test]
    async fn web_calendar_link_uses_the_connected_server_and_current_view(cx: &mut TestAppContext) {
        let (_dir, window) = open(cx);
        window
            .update(cx, |root, _, cx| {
                assert_eq!(
                    root.cloud_calendar_url().unwrap().as_str(),
                    format!(
                        "http://127.0.0.1:9/admin/calendar?date={}&view=day",
                        root.date
                    )
                );
                root.set_calendar_mode(CalendarMode::Week, cx);
                let link = root.cloud_calendar_url().unwrap();
                let query: std::collections::HashMap<_, _> = link.query_pairs().collect();
                assert_eq!(query["date"], root.date.to_string());
                assert_eq!(query["view"], "week");
                assert_eq!(query["staff"], root.week_staff_id);
            })
            .unwrap();
    }

    #[gpui::test]
    async fn opening_a_notice_selects_the_appointment_day_and_details(cx: &mut TestAppContext) {
        let (_dir, win) = open(cx);
        win.update(cx, |root, _, cx| {
            let appointment = root.svc.store.appointment(EXISTING).unwrap().unwrap();
            let day = appointment.starts_at.with_timezone(&root.tz).date_naive();
            root.date = day + Span::days(7);
            root.calendar_mode = CalendarMode::Week;
            root.notices
                .push((appointment, Instant::now() + Duration::from_secs(12)));
            root.show_notice(EXISTING, cx);
            assert_eq!(root.date, day);
            assert_eq!(root.calendar_mode, CalendarMode::Day);
            assert!(root.notices.is_empty());
            assert!(matches!(&root.overlay, Overlay::Details(details) if details.id == EXISTING));
        })
        .unwrap();
    }

    #[gpui::test]
    async fn startup_opens_today_in_the_salons_timezone_not_the_utc_day(cx: &mut TestAppContext) {
        let (_dir, mut config) = desk();
        config.start_date = None;
        let zone = if Utc::now().hour() < 10 {
            "Pacific/Honolulu"
        } else {
            "Pacific/Kiritimati"
        };
        let tz: Tz = zone.parse().unwrap();
        let mut store = Store::open(
            &config.db_path(
                &FileTokenStore::new(config.session_path())
                    .load()
                    .unwrap()
                    .unwrap(),
            ),
        )
        .unwrap();
        store.apply_page(&[up(10, "salon_settings", "1", json!({"name": "SoB", "timezone": zone,
            "slotGranularityMinutes": 15, "minNoticeMinutes": 60, "maxDaysAhead": 60, "updatedAt": T0}))], 10).unwrap();
        drop(store);
        let before = Utc::now().with_timezone(&tz).date_naive();
        let win = cx.add_window(|window, cx| Root::new(config, window, cx));
        let after = Utc::now().with_timezone(&tz).date_naive();
        win.update(cx, |root, _, _| {
            assert!(
                root.date == before || root.date == after,
                "startup should show the salons local day"
            )
        })
        .unwrap();
    }

    #[gpui::test]
    async fn first_sync_uses_local_today_but_preserves_a_deliberately_chosen_day(
        cx: &mut TestAppContext,
    ) {
        for (navigate, explicit) in [
            (false, None),
            (true, None),
            (false, Some("2026-01-01".parse().unwrap())),
        ] {
            let (_dir, mut config) = desk();
            config.start_date = explicit;
            Store::open(
                &config.db_path(
                    &FileTokenStore::new(config.session_path())
                        .load()
                        .unwrap()
                        .unwrap(),
                ),
            )
            .unwrap()
            .reset_replica()
            .unwrap();
            let zone = if Utc::now().hour() < 10 {
                "Pacific/Honolulu"
            } else {
                "Pacific/Kiritimati"
            };
            let tz: Tz = zone.parse().unwrap();
            let win = cx.add_window(|window, cx| Root::new(config, window, cx));
            win.update(cx, |root, _, cx| {
                if navigate { root.shift_day(-30, cx); }
                let chosen = root.date;
                root.svc.store.apply_page(&[up(1, "salon_settings", "1", json!({"name": "SoB", "timezone": zone,
                    "slotGranularityMinutes": 15, "minNoticeMinutes": 60, "maxDaysAhead": 60, "updatedAt": T0}))], 1).unwrap();
                let before = Utc::now().with_timezone(&tz).date_naive();
                root.reload(cx);
                let after = Utc::now().with_timezone(&tz).date_naive();
                if navigate || explicit.is_some() { assert_eq!(root.date, chosen); }
                else { assert!(root.date == before || root.date == after, "first synced catalog should open local today"); }
            }).unwrap();
        }
    }

    #[gpui::test]
    async fn a_theme_change_is_saved_for_the_next_launch(cx: &mut TestAppContext) {
        let (_d, win) = open(cx);
        win.update(cx, |root, _, cx| {
            root.set_theme(true, cx);
            assert_eq!(root.svc.config.saved_theme(), Some(true));
            assert!(theme::is_dark());
            root.set_theme(false, cx);
            assert_eq!(root.svc.config.saved_theme(), Some(false));
            assert!(!theme::is_dark());
        })
        .unwrap();
    }

    #[gpui::test]
    async fn week_view_starts_on_monday_and_navigates_in_whole_weeks(cx: &mut TestAppContext) {
        let (_d, win) = open(cx);
        win.update(cx, |root, _, cx| {
            root.date = "2026-03-11".parse().unwrap();
            root.set_calendar_mode(CalendarMode::Week, cx);
            assert_eq!(root.date.to_string(), "2026-03-11");
            let columns = root.calendar_columns();
            assert_eq!(columns.len(), 7);
            assert_eq!(columns[0].0.to_string(), "2026-03-09");
            assert_eq!(columns[6].0.to_string(), "2026-03-15");
            root.shift_day(1, cx);
            assert_eq!(root.date.to_string(), "2026-03-18");
            assert_eq!(root.calendar_columns()[0].0.to_string(), "2026-03-16");
            root.set_calendar_mode(CalendarMode::Day, cx);
            assert_eq!(root.calendar_columns().len(), 2);
            root.shift_day(-1, cx);
            assert_eq!(root.date.to_string(), "2026-03-17");
        })
        .unwrap();
    }

    #[gpui::test]
    async fn drawing_a_range_can_prefill_and_save_a_block(cx: &mut TestAppContext) {
        let (_dir, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(800.), px(600.)));
        cx.run_until_parked();
        let column = cx.debug_bounds("calendar-col-1").unwrap();
        let start = gpui::point(column.left() + px(40.), column.top() + px(64.));
        let end = gpui::point(column.left() + px(40.), column.top() + px(119.));
        cx.simulate_mouse_down(end, gpui::MouseButton::Left, Default::default());
        let intermediate = gpui::point(px(795.), column.top() + px(96.));
        cx.simulate_mouse_move(intermediate, gpui::MouseButton::Left, Default::default());
        cx.run_until_parked();
        let tooltip = cx
            .debug_bounds("calendar-slot-tooltip")
            .expect("live slot range on the first move");
        assert!(tooltip.right() < intermediate.x);
        root.update(cx, |root, _| {
            let slot = root
                .slot_drag
                .as_ref()
                .unwrap()
                .selection(root.vertical_scroll.handle.offset().y)
                .unwrap();
            assert_eq!(slot.time_label(), "09:30–10:00");
        });

        cx.simulate_mouse_move(start, gpui::MouseButton::Left, Default::default());
        cx.run_until_parked();
        assert!(cx.debug_bounds("calendar-slot-selection").is_some());
        let tooltip = cx
            .debug_bounds("calendar-slot-tooltip")
            .expect("live slot range");
        assert!(tooltip.bottom() <= start.y);
        root.update(cx, |root, _| {
            let drag = root.slot_drag.as_ref().unwrap();
            let slot = drag
                .selection(root.vertical_scroll.handle.offset().y)
                .unwrap();
            assert_eq!(slot.time_label(), "09:00–10:00");
        });
        cx.simulate_mouse_up(start, gpui::MouseButton::Left, Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert!(matches!(&root.overlay, Overlay::Slot(slot)
                if slot.staff_id == BEA && slot.start == 540 && slot.end == 600));
            assert!(
                root.render_slot_tooltip(gpui::size(px(800.), px(600.)))
                    .is_none()
            );
            assert!(outbox_kinds(root).is_empty());
        });
        let block_button = cx.debug_bounds("calendar-slot-block").unwrap().center();
        cx.simulate_click(block_button, Default::default());
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            assert!(matches!(root.overlay, Overlay::Block(_)));
            root.save_block(cx);
            let block = &root.view.as_ref().unwrap().columns[1].blocks[0].time_off;
            assert_eq!(block.staff_id, BEA);
            assert_eq!(root.hhmm(block.starts_at), "09:00");
            assert_eq!(root.hhmm(block.ends_at), "10:00");
            assert_eq!(outbox_kinds(root), ["time_off.create"]);
        });
    }

    #[gpui::test]
    async fn booking_from_a_drawn_range_preserves_the_start_and_checks_service_duration(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(800.), px(600.)));
        cx.run_until_parked();
        let column = cx.debug_bounds("calendar-col-0").unwrap();
        let start = gpui::point(column.left() + px(40.), column.top() + px(64.));
        let end = gpui::point(column.left() + px(40.), column.top() + px(115.));
        cx.simulate_click(start, Default::default());
        root.update(cx, |root, _| assert!(matches!(root.overlay, Overlay::None)));
        cx.simulate_mouse_down(start, gpui::MouseButton::Left, Default::default());
        cx.simulate_mouse_move(end, gpui::MouseButton::Left, Default::default());
        cx.simulate_mouse_up(end, gpui::MouseButton::Left, Default::default());
        cx.run_until_parked();
        let book_button = cx.debug_bounds("calendar-slot-book").unwrap().center();
        cx.simulate_click(book_button, Default::default());
        root.update(cx, |root, cx| {
            let Overlay::New(form) = &mut root.overlay else { panic!("new booking should be open") };
            assert_eq!((form.minutes, form.selected_end, form.staff_id.as_deref()), (540, Some(600), Some(ANA)));
            form.selected_end = Some(585);
            form.client_id = Some(LUCIA.into());
            form.services = vec![CUT.into()];
            root.book(cx);
            assert!(matches!(&root.overlay, Overlay::New(form) if form.error == Some(Key::SelectedSlotTooShort)));
            assert!(outbox_kinds(root).is_empty());
        });
    }

    #[gpui::test]
    async fn a_large_window_fills_the_calendar_and_keeps_the_drag_on_the_hour_grid(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(800.), px(550.)));
        cx.run_until_parked();
        let width = cx.debug_bounds("calendar-col-1").unwrap().size.width;

        cx.simulate_resize(gpui::size(px(1600.), px(1100.)));
        cx.run_until_parked();
        let grid = cx.debug_bounds("calendar-scroll").unwrap();
        let column = cx.debug_bounds("calendar-col-1").unwrap();
        let header = cx.debug_bounds("calendar-head-1").unwrap();
        assert!(column.size.width > width);
        assert_eq!(column.left(), header.left());
        assert_eq!(column.right(), header.right());
        assert_eq!(column.bottom(), grid.bottom());
        assert_eq!(column.right(), grid.right());
        assert!(column.size.height > px(900.));
        let hour = column.size.height / 12.;
        let x = column.left() + px(40.);
        let start = gpui::point(x, column.top() + hour + px(4.));
        let end = gpui::point(x, column.top() + hour * 2. - px(4.));
        cx.simulate_mouse_down(start, gpui::MouseButton::Left, Default::default());
        cx.simulate_mouse_move(end, gpui::MouseButton::Left, Default::default());
        cx.simulate_mouse_up(end, gpui::MouseButton::Left, Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert_eq!(root.vertical_scroll.handle.offset().y, px(0.));
            assert!(matches!(&root.overlay, Overlay::Slot(slot)
                if slot.staff_id == BEA && slot.start == 540 && slot.end == 600));
        });
    }

    #[gpui::test]
    async fn escape_closes_one_modal_at_a_time_even_without_a_focused_field(
        cx: &mut TestAppContext,
    ) {
        let (_dir, win) = open(cx);
        win.update(cx, |root, _, cx| {
            root.open_details(EXISTING, cx);
            let Overlay::Details(details) = &mut root.overlay else {
                panic!("expected appointment details");
            };
            details.checkout = Some(checkout::CheckoutReview::Failed);
        })
        .unwrap();
        cx.simulate_keystrokes(win.into(), "escape");
        win.update(cx, |root, _, _| {
            assert!(
                matches!(&root.overlay, Overlay::Details(details) if details.checkout.is_none())
            );
        })
        .unwrap();
        cx.simulate_keystrokes(win.into(), "escape");
        win.update(cx, |root, _, _| {
            assert!(matches!(root.overlay, Overlay::None));
            assert!(outbox_kinds(root).is_empty());
        })
        .unwrap();
    }

    #[gpui::test]
    async fn escape_closes_the_booking_form_with_a_focused_field(cx: &mut TestAppContext) {
        let (_dir, win) = open(cx);
        win.update(cx, |root, window, cx| {
            root.open_new(window, cx);
            let Overlay::New(form) = &root.overlay else {
                panic!("expected booking form");
            };
            form.client_search.read(cx).focus(window);
        })
        .unwrap();
        cx.simulate_keystrokes(win.into(), "escape");
        win.update(cx, |root, _, _| {
            assert!(matches!(root.overlay, Overlay::None));
            assert!(outbox_kinds(root).is_empty());
        })
        .unwrap();
    }

    #[gpui::test]
    async fn a_details_modal_blocks_the_calendar_and_closes_in_one_click(cx: &mut TestAppContext) {
        let (_dir, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(1200.), px(600.)));
        cx.run_until_parked();
        const SELECTOR: &str = "calendar-appointment-01a1d81e-0000-7000-8000-0000000000e1";
        let card = cx.debug_bounds(SELECTOR).unwrap();
        let point = gpui::point(card.left() + px(15.), card.center().y);
        cx.simulate_click(point, Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert!(matches!(root.overlay, Overlay::Details(_)))
        });

        let close = cx.debug_bounds("calendar-details-close").unwrap();
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: point,
            delta: gpui::ScrollDelta::Lines(gpui::point(0., 12.)),
            ..Default::default()
        });
        let content = cx.debug_bounds("appointment-details-services").unwrap();
        cx.simulate_click(content.center(), Default::default());
        cx.run_until_parked();
        assert_eq!(cx.debug_bounds(SELECTOR).unwrap(), card);
        root.update(cx, |root, _| {
            assert!(matches!(root.overlay, Overlay::Details(_)))
        });
        cx.simulate_click(point, Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert!(matches!(root.overlay, Overlay::None));
            assert!(root.slot_drag.is_none());
            assert!(outbox_kinds(root).is_empty());
        });

        cx.simulate_click(point, Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert!(matches!(root.overlay, Overlay::Details(_)))
        });
        cx.simulate_click(close.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| assert!(matches!(root.overlay, Overlay::None)));
    }

    #[gpui::test]
    async fn manual_booking_rejects_skipped_and_repeated_hours_before_queueing_a_client(
        cx: &mut TestAppContext,
    ) {
        let (_dir, win) = open(cx);
        win.update(cx, |root, window, cx| {
            root.tz = chrono_tz::Europe::Madrid;
            root.open_new(window, cx);
            for date in ["2026-03-29", "2026-10-25"] {
                let Overlay::New(form) = &mut root.overlay else {
                    panic!("expected booking form");
                };
                form.date = date.parse().unwrap();
                form.minutes = 150;
                form.staff_id = Some(ANA.into());
                form.services = vec![CUT.into()];
                form.new_client
                    .update(cx, |field, cx| field.set_text("Synthetic DST contact", cx));
                root.book(cx);
                assert!(matches!(
                    &root.overlay,
                    Overlay::New(form) if form.error == Some(Key::ErrInvalidLocalStart)
                ));
                assert!(outbox_kinds(root).is_empty());
            }
            let Overlay::New(form) = &mut root.overlay else {
                panic!("expected booking form");
            };
            form.minutes = 180;
            root.book(cx);
            assert_eq!(outbox_kinds(root), ["client.create", "appointment.create"]);
            let queued = root.svc.store.outbox(2).unwrap();
            let start = queued[1].payload["startsAt"].as_str().unwrap();
            assert_eq!(
                DateTime::parse_from_rfc3339(start).unwrap(),
                "2026-10-25T02:00:00Z".parse::<DateTime<Utc>>().unwrap()
            );
        })
        .unwrap();
    }

    #[test]
    fn changing_day_keeps_the_local_hour_across_the_clock_change() {
        let tz = chrono_tz::Europe::Madrid;
        for (before, after, elapsed) in [
            ("2026-03-28", "2026-03-29", 23),
            ("2026-10-24", "2026-10-25", 25),
        ] {
            let before = before.parse().unwrap();
            let after = after.parse().unwrap();
            let start = salon_local_instant(tz, before, 600).unwrap();
            let next = step_appointment_time(tz, start, 1440).unwrap();
            assert_eq!(next, salon_local_instant(tz, after, 600).unwrap());
            assert_eq!((next - start).num_hours(), elapsed);
            assert_eq!(step_appointment_time(tz, next, -1440), Some(start));
            let near_change = salon_local_instant(tz, before, 150).unwrap();
            assert!(step_appointment_time(tz, near_change, 1440).is_none());
        }
    }

    #[gpui::test]
    async fn the_calendar_and_dragged_ranges_follow_local_time_on_clock_change_days(
        cx: &mut TestAppContext,
    ) {
        let (_dir, win) = open(cx);
        win.update(cx, |root, _, _| {
            let tz = chrono_tz::Europe::Madrid;
            let spring = NaiveDate::from_ymd_opt(2026, 3, 29).unwrap();
            let autumn = NaiveDate::from_ymd_opt(2026, 10, 25).unwrap();
            let mut item = root.view.as_ref().unwrap().columns[0].items[0].clone();
            let (start, end) = slots::slot_times(tz, spring, 540, 600).unwrap();
            item.appointment.starts_at = start;
            item.appointment.ends_at = end;
            assert_eq!(appointment_bounds(&item, spring, tz).0, 9. * HOUR_PX);
            assert!(slots::slot_times(tz, spring, 120, 180).is_none());
            assert!(slots::slot_times(tz, autumn, 120, 180).is_none());
            let (start, end) = slots::slot_times(tz, spring, 90, 210).unwrap();
            assert_eq!((end - start).num_minutes(), 60);
        })
        .unwrap();
    }

    #[gpui::test]
    async fn large_catalog_stays_in_the_booking_panel_and_scrolls(cx: &mut TestAppContext) {
        let (_dir, mut config) = desk();
        config.start_view = Some("new".into());
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(1100.), px(690.)));
        root.update(cx, |root, cx| {
            let template = root
                .services
                .iter()
                .find(|service| service.id == CUT)
                .unwrap()
                .clone();
            let mut changes = Vec::new();
            for i in 0..160 {
                let mut service = template.clone();
                service.id = format!("01a1d81e-0000-7000-8001-{i:012x}");
                service.name = format!("Synthetic service {i}");
                let id = service.id.clone();
                let link = format!("fixture-service-staff-{i}");
                changes.push(up(
                    10 + i * 2,
                    "service",
                    &id,
                    serde_json::to_value(service).unwrap(),
                ));
                changes.push(up(
                    11 + i * 2,
                    "service_staff",
                    &link,
                    json!({"id": link, "serviceId": id, "staffId": ANA}),
                ));
            }
            root.svc.store.apply_page(&changes, 329).unwrap();
            root.reload(cx);
        });
        cx.run_until_parked();
        let panel = cx.debug_bounds("new-appointment-panel").unwrap();
        let list = cx.debug_bounds("new-service-list").unwrap();
        let footer = cx.debug_bounds("new-appointment-footer").unwrap();
        assert!(list.bottom() <= footer.top());
        assert!(footer.bottom() <= panel.bottom() && panel.bottom() < px(690.));
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: list.center(),
            delta: gpui::ScrollDelta::Lines(gpui::point(0., -6.)),
            ..Default::default()
        });
        cx.run_until_parked();
        root.update(cx, |root, _| {
            let Overlay::New(form) = &root.overlay else {
                panic!("missing booking");
            };
            assert!(form.service_scroll.offset().y < px(0.));
        });
        assert_eq!(cx.debug_bounds("new-appointment-footer").unwrap(), footer);
        cx.simulate_resize(gpui::size(px(530.), px(410.)));
        cx.run_until_parked();
        let narrow = cx.debug_bounds("new-appointment-footer").unwrap();
        assert!(narrow.right() < px(530.) && narrow.bottom() < px(410.));
    }

    #[gpui::test]
    async fn calendar_now_marker_moves_with_the_centres_clock_and_only_shows_today(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(1050.), px(690.)));
        root.update(cx, |root, cx| {
            root.calendar_now = "2026-03-09T13:00:00Z".parse().unwrap();
            cx.notify();
        });
        cx.run_until_parked();
        let earlier = cx.debug_bounds("calendar-now-line-2026-03-09-0").unwrap();
        assert_eq!(
            cx.debug_bounds("calendar-now-line-2026-03-09-1")
                .unwrap()
                .top(),
            earlier.top()
        );
        root.update(cx, |root, cx| {
            root.calendar_now += Span::minutes(15);
            cx.notify();
        });
        cx.run_until_parked();
        assert!(
            (cx.debug_bounds("calendar-now-line-2026-03-09-0")
                .unwrap()
                .top()
                - earlier.top())
                >= px(14.)
        );
        root.update(cx, |root, cx| {
            root.set_calendar_mode(CalendarMode::Week, cx)
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("calendar-now-line-2026-03-09-0").is_some());
        assert!(cx.debug_bounds("calendar-now-line-2026-03-10-1").is_none());
        root.update(cx, |root, cx| root.shift_day(1, cx));
        cx.run_until_parked();
        root.update(cx, |root, _| {
            let today = root.calendar_now.with_timezone(&root.tz).date_naive();
            assert!(
                root.calendar_columns()
                    .iter()
                    .all(|(date, _)| *date != today)
            );
        });
    }

    #[gpui::test]
    async fn calendar_wheel_scrolls_the_hours_without_moving_the_headers(cx: &mut TestAppContext) {
        let (_dir, config) = desk();
        let (_root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(800.), px(550.)));
        cx.run_until_parked();
        let before = cx
            .debug_bounds("calendar-col-0")
            .expect("first professional");
        let header = cx
            .debug_bounds("calendar-head-0")
            .expect("professional heading");
        let hour = cx.debug_bounds("calendar-hour-12").unwrap();
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: gpui::point(px(350.), px(400.)),
            delta: gpui::ScrollDelta::Lines(gpui::point(0., -12.)),
            ..Default::default()
        });
        cx.run_until_parked();
        let after = cx.debug_bounds("calendar-col-0").unwrap();
        assert!(after.origin.y < before.origin.y - px(100.));
        assert_eq!(after.origin.x, before.origin.x);
        assert_eq!(cx.debug_bounds("calendar-head-0").unwrap(), header);
        let moved_hour = cx.debug_bounds("calendar-hour-12").unwrap();
        assert_eq!(
            moved_hour.origin.y - hour.origin.y,
            after.origin.y - before.origin.y
        );
        let rail = cx.debug_bounds("calendar-hour-rail").unwrap();
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: gpui::point(rail.left() + px(10.), px(420.)),
            delta: gpui::ScrollDelta::Lines(gpui::point(0., 12.)),
            ..Default::default()
        });
        cx.run_until_parked();
        assert_eq!(cx.debug_bounds("calendar-col-0").unwrap(), before);
        assert_eq!(cx.debug_bounds("calendar-hour-12").unwrap(), hour);
    }

    #[gpui::test]
    async fn calendar_scrollbar_can_drag_to_later_hours(cx: &mut TestAppContext) {
        let (_dir, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(800.), px(550.)));
        cx.run_until_parked();
        let track = cx.debug_bounds("calendar-vertical-scrollbar").unwrap();
        let x = track.left() + px(6.);
        cx.simulate_mouse_down(
            gpui::point(x, track.top() + px(6.)),
            gpui::MouseButton::Left,
            Default::default(),
        );
        cx.simulate_event(gpui::MouseMoveEvent {
            position: gpui::point(x, track.bottom() - px(6.)),
            pressed_button: Some(gpui::MouseButton::Left),
            ..Default::default()
        });
        cx.simulate_mouse_up(
            gpui::point(x, track.bottom() - px(6.)),
            gpui::MouseButton::Left,
            Default::default(),
        );
        cx.run_until_parked();
        root.update(cx, |root, _| {
            let handle = &root.vertical_scroll.handle;
            assert!(handle.max_offset().height > px(100.));
            assert_eq!(handle.offset().y, -handle.max_offset().height);
        });
    }

    #[gpui::test]
    async fn a_narrow_week_calendar_scrolls_headers_and_days_together(cx: &mut TestAppContext) {
        let (_dir, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.set_calendar_mode(CalendarMode::Week, cx)
        });
        cx.simulate_resize(gpui::size(px(800.), px(700.)));
        cx.run_until_parked();
        let before = cx.debug_bounds("calendar-head-6").expect("Sunday heading");
        let hour = cx.debug_bounds("calendar-hour-12").unwrap();
        assert!(before.right() > px(800.));
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: gpui::point(px(400.), px(400.)),
            delta: gpui::ScrollDelta::Pixels(gpui::point(px(-600.), px(0.))),
            ..Default::default()
        });
        cx.run_until_parked();
        let after = cx.debug_bounds("calendar-head-6").unwrap();
        assert!(
            after.origin.x < before.origin.x - px(100.),
            "horizontal scroll must reveal later days"
        );
        assert!(after.right() <= px(800.));
        assert_eq!(cx.debug_bounds("calendar-hour-12").unwrap(), hour);
        assert_eq!(
            after.origin.x,
            cx.debug_bounds("calendar-col-6").unwrap().origin.x
        );
    }

    #[gpui::test]
    async fn week_view_changes_staff_without_mixing_their_calendars(cx: &mut TestAppContext) {
        let (_d, win) = open(cx);
        win.update(cx, |root, _, cx| {
            root.set_calendar_mode(CalendarMode::Week, cx);
            assert!(
                root.calendar_columns()
                    .iter()
                    .all(|(_, col)| col.staff.id == ANA)
            );
            root.set_week_staff(BEA.to_owned(), cx);
            assert_eq!(root.calendar_columns().len(), 7);
            assert!(
                root.calendar_columns()
                    .iter()
                    .all(|(_, col)| col.staff.id == BEA)
            );
        })
        .unwrap();
    }

    #[gpui::test]
    async fn booking_offline_queues_a_create_and_shows_it_as_pending(cx: &mut TestAppContext) {
        let (_d, win) = open(cx);
        win.update(cx, |root, window, cx| {
            root.open_new(window, cx);
            let Overlay::New(f) = &mut root.overlay else {
                panic!("form not open")
            };
            f.staff_id = Some(ANA.into());
            f.services = vec![CUT.into()];
            f.client_id = Some(LUCIA.into());
            f.minutes = 10 * 60;
            root.book(cx);
            assert!(matches!(root.overlay, Overlay::None));
            assert_eq!(outbox_kinds(root), ["appointment.create"]);
            let e = &root.svc.store.outbox(5).unwrap()[0];
            // 10:00 in Buenos Aires (UTC-3).
            assert_eq!(e.payload["startsAt"], json!("2026-03-09T13:00:00.000Z"));
            let pending: Vec<_> = root.view.as_ref().unwrap().columns[0]
                .items
                .iter()
                .filter(|i| i.pending)
                .collect();
            assert_eq!(pending.len(), 1);
            assert_eq!(root.summary.pending, 1);
        })
        .unwrap();
    }

    #[gpui::test]
    async fn time_off_is_visible_offline_and_removal_needs_confirmation(cx: &mut TestAppContext) {
        let (_d, win) = open(cx);
        win.update(cx, |root, _, cx| {
            root.open_block(None, root.date, cx);
            assert!(matches!(root.overlay, Overlay::Block(_)));
            root.save_block(cx);
            assert!(matches!(root.overlay, Overlay::None));
            let column = &root.view.as_ref().unwrap().columns[0];
            assert_eq!(column.items[0].appointment.id, EXISTING);
            let block = &column.blocks[0];
            assert!(block.pending);
            root.open_block(Some(block.time_off.clone()), root.date, cx);
            root.remove_block(cx);
            assert_eq!(outbox_kinds(root), ["time_off.create"]);
            root.remove_block(cx);
            assert!(matches!(root.overlay, Overlay::None));
            assert!(root.view.as_ref().unwrap().columns[0].blocks.is_empty());
            assert_eq!(outbox_kinds(root), ["time_off.create", "time_off.delete"]);
        })
        .unwrap();
    }

    #[gpui::test]
    async fn booking_inside_a_block_keeps_the_form_and_queues_no_new_client(
        cx: &mut TestAppContext,
    ) {
        let (_d, win) = open(cx);
        win.update(cx, |root, window, cx| {
            root.open_block(None, root.date, cx);
            root.save_block(cx);
            root.open_new(window, cx);
            let Overlay::New(form) = &mut root.overlay else {
                panic!("booking form not open");
            };
            form.staff_id = Some(ANA.into());
            form.services = vec![CUT.into()];
            form.minutes = 10 * 60;
            form.new_client.update(cx, |field, cx| field.set_text("Marta", cx));
            root.book(cx);
            assert!(matches!(&root.overlay, Overlay::New(form) if form.error == Some(Key::TimeOffOverlap)));
            assert_eq!(outbox_kinds(root), ["time_off.create"]);
            assert!(calendar::known_clients(&root.svc.store).unwrap().iter().all(|(_, name)| name != "Marta"));
        })
        .unwrap();
    }

    #[gpui::test]
    async fn an_incomplete_form_shows_an_error_and_queues_nothing(cx: &mut TestAppContext) {
        let (_d, win) = open(cx);
        win.update(cx, |root, window, cx| {
            root.open_new(window, cx);
            root.book(cx);
            let Overlay::New(f) = &root.overlay else {
                panic!("form closed")
            };
            assert_eq!(f.error, Some(Key::ErrPickService));
            assert!(outbox_kinds(root).is_empty());
        })
        .unwrap();
    }

    #[gpui::test]
    async fn switching_staff_drops_services_they_do_not_perform(cx: &mut TestAppContext) {
        let (_d, win) = open(cx);
        win.update(cx, |root, window, cx| {
            root.open_new(window, cx);
            let Overlay::New(f) = &mut root.overlay else {
                panic!()
            };
            f.staff_id = Some(ANA.into());
            f.services = vec![CUT.into(), NAILS.into()];
            root.pick_new_staff(BEA.into(), cx);
            let Overlay::New(f) = &root.overlay else {
                panic!()
            };
            assert_eq!(f.staff_id.as_deref(), Some(BEA));
            assert_eq!(f.services, vec![NAILS.to_string()]);
        })
        .unwrap();
    }

    #[gpui::test]
    async fn a_new_client_and_booking_are_queued_in_dependency_order(cx: &mut TestAppContext) {
        let (_d, win) = open(cx);
        win.update(cx, |root, window, cx| {
            root.open_new(window, cx);
            let Overlay::New(f) = &mut root.overlay else {
                panic!()
            };
            f.staff_id = Some(BEA.into());
            f.services = vec![NAILS.into()];
            f.new_client.update(cx, |t, cx| t.set_text("Marta", cx));
            root.book(cx);
            assert_eq!(outbox_kinds(root), ["client.create", "appointment.create"]);
            assert_eq!(
                root.view.as_ref().unwrap().columns[1].items[0].client_name,
                "Marta"
            );
        })
        .unwrap();
    }

    #[gpui::test]
    async fn moving_then_cancelling_queues_consecutive_versions_and_cancel_needs_confirmation(
        cx: &mut TestAppContext,
    ) {
        let (_d, win) = open(cx);
        win.update(cx, |root, _, cx| {
            root.open_details(EXISTING, cx);
            let Overlay::Details(d) = &mut root.overlay else {
                panic!("no details")
            };
            d.start += Span::minutes(15);
            root.apply_move(cx);
            assert!(matches!(root.overlay, Overlay::None));

            root.open_details(EXISTING, cx);
            root.cancel_appointment(cx);
            assert!(
                matches!(&root.overlay, Overlay::Details(d) if d.confirm_cancel),
                "first click only asks"
            );
            assert_eq!(outbox_kinds(root), ["appointment.reschedule"]);
            root.cancel_appointment(cx);
            assert_eq!(
                outbox_kinds(root),
                ["appointment.reschedule", "appointment.cancel"]
            );
            let q = root.svc.store.outbox(5).unwrap();
            assert_eq!(
                (
                    q[0].payload["version"].clone(),
                    q[1].payload["version"].clone()
                ),
                (json!(3), json!(4))
            );
            assert!(
                root.view.as_ref().unwrap().columns[0].items.is_empty(),
                "cancelled bookings leave the grid"
            );
        })
        .unwrap();
    }

    #[gpui::test]
    async fn a_cloud_move_requires_review_before_saving_the_open_desktop_draft(
        cx: &mut TestAppContext,
    ) {
        let (_dir, win) = open(cx);
        win.update(cx, |root, _, cx| {
            root.open_details(EXISTING, cx);
            root.cancel_appointment(cx);
            let Overlay::Details(draft) = &mut root.overlay else {
                panic!("missing appointment details");
            };
            draft.start += Span::minutes(15);
            let proposed_start = draft.start;
            let mut cloud = root.svc.store.appointment(EXISTING).unwrap().unwrap();
            cloud.version += 1;
            cloud.starts_at += Span::hours(2);
            cloud.ends_at += Span::hours(2);
            root.svc
                .store
                .apply_page(&[up(10, "appointment", EXISTING, json!(&cloud))], 10)
                .unwrap();

            root.cancel_appointment(cx);
            root.apply_move(cx);
            assert!(outbox_kinds(root).is_empty());
            root.review_updated_appointment(cx);
            assert!(matches!(&root.overlay, Overlay::Details(reviewed)
                if !reviewed.confirm_cancel && reviewed.start == proposed_start
                    && reviewed.reviewed.matches(&cloud)));
            root.apply_move(cx);
            let queued = root.svc.store.outbox(5).unwrap();
            assert_eq!(queued.len(), 1);
            assert_eq!(queued[0].payload["version"], json!(cloud.version));
        })
        .unwrap();
    }

    #[gpui::test]
    async fn reviewing_a_conflict_queues_only_the_intended_change_after_review(
        cx: &mut TestAppContext,
    ) {
        let (_dir, win) = open(cx);
        win.update(cx, |root, _, cx| {
            let proposed = "2026-03-09T17:00:00Z".parse().unwrap();
            ops::reschedule_appointment(&mut root.svc.store, EXISTING, Some(proposed), None)
                .unwrap();
            let sent = root.svc.store.outbox(1).unwrap();
            root.svc
                .store
                .apply_push_results(
                    &sent,
                    &[MutationResult::Rejected {
                        mutation_id: sent[0].mutation_id.clone(),
                        reason: "conflict".into(),
                        message: "Cloud appointment moved".into(),
                        replayed: false,
                    }],
                )
                .unwrap();
            let conflict = root.svc.store.conflicts().unwrap().remove(0);
            root.start_conflict_edit(&conflict, cx);
            assert!(matches!(&root.overlay, Overlay::Details(d) if d.start == proposed));
            let mut cloud = root.svc.store.appointment(EXISTING).unwrap().unwrap();
            cloud.version += 1;
            cloud.starts_at += Span::hours(4);
            cloud.ends_at += Span::hours(4);
            root.svc
                .store
                .apply_page(&[up(10, "appointment", EXISTING, json!(&cloud))], 10)
                .unwrap();
            root.apply_move(cx);
            assert!(root.svc.store.outbox(1).unwrap().is_empty());
            assert_eq!(root.svc.store.conflicts().unwrap().len(), 1);
            root.review_updated_appointment(cx);
            root.apply_move(cx);
            assert!(matches!(root.overlay, Overlay::Conflicts { .. }));
            assert!(root.svc.store.conflicts().unwrap().is_empty());
            let next = root.svc.store.outbox(1).unwrap().remove(0);
            assert_eq!(next.payload["version"], json!(cloud.version));
            assert!(next.payload.get("staffId").is_none());
        })
        .unwrap();
    }

    #[gpui::test]
    async fn recording_an_outcome_queues_it_offline_and_prevents_further_edits(
        cx: &mut TestAppContext,
    ) {
        let (_d, win) = open(cx);
        win.update(cx, |root, _, cx| {
            root.open_details(EXISTING, cx);
            root.set_outcome(
                AppointmentStatus::Completed,
                "2026-03-10T12:00:00Z".parse().unwrap(),
                cx,
            );
            assert!(matches!(root.overlay, Overlay::None));
            assert_eq!(outbox_kinds(root), ["appointment.set_status"]);
            assert_eq!(
                root.svc.store.outbox(5).unwrap()[0].payload["version"],
                json!(3)
            );
            let current = calendar::effective_appointment(&root.svc.store, EXISTING)
                .unwrap()
                .unwrap();
            assert_eq!(current.status, AppointmentStatus::Completed);
            root.open_details(EXISTING, cx);
            root.set_outcome(
                AppointmentStatus::NoShow,
                "2026-03-10T12:00:00Z".parse().unwrap(),
                cx,
            );
            assert!(matches!(&root.overlay, Overlay::Details(d) if d.error.is_some()));
            assert_eq!(outbox_kinds(root).len(), 1);
        })
        .unwrap();
    }

    #[gpui::test]
    async fn a_rejected_booking_is_resolved_by_picking_another_time(cx: &mut TestAppContext) {
        let (_d, win) = open(cx);
        win.update(cx, |root, window, cx| {
            root.open_new(window, cx);
            let Overlay::New(f) = &mut root.overlay else {
                panic!()
            };
            f.staff_id = Some(ANA.into());
            f.services = vec![CUT.into()];
            f.client_id = Some(LUCIA.into());
            root.book(cx);
            // The server said no (what a sync cycle would do).
            let sent = root.svc.store.outbox(1).unwrap();
            let rej = MutationResult::Rejected {
                mutation_id: sent[0].mutation_id.clone(),
                reason: "slot_taken".into(),
                message: "taken".into(),
                replayed: false,
            };
            root.svc.store.apply_push_results(&sent, &[rej]).unwrap();
            root.reload(cx);
            assert_eq!(root.summary.conflicts, 1);
            assert!(
                root.view.as_ref().unwrap().columns[0]
                    .items
                    .iter()
                    .all(|i| i.appointment.id == EXISTING)
            );

            let c = root.conflicts[0].clone();
            root.start_conflict_edit(&c, cx);
            let Overlay::Conflicts {
                editing: Some(e), ..
            } = &mut root.overlay
            else {
                panic!("no draft")
            };
            e.start += Span::hours(2);
            let (start, staff) = (e.start, e.staff_id.clone());
            root.resolve(
                &c.mutation_id,
                Resolution::Reschedule {
                    starts_at: start,
                    staff_id: Some(staff),
                },
                cx,
            );
            assert_eq!(root.summary.conflicts, 1);
            assert!(root.svc.store.outbox(5).unwrap().is_empty());
            let Overlay::Conflicts {
                editing: Some(e),
                error: Some(_),
                ..
            } = &mut root.overlay
            else {
                panic!("occupied retry must keep the draft");
            };
            e.start += Span::hours(1);
            let (start, staff) = (e.start, e.staff_id.clone());
            root.resolve(
                &c.mutation_id,
                Resolution::Reschedule {
                    starts_at: start,
                    staff_id: Some(staff),
                },
                cx,
            );
            assert_eq!(root.summary.conflicts, 0);
            let q = root.svc.store.outbox(5).unwrap();
            assert_eq!(q.len(), 1);
            assert_eq!(q[0].payload["startsAt"], json!("2026-03-09T16:00:00.000Z"));
            assert_ne!(q[0].mutation_id, c.mutation_id);
        })
        .unwrap();
    }

    #[gpui::test]
    async fn conflict_reasons_have_user_facing_copy(cx: &mut TestAppContext) {
        let (_d, win) = open(cx);
        win.update(cx, |root, _, _| {
            for r in [
                "slot_taken",
                "slot_unavailable",
                "conflict",
                "not_found",
                "invalid_state",
                "sync_generation_changed",
                "forbidden",
                "invalid",
                "other",
            ] {
                assert!(!root.conflict_reason(r).is_empty());
            }
            assert_eq!(
                root.conflict_reason("slot_taken"),
                "That time is no longer available."
            );
            assert_eq!(root.conflict_reason("intake_required"), "Complete the current required forms in the web application, then retry this proposal. If you booked there, discard this proposal to avoid another visit.");
        })
        .unwrap();
    }

    #[gpui::test]
    async fn signing_out_returns_to_login_and_forgets_the_session(cx: &mut TestAppContext) {
        let (_d, win) = open(cx);
        win.update(cx, |root, _, cx| {
            root.sign_out(cx);
            assert!(matches!(root.screen, Screen::Login));
            assert!(root.svc.tokens.load().unwrap().is_none());
            assert!(root.svc.current_session().is_none());
        })
        .unwrap();
    }
}
