use std::fmt::Write as _;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

use chrono_tz::Tz;

use crate::billing::AppointmentCheckout;
use crate::i18n::{Key, Locale, amount_label, fill, receipt_status_label, t};
use crate::pkce::new_verifier;

const PREVIEW_LIFETIME: Duration = Duration::from_secs(30);

/// One local print preview. The document contains only the reviewed receipt, and no external assets.
pub struct ReceiptPreview {
    listener: TcpListener,
    host: String,
    path: String,
    nonce: String,
    body: String,
}

impl ReceiptPreview {
    pub fn new(
        receipt: &AppointmentCheckout,
        salon: &str,
        timezone: Tz,
        locale: Locale,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let host = listener.local_addr()?.to_string();
        let nonce = new_verifier();
        let body = document(receipt, salon, timezone, locale, &nonce);
        Ok(Self {
            listener,
            host,
            path: format!("/{}", new_verifier()),
            nonce,
            body,
        })
    }

    pub fn url(&self) -> String {
        format!("http://{}{}", self.host, self.path)
    }

    pub fn serve(self) -> bool {
        let deadline = Instant::now() + PREVIEW_LIFETIME;
        while Instant::now() < deadline {
            let mut socket = match self.listener.accept() {
                Ok((socket, _)) => socket,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25));
                    continue;
                }
                Err(_) => return false,
            };
            // A listening socket is nonblocking, and some platforms inherit that on accept.
            // The bounded header reader needs blocking reads with its deadline instead.
            if socket.set_nonblocking(false).is_err()
                || socket
                    .set_write_timeout(Some(Duration::from_secs(1)))
                    .is_err()
            {
                continue;
            }
            if self.accepts(&mut socket, deadline) {
                return write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; script-src 'nonce-{}'; style-src 'nonce-{}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    self.nonce,
                    self.nonce,
                    self.body.len(),
                    self.body
                ).is_ok();
            }
            let _ = socket.write_all(
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        }
        false
    }

    fn accepts(&self, socket: &mut TcpStream, deadline: Instant) -> bool {
        let deadline = deadline.min(Instant::now() + Duration::from_millis(500));
        let mut request = BufReader::new(socket);
        let mut bytes = Vec::with_capacity(2048);
        while bytes.len() < 8192 && !bytes.ends_with(b"\r\n\r\n") {
            let Some(timeout) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            if timeout.is_zero() || request.get_ref().set_read_timeout(Some(timeout)).is_err() {
                return false;
            }
            // Consume one bounded chunk at a time so a short read does not lose request bytes.
            let Ok(buffer) = request.fill_buf() else {
                return false;
            };
            let length = buffer.len().min(8192 - bytes.len());
            if length == 0 {
                return false;
            }
            bytes.extend_from_slice(&buffer[..length]);
            request.consume(length);
            if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let Ok(headers) = std::str::from_utf8(&bytes) else {
            return false;
        };
        let Some((headers, _)) = headers.split_once("\r\n\r\n") else {
            return false;
        };
        let mut lines = headers.lines();
        if !lines.next().is_some_and(|line| {
            let mut words = line.split_ascii_whitespace();
            words.next() == Some("GET")
                && words.next() == Some(self.path.as_str())
                && words.next() == Some("HTTP/1.1")
                && words.next().is_none()
        }) {
            return false;
        }
        let mut hosts = lines.filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("host").then(|| value.trim())
        });
        hosts.next() == Some(self.host.as_str()) && hosts.next().is_none()
    }
}

fn escaped(value: &str) -> String {
    let mut html = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => html.push_str("&amp;"),
            '<' => html.push_str("&lt;"),
            '>' => html.push_str("&gt;"),
            '"' => html.push_str("&quot;"),
            '\'' => html.push_str("&#39;"),
            _ => html.push(character),
        }
    }
    html
}

