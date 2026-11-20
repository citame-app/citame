use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, RwLock, mpsc};

use super::*;
use crate::auth::{BetterAuthSession, Credentials, Session};

/// Serves the given raw HTTP responses, one per connection, and records the requests.
fn serve(responses: Vec<String>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(vec![]));
    let log = seen.clone();
    std::thread::spawn(move || {
        for resp in responses {
            let Ok((mut s, _)) = listener.accept() else {
                return;
            };
            let mut buf = vec![];
            let mut chunk = [0u8; 4096];
            loop {
                let n = s.read(&mut chunk).unwrap_or(0);
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(h) = text.find("\r\n\r\n") {
                    let len = text[..h]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if buf.len() >= h + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            log.lock()
                .unwrap()
                .push(String::from_utf8_lossy(&buf).to_string());
            let _ = s.write_all(resp.as_bytes());
            let _ = s.flush();
        }
    });
    (base, seen)
}

fn http(status: &str, headers: &[&str], body: &str) -> String {
    let extra: String = headers.iter().map(|h| format!("{h}\r\n")).collect();
    format!(
        "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn signed_in(base: &str) -> HttpTransport {
    let session: SessionHandle = Arc::new(RwLock::new(Some(Session {
        cookie: "better-auth.session_token=tok%3D".into(),
        oauth: None,
        user_id: "u".into(),
        name: "n".into(),
        email: "e".into(),
        role: "owner".into(),
    })));
    HttpTransport::new(base, session, Arc::new(BetterAuthSession::new(base)))
}

#[test]
fn waitlist_storage_rejection_is_distinct_from_a_rate_limited_retry() {
    let (base, _) = serve(vec![
        http(
            "409 Conflict",
            &[],
            r#"{"error":{"code":"storage_limit","message":"Too many responses"}}"#,
        ),
        http(
            "429 Too Many Requests",
            &["Retry-After: 2"],
            r#"{"error":{"code":"rate_limited"}}"#,
        ),
    ]);
    let input = AcceptOffer {
        version: 1,
        offer_id: uuid::Uuid::now_v7().to_string(),
        expected_total_cents: 1500,
        idempotency_key: WaitlistRequest::new_key(),
        intake_review_hash: "0".repeat(64),
        intake_submission_ids: vec![],
        intake_responses: vec![],
        protection_waiver_reason: None,
    };
    let entry = uuid::Uuid::now_v7().to_string();
    let transport = signed_in(&base);
    assert!(matches!(
        transport.accept_waitlist_offer(&entry, &input),
        Err(AcceptOfferError::ResponseLimit)
    ));
    assert!(matches!(
        transport.accept_waitlist_offer(&entry, &input),
        Err(AcceptOfferError::Transport(TransportError::RateLimited(_)))
    ));
}

#[test]
fn bank_reconciliation_checks_eligibility_and_reloads_only_the_reviewed_receipt() {
    use crate::billing::BankPaymentOutcome;
    use serde_json::{Value, json};
    use uuid::Uuid;

    let id = Uuid::now_v7();
    let payment = Uuid::now_v7();
    let mut checkout = json!({
        "id": id, "currency": "EUR", "status": "open", "canRefund": true,
        "totalCents": 2200, "discountCents": 0, "paidCents": 0, "balanceCents": 2200,
        "payments": [{"id": payment, "method": "redsys_card", "status": "pending",
            "amountCents": 2200, "order": "123412345678",
            "reconcileAfter": (chrono::Utc::now() - chrono::Duration::minutes(1)).to_rfc3339()}]
    });
    let pending: AppointmentCheckout = serde_json::from_value(checkout.clone()).unwrap();
    checkout["payments"][0]["reconcileAfter"] =
        json!((chrono::Utc::now() + chrono::Duration::minutes(1)).to_rfc3339());
    let recent: AppointmentCheckout = serde_json::from_value(checkout.clone()).unwrap();
    checkout["status"] = json!("paid");
    checkout["paidCents"] = json!(2200);
    checkout["balanceCents"] = json!(0);
    checkout["payments"][0]["status"] = json!("succeeded");
    let (base, requests) = serve(vec![
        http(
            "200 OK",
            &[],
            &json!({"id": payment, "checkoutId": id, "status": "succeeded"}).to_string(),
        ),
        http("200 OK", &[], &checkout.to_string()),
        http(
            "200 OK",
            &[],
            &json!({"id": payment, "checkoutId": id, "status": "failed"}).to_string(),
        ),
        http("200 OK", &[], &checkout.to_string()),
    ]);
    let transport = signed_in(&base);
    let command =
        BankPaymentReconciliation::new(BankPaymentOutcome::Succeeded, "  BANK-1234  ").unwrap();
    assert!(BankPaymentReconciliation::new(BankPaymentOutcome::Failed, "short").is_none());
    assert!(matches!(
        transport.reconcile_bank_payment(&recent, payment, &command),
        Err(TransportError::BadRequest(_))
    ));
    assert!(requests.lock().unwrap().is_empty());
    let reviewed = transport
        .reconcile_bank_payment(&pending, payment, &command)
        .unwrap();
    assert_eq!(reviewed.receipt.paid_cents, 2200);
    assert!(!reviewed.bank_outcome_changed);
    let no_charge =
        BankPaymentReconciliation::new(BankPaymentOutcome::Failed, "BANK-1235").unwrap();
    let raced = transport
        .reconcile_bank_payment(&pending, payment, &no_charge)
        .unwrap();
    assert_eq!(raced.receipt.paid_cents, 2200);
    assert!(raced.bank_outcome_changed);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(requests[0].starts_with(&format!(
        "POST /admin/commerce/payments/{payment}/reconcile "
    )));
    assert_eq!(
        serde_json::from_str::<Value>(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap(),
        json!({"outcome": "succeeded", "reference": "BANK-1234"})
    );
    assert!(requests[1].starts_with(&format!("GET /admin/commerce/checkouts/{id} ")));
}

#[test]
fn bank_refund_reservation_dispatch_and_reconciliation_load_the_server_state() {
    use crate::billing::BankPaymentOutcome;
    use serde_json::json;
    use uuid::Uuid;

    let id = Uuid::now_v7();
    let payment = Uuid::now_v7();
    let refund = Uuid::now_v7();
    let mut sale = json!({
        "id": id, "currency": "EUR", "status": "paid", "canRefund": true,
        "canDispatchBankRefunds": true, "totalCents": 2200, "discountCents": 0,
        "paidCents": 2200, "balanceCents": 0, "payments": [{
            "id": payment, "method": "redsys_bizum", "status": "succeeded",
            "amountCents": 2200, "order": "123412345678"
        }]
    });
    let paid: AppointmentCheckout = serde_json::from_value(sale.clone()).unwrap();
    let mut entry = json!({
        "id": refund, "paymentId": payment, "amountCents": 400,
        "reason": "Synthetic treatment refund", "status": "requested"
    });
    sale["refunds"] = json!([entry.clone()]);
    let reserved_receipt = sale.to_string();
    let reserved = entry.to_string();
    entry["status"] = json!("reconciliation");
    entry["reconcileAfter"] = json!("2026-03-12T00:00:00Z");
    sale["refunds"] = json!([entry.clone()]);
    let review_receipt = sale.to_string();
    let review = entry.to_string();
    entry["status"] = json!("succeeded");
    sale["refunds"] = json!([entry.clone()]);
    sale["refundedCents"] = json!(400);
    sale["status"] = json!("partially_refunded");
    let (base, requests) = serve(vec![
        http("201 Created", &[], &reserved),
        http("200 OK", &[], &reserved_receipt),
        http("200 OK", &[], &review),
        http("200 OK", &[], &review_receipt),
        http("200 OK", &[], &entry.to_string()),
        http("200 OK", &[], &sale.to_string()),
    ]);
    let transport = signed_in(&base);
    let attempt = RefundAttempt::new(400, "Synthetic treatment refund").unwrap();
    let requested = transport
        .record_checkout_refund(&paid, payment, &attempt)
        .unwrap();
    assert_eq!(requested.refunded_cents, 0);
    assert_eq!(
        requested
            .recordable_refunds_available()
            .next()
            .unwrap()
            .available,
        1800
    );
    let uncertain = transport.dispatch_bank_refund(&requested, refund).unwrap();
    assert!(
        !uncertain
            .reviewable_bank_refunds(chrono::Utc::now())
            .any(|r| r.action == BankRefundAction::Dispatch)
    );
    assert!(transport.dispatch_bank_refund(&uncertain, refund).is_err());
    let confirmed = transport
        .reconcile_bank_refund(
            &uncertain,
            refund,
            &BankPaymentReconciliation::new(BankPaymentOutcome::Succeeded, "BANK-REF-400").unwrap(),
        )
        .unwrap();
    assert_eq!(confirmed.refunded_cents, 400);
    let log = requests.lock().unwrap();
    assert_eq!(log.len(), 6);
    assert!(log[0].starts_with(&format!("POST /admin/commerce/payments/{payment}/refunds ")));
    assert!(log[2].starts_with(&format!("POST /admin/commerce/refunds/{refund}/execute ")));
    assert!(log[4].starts_with(&format!("POST /admin/commerce/refunds/{refund}/reconcile ")));
}

#[test]
fn an_unsent_refund_can_be_cancelled_without_a_gateway_and_releases_its_balance() {
    use serde_json::json;
    use uuid::Uuid;

    let id = Uuid::now_v7();
    let payment = Uuid::now_v7();
    let refund = Uuid::now_v7();
    let mut sale = json!({
        "id": id, "currency": "EUR", "status": "paid", "canRefund": true,
        "canDispatchBankRefunds": false, "totalCents": 2200, "discountCents": 0,
        "paidCents": 2200, "balanceCents": 0, "payments": [{
            "id": payment, "method": "redsys_card", "status": "succeeded",
            "amountCents": 2200, "order": "123412345678"
        }],
        "refunds": [{
            "id": refund, "paymentId": payment, "amountCents": 400,
            "reason": "Incorrect amount", "status": "requested"
        }]
    });
    let requested: AppointmentCheckout = serde_json::from_value(sale.clone()).unwrap();
    assert_eq!(
        requested
            .recordable_refunds_available()
            .next()
            .unwrap()
            .available,
        1800
    );
    assert_eq!(
        requested
            .reviewable_bank_refunds(chrono::Utc::now())
            .next()
            .unwrap()
            .action,
        BankRefundAction::Cancel
    );
    sale["refunds"][0]["status"] = json!("failed");
    sale["refunds"][0]["cancelledAt"] = json!("2026-11-20T16:00:00Z");
    let (base, requests) = serve(vec![
        http("200 OK", &[], &sale["refunds"][0].to_string()),
        http("200 OK", &[], &sale.to_string()),
    ]);
    let transport = signed_in(&base);
    assert!(transport.dispatch_bank_refund(&requested, refund).is_err());
    let cancelled = transport.cancel_bank_refund(&requested, refund).unwrap();
    assert!(cancelled.refunds[0].cancelled_at.is_some());
    assert_eq!(
        cancelled
            .recordable_refunds_available()
            .next()
            .unwrap()
            .available,
        2200
    );
    let log = requests.lock().unwrap();
    assert_eq!(log.len(), 2);
    assert!(log[0].starts_with(&format!("POST /admin/commerce/refunds/{refund}/cancel ")));
    assert!(log[1].starts_with(&format!("GET /admin/commerce/checkouts/{id} ")));
}

#[test]
fn an_access_only_membership_refund_keeps_the_quoted_fee_and_generation() {
    use serde_json::{Value, json};
    use uuid::Uuid;

    let id = Uuid::now_v7();
    let payment = Uuid::now_v7();
    let period = Uuid::now_v7();
    let mut sale = json!({
        "id": id, "currency": "EUR", "status": "paid", "canRefund": true,
        "refundReviewGeneration": "current", "totalCents": 2200, "discountCents": 0,
        "paidCents": 2200, "balanceCents": 0,
        "lines": [{"id": Uuid::now_v7(), "passPeriodId": period, "description": "Membership",
            "quantity": 1, "unitAmountCents": 2200}],
        "payments": [{"id": payment, "method": "external_card", "status": "succeeded",
            "amountCents": 2200}]
    });
    let paid: AppointmentCheckout = serde_json::from_value(sale.clone()).unwrap();
    let quote = json!({"amountCents": 2200, "unitCount": 0, "excessCents": 0,
        "availableUses": 0, "accessFee": true});
    let refund = json!({"id": Uuid::now_v7(), "paymentId": payment, "amountCents": 2200,
        "reason": "Access fee refund", "status": "succeeded"});
    sale["refunds"] = json!([refund]);
    sale["refundedCents"] = json!(2200);
    sale["status"] = json!("refunded");
    let (base, requests) = serve(vec![
        http("200 OK", &[], &quote.to_string()),
        http("201 Created", &[], &refund.to_string()),
        http("200 OK", &[], &sale.to_string()),
    ]);
    let transport = signed_in(&base);
    let quote = transport.quote_pass_refund(&paid, payment, 0).unwrap();
    assert!(quote.access_fee);
    let unquoted = RefundAttempt::new(2200, "Access fee refund").unwrap();
    assert!(matches!(
        transport.record_checkout_refund(&paid, payment, &unquoted),
        Err(TransportError::BadRequest(_))
    ));
    let attempt =
        RefundAttempt::from_pass_quote(&quote, "Access fee refund", period, "current".into())
            .unwrap();
    let refunded = transport
        .record_checkout_refund(&paid, payment, &attempt)
        .unwrap();
    assert_eq!(refunded.refunded_cents, 2200);
    let requests = requests.lock().unwrap();
    let body = |index: usize| {
        serde_json::from_str::<Value>(requests[index].split_once("\r\n\r\n").unwrap().1).unwrap()
    };
    assert!(requests[0].starts_with("POST /admin/passes/refund-quote "));
    assert_eq!(
        body(0),
        json!({"periodId": period, "paymentId": payment, "unitCount": 0})
    );
    assert_eq!(
        body(1)["passQuote"],
        json!({"periodId": period, "unitCount": 0, "generation": "current"})
    );
    assert_eq!(body(1)["amountCents"], 2200);
}

#[test]
fn a_lost_bank_reservation_response_can_be_replayed_from_a_reopened_replica() {
    use crate::billing::{BankPaymentMethod, BankRefundReviewContext, ReviewedBankRefund};
    use crate::store::Store;
    use serde_json::json;
    use uuid::Uuid;

    let id = Uuid::now_v7();
    let payment = Uuid::now_v7();
    let reservation = Uuid::now_v7();
    let saved = SavedBankRefund {
        payment_id: payment,
        method: BankPaymentMethod::Card,
        request: ReviewedBankRefund {
            attempt: RefundAttempt::new(1800, "Synthetic bank refund").unwrap(),
            review: BankRefundReviewContext {
                checkout_id: id,
                actor_user_id: "u".into(),
                generation: "live".into(),
            },
        },
    };
    let refund = json!({
        "id": reservation, "paymentId": payment, "amountCents": 1800,
        "reason": saved.request.attempt.reason(), "status":"requested",
    });
    let mut data = json!({
        "id": id, "currency":"EUR", "status":"paid", "canRefund":true, "refundReviewGeneration":"live",
        "totalCents":1800, "paidCents":1800, "discountCents":0, "balanceCents":0,
        "payments":[{"id":payment, "method":"redsys_card", "status":"succeeded",
            "amountCents":1800, "order":"123412345678"}],
    });
    let initial = serde_json::from_value(data.clone()).unwrap();
    data["refunds"] = json!([refund.clone()]);
    let fresh = serde_json::from_value::<AppointmentCheckout>(data.clone()).unwrap();
    assert!(fresh.recordable_refunds_available().next().is_none());
    let (base, log) = serve(vec![
        http("503 Service Unavailable", &[], ""),
        http("201 Created", &[], &refund.to_string()),
        http("404 Not Found", &[], ""),
        http("201 Created", &[], &refund.to_string()),
        http("200 OK", &[], &data.to_string()),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("desk.db");
    {
        let store = Store::open(&path).unwrap();
        assert!(store.reserve_bank_refund(&saved).unwrap());
        assert!(
            signed_in(&base)
                .record_reviewed_bank_refund(&initial, &saved)
                .is_err()
        );
    }
    let store = Store::open(&path).unwrap();
    assert!(
        store
            .pending_bank_refund(id, "another-user")
            .unwrap()
            .is_none()
    );
    assert!(!store.reserve_bank_refund(&saved).unwrap());
    let recovered = store.pending_bank_refund(id, "u").unwrap().unwrap();
    assert_eq!(recovered, saved);
    let transport = signed_in(&base);
    data["refundReviewGeneration"] = json!("restored");
    let from_backup = serde_json::from_value(data).unwrap();
    assert!(matches!(
        transport.record_reviewed_bank_refund(&from_backup, &recovered),
        Err(TransportError::ReplicaGenerationChanged)
    ));
    let unverified = transport.record_reviewed_bank_refund(&fresh, &recovered);
    assert!(matches!(unverified, Err(TransportError::Server(_))));
    store.settle_bank_refund(&recovered, &unverified).unwrap();
    assert_eq!(
        store.pending_bank_refund(id, "u").unwrap(),
        Some(recovered.clone())
    );
    let confirmed = transport.record_reviewed_bank_refund(&fresh, &recovered);
    let updated = confirmed.as_ref().unwrap();
    assert_eq!(updated.refunds[0].id, reservation);
    store.settle_bank_refund(&recovered, &confirmed).unwrap();
    assert!(store.pending_bank_refund(id, "u").unwrap().is_none());
    let log = log.lock().unwrap();
    assert_eq!(log.len(), 5);
    assert_eq!(
        log[0].split_once("\r\n\r\n").unwrap().1,
        log[1].split_once("\r\n\r\n").unwrap().1
    );
    assert_eq!(
        log[1].split_once("\r\n\r\n").unwrap().1,
        log[3].split_once("\r\n\r\n").unwrap().1
    );
}

#[test]
fn report_transport_reads_the_filtered_summary_and_exports_safe_csv() {
    let counts = serde_json::json!({"booked": 1, "completed": 0, "cancelled": 0, "no_show": 0});
    let slice = serde_json::json!({"appointments": 1, "revenueCents": 0, "byStatus": counts});
    let response = serde_json::json!({
        "from": "2026-11-18", "to": "2026-11-18", "currency": "EUR", "currencies": ["EUR"],
        "totals": slice, "series": [], "perStaff": [], "topServices": [],
        "appointmentBreakdown": {"hour": [], "category": [], "addon": [], "service": [
            {"label": "=1,2", "appointments": 1, "byStatus": counts}
        ]},
    });
    let (base, seen) = serve(vec![http("200 OK", &[], &response.to_string())]);
    let query = ReportQuery {
        from: "2026-11-18".parse().unwrap(),
        to: "2026-11-18".parse().unwrap(),
        staff_id: Some("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa".into()),
        currency: Some("EUR".into()),
    };
    let report = signed_in(&base).report_summary(&query).unwrap();
    assert_eq!(report.totals.appointments, 1);
    assert!(!report.can_report_clients);
    assert!(report.to_csv().contains("service,\"'=1,2\",1,1,0,0,0\r\n"));
    let seen = seen.lock().unwrap();
    assert!(seen[0].starts_with(concat!(
        "GET /admin/reports/summary?from=2026-11-18&to=2026-11-18",
        "&staffId=aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa&currency=EUR "
    )));
    assert!(
        seen[0]
            .to_lowercase()
            .contains("cookie: better-auth.session_token=tok%3d")
    );
}

#[test]
fn report_csv_distinguishes_unknown_amounts_from_free_services() {
    let report: crate::reports::ReportSummary = serde_json::from_value(serde_json::json!({
        "from": "2026-11-18", "to": "2026-11-18", "currency": "EUR",
        "totals": {"appointments": 1, "revenueCents": 0, "unpricedServices": 1,
            "byStatus": {"booked": 0, "completed": 1, "cancelled": 0, "no_show": 0}},
        "series": [], "perStaff": [],
        "topServices": [
            {"name": "Pending care", "count": 1, "revenueCents": 0, "unpricedServices": 1},
            {"name": "Free care", "count": 1, "revenueCents": 0}
        ],
    }))
    .unwrap();
    assert_eq!(report.totals.unpriced_services, 1);
    assert!(report.to_csv().contains(concat!(
        "service,completed,revenue,currency,unpriced_services\r\n",
        "Pending care,1,0.00,EUR,1\r\n",
        "Free care,1,0.00,EUR,0\r\n",
    )));
}

#[test]
fn client_reports_use_the_professional_and_dates_without_currency() {
    let (base, seen) = serve(vec![http(
        "200 OK",
        &["Content-Type: application/json"],
        r#"{"from":"2026-11-18","to":"2026-11-20","totals":{"newClients":2,"returningClients":3},"rows":[{"date":"2026-11-19","newClients":2,"returningClients":3}]}"#,
    )]);
    let report = signed_in(&base)
        .report_clients(&ReportQuery {
            from: "2026-11-18".parse().unwrap(),
            to: "2026-11-20".parse().unwrap(),
            staff_id: Some("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa".into()),
            currency: Some("EUR".into()),
        })
        .unwrap();
    assert_eq!(report.totals.returning_clients, 3);
    assert_eq!(
        report.to_csv(),
        "date,new_clients,returning_clients\r\n2026-11-19,2,3\r\n"
    );
    assert!(seen.lock().unwrap()[0].starts_with(concat!(
        "GET /admin/reports/clients?from=2026-11-18&to=2026-11-20",
        "&staffId=aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa "
    )));
}

#[test]
fn outcome_lists_are_paged_and_the_export_stream_uses_the_same_filters() {
    let (base, seen) = serve(vec![
        http(
            "200 OK",
            &["Content-Type: application/json"],
            r#"{"timezone":"Europe/Madrid","total":28,"page":2,"pageSize":25,"rows":[{"startsAt":"2026-11-19T11:42:00.000031Z","client":null,"staff":"Ada","services":["Haircut"]}]}"#,
        ),
        http(
            "200 OK",
            &["Content-Type: text/csv; charset=utf-8"],
            "status\r\nno_show\r\n",
        ),
        http(
            "403 Forbidden",
            &["Content-Type: application/json"],
            r#"{"error":{}}"#,
        ),
    ]);
    let query = ReportQuery {
        from: "2026-11-18".parse().unwrap(),
        to: "2026-11-20".parse().unwrap(),
        staff_id: None,
        currency: Some("EUR".into()),
    };
    let transport = signed_in(&base);
    let page = transport
        .report_outcomes(&query, Outcome::NoShow, 2)
        .unwrap();
    assert_eq!((page.total, page.page, page.page_size), (28, 2, 25));
    assert_eq!(page.rows[0].starts_at.timestamp_subsec_micros(), 31);
    assert!(page.rows[0].client.is_none());
    let mut output = Vec::new();
    transport
        .write_report_outcomes_csv(&query, Outcome::NoShow, &mut output)
        .unwrap();
    assert_eq!(output, b"status\r\nno_show\r\n");
    assert!(matches!(
        transport.write_report_outcomes_csv(&query, Outcome::Cancelled, &mut output),
        Err(TransportError::Forbidden(_))
    ));
    assert_eq!(output, b"status\r\nno_show\r\n");
    let seen = seen.lock().unwrap();
    assert!(seen[0].starts_with(concat!(
        "GET /admin/reports/outcomes?",
        "from=2026-11-18&to=2026-11-20&currency=EUR&status=no_show&page=2 "
    )));
    assert!(seen[1].starts_with(concat!(
        "GET /admin/reports/outcomes/export?",
        "from=2026-11-18&to=2026-11-20&currency=EUR&status=no_show "
    )));
}

#[test]
fn price_review_reads_the_version_and_sends_exact_prices_to_the_guarded_endpoint() {
    use crate::billing::ReviewedServicePrice;
    let id = "01a1d81f-2231-75bd-ba65-bc41f42803e9";
    let (base, seen) = serve(vec![
        http(
            "200 OK",
            &[],
            &serde_json::json!({"appointmentVersion": 4, "lines": [{"id": id, "name": "Haircut"}]})
                .to_string(),
        ),
        http("200 OK", &[], r#"{ "ok": true }"#),
    ]);
    let transport = signed_in(&base);
    let preview = transport.imported_price_preview(id).unwrap();
    assert_eq!(preview.appointment_version, 4);
    transport
        .review_imported_price(
            id,
            &ImportedPriceReview {
                appointment_version: preview.appointment_version,
                reference: "Checked fixture quote".into(),
                lines: vec![ReviewedServicePrice {
                    id: preview.lines[0].id.clone(),
                    amount_cents: 3650,
                }],
            },
        )
        .unwrap();
    let seen = seen.lock().unwrap();
    let path = format!("/admin/commerce/appointments/{id}/imported-price");
    assert!(seen[0].starts_with(&format!("GET {path} ")));
    assert!(seen[1].starts_with(&format!("PUT {path} ")));
    assert!(
        seen[1]
            .to_lowercase()
            .contains("cookie: better-auth.session_token=tok%3d")
    );
    let body: serde_json::Value =
        serde_json::from_str(seen[1].split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["lines"][0]["amountCents"], 3650);
    assert_eq!(body["appointmentVersion"], 4);
}

#[test]
fn checkout_retries_the_exact_cash_registration_when_a_response_is_lost() {
    use serde_json::{Value, json};

    let appointment = "01a1d81f-2231-75bd-ba65-bc41f42803e9";
    let id = "01a1d81f-2231-75bd-ba65-bc41f4280300";
    let balance = ExternalBalance {
        paid_in_booksy_cents: 3500,
        due_in_citame_cents: 6500,
    };
    let open = json!({
        "id": id, "appointmentId": appointment, "currency": "EUR", "status": "open",
        "totalCents": 6500, "discountCents": 0, "paidCents": 0, "balanceCents": 6500, "externalBalance": balance,
        "payments": [],
    });
    let payment = json!({"method":"cash", "amountCents": 6500, "status":"succeeded"});
    let mut paid = open.clone();
    paid["status"] = json!("paid");
    paid["paidCents"] = json!(6500);
    paid["balanceCents"] = json!(0);
    paid["payments"] = json!([payment.clone()]);
    let (base, seen) = serve(vec![
        http("201 Created", &[], &open.to_string()),
        http("503 Service Unavailable", &[], ""),
        http(
            "201 Created",
            &[],
            &json!({ "payment": payment }).to_string(),
        ),
        http("200 OK", &[], &paid.to_string()),
    ]);

    let transport = signed_in(&base);
    let checkout = transport
        .open_appointment_checkout(appointment, Some(balance))
        .unwrap();
    let attempt = PaymentAttempt::new(ReceiptTender::Cash, 6500);
    assert!(
        transport
            .record_checkout_payment(&checkout, &attempt)
            .is_err()
    );
    let recorded = transport
        .record_checkout_payment(&checkout, &attempt)
        .unwrap();
    assert_eq!(recorded.paid_cents, 6500);
    assert_eq!(recorded.collectible_cents(), 0);

    let requests = seen.lock().unwrap();
    let body = |index: usize| -> Value {
        serde_json::from_str(requests[index].split_once("\r\n\r\n").unwrap().1).unwrap()
    };
    assert!(body(0).get("useClientDiscount").is_none());
    assert_eq!(body(1), body(2));
    assert_eq!(body(2)["amountCents"], 6500);
    assert_eq!(body(2)["method"], "cash");
    assert!(requests[3].starts_with(&format!("GET /admin/commerce/checkouts/{id} ")));
}

#[test]
fn appointment_checkout_uses_the_server_payable_limit_and_blocks_unresolved_payments() {
    use crate::billing::{PaymentAttempt, ReceiptTender};
    use serde_json::{Value, json};

    let appointment = "01a1d81f-2231-75bd-ba65-bc41f42803e9";
    let id = "01a1d81f-2231-75bd-ba65-bc41f4280300";
    let open = json!({
        "id": id, "appointmentId": appointment, "currency": "EUR", "status": "open",
        "totalCents": 9000, "discountCents": 1000, "paidCents": 1000,
        "balanceCents": 8000, "payableCents": 1500, "payments": [],
    });
    let mut pending = open.clone();
    pending["payments"] = json!([{ "status": "reconciliation" }]);
    let (base, seen) = serve(vec![
        http("201 Created", &[], &open.to_string()),
        http("201 Created", &[], &pending.to_string()),
    ]);
    let transport = signed_in(&base);
    let checkout = transport
        .open_appointment_checkout(appointment, None)
        .unwrap();
    assert_eq!(checkout.collectible_cents(), 1500);
    assert!(matches!(
        transport
            .record_checkout_payment(&checkout, &PaymentAttempt::new(ReceiptTender::Cash, 1501)),
        Err(TransportError::BadRequest(_))
    ));
    let checkout = transport
        .open_appointment_checkout(appointment, None)
        .unwrap();
    assert_eq!(checkout.collectible_cents(), 0);
    assert!(
        transport
            .record_checkout_payment(&checkout, &PaymentAttempt::new(ReceiptTender::Cash, 1000))
            .is_err()
    );
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let body: Value = serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["useClientDiscount"], true);
}

fn req() -> PushRequest {
    PushRequest {
        generation: None,
        device_id: "dev-1".into(),
        mutations: vec![WireMutation {
            mutation_id: "01a1d81f-2231-75bd-ba65-bc41f42803e9".into(),
            created_at: "2026-03-09T11:58:03.120Z".into(),
            kind: "client.create".into(),
            payload: serde_json::json!({"id": "c1", "name": "Lucia"}),
        }],
    }
}

#[test]
fn push_posts_json_with_the_session_cookie_and_parses_results() {
    let body = r#"{"results":[{"mutationId":"01a1d81f-2231-75bd-ba65-bc41f42803e9","status":"applied","appliedSeq":12,"replayed":false}],"headSeq":12}"#;
    let (base, seen) = serve(vec![http(
        "200 OK",
        &["Content-Type: application/json"],
        body,
    )]);
    let r = signed_in(&base).push(&req()).unwrap();
    assert_eq!(r.head_seq, 12);
    assert!(matches!(
        &r.results[0],
        MutationResult::Applied {
            applied_seq: Some(12),
            ..
        }
    ));
    let sent = seen.lock().unwrap()[0].clone();
    assert!(sent.starts_with("POST /sync/push HTTP/1.1"), "{sent}");
    assert!(
        sent.to_lowercase()
            .contains("cookie: better-auth.session_token=tok%3d"),
        "{sent}"
    );
    assert!(
        sent.to_lowercase()
            .contains("content-type: application/json")
    );
    assert!(
        sent.contains("\"deviceId\":\"dev-1\"")
            && sent.contains("\"mutationId\":\"01a1d81f-2231-75bd-ba65-bc41f42803e9\"")
    );
}

#[test]
fn pull_sends_cursor_and_limit_and_parses_the_page() {
    let body = r#"{"changes":[{"seq":3,"entity":"time_off","id":"t1","op":"delete","data":null}],"nextCursor":3,"hasMore":true,"headSeq":9}"#;
    let (base, seen) = serve(vec![http(
        "200 OK",
        &["Content-Type: application/json"],
        body,
    )]);
    let p = signed_in(&base).pull(2, 200).unwrap();
    assert_eq!((p.next_cursor, p.has_more, p.head_seq), (3, true, 9));
    assert_eq!(p.changes[0].op, "delete");
    assert!(
        seen.lock().unwrap()[0]
            .starts_with("GET /sync/pull?since=2&limit=200&reviewRequests=1 HTTP/1.1")
    );
}

#[test]
fn an_upgraded_replica_recovers_service_colors_without_rewinding_its_cursor() {
    use crate::store::Store;
    use crate::sync::pull_all;
    use serde_json::json;

    let mut store = Store::open_in_memory().unwrap();
    store
        .apply_page(
            &[RawChange {
                seq: 1,
                entity: "service".into(),
                id: "s1".into(),
                op: "upsert".into(),
                data: Some(json!({
                    "id": "s1", "name": "Haircut", "durationMinutes": 45,
                    "bufferMinutes": 0, "priceCents": 100, "currency": "EUR",
                    "active": true, "updatedAt": "2026-03-01T10:00:00.000Z",
                    "quoteHash": "a".repeat(64)
                })),
            }],
            42,
        )
        .unwrap();
    let pending = store
        .enqueue("client.create", "local", json!({"id":"local","name":"Ana"}))
        .unwrap();
    let page = r#"{"changes":[],"nextCursor":42,"hasMore":false,"headSeq":42}"#;
    let repaired = r##"{"changes":[],"nextCursor":42,"hasMore":false,"headSeq":42,"catalogColors":{"s1":"#AC3456"}}"##;
    let (base, seen) = serve(
        [page, repaired, page]
            .map(|body| http("200 OK", &["Content-Type: application/json"], body))
            .to_vec(),
    );
    let transport = signed_in(&base);
    assert_eq!(pull_all(&mut store, &transport).unwrap().cursor, 42);
    assert_eq!(store.services().unwrap()[0].color, None);
    assert_eq!(pull_all(&mut store, &transport).unwrap().cursor, 42);
    let service = store.services().unwrap().remove(0);
    assert_eq!(service.name, "Haircut");
    assert_eq!(service.color.as_deref(), Some("#AC3456"));
    assert_eq!(store.outbox(1).unwrap()[0].mutation_id, pending.mutation_id);
    pull_all(&mut store, &transport).unwrap();
    let requests = seen.lock().unwrap();
    assert!(
        requests[0]
            .starts_with("GET /sync/pull?since=42&limit=200&catalogColors=1&reviewRequests=1 ")
    );
    assert!(
        requests[1]
            .starts_with("GET /sync/pull?since=42&limit=200&catalogColors=1&reviewRequests=1 ")
    );
    assert!(requests[2].starts_with("GET /sync/pull?since=42&limit=200&reviewRequests=1 "));
}

fn status_of(code: &str, headers: &[&str], body: &str, pull: bool) -> TransportError {
    let (base, _) = serve(vec![http(code, headers, body)]);
    let t = signed_in(&base);
    if pull {
        t.pull(0, 10).unwrap_err()
    } else {
        t.push(&req()).unwrap_err()
    }
}

#[test]
fn error_statuses_follow_the_protocol_table() {
    assert_eq!(
        status_of(
            "401 Unauthorized",
            &[],
            r#"{"error":{"code":"unauthorized","message":"x"}}"#,
            false
        ),
        TransportError::Unauthorized
    );
    assert!(
        matches!(status_of("403 Forbidden", &[], r#"{"error":{"code":"forbidden","message":"nope"}}"#, false), TransportError::Forbidden(m) if m.contains("nope"))
    );
    assert_eq!(
        status_of("429 Too Many Requests", &["Retry-After: 7"], "{}", false),
        TransportError::RateLimited(Some(Duration::from_secs(7)))
    );
    assert_eq!(
        status_of("429 Too Many Requests", &[], "{}", true),
        TransportError::RateLimited(None)
    );
    assert!(matches!(
        status_of("500 Internal Server Error", &[], "", false),
        TransportError::Server(_)
    ));
    assert!(matches!(
        status_of("502 Bad Gateway", &[], "<html>", true),
        TransportError::Server(_)
    ));
    assert!(
        matches!(status_of("400 Bad Request", &[], r#"{"error":{"code":"validation_error","message":"too many"}}"#, false), TransportError::BadRequest(m) if m.contains("too many"))
    );
    assert_eq!(
        status_of(
            "409 Conflict",
            &[],
            r#"{"error":{"code":"invalid_state","message":"ahead"}}"#,
            true
        ),
        TransportError::CursorAhead
    );
}

#[test]
fn a_garbled_success_body_is_treated_like_a_server_failure() {
    assert!(matches!(
        status_of("200 OK", &[], "<html>captive portal</html>", false),
        TransportError::Server(_)
    ));
}

#[test]
fn classify_is_pure() {
    assert_eq!(
        classify_status(401, None, "", true),
        TransportError::Unauthorized
    );
    assert_eq!(
        classify_status(429, Some("Wed, 21 Oct 2026 07:28:00 GMT"), "", true),
        TransportError::RateLimited(None)
    );
    assert_eq!(
        classify_status(
            409,
            None,
            r#"{"error":{"code":"sync_generation_changed"}}"#,
            false
        ),
        TransportError::ReplicaGenerationChanged
    );
}

#[test]
fn an_unreachable_server_is_offline() {
    let port = {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    };
    let e = signed_in(&format!("http://127.0.0.1:{port}"))
        .pull(0, 10)
        .unwrap_err();
    assert!(matches!(e, TransportError::Offline(_)), "{e:?}");
}

#[test]
fn without_a_session_nothing_goes_on_the_wire() {
    let session: SessionHandle = Arc::new(RwLock::new(None));
    let t = HttpTransport::new(
        "http://127.0.0.1:9",
        session,
        Arc::new(BetterAuthSession::new("http://127.0.0.1:9")),
    );
    assert_eq!(t.pull(0, 10).unwrap_err(), TransportError::Unauthorized);
}

#[test]
fn sign_in_returns_the_session_cookie_and_user() {
    let body = r#"{"redirect":false,"token":"t","user":{"id":"u1","name":"Owner","email":"owner@example.com","role":"owner"}}"#;
    let (base, seen) = serve(vec![http(
        "200 OK",
        &[
            "Content-Type: application/json",
            "Set-Cookie: better-auth.session_token=abc.def%3D; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax",
        ],
        body,
    )]);
    let s = BetterAuthSession::new(&base)
        .sign_in(&Credentials {
            email: "owner@example.com".into(),
            password: "pw".into(),
        })
        .unwrap();
    assert_eq!(
        (s.cookie.as_str(), s.role.as_str(), s.user_id.as_str()),
        ("better-auth.session_token=abc.def%3D", "owner", "u1")
    );
    let sent = seen.lock().unwrap()[0].clone();
    assert!(sent.starts_with("POST /api/auth/sign-in/email HTTP/1.1"));
    assert!(
        sent.contains("\"email\":\"owner@example.com\"") && sent.contains("\"password\":\"pw\"")
    );
}

#[test]
fn sign_in_failures_are_distinguished() {
    let creds = Credentials {
        email: "a@b.c".into(),
        password: "x".into(),
    };
    let (base, _) = serve(vec![http(
        "401 Unauthorized",
        &[],
        r#"{"code":"INVALID_EMAIL_OR_PASSWORD","message":"Invalid email or password"}"#,
    )]);
    assert_eq!(
        BetterAuthSession::new(&base).sign_in(&creds).unwrap_err(),
        crate::auth::AuthError::InvalidCredentials
    );

    let body = r#"{"user":{"id":"u2","name":"Cli","email":"a@b.c","role":"client"}}"#;
    let (base, _) = serve(vec![http(
        "200 OK",
        &["Set-Cookie: better-auth.session_token=z; Path=/"],
        body,
    )]);
    assert!(
        matches!(BetterAuthSession::new(&base).sign_in(&creds).unwrap_err(), crate::auth::AuthError::WrongRole(r) if r == "client")
    );

    let port = {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    };
    assert!(matches!(
        BetterAuthSession::new(&format!("http://127.0.0.1:{port}"))
            .sign_in(&creds)
            .unwrap_err(),
        crate::auth::AuthError::Network(_)
    ));
}

#[test]
fn validate_asks_the_server_whether_the_session_is_alive() {
    let s = Session {
        cookie: "better-auth.session_token=a".into(),
        oauth: None,
        user_id: "u".into(),
        name: "n".into(),
        email: "e".into(),
        role: "owner".into(),
    };
    let (base, seen) = serve(vec![
        http(
            "200 OK",
            &[],
            r#"{"user":{"id":"u","name":"n","email":"e","role":"owner"}}"#,
        ),
        http(
            "200 OK",
            &[],
            r#"{"user":{"id":"u","name":"n","email":"e","role":"staff"}}"#,
        ),
        http("401 Unauthorized", &[], "{}"),
    ]);
    let a = BetterAuthSession::new(&base);
    assert_eq!(a.validate(&s), Ok(true));
    assert_eq!(a.validate(&s), Ok(false));
    assert_eq!(a.validate(&s), Ok(false));
    assert!(seen.lock().unwrap()[0].starts_with("GET /me HTTP/1.1"));
}

fn sse(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n{body}"
    )
}

#[test]
fn the_stream_forwards_change_events_and_ignores_pings() {
    let body = "event: change\nid: 5\ndata: {\"seq\":5}\n\n: ping\n\nevent: change\nid: 6\ndata: {\"seq\":6}\n\n";
    let (base, seen) = serve(vec![sse(body)]);
    let t = signed_in(&base);
    let (mut connected, mut seqs) = (0, vec![]);
    let end = stream_once(&t, &mut || connected += 1, &mut |s| seqs.push(s)).unwrap();
    assert_eq!(end, StreamEnd::Closed);
    assert_eq!((connected, seqs), (1, vec![5, 6]));
    let sent = seen.lock().unwrap()[0].to_lowercase();
    assert!(
        sent.starts_with("get /sync/stream http/1.1")
            && sent.contains("accept: text/event-stream")
            && sent.contains("cookie: better-auth.session_token=tok%3d")
    );
}

#[test]
fn the_stream_reports_auth_and_rate_limit_errors() {
    let (base, _) = serve(vec![http("401 Unauthorized", &[], "{}")]);
    assert_eq!(
        stream_once(&signed_in(&base), &mut || {}, &mut |_| {}).unwrap_err(),
        TransportError::Unauthorized
    );
    let (base, _) = serve(vec![http(
        "429 Too Many Requests",
        &["Retry-After: 3"],
        "{}",
    )]);
    assert_eq!(
        stream_once(&signed_in(&base), &mut || {}, &mut |_| {}).unwrap_err(),
        TransportError::RateLimited(Some(Duration::from_secs(3)))
    );
}

#[test]
fn the_listener_reconnects_after_the_stream_closes_and_wakes_the_runner() {
    let first = sse("event: change\nid: 5\ndata: {\"seq\":5}\n\n");
    let second = sse("event: change\nid: 7\ndata: {\"seq\":7}\n\n");
    let (base, _) = serve(vec![first, second]);
    let t = Arc::new(signed_in(&base));
    let (tx, rx) = mpsc::channel();
    let live = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let h = spawn_stream_listener(t, tx, live.clone(), stop.clone());
    let got: Vec<_> = (0..4)
        .map(|_| rx.recv_timeout(Duration::from_secs(10)).unwrap())
        .collect();
    assert_eq!(
        got,
        vec![Wake::Manual, Wake::Nudge(5), Wake::Manual, Wake::Nudge(7)]
    );
    stop.store(true, Ordering::SeqCst);
    h.join().unwrap();
    assert!(!live.load(Ordering::SeqCst));
}

#[test]
fn neither_credentials_nor_synced_data_follow_a_redirect_to_another_server() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    target.set_nonblocking(true).unwrap();
    let location = format!(
        "Location: http://{}/unexpected",
        target.local_addr().unwrap()
    );
    let (origin, seen) = serve(vec![
        http("307 Temporary Redirect", &[&location], ""),
        http("307 Temporary Redirect", &[&location], ""),
    ]);
    let browser_session = Arc::new(BetterAuthSession::new(&origin));
    let result = browser_session.sign_in(&Credentials {
        email: "operator@local.test".into(),
        password: "synthetic sign in".into(),
    });
    assert!(matches!(result, Err(crate::auth::AuthError::Unexpected(_))));
    let handle = Arc::new(std::sync::RwLock::new(Some(Session {
        cookie: "better-auth.session_token=synthetic".into(),
        oauth: None,
        user_id: "id".into(),
        role: "owner".into(),
        name: "Owner".into(),
        email: "operator@local.test".into(),
    })));
    let transport = HttpTransport::new(&origin, handle, browser_session);
    assert!(transport.pull(0, 20).is_err());
    assert_eq!(seen.lock().unwrap().len(), 2);
    assert_eq!(
        target.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn concurrent_requests_share_one_rotated_desktop_token_and_save_it() {
    let tokens = r#"{"access_token":"next","refresh_token":"next-refresh","expires_in":900}"#;
    let page = r#"{"changes":[],"nextCursor":0,"hasMore":false,"headSeq":0}"#;
    let (base, seen) = serve(vec![
        http("200 OK", &[], tokens),
        http("200 OK", &[], page),
        http("200 OK", &[], page),
    ]);
    let expired: Session = serde_json::from_value(serde_json::json!({
        "oauth": {"access_token": "old", "refresh_token": "old-refresh", "expires_at": 0},
        "user_id": "u", "name": "Owner", "email": "owner@example.com", "role": "owner"
    }))
    .unwrap();
    let state = Arc::new(RwLock::new(Some(expired)));
    let saved = Arc::new(crate::auth::MemoryTokenStore::default());
    let t = Arc::new(
        HttpTransport::new(
            &base,
            state.clone(),
            Arc::new(BetterAuthSession::new(&base)),
        )
        .with_token_store(saved.clone()),
    );
    std::thread::scope(|scope| {
        let parallel = t.clone();
        let first = scope.spawn(move || parallel.pull(0, 20).unwrap());
        let second = t.pull(0, 20).unwrap();
        assert_eq!(first.join().unwrap(), second);
    });
    assert_eq!(saved.load().unwrap(), state.read().unwrap().clone());
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[0].starts_with("POST /api/auth/oauth2/token"));
    assert!(requests[0].contains("refresh_token=old-refresh"));
    for req in &requests[1..] {
        assert!(
            req.to_ascii_lowercase()
                .contains("authorization: bearer next")
        );
        assert!(!req.to_ascii_lowercase().contains("cookie:"));
    }
}

#[test]
fn a_replica_for_an_old_role_does_not_accept_the_new_roles_snapshot() {
    let (base, _) = serve(vec![http(
        "200 OK",
        &[],
        r#"{"changes":[],"nextCursor":3,"hasMore":false,"headSeq":3,"viewerRole":"staff"}"#,
    )]);
    assert_eq!(
        signed_in(&base).pull(0, 20),
        Err(TransportError::Unauthorized)
    );
}

#[test]
fn staff_portrait_transport_loads_authorized_directory_and_fences_writes() {
    let id = "01a1d81f-2231-75bd-ba65-bc41f42803e9";
    let version = "01a1d81f-2231-75bd-ba65-bc41f4280300";
    let absence = "01a1d81f-2231-75bd-ba65-bc41f4280311";
    let staff = serde_json::json!({"canEditPortraits": true, "staff": [{
        "id": id, "displayName": "Example", "active": true, "portraitVersion": version
    }]});
    let after_removal = serde_json::json!({"canEditPortraits": true, "staff": [{
        "id": id, "displayName": "Example", "active": true, "portraitAbsenceVersion": absence
    }]});
    let (base, seen) = serve(vec![
        http("200 OK", &[], &staff.to_string()),
        http("404 Not Found", &[], ""),
        http(
            "409 Conflict",
            &[],
            r#"{"error":{"code":"version_conflict"}}"#,
        ),
        http("200 OK", &[], r#"{"version":null}"#),
        http("200 OK", &[], &after_removal.to_string()),
        http("200 OK", &[], &staff.to_string()),
    ]);
    let transport = signed_in(&base);
    let directory = transport.portrait_directory().unwrap();
    assert!(directory.can_edit);
    assert!(!directory.staff[0].portrait_published);
    assert_eq!(directory.staff[0].upload_version(), Some(version));
    assert!(transport.staff_portrait(id, version).is_err());
    assert!(
        transport
            .set_staff_portrait(
                id,
                PortraitUpdate::Publish {
                    version: version.into(),
                    published: true,
                }
            )
            .is_err()
    );
    transport
        .set_staff_portrait(
            id,
            PortraitUpdate::Remove {
                version: version.into(),
            },
        )
        .unwrap();
    let directory = transport.portrait_directory().unwrap();
    assert!(directory.staff[0].portrait_version.is_none());
    transport
        .set_staff_portrait(
            id,
            PortraitUpdate::Upload {
                version: directory.staff[0].upload_version().map(str::to_owned),
                jpeg: vec![255, 216, 255],
            },
        )
        .unwrap();

    let requests = seen.lock().unwrap();
    let body = |index: usize| -> serde_json::Value {
        serde_json::from_str(requests[index].split_once("\r\n\r\n").unwrap().1).unwrap()
    };
    assert!(requests[1].starts_with(&format!("GET /admin/staff/{id}/portrait?v={version} ")));
    assert!(requests[2].starts_with(&format!("PUT /admin/staff/{id}/portrait/publication ")));
    assert_eq!(
        body(2),
        serde_json::json!({"version":version,"published":true})
    );
    assert_eq!(
        body(3),
        serde_json::json!({"version":version,"imageBase64":null})
    );
    assert_eq!(
        body(5),
        serde_json::json!({"version":absence,"imageBase64":"/9j/"})
    );
}
