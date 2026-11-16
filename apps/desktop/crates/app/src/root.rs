//! The application view: login, the day calendar, the booking and detail dialogs and the
//! conflict review. All state transitions go through `sob_core` (store, ops, runner); this file
//! only renders and forwards user intent.

use std::time::Duration;

use chrono::{DateTime, Datelike, Duration as Span, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use gpui::prelude::*;
use gpui::{
    App, ClickEvent, Context, ElementId, Entity, FontWeight, IntoElement, Render, SharedString,
    Stateful, Subscription, Window, div, px,
};
use sob_core::auth::{AuthError, Credentials, Session, TokenStore};
use sob_core::calendar::{self, CalendarItem, DayView, SyncSummary};
use sob_core::i18n::{self, Key, Locale};
use sob_core::model::*;
use sob_core::ops::{self, NewAppointment, Resolution};
use sob_core::runner::{Connectivity, SyncStatus, Wake};

use crate::config::Config;
use crate::field::{FieldEvent, TextField};
use crate::services::Services;
use crate::theme;

const HOUR_PX: f32 = 60.0;
const GUTTER_PX: f32 = 56.0;

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
    email: Entity<TextField>,
    password: Entity<TextField>,
    busy: bool,
    error: Option<Key>,
}

struct NewForm {
    date: NaiveDate,
    minutes: i64,
    staff_id: Option<String>,
    services: Vec<String>,
    client_id: Option<String>,
    new_client: Entity<TextField>,
    new_client_phone: Entity<TextField>,
    notes: Entity<TextField>,
    error: Option<Key>,
}

struct Details {
    id: String,
    original_start: DateTime<Utc>,
    original_staff: String,
    start: DateTime<Utc>,
    staff_id: String,
    confirm_cancel: bool,
    error: Option<String>,
}

struct ConflictDraft {
    mutation_id: String,
    start: DateTime<Utc>,
    staff_id: String,
}

enum Overlay {
    None,
    New(Box<NewForm>),
    Details(Box<Details>),
    Conflicts {
        editing: Option<ConflictDraft>,
        error: Option<String>,
    },
}

pub struct Root {
    svc: Services,
    locale: Locale,
    screen: Screen,
    login: LoginForm,
    date: NaiveDate,
    tz: Tz,
    view: Option<DayView>,
    week_mode: bool,
    week_views: Vec<DayView>,
    week_staff_id: String,
    theme_override: Option<bool>,
    pending_local_today: bool,
    status: SyncStatus,
    summary: SyncSummary,
    conflicts: Vec<Conflict>,
    clients: Vec<(String, String)>,
    staff: Vec<Staff>,
    services: Vec<Service>,
    overlay: Overlay,
    last_sig: Option<(SyncStatus, SyncSummary)>,
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
        let t = |k| i18n::t(locale, k);
        let email = cx.new(|cx| TextField::new(t(Key::Email), false, cx));
        let password = cx.new(|cx| TextField::new(t(Key::Password), true, cx));
        let mut subs = vec![];
        for field in [&email, &password] {
            subs.push(
                cx.subscribe(field, |this: &mut Root, _, ev: &FieldEvent, cx| {
                    if matches!(ev, FieldEvent::Submit) {
                        this.submit_login(cx);
                    }
                }),
            );
        }
        let mut root = Self {
            svc,
            locale,
            screen: Screen::Login,
            login: LoginForm {
                email: email.clone(),
                password,
                busy: false,
                error: None,
            },
            date: start_date.unwrap_or_else(|| Utc::now().with_timezone(&tz).date_naive()),
            tz,
            view: None,
            week_mode: false,
            week_views: vec![],
            week_staff_id: String::new(),
            theme_override,
            pending_local_today,
            status: SyncStatus::default(),
            summary: SyncSummary::default(),
            conflicts: vec![],
            clients: vec![],
            staff: vec![],
            services: vec![],
            overlay: Overlay::None,
            last_sig: None,
            _subs: subs,
        };
        if let Some(saved) = root.svc.load_saved_session() {
            // Offline-first: a saved session opens the app at once; validity is checked in the
            // background and only a definite "no" signs the user out.
            root.enter_main(cx);
            root.validate_saved(saved, cx);
            root.open_start_view(start_view.as_deref(), window, cx);
        } else {
            email.read(cx).focus(window);
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
            Some("new") => self.open_new(window, cx),
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
        if self.login.busy {
            return;
        }
        let creds = Credentials {
            email: self.login.email.read(cx).text().trim().to_owned(),
            password: self.login.password.read(cx).text().to_owned(),
        };
        if creds.email.is_empty() || creds.password.is_empty() {
            return;
        }
        self.login.busy = true;
        self.login.error = None;
        cx.notify();
        let auth = self.svc.auth.clone();
        cx.spawn(async move |this, cx| {
            let res = cx
                .background_executor()
                .spawn(async move { sob_core::auth::AuthProvider::sign_in(&*auth, &creds) })
                .await;
            let _ = this.update(cx, |this, cx| this.finish_login(res, cx));
        })
        .detach();
    }

