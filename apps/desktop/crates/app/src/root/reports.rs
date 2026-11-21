use super::*;
use sob_core::reports::{
    ClientReport, Outcome, ReportQuery, ReportSummary, StatusCounts, decimal_amount,
};
use sob_core::sync::TransportError;

mod clients;
mod financial;
mod outcomes;

use sob_core::reports::financial::FinancialReport;

const PAGE_SIZE: usize = 15;
const RETRY_DELAY: Duration = Duration::from_secs(5);

enum ReportData {
    Summary(Box<ReportSummary>),
    Clients(ClientReport),
    Financial(Box<FinancialReport>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReportMode {
    Overview,
    Clients,
    Financial,
    Outcome(Outcome),
}

impl ReportMode {
    fn uses_summary(self) -> bool {
        matches!(self, Self::Overview | Self::Outcome(_))
    }

    fn outcome(self) -> Option<Outcome> {
        match self {
            Self::Outcome(status) => Some(status),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Group {
    Day,
    Hour,
    Service,
    Category,
    Addon,
    Staff,
}

impl Group {
    fn label(self) -> Key {
        match self {
            Self::Day => Key::ReportDay,
            Self::Hour => Key::ReportHour,
            Self::Service => Key::ReportService,
            Self::Category => Key::ReportCategory,
            Self::Addon => Key::ReportAddon,
            Self::Staff => Key::ReportStaff,
        }
    }

    fn shows_revenue(self) -> bool {
        matches!(self, Self::Day | Self::Staff)
    }
}

pub(super) struct Desk {
    instance: Arc<()>,
    from: Entity<TextField>,
    to: Entity<TextField>,
    staff_id: Option<String>,
    currency: Option<String>,
    submitted: Option<ReportQuery>,
    summary: Option<ReportSummary>,
    mode: ReportMode,
    can_view_financial_reports: bool,
    client_report: Option<ClientReport>,
    financial_report: Option<FinancialReport>,
    group: Group,
    page: usize,
    request: Option<Arc<()>>,
    observed_cursor: i64,
    retry_at: Option<Instant>,
    error: Option<Key>,
    export_pending: bool,
    export_notice: Option<Key>,
    outcomes: outcomes::Desk,
}

pub(super) fn parse_report_date(value: &str) -> Option<NaiveDate> {
    let input = value.trim();
    let date = NaiveDate::parse_from_str(input, "%Y-%m-%d").ok()?;
    (input.len() == 10 && date.year() > 0 && date.to_string() == input).then_some(date)
}

impl Root {
    pub(super) fn open_outcome_report(
        &mut self,
        status: sob_core::reports::Outcome,
        cx: &mut Context<Self>,
    ) {
        self.open_reports(cx);
        self.select_report_mode(ReportMode::Outcome(status), cx);
    }

    pub(super) fn open_reports(&mut self, cx: &mut Context<Self>) {
        let today = Utc::now().with_timezone(&self.tz).date_naive();
        let from = (today - Span::days(29)).to_string();
        let to = today.to_string();
        self.overlay = Overlay::Reports(Box::new(Desk {
            instance: Arc::new(()),
            from: cx.new(|cx| report_date_field(&from, cx)),
            to: cx.new(|cx| report_date_field(&to, cx)),
            staff_id: None,
            currency: None,
            submitted: None,
            summary: None,
            mode: ReportMode::Overview,
            can_view_financial_reports: false,
            client_report: None,
            financial_report: None,
            group: Group::Day,
            page: 0,
            request: None,
            observed_cursor: 0,
            retry_at: None,
            error: None,
            export_pending: false,
            export_notice: None,
            outcomes: outcomes::Desk::default(),
        }));
        self.submit_report(cx);
    }

    fn submit_report(&mut self, cx: &mut Context<Self>) {
        let Overlay::Reports(desk) = &mut self.overlay else {
            return;
        };
        let dates = parse_report_date(desk.from.read(cx).text())
            .zip(parse_report_date(desk.to.read(cx).text()))
            .filter(|(from, to)| (0..366).contains(&to.signed_duration_since(*from).num_days()));
        let Some((from, to)) = dates else {
            desk.request = None;
            desk.client_report = None;
            desk.financial_report = None;
            desk.outcomes.reset_page();
            desk.error = Some(Key::ReportRange);
            cx.notify();
            return;
        };
        let query = ReportQuery {
            from,
            to,
            staff_id: desk.staff_id.clone(),
            currency: desk.currency.clone(),
        };
        if desk.submitted.as_ref() != Some(&query) {
            desk.summary = None;
            desk.client_report = None;
            desk.financial_report = None;
            desk.page = 0;
            desk.outcomes.reset_page();
        }
        desk.submitted = Some(query);
        self.load_report(self.status.cursor, cx);
    }

    pub(super) fn refresh_open_report(&mut self, status: &SyncStatus, cx: &mut Context<Self>) {
        if status.connectivity != Connectivity::Online {
            return;
        }
        if matches!(&self.overlay, Overlay::Reports(desk)
        if desk.request.is_none() && desk.submitted.is_some() &&
            !matches!(desk.error, Some(Key::ReportRestricted | Key::ReportRange)) &&
            desk.retry_at.map_or(
                desk.observed_cursor != status.cursor || self.status.connectivity != Connectivity::Online,
                |retry| Instant::now() >= retry,
            ))
        {
            self.load_report(status.cursor, cx);
        }
    }

    fn load_report(&mut self, cursor: i64, cx: &mut Context<Self>) {
        let Overlay::Reports(desk) = &mut self.overlay else {
            return;
        };
        let Some(query) = desk.submitted.clone() else {
            return;
        };
        let Some(transport) = self.svc.transport() else {
            desk.error = Some(Key::ReportOffline);
            cx.notify();
            return;
        };
        let request = Arc::new(());
        let session = self.svc.session.clone();
        let mode = desk.mode;
        desk.request = Some(request.clone());
        desk.error = None;
        desk.retry_at = None;
        desk.observed_cursor = cursor;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match mode {
                        ReportMode::Clients => {
                            transport.report_clients(&query).map(ReportData::Clients)
                        }
                        ReportMode::Financial => transport
                            .financial_report(&query)
                            .map(|report| ReportData::Financial(Box::new(report))),
                        ReportMode::Overview | ReportMode::Outcome(_) => transport
                            .report_summary(&query)
                            .map(|summary| ReportData::Summary(Box::new(summary))),
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Overlay::Reports(desk) = &mut root.overlay else {
                    return;
                };
                if !desk
                    .request
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &request))
                {
                    return;
                }
                desk.request = None;
                match result {
                    Ok(ReportData::Summary(summary)) => {
                        if summary.appointment_breakdown.is_none() && !desk.group.shows_revenue() {
                            desk.group = Group::Day;
                            desk.page = 0;
                        }
                        desk.can_view_financial_reports = summary.can_report_clients;
                        desk.summary = Some(*summary);
                        root.refresh_outcome_page(cx);
                    }
                    Ok(ReportData::Clients(report)) => desk.client_report = Some(report),
                    Ok(ReportData::Financial(report)) => desk.financial_report = Some(*report),
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized) => {
                        desk.summary = None;
                        desk.client_report = None;
                        desk.financial_report = None;
                        desk.can_view_financial_reports = false;
                        desk.outcomes.reset_page();
                        desk.error = Some(Key::ReportRestricted);
                    }
                    Err(TransportError::Offline(_)) => {
                        desk.error = Some(Key::ReportOffline);
                        desk.retry_at = Some(Instant::now() + RETRY_DELAY);
                    }
                    Err(TransportError::Server(_)) => {
                        desk.error = Some(Key::ReportFailed);
                        desk.retry_at = Some(Instant::now() + RETRY_DELAY);
                    }
                    Err(TransportError::RateLimited(delay)) => {
                        desk.error = Some(Key::ReportFailed);
                        let delay = delay.unwrap_or_default().max(RETRY_DELAY);
                        desk.retry_at = Instant::now().checked_add(delay);
                    }
                    Err(_) => desk.error = Some(Key::ReportFailed),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn report_staff(&mut self, id: String, cx: &mut Context<Self>) {
        if let Overlay::Reports(desk) = &mut self.overlay {
            desk.staff_id = (!id.is_empty()).then_some(id);
            self.submit_report(cx);
        }
    }

    fn report_currency(&mut self, currency: String, cx: &mut Context<Self>) {
        if let Overlay::Reports(desk) = &mut self.overlay {
            desk.currency = Some(currency);
            self.submit_report(cx);
        }
    }

    fn report_group(&mut self, group: Group, cx: &mut Context<Self>) {
        if let Overlay::Reports(desk) = &mut self.overlay {
            desk.group = group;
            desk.page = 0;
            cx.notify();
        }
    }

    fn report_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if let Overlay::Reports(desk) = &mut self.overlay {
            desk.page = page;
            cx.notify();
        }
    }

    fn save_report(&mut self, cx: &mut Context<Self>) {
        let Overlay::Reports(desk) = &mut self.overlay else {
            return;
        };
        if desk.export_pending || desk.request.is_some() || desk.error == Some(Key::ReportRange) {
            return;
        }
        let (filename, csv) = match desk.mode {
            ReportMode::Clients if desk.error.is_none() => {
                let Some(report) = desk.client_report.as_ref().filter(|r| !r.rows.is_empty())
                else {
                    return;
                };
                (
                    format!("clients-{}-{}.csv", report.from, report.to),
                    report.to_csv(),
                )
            }
            ReportMode::Financial if desk.error.is_none() => {
                let Some(report) = desk.financial_report.as_ref() else {
                    return;
                };
                (
                    format!("financial-summary-{}-{}.csv", report.from, report.to),
                    report.to_csv(),
                )
            }
            ReportMode::Overview => {
                let Some(report) = desk.summary.as_ref() else {
                    return;
                };
                (
                    format!("report-{}-{}.csv", report.from, report.to),
                    report.to_csv(),
                )
            }
            _ => return,
        };
        self.choose_report_export(
            filename,
            move |output| {
                use std::io::Write;
                output.write_all(csv.as_bytes())
            },
            cx,
        );
    }

    fn choose_report_export(
        &mut self,
        filename: String,
        write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        let Overlay::Reports(desk) = &mut self.overlay else {
            return;
        };
        if desk.export_pending {
            return;
        }
        let instance = desk.instance.clone();
        let expected_instance = instance.clone();
        let session = self.svc.session.clone();
        let mode = desk.mode;
        let query = desk.submitted.clone();
        desk.export_pending = true;
        desk.export_notice = None;
        cx.notify();
        prompt_csv_export(
            &filename,
            move |root| {
                Arc::ptr_eq(&session, &root.svc.session)
                    && root.svc.status().connectivity != Connectivity::AuthRequired
                    && matches!(&root.overlay, Overlay::Reports(current)
                    if Arc::ptr_eq(&expected_instance, &current.instance)
                        && current.mode == mode && current.submitted == query
                        && current.error != Some(Key::ReportRange)
                        && (mode.uses_summary() || (
                            current.can_view_financial_reports && current.error.is_none()
                                && current.request.is_none()
                        )))
            },
            write,
            move |root, notice, cx| {
                if let Overlay::Reports(desk) = &mut root.overlay
                    && Arc::ptr_eq(&instance, &desk.instance)
                {
                    desk.export_pending = false;
                    desk.export_notice = notice;
                    cx.notify();
                }
            },
            cx,
        );
    }

    pub(super) fn render_reports(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let dimensions = (
            (viewport.width - px(32.)).clamp(px(280.), px(900.)),
            (viewport.height - px(32.)).clamp(px(200.), px(800.)),
        );
        let body = div()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::BOLD)
                            .child(self.t(Key::Reports)),
                    )
                    .child(self.button(
                        "reports-close",
                        self.t(Key::Close),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                    )),
            )
            .child(
                div()
                    .id("report-content")
                    .debug_selector(|| "report-content".to_string())
                    .overflow_y_scroll()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_end()
                            .gap_2()
                            .children(
                                [(Key::ReportFrom, &desk.from), (Key::ReportTo, &desk.to)].map(
                                    |(key, input)| {
                                        div()
                                            .w(px(150.))
                                            .flex()
                                            .flex_col()
                                            .gap_1()
                                            .child(div().text_sm().child(self.t(key)))
                                            .child(input.clone())
                                    },
                                ),
                            )
                            .child(self.button(
                                "reports-apply",
                                self.t(Key::ReportApply),
                                Kind::Primary,
                                cx.listener(|root, _, _, cx| root.submit_report(cx)),
                            )),
                    )
                    .when(self.calendar_scope.as_deref() == Some("all"), |view| {
                        view.child(
                            div()
                                .flex()
                                .flex_wrap()
                                .gap_2()
                                .child(self.chip(
                                    "reports-entire-team",
                                    self.t(Key::ReportAllStaff),
                                    desk.staff_id.is_none(),
                                    cx.listener(|root, _, _, cx| {
                                        root.report_staff(String::new(), cx)
                                    }),
                                ))
                                .child(self.staff_chips(
                                    &self.report_staff_options,
                                    "reports-team",
                                    desk.staff_id.as_deref().unwrap_or_default(),
                                    cx,
                                    Self::report_staff,
                                )),
                        )
                    })
                    .when_some(
                        desk.error
                            .or((!online && desk.request.is_none()).then_some(Key::ReportOffline)),
                        |view, error| {
                            view.child(
                                div()
                                    .text_sm()
                                    .text_color(theme::conflict_fg())
                                    .child(self.t(error)),
                            )
                        },
                    )
                    .when(desk.request.is_some(), |view| {
                        view.child(
                            div()
                                .text_sm()
                                .text_color(theme::muted())
                                .child(self.t(Key::ReportLoading)),
                        )
                    })
                    .when(
                        desk.summary.is_some() || !desk.mode.uses_summary(),
                        |view| view.child(self.render_report_mode(desk, cx)),
                    )
                    .when(desk.mode == ReportMode::Clients, |view| {
                        view.when_some(desk.client_report.as_ref(), |view, report| {
                            view.child(self.render_client_report(desk, report, cx))
                        })
                    })
                    .when(desk.mode == ReportMode::Financial, |view| {
                        view.when_some(desk.financial_report.as_ref(), |view, report| {
                            view.child(self.render_financial_report(desk, report, cx))
                        })
                    })
                    .when_some(
                        desk.summary.as_ref().filter(|_| {
                            desk.mode.uses_summary() && desk.error != Some(Key::ReportRange)
                        }),
                        |view, report| {
                            view.child(self.render_report_period(desk, report, cx))
                                .when(desk.mode == ReportMode::Overview, |view| {
                                    view.child(self.render_report_summary(desk, report, cx))
                                })
                                .when_some(desk.mode.outcome(), |view, status| {
                                    view.child(self.render_outcomes(desk, status, cx))
                                })
                        },
                    ),
            );
        self.modal_with_height(body, dimensions.0, dimensions.1, Some(cx))
    }

