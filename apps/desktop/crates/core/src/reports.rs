//! Operational reporting uses the same scoped totals and currency as the web desk.

use std::fmt::Write;

use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use url::form_urlencoded;

pub mod financial;

#[derive(Clone, PartialEq, Eq)]
pub struct ReportQuery {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub staff_id: Option<String>,
    pub currency: Option<String>,
}

impl ReportQuery {
    pub(crate) fn path(&self) -> String {
        self.url("/admin/reports/summary", true, &[])
    }

    pub(crate) fn clients_path(&self) -> String {
        self.url("/admin/reports/clients", false, &[])
    }

    pub(crate) fn financial_path(&self) -> String {
        self.url("/admin/accounting/sales", false, &[])
    }

    pub(crate) fn outcome_path(&self, status: Outcome, page: u32) -> String {
        self.url(
            "/admin/reports/outcomes",
            true,
            &[("status", status.value()), ("page", &page.to_string())],
        )
    }

    pub(crate) fn outcome_export_path(&self, status: Outcome) -> String {
        self.url(
            "/admin/reports/outcomes/export",
            true,
            &[("status", status.value())],
        )
    }

    fn url(&self, path: &str, include_currency: bool, extra: &[(&str, &str)]) -> String {
        let mut query = form_urlencoded::Serializer::new(String::new());
        query.append_pair("from", &self.from.to_string());
        query.append_pair("to", &self.to.to_string());
        if let Some(id) = &self.staff_id {
            query.append_pair("staffId", id);
        }
        if let Some(currency) = self.currency.as_ref().filter(|_| include_currency) {
            query.append_pair("currency", currency);
        }
        query.extend_pairs(extra.iter().copied());
        format!("{path}?{}", query.finish())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Cancelled,
    NoShow,
}

impl Outcome {
    pub fn value(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::NoShow => "no_show",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomePage {
    pub rows: Vec<OutcomeRow>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
    pub timezone: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeRow {
    pub starts_at: DateTime<Utc>,
    pub client: Option<String>,
    pub staff: String,
    pub services: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct StatusCounts {
    pub booked: u64,
    pub completed: u64,
    pub cancelled: u64,
    pub no_show: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSlice {
    pub appointments: u64,
    pub by_status: StatusCounts,
    pub revenue_cents: u64,
    #[serde(default)]
    pub unpriced_services: u64,
}

#[derive(Debug, Deserialize)]
pub struct DailyReport {
    pub date: NaiveDate,
    #[serde(flatten)]
    pub slice: ReportSlice,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffReport {
    pub display_name: String,
    pub no_show_rate: Option<f64>,
    #[serde(flatten)]
    pub slice: ReportSlice,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopService {
    pub name: String,
    pub count: u64,
    pub revenue_cents: u64,
    #[serde(default)]
    pub unpriced_services: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakdownRow {
    pub label: Option<String>,
    pub appointments: u64,
    pub by_status: StatusCounts,
}

#[derive(Debug, Deserialize)]
pub struct AppointmentBreakdown {
    pub hour: Vec<BreakdownRow>,
    pub service: Vec<BreakdownRow>,
    pub category: Vec<BreakdownRow>,
    pub addon: Vec<BreakdownRow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSummary {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub currency: Option<String>,
    #[serde(default)]
    pub currencies: Vec<String>,
    pub totals: ReportSlice,
    pub series: Vec<DailyReport>,
    pub per_staff: Vec<StaffReport>,
    pub top_services: Vec<TopService>,
    pub appointment_breakdown: Option<AppointmentBreakdown>,
    #[serde(default)]
    pub can_report_clients: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCounts {
    pub new_clients: u64,
    pub returning_clients: u64,
}

#[derive(Debug, Deserialize)]
pub struct ClientReportRow {
    pub date: NaiveDate,
    #[serde(flatten)]
    pub counts: ClientCounts,
}

#[derive(Debug, Deserialize)]
pub struct ClientGroupRow {
    pub name: String,
    pub clients: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientVisitFrequency {
    pub one: u64,
    pub two: u64,
    pub three_or_more: u64,
}

impl ClientVisitFrequency {
    pub fn to_csv(&self) -> String {
        format!(
            "visit_frequency,clients\r\none,{}\r\ntwo,{}\r\nthreeOrMore,{}\r\n",
            self.one, self.two, self.three_or_more
        )
    }
}

#[derive(Debug, Deserialize)]
pub struct ClientReport {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub totals: ClientCounts,
    pub rows: Vec<ClientReportRow>,
    pub groups: Option<Vec<ClientGroupRow>>,
    pub frequency: Option<ClientVisitFrequency>,
}

impl ClientReport {
    pub fn groups_csv(&self) -> Option<String> {
        let groups = self.groups.as_ref().filter(|groups| !groups.is_empty())?;
        let mut csv = String::from("group,clients\r\n");
        for entry in groups {
            csv_row(&mut csv, [entry.name.as_str(), &entry.clients.to_string()]);
        }
        Some(csv)
    }

    pub fn to_csv(&self) -> String {
        let mut csv = String::from("date,new_clients,returning_clients\r\n");
        for row in &self.rows {
            let _ = write!(
                csv,
                "{},{},{}\r\n",
                row.date, row.counts.new_clients, row.counts.returning_clients
            );
        }
        csv
    }
}

const COUNTS: [&str; 5] = [
    "appointments",
    "booked",
    "completed",
    "cancelled",
    "no_show",
];

fn counts(appointments: u64, status: &StatusCounts) -> [String; 5] {
    [
        appointments.to_string(),
        status.booked.to_string(),
        status.completed.to_string(),
        status.cancelled.to_string(),
        status.no_show.to_string(),
    ]
}

pub fn decimal_amount(cents: u64) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}

fn csv_row(output: &mut String, cells: impl IntoIterator<Item = impl AsRef<str>>) {
    for (index, cell) in cells.into_iter().enumerate() {
        if index != 0 {
            output.push(',');
        }
        let cell = cell.as_ref();
        let quote = cell.contains([',', '"', '\r', '\n']);
        if quote {
            output.push('"');
        }
        if cell.starts_with(['=', '+', '-', '@', '\t', '\r']) {
            output.push('\'');
        }
        if quote {
            output.push_str(&cell.replace('"', "\"\""));
            output.push('"');
        } else {
            output.push_str(cell);
        }
    }
    output.push_str("\r\n");
}

impl ReportSummary {
    pub fn to_csv(&self) -> String {
        let currency = self.currency.as_deref();
        let include_unpriced = self.totals.unpriced_services > 0;
        let unpriced_column = include_unpriced.then_some("unpriced_services");
        let unpriced_cell = |count: u64| include_unpriced.then(|| count.to_string());
        let mut output = String::new();
        csv_row(
            &mut output,
            ["date"]
                .into_iter()
                .chain(COUNTS)
                .chain(["revenue"])
                .chain(currency.map(|_| "currency"))
                .chain(unpriced_column),
        );
        for day in &self.series {
            csv_row(
                &mut output,
                [day.date.to_string()]
                    .into_iter()
                    .chain(counts(day.slice.appointments, &day.slice.by_status))
                    .chain([decimal_amount(day.slice.revenue_cents)])
                    .chain(currency.map(str::to_owned))
                    .chain(unpriced_cell(day.slice.unpriced_services)),
            );
        }
        output.push_str("\r\n");
        csv_row(
            &mut output,
            ["service", "completed", "revenue"]
                .into_iter()
                .chain(currency.map(|_| "currency"))
                .chain(unpriced_column),
        );
        for service in &self.top_services {
            csv_row(
                &mut output,
                [
                    service.name.clone(),
                    service.count.to_string(),
                    decimal_amount(service.revenue_cents),
                ]
                .into_iter()
                .chain(currency.map(str::to_owned))
                .chain(unpriced_cell(service.unpriced_services)),
            );
        }
        output.push_str("\r\n");
        csv_row(
            &mut output,
            [
                "staff",
                "appointments",
                "completed",
                "no_show",
                "no_show_rate",
                "revenue",
            ]
            .into_iter()
            .chain(currency.map(|_| "currency"))
            .chain(unpriced_column),
        );
        for staff in &self.per_staff {
            csv_row(
                &mut output,
                [
                    staff.display_name.clone(),
                    staff.slice.appointments.to_string(),
                    staff.slice.by_status.completed.to_string(),
                    staff.slice.by_status.no_show.to_string(),
                    staff
                        .no_show_rate
                        .map(|rate| format!("{rate:.4}"))
                        .unwrap_or_default(),
                    decimal_amount(staff.slice.revenue_cents),
                ]
                .into_iter()
                .chain(currency.map(str::to_owned))
                .chain(unpriced_cell(staff.slice.unpriced_services)),
            );
        }
        if let Some(breakdown) = &self.appointment_breakdown {
            output.push_str("\r\n");
            csv_row(&mut output, ["group", "label"].into_iter().chain(COUNTS));
            for (kind, rows) in [
                ("hour", &breakdown.hour),
                ("service", &breakdown.service),
                ("category", &breakdown.category),
                ("addon", &breakdown.addon),
            ] {
                for row in rows {
                    csv_row(
                        &mut output,
                        [kind.to_owned(), row.label.clone().unwrap_or_default()]
                            .into_iter()
                            .chain(counts(row.appointments, &row.by_status)),
                    );
                }
            }
        }
        output
    }
}