    fn finish_login(&mut self, res: Result<Session, AuthError>, cx: &mut Context<Self>) {
        self.login.busy = false;
        match res {
            Ok(session) => {
                let _ = self.svc.tokens.save(&session);
                self.svc.set_session(Some(session));
                self.login.password.update(cx, |f, cx| f.clear(cx));
                self.enter_main(cx);
            }
            Err(e) => {
                self.login.error = Some(match e {
                    AuthError::InvalidCredentials => Key::ErrWrongCredentials,
                    AuthError::WrongRole(_) => Key::ErrWrongRole,
                    AuthError::Network(_) => Key::ErrNetwork,
                    _ => Key::ErrGeneric,
                });
            }
        }
        cx.notify();
    }

    fn enter_main(&mut self, cx: &mut Context<Self>) {
        self.screen = Screen::Main;
        if let Err(e) = self.svc.start_sync() {
            eprintln!("could not start sync: {e}");
        }
        self.last_sig = None;
        self.reload(cx);
    }

    fn validate_saved(&mut self, session: Session, cx: &mut Context<Self>) {
        let auth = self.svc.auth.clone();
        cx.spawn(async move |this, cx| {
            let ok = cx
                .background_executor()
                .spawn(async move { sob_core::auth::AuthProvider::validate(&*auth, &session) })
                .await;
            if let Ok(false) = ok {
                let _ = this.update(cx, |this, cx| this.sign_out(cx));
            }
        })
        .detach();
    }

    fn sign_out(&mut self, cx: &mut Context<Self>) {
        self.svc.sign_out();
        self.screen = Screen::Login;
        self.overlay = Overlay::None;
        cx.notify();
    }

    // ---------------------------------------------------------------- data