    fn render_report_period(
        &self,
        desk: &Desk,
        report: &ReportSummary,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let currency = report.currency.as_deref().unwrap_or_default();
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(format!(
                                "{} – {}",
                                i18n::date_label(self.locale, report.from),
                                i18n::date_label(self.locale, report.to),
                            )),
                    )
                    .children(report.currencies.iter().enumerate().map(|(index, code)| {
                        let code = code.clone();
                        self.chip(
                            ("reports-currency", index),
                            SharedString::from(code.clone()),
                            currency == code,
                            cx.listener(move |root, _, _, cx| {
                                root.report_currency(code.clone(), cx)
                            }),
                        )
                    }))
                    .when(
                        !desk.export_pending
                            && desk.request.is_none()
                            && desk.mode == ReportMode::Overview
                            && report.totals.appointments > 0,
                        |view| {
                            view.child(self.button(
                                "reports-export",
                                self.t(Key::ReportExport),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| root.save_report(cx)),
                            ))
                        },
                    ),
            )
            .when_some(desk.export_notice, |view, notice| {
                view.child(div().text_sm().child(self.t(notice)))
            })
    }

    fn render_report_summary(
        &self,
        desk: &Desk,
        report: &ReportSummary,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let groups: &[Group] = if report.appointment_breakdown.is_some() {
            &[
                Group::Day,
                Group::Hour,
                Group::Service,
                Group::Category,
                Group::Addon,
                Group::Staff,
            ]
        } else {
            &[Group::Day, Group::Staff]
        };
        let is_breakdown = !desk.group.shows_revenue();
        let report_breakdown =
            report
                .appointment_breakdown
                .as_ref()
                .map(|breakdown| match desk.group {
                    Group::Hour => breakdown.hour.as_slice(),
                    Group::Service => breakdown.service.as_slice(),
                    Group::Category => breakdown.category.as_slice(),
                    Group::Addon => breakdown.addon.as_slice(),
                    Group::Day | Group::Staff => &[],
                });
        let total = match desk.group {
            Group::Day => report.series.len(),
            Group::Staff => report.per_staff.len(),
            _ => report_breakdown.unwrap_or_default().len(),
        };
        let pages = total.div_ceil(PAGE_SIZE).max(1);
        let page = desk.page.min(pages - 1);
        let start = page * PAGE_SIZE;
        let currency = report.currency.as_deref().unwrap_or_default();
        let row = |label, appointments: u64, counts: &StatusCounts, revenue: Option<u64>| {
            report_table_row(
                label,
                [
                    appointments.to_string(),
                    counts.booked.to_string(),
                    counts.completed.to_string(),
                    counts.cancelled.to_string(),
                    counts.no_show.to_string(),
                ],
                revenue.map(|cents| self.report_amount(cents, currency)),
                false,
            )
        };
        let rows: Vec<_> = match desk.group {
            Group::Day => report
                .series
                .iter()
                .skip(start)
                .take(PAGE_SIZE)
                .map(|entry| {
                    row(
                        i18n::date_label(self.locale, entry.date),
                        entry.slice.appointments,
                        &entry.slice.by_status,
                        Some(entry.slice.revenue_cents),
                    )
                })
                .collect(),
            Group::Staff => report
                .per_staff
                .iter()
                .skip(start)
                .take(PAGE_SIZE)
                .map(|entry| {
                    row(
                        entry.display_name.clone(),
                        entry.slice.appointments,
                        &entry.slice.by_status,
                        Some(entry.slice.revenue_cents),
                    )
                })
                .collect(),
            _ => report_breakdown
                .unwrap_or_default()
                .iter()
                .skip(start)
                .take(PAGE_SIZE)
                .map(|entry| {
                    row(
                        entry
                            .label
                            .clone()
                            .unwrap_or_else(|| self.t(Key::ReportUncategorized).to_string()),
                        entry.appointments,
                        &entry.by_status,
                        None,
                    )
                })
                .collect(),
        };
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div().flex().flex_wrap().gap_2().children(
                    [
                        (
                            Key::ReportAppointments,
                            report.totals.appointments.to_string(),
                        ),
                        (
                            Key::ReportCompleted,
                            report.totals.by_status.completed.to_string(),
                        ),
                        (
                            Key::ReportNoShow,
                            report.totals.by_status.no_show.to_string(),
                        ),
                        (
                            Key::ReportRevenue,
                            self.report_amount(report.totals.revenue_cents, currency),
                        ),
                    ]
                    .map(|(key, value)| {
                        div()
                            .flex_1()
                            .min_w(px(120.))
                            .rounded_md()
                            .border_1()
                            .border_color(theme::line())
                            .p_3()
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(theme::muted())
                                    .child(self.t(key)),
                            )
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(value),
                            )
                    }),
                ),
            )
            .when(report.totals.unpriced_services > 0, |view| {
                view.child(
                    div()
                        .debug_selector(|| "report-unpriced-services".to_string())
                        .text_sm()
                        .text_color(theme::muted())
                        .child(
                            self.t(Key::ReportUnpricedServices)
                                .replace("{count}", &report.totals.unpriced_services.to_string()),
                        ),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(groups.iter().enumerate().map(|(index, &group)| {
                        self.chip(
                            ("report-group", index),
                            self.t(group.label()),
                            desk.group == group,
                            cx.listener(move |root, _, _, cx| root.report_group(group, cx)),
                        )
                    })),
            )
            .when(total == 0, |view| {
                view.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::ReportNoRows)),
                )
            })
            .when(total > 0, |view| {
                view.child(
                    div()
                        .id("report-table")
                        .debug_selector(|| "report-table".to_string())
                        .overflow_x_scroll()
                        .rounded_md()
                        .border_1()
                        .border_color(theme::line())
                        .child(
                            div()
                                .min_w(px(if is_breakdown { 560. } else { 680. }))
                                .child(report_table_row(
                                    self.t(desk.group.label()).to_string(),
                                    [
                                        Key::ReportAppointments,
                                        Key::ReportBooked,
                                        Key::ReportCompleted,
                                        Key::ReportCancelled,
                                        Key::ReportNoShow,
                                    ]
                                    .map(|key| self.t(key).to_string()),
                                    (!is_breakdown).then(|| self.t(Key::ReportRevenue).to_string()),
                                    true,
                                ))
                                .children(rows),
                        ),
                )
            })
            .when(pages > 1, |view| {
                view.child(self.render_report_pager(page, pages, cx))
            })
    }

    fn render_report_pager(&self, page: usize, pages: usize, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .flex()
            .justify_end()
            .items_center()
            .gap_2()
            .when(page > 0, |view| {
                view.child(self.button(
                    "reports-previous",
                    self.t(Key::InboxPrevious),
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| root.report_page(page - 1, cx)),
                ))
            })
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(format!("{} / {pages}", page + 1)),
            )
            .when(page + 1 < pages, |view| {
                view.child(self.button(
                    "reports-next",
                    self.t(Key::InboxNext),
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| root.report_page(page + 1, cx)),
                ))
            })
    }

    fn report_amount(&self, cents: u64, currency: &str) -> String {
        let mut amount = decimal_amount(cents);
        if self.locale == Locale::EsAr {
            amount = amount.replace('.', ",");
        }
        if currency.is_empty() {
            return amount;
        }
        format!("{amount} {currency}")
    }
}

