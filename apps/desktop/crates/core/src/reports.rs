//! Operational reporting uses the same scoped totals and currency as the web desk.

use std::fmt::Write;

use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use url::form_urlencoded;

pub mod commissions;
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

    pub(crate) fn staff_work_path(&self) -> String {
        self.url("/admin/reports/staff-work", false, &[])
    }

    pub(crate) fn clients_path(&self) -> String {
        self.url("/admin/reports/clients", false, &[])
    }

    pub(crate) fn financial_path(&self, client_id: Option<&str>) -> String {
        match client_id {
            Some(id) => self.url("/admin/accounting/sales", false, &[("clientId", id)]),
            None => self.url("/admin/accounting/sales", false, &[]),
        }
    }

    pub(crate) fn profitability_path(&self, client_id: Option<&str>, page: Option<u32>) -> String {
        let page_string = page.map(|page| page.to_string());
        let mut fields = Vec::new();
        if let Some(id) = client_id {
            fields.push(("clientId", id));
        }
        if let Some(page) = page_string.as_deref() {
            fields.push(("page", page));
        }
        self.url(
            if page.is_some() {
                "/admin/accounting/appointment-profitability"
            } else {
                "/admin/accounting/appointment-profitability/export"
            },
            false,
            &fields,
        )
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
    pub staff_id: Option<String>,
    pub display_name: String,
    pub no_show_rate: Option<f64>,
    pub occupancy: Option<StaffOccupancy>,
    #[serde(flatten)]
    pub slice: ReportSlice,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffOccupancy {
    pub scheduled_minutes: u64,
    pub blocked_minutes: u64,
    pub reserved_minutes: u64,
    pub completed_minutes: u64,
    pub no_show_minutes: u64,
    pub occupancy_rate: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffWorkReport {
    pub staff_id: String,
    pub timezone: String,
    pub selected: StaffWorkPeriod,
    pub upcoming: StaffWorkPeriod,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffWorkPeriod {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub totals: StaffOccupancy,
    pub days: Vec<StaffWorkDay>,
    pub unavailable: Vec<StaffWorkBlock>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffWorkDay {
    pub date: NaiveDate,
    #[serde(flatten)]
    pub occupancy: StaffOccupancy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffWorkBlock {
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
}

impl StaffWorkPeriod {
    pub fn to_csv(&self) -> String {
        let mut csv = String::from(
            "\u{feff}date,scheduled_minutes,blocked_minutes,reserved_minutes,completed_minutes,no_show_minutes,occupancy_rate\r\n",
        );
        for day in &self.days {
            let [scheduled, blocked, reserved, completed, missed] = day.occupancy.minutes();
            let rate = day
                .occupancy
                .occupancy_rate
                .map_or_else(String::new, |rate| rate.to_string());
            writeln!(
                csv,
                "{},{scheduled},{blocked},{reserved},{completed},{missed},{rate}\r",
                day.date
            )
            .expect("writing into a String cannot fail");
        }
        csv
    }
}

impl StaffOccupancy {
    pub fn minutes(&self) -> [u64; 5] {
        [
            self.scheduled_minutes,
            self.blocked_minutes,
            self.reserved_minutes,
            self.completed_minutes,
            self.no_show_minutes,
        ]
    }
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
pub struct BusinessOverview {
    pub visiting_clients: u64,
    pub occupancy_rate: Option<f64>,
    pub net_collected_cents: i64,
    pub low_stock_products: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSummary {
    pub business_overview: Option<BusinessOverview>,
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
    pub promotion_breakdown: Option<Vec<BreakdownRow>>,
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
#[serde(rename_all = "camelCase")]
pub struct ClientNetCollections {
    pub name: String,
    pub net_cents: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientReport {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub totals: ClientCounts,
    pub rows: Vec<ClientReportRow>,
    pub groups: Option<Vec<ClientGroupRow>>,
    pub frequency: Option<ClientVisitFrequency>,
    pub top_collections: Option<Vec<ClientNetCollections>>,
}

impl ClientReport {
    pub fn collections_csv(&self) -> Option<String> {
        let collections = self
            .top_collections
            .as_ref()
            .filter(|rows| !rows.is_empty())?;
        let mut csv = String::from("client,net_cents,currency\r\n");
        for entry in collections {
            csv_row(
                &mut csv,
                [
                    entry.name.as_str(),
                    &entry.net_cents.to_string(),
                    financial::CURRENCY,
                ],
            );
        }
        Some(csv)
    }

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
    pub fn has_occupancy_minutes(&self) -> bool {
        self.per_staff
            .iter()
            .filter_map(|staff| staff.occupancy.as_ref())
            .any(|occupancy| occupancy.minutes().into_iter().any(|minutes| minutes > 0))
    }

    pub fn has_overview_data(&self) -> bool {
        self.totals.appointments > 0 || self.has_occupancy_minutes()
    }

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
        if self.per_staff.iter().any(|staff| staff.occupancy.is_some()) {
            output.push_str("\r\n");
            csv_row(
                &mut output,
                [
                    "staff",
                    "scheduled_minutes",
                    "blocked_minutes",
                    "reserved_minutes",
                    "completed_visit_minutes",
                    "no_show_minutes",
                    "occupancy_rate",
                ],
            );
            for staff in &self.per_staff {
                let Some(occupancy) = staff.occupancy.as_ref() else {
                    continue;
                };
                csv_row(
                    &mut output,
                    std::iter::once(staff.display_name.clone())
                        .chain(occupancy.minutes().map(|value| value.to_string()))
                        .chain(std::iter::once(
                            occupancy
                                .occupancy_rate
                                .map(|rate| format!("{rate:.4}"))
                                .unwrap_or_default(),
                        )),
                );
            }
        }
        if let Some(breakdown) = &self.appointment_breakdown {
            output.push_str("\r\n");
            csv_row(&mut output, ["group", "label"].into_iter().chain(COUNTS));
            for (kind, rows) in [
                ("hour", breakdown.hour.as_slice()),
                ("service", breakdown.service.as_slice()),
                ("category", breakdown.category.as_slice()),
                ("addon", breakdown.addon.as_slice()),
                (
                    "promotion",
                    self.promotion_breakdown.as_deref().unwrap_or_default(),
                ),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_booking_promotion_outcomes_and_accepts_older_reports() {
        let mut response = serde_json::json!({
            "from": "2026-03-09",
            "to": "2026-03-09",
            "totals": {
                "appointments": 3,
                "byStatus": {"booked": 0, "completed": 2, "cancelled": 0, "no_show": 1},
                "revenueCents": 0
            },
            "series": [],
            "perStaff": [],
            "topServices": [],
            "appointmentBreakdown": {"hour": [], "service": [], "category": [], "addon": []}
        });
        let older: ReportSummary = serde_json::from_value(response.clone()).unwrap();
        assert!(older.promotion_breakdown.is_none());
        response["promotionBreakdown"] = serde_json::json!([{
            "label": "March offer (MARCH10)",
            "appointments": 3,
            "byStatus": {"booked": 0, "completed": 2, "cancelled": 0, "no_show": 1}
        }]);
        let report: ReportSummary = serde_json::from_value(response).unwrap();
        assert!(
            report
                .to_csv()
                .contains("promotion,March offer (MARCH10),3,0,2,0,1\r\n")
        );
    }
}