    fn tick(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.screen, Screen::Main) {
            return;
        }
        let status = self.svc.status();
        let summary = calendar::sync_summary(&self.svc.store).unwrap_or_default();
        let sig = (status.clone(), summary);
        if self.last_sig.as_ref() != Some(&sig) {
            self.last_sig = Some(sig);
            self.reload(cx);
        }
        if status.connectivity == Connectivity::AuthRequired && !self.status_is_auth() {
            cx.notify();
        }
    }

    fn status_is_auth(&self) -> bool {
        self.status.connectivity == Connectivity::AuthRequired
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        let store = &self.svc.store;
        self.tz = calendar::salon_tz(store).unwrap_or(Tz::UTC);
        if self.pending_local_today && store.salon_settings().ok().flatten().is_some() {
            self.date = Utc::now().with_timezone(&self.tz).date_naive();
            if self.week_mode {
                self.date -= Span::days(self.date.weekday().num_days_from_monday().into());
            }
            self.pending_local_today = false;
        }
        self.view = calendar::day_view(store, self.date).ok();
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
        self.week_views = if self.week_mode {
            calendar::week_view(store, self.date).unwrap_or_default()
        } else {
            vec![]
        };
        self.status = self.svc.status();
        self.summary = calendar::sync_summary(store).unwrap_or_default();
        self.conflicts = store.conflicts().unwrap_or_default();
        self.clients = calendar::known_clients(store).unwrap_or_default();
        self.staff = store.staff().unwrap_or_default();
        self.services = store
            .services()
            .unwrap_or_default()
            .into_iter()
            .filter(|s| s.active)
            .collect();
        cx.notify();
    }

    /// After a local edit: show it now, and tell the worker.
    fn edited(&mut self, cx: &mut Context<Self>) {
        self.svc.wake(Wake::Local);
        self.last_sig = None;
        self.reload(cx);
    }

    fn shift_day(&mut self, days: i64, cx: &mut Context<Self>) {
        self.pending_local_today = false;
        self.date += Span::days(days * if self.week_mode { 7 } else { 1 });
        self.reload(cx);
    }

    fn today(&mut self, cx: &mut Context<Self>) {
        self.date = Utc::now().with_timezone(&self.tz).date_naive();
        if self.week_mode {
            self.date -= Span::days(self.date.weekday().num_days_from_monday().into());
        }
        self.reload(cx);
    }

    fn set_week(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.week_mode = enabled;
        if enabled {
            self.date -= Span::days(self.date.weekday().num_days_from_monday().into());
        }
        self.reload(cx);
    }

    fn set_week_staff(&mut self, id: String, cx: &mut Context<Self>) {
        self.week_staff_id = id;
        cx.notify();
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
        if self.week_mode {
            self.week_views
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
                .map(|view| view.columns.iter().map(|col| (view.date, col)).collect())
                .unwrap_or_default()
        }
    }

    // ---------------------------------------------------------------- time helpers

    fn at_local(&self, date: NaiveDate, minutes: i64) -> DateTime<Utc> {
        let m = minutes.clamp(0, 24 * 60 - 15);
        let naive = date
            .and_hms_opt((m / 60) as u32, (m % 60) as u32, 0)
            .expect("valid time");
        self.tz
            .from_local_datetime(&naive)
            .earliest()
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|| Utc.from_utc_datetime(&naive))
    }

    fn hhmm(&self, dt: DateTime<Utc>) -> String {
        let l = dt.with_timezone(&self.tz);
        format!("{:02}:{:02}", l.hour(), l.minute())
    }

    fn date_time_label(&self, dt: DateTime<Utc>) -> String {
        let l = dt.with_timezone(&self.tz);
        format!(
            "{} {}",
            i18n::date_label(self.locale, l.date_naive()),
            self.hhmm(dt)
        )
    }

    fn staff_name(&self, id: &str) -> String {
        self.staff
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.display_name.clone())
            .unwrap_or_default()
    }

    fn client_name(&self, id: &str) -> String {
        self.clients
            .iter()
            .find(|(cid, _)| cid == id)
            .map(|(_, n)| n.clone())
            .unwrap_or_else(|| self.t(Key::UnknownClient).to_owned())
    }

    // ---------------------------------------------------------------- dialogs: new

    fn open_new(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let t = |k| i18n::t(self.locale, k);
        let new_client = cx.new(|cx| TextField::new(t(Key::ClientName), false, cx));
        let new_client_phone = cx.new(|cx| TextField::new(t(Key::ClientPhone), false, cx));
        let notes = cx.new(|cx| TextField::new(t(Key::Notes), false, cx));
        let _ = window;
        self.overlay = Overlay::New(Box::new(NewForm {
            date: self.date,
            minutes: 10 * 60,
            staff_id: self.staff.first().map(|s| s.id.clone()),
            services: vec![],
            client_id: None,
            new_client,
            new_client_phone,
            notes,
            error: None,
        }));
        cx.notify();
    }

    /// Choosing a staff member drops selected services they do not perform.
    fn pick_new_staff(&mut self, id: String, cx: &mut Context<Self>) {
        let performed = ops::performed_services(&self.svc.store, &id).unwrap_or_default();
        if let Overlay::New(f) = &mut self.overlay {
            f.services.retain(|s| performed.contains(s));
            f.staff_id = Some(id);
        }
        cx.notify();
    }

    fn book(&mut self, cx: &mut Context<Self>) {
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
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
        if form.client_id.is_none() && name.is_empty() {
            form.error = Some(Key::ErrPickClient);
            cx.notify();
            return;
        }
        let (date, minutes, services, chosen) = (
            form.date,
            form.minutes,
            form.services.clone(),
            form.client_id.clone(),
        );
        let starts_at = self.at_local(date, minutes);
        let result = (|| {
            let client_id = match chosen {
                Some(id) => id,
                None => ops::create_client(
                    &mut self.svc.store,
                    &name,
                    (!phone.is_empty()).then_some(phone.as_str()),
                )?,
            };
            ops::create_appointment(
                &mut self.svc.store,
                NewAppointment {
                    staff_id,
                    service_ids: services,
                    starts_at,
                    client_id,
                    notes: (!notes.is_empty()).then_some(notes),
                    override_notice: false,
                },
            )
        })();
        match result {
            Ok(_) => {
                self.overlay = Overlay::None;
                self.date = starts_at.with_timezone(&self.tz).date_naive();
                self.edited(cx);
            }
            Err(e) => {
                eprintln!("booking failed: {e}");
                if let Overlay::New(f) = &mut self.overlay {
                    f.error = Some(Key::ErrGeneric);
                }
                cx.notify();
            }
        }
    }

    // ---------------------------------------------------------------- dialogs: details

    fn open_details(&mut self, id: &str, cx: &mut Context<Self>) {
        let Ok(Some(a)) = calendar::effective_appointment(&self.svc.store, id) else {
            return;
        };
        self.overlay = Overlay::Details(Box::new(Details {
            id: a.id.clone(),
            original_start: a.starts_at,
            original_staff: a.staff_id.clone(),
            start: a.starts_at,
            staff_id: a.staff_id,
            confirm_cancel: false,
            error: None,
        }));
        cx.notify();
    }

    fn apply_move(&mut self, cx: &mut Context<Self>) {
        let Overlay::Details(d) = &mut self.overlay else {
            return;
        };
        let start = (d.start != d.original_start).then_some(d.start);
        let staff = (d.staff_id != d.original_staff).then(|| d.staff_id.clone());
        match ops::reschedule_appointment(&mut self.svc.store, &d.id, start, staff.as_deref()) {
            Ok(()) => {
                self.overlay = Overlay::None;
                self.edited(cx);
            }
            Err(e) => {
                d.error = Some(e.to_string());
                cx.notify();
            }
        }
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
        match ops::cancel_appointment(&mut self.svc.store, &d.id) {
            Ok(()) => {
                self.overlay = Overlay::None;
                self.edited(cx);
            }
            Err(e) => {
                d.error = Some(e.to_string());
                cx.notify();
            }
        }
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
        match ops::set_appointment_status(&mut self.svc.store, &d.id, status, now) {
            Ok(()) => {
                self.overlay = Overlay::None;
                self.edited(cx);
            }
            Err(error) => {
                d.error = Some(error.to_string());
                cx.notify();
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
                self.overlay = Overlay::Conflicts {
                    editing: None,
                    error: Some(e.to_string()),
                };
                cx.notify();
            }
        }
    }

    fn start_conflict_edit(&mut self, c: &Conflict, cx: &mut Context<Self>) {
        let start = c
            .payload
            .get("startsAt")
            .and_then(|v| v.as_str())
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
            .or_else(|| {
                calendar::effective_appointment(&self.svc.store, &c.entity_id)
                    .ok()
                    .flatten()
                    .map(|a| a.starts_at)
            })
            .unwrap_or_else(Utc::now);
        let staff_id = c
            .payload
            .get("staffId")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .or_else(|| {
                calendar::effective_appointment(&self.svc.store, &c.entity_id)
                    .ok()
                    .flatten()
                    .map(|a| a.staff_id)
            })
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
                            .child(t(Key::SignInTitle)),
                    )
                    .child(self.label(Key::Email))
                    .child(self.login.email.clone())
                    .child(self.label(Key::Password))
                    .child(self.login.password.clone())
                    .when_some(self.login.error, |d, e| {
                        d.child(div().text_sm().text_color(theme::conflict_fg()).child(t(e)))
                    })
                    .child(
                        self.button(
                            "sign-in",
                            if self.login.busy {
                                t(Key::SigningIn)
                            } else {
                                t(Key::SignIn)
                            },
                            Kind::Primary,
                            cx.listener(|this, _, _, cx| this.submit_login(cx)),
                        )
                        .mt_2(),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme::muted())
                            .child(SharedString::from(format!(
                                "{}: {}",
                                t(Key::ServerUrl),
                                self.svc.config.api_url
                            ))),
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

    fn render_header(&self, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_4()
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
                    .child(
                        div()
                            .ml_2()
                            .text_base()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(SharedString::from(i18n::date_label(self.locale, self.date))),
                    ),
            )
            .child(self.button(
                "view-day",
                self.t(Key::ViewDay),
                if self.week_mode {
                    Kind::Ghost
                } else {
                    Kind::Primary
                },
                cx.listener(|this, _, _, cx| this.set_week(false, cx)),
            ))
            .child(self.button(
                "view-week",
                self.t(Key::ViewWeek),
                if self.week_mode {
                    Kind::Primary
                } else {
                    Kind::Ghost
                },
                cx.listener(|this, _, _, cx| this.set_week(true, cx)),
            ))
            .child(div().flex_1())
            .child(self.status_cluster(cx))
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
            .child(self.button(
                "sign-out",
                self.t(Key::SignOut),
                Kind::Ghost,
                cx.listener(|this, _, _, cx| this.sign_out(cx)),
            ))
    }

    fn visible_hours(&self, view: &DayView) -> (u32, u32) {
        let (mut first, mut last) = (8u32, 20u32);
        for col in &view.columns {
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

    fn render_block(
        &self,
        item: &CalendarItem,
        date: NaiveDate,
        first_hour: u32,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let a = &item.appointment;
        let start_local = a.starts_at.with_timezone(&self.tz);
        let day_start = self.at_local(date, 0);
        let from_min = ((a.starts_at - day_start).num_minutes() as f32).max(0.0);
        let _ = start_local;
        let top = (from_min - first_hour as f32 * 60.0) * HOUR_PX / 60.0;
        let len_min = (a.ends_at - a.starts_at).num_minutes().max(15) as f32;
        let height = (len_min * HOUR_PX / 60.0 - 2.0).max(22.0);
        let (bg, edge) = if item.conflict {
            (theme::conflict_bg(), theme::conflict_fg())
        } else if item.pending {
            (theme::pending_bg(), theme::warn())
        } else {
            (theme::accent_soft(), theme::accent())
        };
        let id = a.id.clone();
        let services = a
            .services
            .iter()
            .map(|s| s.name.clone())
            .collect::<Vec<_>>()
            .join(", ");
        div()
            .id(SharedString::from(format!("appt-{}", a.id)))
            .absolute()
            .top(px(top))
            .left(px(3.))
            .right(px(3.))
            .h(px(height))
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
            .on_click(cx.listener(move |this, _, _, cx| this.open_details(&id, cx)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_1()
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .truncate()
                            .child(SharedString::from(item.client_name.clone())),
                    )
                    .when(item.conflict, |d| {
                        d.child(self.badge(
                            self.t(Key::ConflictBadge),
                            theme::conflict_fg(),
                            theme::conflict_bg(),
                        ))
                    })
                    .when(item.pending && !item.conflict, |d| {
                        d.child(self.badge(
                            self.t(Key::PendingBadge),
                            theme::pending_fg(),
                            rgb_white(),
                        ))
                    }),
            )
            .child(
                div()
                    .text_color(theme::muted())
                    .truncate()
                    .child(SharedString::from(format!(
                        "{}-{}  {}",
                        self.hhmm(a.starts_at),
                        self.hhmm(a.ends_at),
                        services
                    ))),
            )
            .into_any_element()
    }

    fn render_calendar(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
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
        let (first, last) = if self.week_mode {
            self.week_views
                .iter()
                .map(|view| self.visible_hours(view))
                .fold((8, 20), |(a, b), (c, d)| (a.min(c), b.max(d)))
        } else {
            self.visible_hours(view)
        };
        let visible_columns = self.calendar_columns();
        let total_h = (last - first) as f32 * HOUR_PX;
        let hours = div()
            .w(px(GUTTER_PX))
            .flex_none()
            .relative()
            .h(px(total_h))
            .children((first..last).map(|h| {
                div()
                    .absolute()
                    .top(px((h - first) as f32 * HOUR_PX - 7.0))
                    .right(px(8.))
                    .text_xs()
                    .text_color(theme::muted())
                    .child(SharedString::from(format!("{h:02}:00")))
            }));
        let columns = visible_columns
            .iter()
            .enumerate()
            .map(|(index, (date, col))| {
                div()
                    .debug_selector(|| format!("calendar-col-{index}"))
                    .flex_1()
                    .min_w(px(160.))
                    .relative()
                    .h(px(total_h))
                    .border_l_1()
                    .border_color(theme::line())
                    .children((first..last).map(|h| {
                        div()
                            .absolute()
                            .top(px((h - first) as f32 * HOUR_PX))
                            .left_0()
                            .right_0()
                            .h(px(1.))
                            .bg(theme::line_soft())
                    }))
                    .children(
                        col.items
                            .iter()
                            .map(|item| self.render_block(item, *date, first, cx)),
                    )
            });
        let heads = visible_columns
            .iter()
            .enumerate()
            .map(|(index, (date, col))| {
                div()
                    .debug_selector(|| format!("calendar-head-{index}"))
                    .flex_1()
                    .min_w(px(160.))
                    .h(px(36.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .border_l_1()
                    .border_color(theme::line())
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(SharedString::from(if self.week_mode {
                        format!(
                            "{} {}",
                            i18n::weekday_short(self.locale, date.weekday()),
                            date.format("%d/%m")
                        )
                    } else {
                        col.staff.display_name.clone()
                    }))
            });
        div()
            .id("calendar-horizontal-scroll")
            .flex_1()
            .min_w_0()
            .min_h_0()
            .overflow_x_scroll()
            .child(
                div()
                    .w_full()
                    .h_full()
                    .min_w(px(GUTTER_PX + visible_columns.len() as f32 * 160.))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .border_b_1()
                            .border_color(theme::line())
                            .bg(theme::panel())
                            .child(div().w(px(GUTTER_PX)).flex_none())
                            .children(heads),
                    )
                    .child(
                        div()
                            .id("calendar-scroll")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .bg(theme::panel())
                            .child(div().flex().child(hours).children(columns)),
                    ),
            )
            .into_any_element()
    }

    // ---------------------------------------------------------------- render: overlays

    fn modal(&self, body: gpui::Div) -> gpui::Div {
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(theme::backdrop())
            .child(
                body.w(px(560.))
                    .max_h(px(720.))
                    .p_5()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme::line())
                    .bg(theme::panel())
                    .shadow_lg(),
            )
    }

    fn stepper(
        &self,
        prefix: &'static str,
        start: DateTime<Utc>,
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
                    .child(SharedString::from(self.date_time_label(start))),
            )
            .child(mk("m+", Key::MoveLater, 15, cx))
            .child(mk("d+", Key::MoveNextDay, 1440, cx))
    }

    fn staff_chips(
        &self,
        prefix: &'static str,
        selected: &str,
        cx: &mut Context<Self>,
        pick: fn(&mut Root, String, &mut Context<Root>),
    ) -> gpui::Div {
        div()
            .flex()
            .flex_wrap()
            .gap_2()
            .children(self.staff.iter().enumerate().map(|(i, s)| {
                let id = s.id.clone();
                self.chip(
                    (prefix, i),
                    SharedString::from(s.display_name.clone()),
                    s.id == selected,
                    cx.listener(move |this, _, _, cx| pick(this, id.clone(), cx)),
                )
            }))
    }

    fn render_new(&self, f: &NewForm, cx: &mut Context<Self>) -> gpui::Div {
        let start = self.at_local(f.date, f.minutes);
        let selected_staff = f.staff_id.clone().unwrap_or_default();
        let clients = div()
            .id("new-clients")
            .max_h(px(96.))
            .overflow_y_scroll()
            .flex()
            .flex_wrap()
            .gap_2()
            .children(self.clients.iter().enumerate().map(|(i, (id, name))| {
                let cid = id.clone();
                self.chip(
                    ("client", i),
                    SharedString::from(name.clone()),
                    f.client_id.as_deref() == Some(id.as_str()),
                    cx.listener(move |this, _, _, cx| {
                        if let Overlay::New(f) = &mut this.overlay {
                            f.client_id = if f.client_id.as_deref() == Some(cid.as_str()) {
                                None
                            } else {
                                Some(cid.clone())
                            };
                        }
                        cx.notify();
                    }),
                )
            }));
        let performed =
            ops::performed_services(&self.svc.store, &selected_staff).unwrap_or_default();
        let offered = self.services.iter().filter(|s| performed.contains(&s.id));
        let services = div()
            .flex()
            .flex_wrap()
            .gap_2()
            .children(offered.enumerate().map(|(i, s)| {
                let sid = s.id.clone();
                self.chip(
                    ("service", i),
                    SharedString::from(format!("{} ({} min)", s.name, s.duration_minutes)),
                    f.services.contains(&s.id),
                    cx.listener(move |this, _, _, cx| {
                        if let Overlay::New(f) = &mut this.overlay {
                            match f.services.iter().position(|x| *x == sid) {
                                Some(p) => {
                                    f.services.remove(p);
                                }
                                None => f.services.push(sid.clone()),
                            }
                        }
                        cx.notify();
                    }),
                )
            }));
        self.modal(
            div()
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::BOLD)
                        .child(self.t(Key::NewAppointment)),
                )
                .child(self.label(Key::Staff))
                .child(
                    self.staff_chips("new-staff", &selected_staff, cx, |this, id, cx| {
                        this.pick_new_staff(id, cx)
                    }),
                )
                .child(self.label(Key::Client))
                .child(clients)
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .child(div().flex_1().child(f.new_client.clone()))
                        .child(div().flex_1().child(f.new_client_phone.clone())),
                )
                .child(self.label(Key::Services))
                .child(services)
                .child(self.label(Key::Start))
                .child(self.stepper("new-start", start, cx, |this, minutes, cx| {
                    if let Overlay::New(f) = &mut this.overlay {
                        let total = f.minutes + minutes;
                        f.date += Span::days(total.div_euclid(1440));
                        f.minutes = total.rem_euclid(1440);
                    }
                    cx.notify();
                }))
                .child(f.notes.clone())
                .when_some(f.error, |d, e| {
                    d.child(
                        div()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(self.t(e)),
                    )
                })
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap_2()
                        .child(self.button(
                            "new-cancel",
                            self.t(Key::Cancel),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| {
                                this.overlay = Overlay::None;
                                cx.notify();
                            }),
                        ))
                        .child(self.button(
                            "new-book",
                            self.t(Key::Book),
                            Kind::Primary,
                            cx.listener(|this, _, _, cx| this.book(cx)),
                        )),
                ),
        )
    }

    fn render_details(&self, d: &Details, cx: &mut Context<Self>) -> gpui::Div {
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
        let services = current
            .as_ref()
            .map(|a| {
                a.services
                    .iter()
                    .map(|s| s.name.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        let client = current
            .as_ref()
            .map(|a| self.client_name(&a.client_id))
            .unwrap_or_default();
        let editable = current
            .as_ref()
            .is_some_and(|a| a.status == AppointmentStatus::Booked);
        let can_set_outcome =
            editable && current.as_ref().is_some_and(|a| a.starts_at <= Utc::now());
        let changed = editable && (d.start != d.original_start || d.staff_id != d.original_staff);
        self.modal(
            div()
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
                        .child(SharedString::from(format!(
                            "{} - {}",
                            self.staff_name(&d.original_staff),
                            services
                        ))),
                )
                .child(
                    div()
                        .text_sm()
                        .child(SharedString::from(self.date_time_label(d.original_start))),
                )
                .when(editable, |x| {
                    x.child(self.label(Key::MoveTo))
                        .child(self.stepper("move", d.start, cx, |this, minutes, cx| {
                            if let Overlay::Details(d) = &mut this.overlay {
                                d.start += Span::minutes(minutes);
                            }
                            cx.notify();
                        }))
                        .child(
                            self.staff_chips("move-staff", &d.staff_id, cx, |this, id, cx| {
                                if let Overlay::Details(d) = &mut this.overlay {
                                    d.staff_id = id;
                                }
                                cx.notify();
                            }),
                        )
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
                .when_some(d.error.clone(), |x, e| {
                    x.child(
                        div()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(SharedString::from(e)),
                    )
                })
                .child(
                    div()
                        .flex()
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
                                .child(self.button(
                                    "details-close",
                                    self.t(Key::Close),
                                    Kind::Ghost,
                                    cx.listener(|this, _, _, cx| {
                                        this.overlay = Overlay::None;
                                        cx.notify();
                                    }),
                                ))
                                .when(changed, |x| {
                                    x.child(self.button(
                                        "apply-move",
                                        self.t(Key::ApplyMove),
                                        Kind::Primary,
                                        cx.listener(|this, _, _, cx| this.apply_move(cx)),
                                    ))
                                }),
                        ),
                ),
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
                _ => Key::ConflictOther,
            });
            let when = c
                .payload
                .get("startsAt")
                .and_then(|v| v.as_str())
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| self.date_time_label(d.with_timezone(&Utc)))
                .unwrap_or_default();
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
                                .child(SharedString::from(format!("{when} {staff}"))),
                        ),
                )
                .child(div().text_sm().child(self.conflict_reason(&c.reason)));
            if !c.is_appointment() {
                let m = mid.clone();
                return card.child(self.button(
                    ("c-dismiss", i),
                    self.t(Key::ConflictDismiss),
                    Kind::Ghost,
                    cx.listener(move |this, _, _, cx| this.resolve(&m, Resolution::Dismiss, cx)),
                ));
            }
            if let Some(dr) = draft {
                let m = mid.clone();
                let (start, staff_id) = (dr.start, dr.staff_id.clone());
                return card
                    .child(self.stepper("c-step", dr.start, cx, |this, minutes, cx| {
                        if let Overlay::Conflicts {
                            editing: Some(e), ..
                        } = &mut this.overlay
                        {
                            e.start += Span::minutes(minutes);
                        }
                        cx.notify();
                    }))
                    .child(
                        self.staff_chips("c-staff", &dr.staff_id, cx, |this, id, cx| {
                            if let Overlay::Conflicts {
                                editing: Some(e), ..
                            } = &mut this.overlay
                            {
                                e.staff_id = id;
                            }
                            cx.notify();
                        }),
                    )
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
            let drop_label = if c.kind == "appointment.create" {
                Key::ConflictDropBooking
            } else {
                Key::ConflictCancelAppointment
            };
            let can_reschedule = matches!(
                c.kind.as_str(),
                "appointment.create" | "appointment.reschedule"
            );
            card.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .when(can_reschedule, |x| {
                        x.child(self.button(
                            ("c-resched", i),
                            self.t(Key::ConflictPickNewTime),
                            Kind::Primary,
                            cx.listener(move |this, _, _, cx| this.start_conflict_edit(&m3, cx)),
                        ))
                    })
                    .child(self.button(
                        ("c-cancel", i),
                        self.t(drop_label),
                        Kind::Danger,
                        cx.listener(move |this, _, _, cx| {
                            this.resolve(&m1, Resolution::Cancel, cx)
                        }),
                    ))
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

fn rgb_white() -> gpui::Rgba {
    gpui::rgb(0xffffff)
}

impl Render for Root {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        theme::set_dark(self.theme_override.unwrap_or(matches!(
            window.appearance(),
            gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark
        )));
        let base = div()
            .size_full()
            .relative()
            .bg(theme::bg())
            .text_color(theme::text());
        match self.screen {
            Screen::Login => base.child(self.render_login(cx)),
            Screen::Main => {
                let overlay = match &self.overlay {
                    Overlay::None => None,
                    Overlay::New(f) => Some(self.render_new(f, cx)),
                    Overlay::Details(d) => Some(self.render_details(d, cx)),
                    Overlay::Conflicts { editing, error } => {
                        Some(self.render_conflicts(editing, error, cx))
                    }
                };
                base.flex()
                    .flex_col()
                    .child(self.render_header(cx))
                    .when(self.week_mode, |d| {
                        d.child(
                            div()
                                .px_4()
                                .py_2()
                                .bg(theme::panel())
                                .child(self.staff_chips(
                                    "week-staff",
                                    &self.week_staff_id,
                                    cx,
                                    |this, id, cx| this.set_week_staff(id, cx),
                                )),
                        )
                    })
                    .child(self.render_calendar(cx))
                    .children(overlay)
            }
        }
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

    use super::*;

    const ANA: &str = "01a1d81e-0000-7000-8000-000000000001";
    const BEA: &str = "01a1d81e-0000-7000-8000-000000000002";
    const CUT: &str = "01a1d81e-0000-7000-8000-0000000000a1";
    const NAILS: &str = "01a1d81e-0000-7000-8000-0000000000a2";
    const LUCIA: &str = "01a1d81e-0000-7000-8000-0000000000c1";
    const EXISTING: &str = "01a1d81e-0000-7000-8000-0000000000e1";
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
    fn desk() -> (tempfile::TempDir, Config) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("replica.db")).unwrap();
        store
            .apply_page(
                &[
                    up(1, "salon_settings", "1", json!({"name": "SoB", "timezone": "America/Argentina/Buenos_Aires",
                        "slotGranularityMinutes": 15, "minNoticeMinutes": 60, "maxDaysAhead": 60, "updatedAt": T0})),
                    up(2, "staff", ANA, json!({"id": ANA, "displayName": "Ana", "active": true, "userId": null, "updatedAt": T0})),
                    up(3, "staff", BEA, json!({"id": BEA, "displayName": "Bea", "active": true, "userId": null, "updatedAt": T0})),
                    up(4, "service", CUT, json!({"id": CUT, "name": "Haircut", "description": null, "durationMinutes": 45, "bufferMinutes": 15, "priceCents": 1, "currency": "ARS", "active": true, "updatedAt": T0})),
                    up(5, "service", NAILS, json!({"id": NAILS, "name": "Manicure", "description": null, "durationMinutes": 45, "bufferMinutes": 0, "priceCents": 1, "currency": "ARS", "active": true, "updatedAt": T0})),
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
        FileTokenStore::new(dir.path().join("session.json"))
            .save(&Session {
                cookie: "better-auth.session_token=x".into(),
                user_id: "u".into(),
                name: "Owner".into(),
                email: "o@x.test".into(),
                role: "owner".into(),
            })
            .unwrap();
        let config = Config {
            api_url: "http://127.0.0.1:9".into(),
            data_dir: dir.path().to_path_buf(),
            locale: Locale::En,
            start_date: Some("2026-03-09".parse().unwrap()),
            start_view: None,
        };
        (dir, config)
    }

    fn open(cx: &mut TestAppContext) -> (tempfile::TempDir, gpui::WindowHandle<Root>) {
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
    async fn startup_opens_today_in_the_salons_timezone_not_the_utc_day(cx: &mut TestAppContext) {
        let (_dir, mut config) = desk();
        config.start_date = None;
        let zone = if Utc::now().hour() < 10 {
            "Pacific/Honolulu"
        } else {
            "Pacific/Kiritimati"
        };
        let tz: Tz = zone.parse().unwrap();
        let mut store = Store::open(&config.db_path()).unwrap();
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
            Store::open(&config.db_path())
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
            root.set_week(true, cx);
            assert_eq!(root.date, "2026-03-09".parse::<NaiveDate>().unwrap());
            let columns = root.calendar_columns();
            assert_eq!(columns.len(), 7);
            assert_eq!(columns[0].0, root.date);
            assert_eq!(columns[6].0, root.date + Span::days(6));
            root.shift_day(1, cx);
            assert_eq!(root.date, "2026-03-16".parse::<NaiveDate>().unwrap());
            root.set_week(false, cx);
            assert_eq!(root.calendar_columns().len(), 2);
            root.shift_day(-1, cx);
            assert_eq!(root.date, "2026-03-15".parse::<NaiveDate>().unwrap());
        })
        .unwrap();
    }

    #[gpui::test]
    async fn a_narrow_week_calendar_scrolls_headers_and_days_together(cx: &mut TestAppContext) {
        let (_dir, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| root.set_week(true, cx));
        cx.simulate_resize(gpui::size(px(800.), px(700.)));
        cx.run_until_parked();
        let before = cx.debug_bounds("calendar-head-6").expect("Sunday heading");
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
        assert_eq!(
            after.origin.x,
            cx.debug_bounds("calendar-col-6").unwrap().origin.x
        );
    }

    #[gpui::test]
    async fn week_view_changes_staff_without_mixing_their_calendars(cx: &mut TestAppContext) {
        let (_d, win) = open(cx);
        win.update(cx, |root, _, cx| {
            root.set_week(true, cx);
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
            assert_eq!(root.summary.conflicts, 0);
            let q = root.svc.store.outbox(5).unwrap();
            assert_eq!(q.len(), 1);
            assert_eq!(q[0].payload["startsAt"], json!("2026-03-09T15:00:00.000Z"));
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