fn report_table_row(
    label: String,
    counts: [String; 5],
    revenue: Option<String>,
    header: bool,
) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .gap_1()
        .px_3()
        .py_2()
        .text_sm()
        .border_b_1()
        .border_color(theme::line())
        .when(header, |row| {
            row.bg(theme::bg()).font_weight(FontWeight::SEMIBOLD)
        })
        .child(div().flex_1().min_w(px(90.)).child(label))
        .children(counts.map(|value| div().w(px(84.)).flex_shrink_0().text_right().child(value)))
        .when_some(revenue, |row, value| {
            row.child(div().w(px(114.)).flex_shrink_0().text_right().child(value))
        })
}

fn report_date_field(date: &str, cx: &mut Context<TextField>) -> TextField {
    let mut field = TextField::new("YYYY-MM-DD", false, cx);
    field.set_text(date, cx);
    field
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn report_filters_open_with_dates_and_the_panel_scrolls_in_a_short_window(
        cx: &mut TestAppContext,
    ) {
        let (dir, mut config) = super::super::tests::desk();
        config.start_view = Some("reports".into());
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(640.), px(450.)));
        root.update(cx, |root, cx| {
            let Overlay::Reports(desk) = &mut root.overlay else {
                panic!("report desk did not open");
            };
            assert!(parse_report_date(desk.from.read(cx).text()).is_some());
            assert!(parse_report_date(desk.to.read(cx).text()).is_some());
            assert!(desk.submitted.is_some());
            desk.request = None;
            desk.error = None;
            let counts = serde_json::json!({
                "booked": 0, "completed": 1, "cancelled": 0, "no_show": 0,
            });
            let row = serde_json::json!({
                "date": "2026-11-18", "appointments": 1, "byStatus": counts, "revenueCents": 0,
                "unpricedServices": 1,
            });
            desk.summary = Some(serde_json::from_value(serde_json::json!({
                "from": "2026-11-18", "to": "2026-11-18", "currency": "EUR",
                "totals": row, "series": vec![row; 40], "perStaff": [], "topServices": [],
                "appointmentBreakdown": {"hour": [], "service": [], "category": [], "addon": []},
            })).unwrap());
            cx.notify();
        });
        cx.run_until_parked();
        let content = cx.debug_bounds("report-content").unwrap();
        let warning = cx.debug_bounds("report-unpriced-services").unwrap();
        let table = cx.debug_bounds("report-table").unwrap();
        assert!(content.bottom() < px(450.));
        assert!(warning.bottom() < table.top());
        assert!(table.bottom() > content.bottom());
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: content.center(),
            delta: gpui::ScrollDelta::Lines(gpui::point(0., -6.)),
            ..Default::default()
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("report-table").unwrap().top() < table.top());
        let export = dir.path().join("appointments.csv");
        root.update(cx, |root, cx| root.save_report(cx));
        cx.simulate_new_path_selection(|_| Some(export.clone()));
        cx.run_until_parked();
        let csv = std::fs::read_to_string(&export).unwrap();
        assert!(csv.contains("2026-11-18,1,0,1,0,0,0.00,EUR,1"));
        let failed_export = dir.path().join("interrupted.csv");
        root.update(cx, |root, cx| {
            root.choose_report_export(
                "interrupted.csv".into(),
                |output| {
                    use std::io::Write;
                    output.write_all(b"incomplete").unwrap();
                    Err(std::io::Error::other("synthetic failed export"))
                },
                cx,
            );
        });
        cx.simulate_new_path_selection(|_| Some(failed_export.clone()));
        cx.run_until_parked();
        assert!(!failed_export.exists());
        root.update(cx, |root, cx| {
            assert!(matches!(&root.overlay, Overlay::Reports(desk)
                if desk.export_notice == Some(Key::ReportExportFailed)));
            root.report_page(1, cx);
            root.report_group(Group::Hour, cx);
            assert!(matches!(&root.overlay, Overlay::Reports(desk) if desk.page == 0));
            root.dismiss_overlay(cx);
            assert!(matches!(root.overlay, Overlay::None));
        });
    }
}