fn document(
    sale: &AppointmentCheckout,
    salon: &str,
    tz: Tz,
    locale: Locale,
    nonce: &str,
) -> String {
    let label = |key| t(locale, key);
    let money = |cents| {
        format!(
            "<span data-cents=\"{cents}\">{}</span>",
            escaped(&amount_label(locale, cents, &sale.currency))
        )
    };
    let lang = if locale == Locale::EsAr {
        "es-AR"
    } else {
        "en"
    };
    let title = label(Key::PrintReceiptTitle);
    let mut out = format!(
        r#"<!doctype html><html lang="{lang}">
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title><style nonce="{nonce}">
body{{margin:0;color:#211c20;background:white;font:1rem/1.45 system-ui,sans-serif}}
main{{margin:auto;max-width:43rem;padding:1.5rem;overflow-wrap:anywhere}}
h1,h2,p{{margin:0 0 .65rem}} h1{{font-size:1.45rem}} h2{{font-size:1.18rem}}
button{{font:inherit;padding:.65rem 1rem;background:#823054;color:white;border:0;border-radius:.35rem;margin-bottom:1.25rem}}
table{{border-collapse:collapse;width:100%;margin:1rem 0;text-align:start}}
th,td{{padding:.4rem .2rem;border-bottom:1px solid #ded8dc}} th{{text-align:start}}
td:last-child,th:last-child{{text-align:end}} td:last-child{{font-variant-numeric:tabular-nums}}
dl{{margin:0}} dl>div{{display:flex;justify-content:space-between;gap:1rem;padding:.3rem .2rem}} dd{{margin:0;font-weight:600}}
tr,dl>div{{break-inside:avoid}}
@media print{{button{{display:none}} main{{max-width:none;padding:0}}}}
</style>
<main data-currency="{currency}" data-timezone="{tz}"><button type="button" id="print">{print}</button><h1>{salon}</h1><h2>{title}</h2><p>{receipt}</p>"#,
        print = label(Key::PrintReceipt),
        salon = escaped(salon),
        receipt = escaped(&sale.id),
        currency = escaped(&sale.currency),
    );
    if let Some(instant) = sale.created_at {
        let local = instant.with_timezone(&tz);
        let date_format = if locale == Locale::EsAr {
            "%d/%m/%Y %H:%M"
        } else {
            "%Y-%m-%d %H:%M"
        };
        let _ = write!(
            out,
            "<p><time datetime=\"{}\">{}</time></p>",
            instant.to_rfc3339(),
            local.format(date_format)
        );
    }
    let _ = write!(
        out,
        "<p>{}</p>",
        escaped(receipt_status_label(locale, &sale.status))
    );
    if sale.lines.iter().any(|line| line.price_pending) {
        let _ = write!(
            out,
            "<p>{}</p>",
            label(Key::PrintReceiptPricesPendingNotice)
        );
    }
    let _ = write!(
        out,
        "<table><thead><tr><th scope=\"col\">{}</th><th scope=\"col\">{}</th></tr></thead><tbody>",
        label(Key::PrintReceiptItems),
        label(Key::PrintReceiptLineAmount)
    );
    for line in &sale.lines {
        let amount = if line.price_pending {
            label(Key::PrintReceiptPricePending).to_owned()
        } else {
            money(i64::from(line.quantity).saturating_mul(i64::from(line.unit_amount_cents)))
        };
        let _ = write!(
            out,
            "<tr><th scope=\"row\">{} × {}</th><td>{amount}</td></tr>",
            escaped(&line.description),
            line.quantity
        );
    }
    out.push_str("</tbody></table><dl>");
    let totals = [
        (
            Key::CheckoutDiscount,
            -i64::from(sale.discount_cents),
            false,
        ),
        (Key::SaleTip, i64::from(sale.tip_cents), false),
        (Key::PrintReceiptTax, i64::from(sale.tax_cents), false),
        (Key::CheckoutTotal, i64::from(sale.total_cents), true),
        (
            Key::PrintReceiptCollected,
            sale.paid_cents.min(i64::MAX as u64) as i64,
            true,
        ),
        (
            Key::SalesStatusRefunded,
            sale.refunded_cents.min(i64::MAX as u64) as i64,
            false,
        ),
        (Key::CheckoutDue, i64::from(sale.balance_cents), true),
    ];
    for (key, cents, _) in totals
        .into_iter()
        .filter(|(_, cents, always)| *always || *cents != 0)
    {
        let _ = write!(
            out,
            "<div><dt>{}</dt><dd>{}</dd></div>",
            label(key),
            money(cents)
        );
    }
    out.push_str("</dl>");
    if let Some(reward) = &sale.reward {
        let name = if reward.kind == crate::loyalty::checkout::RewardKind::Points {
            label(Key::PrintReceiptPoints)
        } else {
            &reward.name
        };
        let _ = write!(out, "<h2>{}</h2>", escaped(name));
        if let Some(code) = &reward.code {
            let _ = write!(out, "<p>{}</p>", escaped(code));
        }
        for (key, points) in [
            (Key::PrintReceiptPointsUsed, reward.points_used),
            (Key::PrintReceiptPointsReturned, reward.returned_points),
        ] {
            if points > 0 {
                let _ = write!(
                    out,
                    "<p>{}</p>",
                    fill(label(key), &[("points", &points.to_string())])
                );
            }
        }
    }
    let _ = write!(
        out,
        r#"</main><script nonce="{nonce}">
const root = document.querySelector("main");
const locale = document.documentElement.lang;
document.getElementById("print").addEventListener("click", () => window.print());
const formatDate = new Intl.DateTimeFormat(locale, {{dateStyle:"medium",timeStyle:"short",timeZone:root.dataset.timezone}});
const date = root.querySelector("time");
if (date) date.textContent = formatDate.format(new Date(date.dateTime));
const formatWhole = new Intl.NumberFormat(locale, {{style:"currency",currency:root.dataset.currency,minimumFractionDigits:0,maximumFractionDigits:0}});
const formatFraction = new Intl.NumberFormat(locale, {{style:"currency",currency:root.dataset.currency,minimumFractionDigits:2,maximumFractionDigits:2}});
for (const cell of root.querySelectorAll("[data-cents]")) {{
    const cents = Number(cell.dataset.cents);
    cell.textContent = (cents % 100 === 0 ? formatWhole : formatFraction).format(cents / 100);
}}
</script></html>"#
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{billing::AppointmentCheckout, i18n::Locale};

    #[test]
    fn printable_receipt_keeps_amounts_and_escapes_salon_and_service_names() {
        let receipt: AppointmentCheckout = serde_json::from_value(serde_json::json!({
            "id":"0198f5a0-7b1c-7000-8000-000000000101",
            "createdAt":"2026-11-20T09:15:00Z", "currency":"EUR", "status":"partially_refunded",
            "totalCents":2600, "discountCents":300, "taxCents":200, "tipCents":100,
            "paidCents":2600, "refundedCents":400, "balanceCents":0, "payments":[],
            "lines":[{"id":"0198f5a0-7b1c-7000-8000-000000000102","quantity":2,
                "unitAmountCents":1400, "description":"<img src=x> & nails"}]
        }))
        .unwrap();
        let preview = ReceiptPreview::new(
            &receipt,
            "Salón <Belleza>",
            chrono_tz::Europe::Madrid,
            Locale::EsAr,
        )
        .unwrap();
        assert!(preview.body.contains("Salón &lt;Belleza&gt;"));
        assert!(preview.body.contains("&lt;img src=x&gt; &amp; nails"));
        assert!(preview.body.contains("10:15"));
        assert!(preview.body.contains("−3,00 EUR"));
        assert!(preview.body.contains("28,00 EUR"));
        assert!(preview.body.contains("26,00 EUR"));
        assert!(preview.body.contains("4,00 EUR"));
        assert!(!preview.body.contains("<img"));
    }
    #[test]
    fn local_preview_rejects_the_wrong_origin_and_is_served_once() {
        use std::io::Read;

        let receipt: AppointmentCheckout = serde_json::from_value(serde_json::json!({
            "id":"0198f5a0-7b1c-7000-8000-000000000101",
            "currency":"EUR", "status":"paid", "totalCents":2400,
            "discountCents":0, "paidCents":2400, "balanceCents":0, "payments":[]
        }))
        .unwrap();
        let preview =
            ReceiptPreview::new(&receipt, "Test salon", chrono_tz::UTC, Locale::En).unwrap();
        let address = preview.listener.local_addr().unwrap();
        let path = preview.path.clone();
        let host = preview.host.clone();
        let worker = std::thread::spawn(move || preview.serve());
        let get = |path: &str, host: &str| {
            let mut socket = TcpStream::connect(address).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            write!(socket, "GET {path} HTTP/1.1\r\n").unwrap();
            std::thread::sleep(Duration::from_millis(40));
            write!(socket, "Host: {host}\r\nConnection: close\r\n\r\n").unwrap();
            let mut response = String::new();
            socket.read_to_string(&mut response).unwrap();
            response
        };
        assert!(get(&path, "other.example").starts_with("HTTP/1.1 404"));
        assert!(get("/other", &host).starts_with("HTTP/1.1 404"));
        let response = get(&path, &host);
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("HTTP/1.1 200 OK"));
        assert!(headers.contains("Cache-Control: no-store"));
        assert!(headers.contains("Referrer-Policy: no-referrer"));
        assert!(headers.contains("frame-ancestors 'none'"));
        assert!(body.ends_with("</html>"));
        assert!(body.contains("Test salon"));
        assert!(worker.join().unwrap());
        assert!(TcpStream::connect(address).is_err());
    }
    #[test]
    fn a_pending_service_and_reward_show_the_same_information_as_cloud() {
        let receipt: AppointmentCheckout = serde_json::from_value(serde_json::json!({
            "id":"0198f5a0-7b1c-7000-8000-000000000101", "currency":"EUR", "status":"open",
            "totalCents":0, "discountCents":0, "paidCents":0, "balanceCents":0, "payments":[],
            "reward":{"kind":"points","name":"Customer rewards","code":null,"pointsUsed":10,"returnedPoints":2},
            "lines":[{"id":"0198f5a0-7b1c-7000-8000-000000000102","quantity":1,
                "unitAmountCents":1000, "description":"Treatment", "pricePending":true}]
        })).unwrap();
        let body = document(&receipt, "Test salon", chrono_tz::UTC, Locale::En, "nonce");
        assert!(
            body.contains(
                "The team must set the final service price before collecting the balance."
            )
        );
        assert!(body.contains("<td>Price varies</td>"));
        assert!(body.contains("<th scope=\"col\">Amount</th>"));
        assert!(body.contains("<dt>Collected</dt>"));
        assert!(body.contains("<h2>Loyalty points</h2>"));
        assert!(body.contains("10 points used"));
        assert!(body.contains("2 points returned"));
    }
}
