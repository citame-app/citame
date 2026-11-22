use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::*;
use crate::ops::*;

type PushFn = Box<dyn Fn(&PushRequest) -> Result<PushResponse, TransportError> + Send + Sync>;
type PullFn = Box<dyn Fn(i64, u32) -> Result<PullResponse, TransportError> + Send + Sync>;

/// A scripted peer. Not a server fake for the headless test (that one talks to the real API);
/// this one lets unit tests inject faults the real server cannot produce on demand.
struct Fake {
    push: PushFn,
    pull: PullFn,
    log: Mutex<Vec<String>>,
    pushes: Mutex<Vec<PushRequest>>,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
}

impl Fake {
    fn new(push: PushFn, pull: PullFn) -> Self {
        Self {
            push,
            pull,
            log: Mutex::new(vec![]),
            pushes: Mutex::new(vec![]),
            in_flight: AtomicUsize::new(0),
            max_in_flight: AtomicUsize::new(0),
        }
    }
    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
    fn pushes(&self) -> Vec<PushRequest> {
        self.pushes.lock().unwrap().clone()
    }
}

impl Transport for Fake {
    fn push(&self, request: &PushRequest) -> Result<PushResponse, TransportError> {
        let n = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_in_flight.fetch_max(n, Ordering::SeqCst);
        self.log
            .lock()
            .unwrap()
            .push(format!("push:{}", request.mutations.len()));
        self.pushes.lock().unwrap().push(request.clone());
        let r = (self.push)(request);
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        r
    }
    fn pull(&self, since: i64, limit: u32) -> Result<PullResponse, TransportError> {
        self.log.lock().unwrap().push(format!("pull:{since}"));
        (self.pull)(since, limit)
    }
}

fn applied_all(req: &PushRequest) -> Result<PushResponse, TransportError> {
    Ok(PushResponse {
        results: req
            .mutations
            .iter()
            .map(|m| MutationResult::Applied {
                mutation_id: m.mutation_id.clone(),
                applied_seq: Some(1),
                replayed: false,
            })
            .collect(),
        head_seq: 1,
    })
}

fn empty_pull(since: i64, _limit: u32) -> Result<PullResponse, TransportError> {
    Ok(PullResponse {
        generation: None,
        changes: vec![],
        next_cursor: since,
        has_more: false,
        refresh: vec![],
        time_off_scope: None,
        client_directory: None,
        gift_cards_scope: None,
        client_groups: None,
        calendar_scope: None,
        viewer_role: None,
        viewer_edit_catalogue: None,
        peak_prices: None,
        peak_price_access: None,
        resource_pools: None,
        combinations: None,
        viewer_write_inventory: None,
        portfolio_uploads: None,
        viewer_read_inventory: None,
        head_seq: since,
    })
}

fn enqueue_clients(s: &mut Store, n: usize) -> Vec<String> {
    (0..n)
        .map(|i| {
            s.enqueue(
                "client.create",
                &format!("c{i}"),
                json!({"id": format!("c{i}"), "name": format!("N{i}")}),
            )
            .unwrap()
            .mutation_id
        })
        .collect()
}

#[test]
fn pushes_split_at_the_wire_limit_and_keep_oversized_drafts_in_conflicts() {
    let mut store = Store::open_in_memory().unwrap();
    let mut ids = vec![];
    for (i, size) in [500_000, 500_000, PUSH_JSON_BYTES, 20]
        .into_iter()
        .enumerate()
    {
        ids.push(
            store
                .enqueue(
                    "client.create",
                    &format!("c{i}"),
                    json!({"id":format!("c{i}"),"name":"x".repeat(size)}),
                )
                .unwrap()
                .mutation_id,
        );
    }
    let peer = Fake::new(Box::new(applied_all), Box::new(empty_pull));
    let report = push_outbox(&mut store, &peer).unwrap();
    let requests = peer.pushes();
    assert!(
        requests
            .iter()
            .all(|request| serde_json::to_vec(request).unwrap().len() <= PUSH_JSON_BYTES)
    );
    let sent: Vec<_> = requests
        .iter()
        .flat_map(|request| &request.mutations)
        .map(|mutation| &mutation.mutation_id)
        .collect();
    assert_eq!(sent, [&ids[0], &ids[1], &ids[3]]);
    assert_eq!(report.rejected, 1);
    assert!(store.conflict(&ids[2]).unwrap().is_some());
    assert!(store.outbox(1).unwrap().is_empty());
}

#[test]
fn restored_generation_rebuilds_even_when_the_old_cursor_is_still_valid() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("replica.sqlite");
    let mut store = Store::open(&path).unwrap();
    store.apply_page(&[], 40).unwrap();
    let ids = enqueue_clients(&mut store, PUSH_BATCH + 1);
    let peer = Fake::new(
        Box::new(|request| {
            if request.generation.as_deref() != Some("restored-test") {
                return Err(TransportError::ReplicaGenerationChanged);
            }
            applied_all(request)
        }),
        Box::new(|since, limit| {
            let mut page = empty_pull(since, limit)?;
            page.generation = Some("restored-test".into());
            page.next_cursor = 42;
            page.head_seq = 42;
            Ok(page)
        }),
    );
    let cycle = sync_cycle(&mut store, &peer).unwrap();
    assert!(cycle.pull.replica_reset);
    assert_eq!(cycle.pull.cursor, 42);
    assert_eq!(peer.log(), ["push:100", "pull:40", "pull:0"]);
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.outbox_len().unwrap(), 0);
    let conflicts = store.conflicts().unwrap();
    assert_eq!(conflicts.len(), ids.len());
    for (i, (conflict, id)) in conflicts.iter().zip(ids).enumerate() {
        assert_eq!(conflict.mutation_id, id);
        assert_eq!(conflict.reason, "sync_generation_changed");
        assert_eq!(conflict.payload["name"], format!("N{i}"));
    }
    enqueue_clients(&mut store, 1);
    assert_eq!(sync_cycle(&mut store, &peer).unwrap().push.applied, 1);
    assert_eq!(
        peer.pushes()[1].generation.as_deref(),
        Some("restored-test")
    );
    assert_eq!(store.conflicts().unwrap().len(), conflicts.len());
}

#[test]
fn conflicting_server_generations_never_consume_or_retry_the_queue_on_the_wrong_peer() {
    let mut store = Store::open_in_memory().unwrap();
    enqueue_clients(&mut store, 1);
    let peer = Fake::new(
        Box::new(|_| Err(TransportError::ReplicaGenerationChanged)),
        Box::new(empty_pull),
    );
    assert!(matches!(
        sync_cycle(&mut store, &peer),
        Err(SyncError::Retry(_))
    ));
    assert_eq!(store.outbox_len().unwrap(), 1);
    assert_eq!(store.conflicts().unwrap().len(), 0);
    assert_eq!(peer.log(), ["push:1", "pull:0"]);
}

#[test]
fn a_restore_fences_stale_views_and_late_pages_until_the_rebuild_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("replica.sqlite");
    let mut runner = Store::open(&path).unwrap();
    let mut view = Store::open(&path).unwrap();
    let ids = enqueue_clients(&mut view, 1);
    let batch = runner.outbox(1).unwrap();
    runner
        .apply_push_results(
            &batch,
            &[MutationResult::Rejected {
                mutation_id: ids[0].clone(),
                reason: "conflict".into(),
                message: "An earlier rejection".into(),
                replayed: false,
            }],
        )
        .unwrap();
    runner
        .switch_replica_generation(INITIAL_GENERATION, "restored-test")
        .unwrap();
    assert_eq!(
        runner.conflicts().unwrap()[0].message,
        "An earlier rejection"
    );
    assert!(runner.conflicts().unwrap()[0].requires_restored_review());
    assert!(
        runner
            .apply_sync_page(&[], 60, false, true, &[], Some(INITIAL_GENERATION))
            .is_err()
    );
    assert!(
        view.enqueue("client.create", "stale", json!({"id":"stale"}))
            .is_err()
    );
    view.refresh_reviewed_generation().unwrap();
    runner
        .apply_sync_page(&[], 41, false, false, &[], Some("restored-test"))
        .unwrap();
    drop(runner);
    let mut runner = Store::open(&path).unwrap();
    assert!(
        view.enqueue("client.create", "partial", json!({"id":"partial"}))
            .is_err()
    );
    runner
        .apply_sync_page(&[], 42, false, true, &[], Some("restored-test"))
        .unwrap();
    enqueue_clients(&mut view, 1);
    let (generation, batch) = runner.push_snapshot(100).unwrap();
    assert_eq!(generation, "restored-test");
    assert_eq!(batch.len(), 1);
}

#[test]
fn push_sends_batches_of_100_in_creation_order_one_at_a_time() {
    let mut s = Store::open_in_memory().unwrap();
    let ids = enqueue_clients(&mut s, 250);
    let t = Fake::new(Box::new(applied_all), Box::new(empty_pull));
    let r = push_outbox(&mut s, &t).unwrap();
    assert_eq!(
        r,
        PushReport {
            batches: 3,
            applied: 250,
            rejected: 0
        }
    );
    let sent: Vec<_> = t.pushes();
    assert_eq!(
        sent.iter().map(|p| p.mutations.len()).collect::<Vec<_>>(),
        [100, 100, 50]
    );
    let flat: Vec<_> = sent
        .iter()
        .flat_map(|p| p.mutations.iter().map(|m| m.mutation_id.clone()))
        .collect();
    assert_eq!(flat, ids);
    assert_eq!(t.max_in_flight.load(Ordering::SeqCst), 1);
    assert!(sent.iter().all(|p| p.device_id == s.device_id().unwrap()));
    assert_eq!(s.outbox_len().unwrap(), 0);
}

#[test]
fn an_empty_outbox_makes_no_push_request() {
    let mut s = Store::open_in_memory().unwrap();
    let t = Fake::new(Box::new(applied_all), Box::new(empty_pull));
    assert_eq!(push_outbox(&mut s, &t).unwrap(), PushReport::default());
    assert!(t.log().is_empty());
}

#[test]
fn a_network_failure_keeps_the_outbox_and_the_resend_is_byte_identical_and_idempotent() {
    let mut s = Store::open_in_memory().unwrap();
    let ids = enqueue_clients(&mut s, 3);
    let down = Fake::new(
        Box::new(|_| Err(TransportError::Offline("connection refused".into()))),
        Box::new(empty_pull),
    );
    let err = push_outbox(&mut s, &down).unwrap_err();
    assert!(matches!(err, SyncError::Offline(_)));
    assert_eq!(s.outbox_len().unwrap(), 3);
    assert_eq!(s.outbox(1).unwrap()[0].attempts, 1);

    // The server had actually processed the batch before the connection dropped: replay.
    let up = Fake::new(
        Box::new(|req| {
            Ok(PushResponse {
                results: req
                    .mutations
                    .iter()
                    .map(|m| MutationResult::Applied {
                        mutation_id: m.mutation_id.clone(),
                        applied_seq: Some(5),
                        replayed: true,
                    })
                    .collect(),
                head_seq: 5,
            })
        }),
        Box::new(empty_pull),
    );
    push_outbox(&mut s, &up).unwrap();
    let first = down.pushes();
    let second = up.pushes();
    assert_eq!(
        first, second,
        "same mutation ids, same createdAt, same payloads"
    );
    assert_eq!(
        second[0]
            .mutations
            .iter()
            .map(|m| m.mutation_id.clone())
            .collect::<Vec<_>>(),
        ids
    );
    assert_eq!(s.outbox_len().unwrap(), 0);
}

#[test]
fn a_rejected_booking_surfaces_as_a_conflict_not_silence() {
    let mut s = Store::open_in_memory().unwrap();
    s.enqueue("appointment.create", "A1", json!({"id": "A1"}))
        .unwrap();
    let t = Fake::new(
        Box::new(|req| {
            Ok(PushResponse {
                results: vec![MutationResult::Rejected {
                    mutation_id: req.mutations[0].mutation_id.clone(),
                    reason: "slot_taken".into(),
                    message: "The selected time slot is no longer available".into(),
                    replayed: false,
                }],
                head_seq: 3,
            })
        }),
        Box::new(empty_pull),
    );
    let r = push_outbox(&mut s, &t).unwrap();
    assert_eq!((r.applied, r.rejected), (0, 1));
    assert_eq!(s.outbox_len().unwrap(), 0);
    assert_eq!(s.conflicts().unwrap()[0].reason, "slot_taken");
}

#[test]
fn a_retry_result_stops_the_push_and_leaves_the_rest_for_the_next_attempt() {
    let mut s = Store::open_in_memory().unwrap();
    let ids = enqueue_clients(&mut s, 3);
    let flaky = Fake::new(
        Box::new(|req| {
            let m = &req.mutations;
            Ok(PushResponse {
                results: vec![
                    MutationResult::Applied {
                        mutation_id: m[0].mutation_id.clone(),
                        applied_seq: Some(1),
                        replayed: false,
                    },
                    MutationResult::Retry {
                        mutation_id: m[1].mutation_id.clone(),
                        message: "busy".into(),
                    },
                    MutationResult::Retry {
                        mutation_id: m[2].mutation_id.clone(),
                        message: "busy".into(),
                    },
                ],
                head_seq: 1,
            })
        }),
        Box::new(empty_pull),
    );
    assert!(matches!(
        push_outbox(&mut s, &flaky).unwrap_err(),
        SyncError::Retry(_)
    ));
    let left: Vec<_> = s
        .outbox(10)
        .unwrap()
        .into_iter()
        .map(|e| e.mutation_id)
        .collect();
    assert_eq!(left, ids[1..].to_vec());
    // Next attempt resends only the unprocessed tail, in order.
    let ok = Fake::new(Box::new(applied_all), Box::new(empty_pull));
    push_outbox(&mut s, &ok).unwrap();
    assert_eq!(
        ok.pushes()[0]
            .mutations
            .iter()
            .map(|m| m.mutation_id.clone())
            .collect::<Vec<_>>(),
        ids[1..].to_vec()
    );
}

fn page(from: i64, n: i64, has_more: bool) -> PullResponse {
    PullResponse {
        generation: None,
        changes: (from + 1..=from + n)
            .map(|seq| RawChange {
                seq,
                entity: "client".into(),
                id: format!("c{seq}"),
                op: "upsert".into(),
                data: Some(json!({"id": format!("c{seq}"), "name": format!("Client {seq}"), "phone": null,
                    "email": null, "notes": null, "createdAt": "2026-03-01T10:00:00.000Z", "updatedAt": "2026-03-01T10:00:00.000Z"})),
            })
            .collect(),
        next_cursor: from + n,
        has_more,
        refresh: vec![],        time_off_scope: None,
            client_directory: None,
            gift_cards_scope: None,
            client_groups: None,
            calendar_scope: None,
            viewer_role: None,
            viewer_edit_catalogue: None,
            peak_prices: None,
            peak_price_access: None,
            resource_pools: None,
            combinations: None,
            viewer_write_inventory: None,
            portfolio_uploads: None,
            viewer_read_inventory: None,
        head_seq: 6,
    }
}

#[test]
fn legacy_client_groups_wait_for_server_support_before_replay() {
    let mut store = Store::open_in_memory().unwrap();
    let legacy = Fake::new(
        Box::new(applied_all),
        Box::new(|since, _| {
            if since == 0 {
                Ok(page(0, 6, false))
            } else {
                empty_pull(since, 0)
            }
        }),
    );
    pull_all(&mut store, &legacy).unwrap();
    pull_all(&mut store, &legacy).unwrap();
    assert_eq!(legacy.log(), ["pull:0", "pull:6"]);
    assert_eq!(store.cursor().unwrap(), 6);
    assert!(
        store
            .clients()
            .unwrap()
            .iter()
            .all(|client| client.group_names.is_none())
    );

    let interrupted = AtomicUsize::new(0);
    let upgraded = Fake::new(
        Box::new(applied_all),
        Box::new(move |since, _| {
            let mut response = match since {
                0 => page(0, 2, true),
                2 if interrupted.fetch_add(1, Ordering::SeqCst) == 0 => {
                    return Err(TransportError::Offline("Temporary outage".into()));
                }
                2 => page(2, 4, false),
                _ => empty_pull(since, 0)?,
            };
            response.client_groups = Some(true);
            for change in &mut response.changes {
                change.data.as_mut().unwrap()["groupNames"] = json!(["vip"]);
            }
            Ok(response)
        }),
    );
    assert!(pull_all(&mut store, &upgraded).is_err());
    assert_eq!(store.cursor().unwrap(), 6);
    assert_eq!(store.client_groups_cursor().unwrap(), Some(2));
    pull_all(&mut store, &upgraded).unwrap();
    pull_all(&mut store, &upgraded).unwrap();
    assert_eq!(
        upgraded.log(),
        ["pull:6", "pull:0", "pull:2", "pull:6", "pull:2", "pull:6"]
    );
    assert_eq!(store.cursor().unwrap(), 6);
    assert_eq!(
        crate::calendar::directory_groups(&store.clients().unwrap()).unwrap()["vip"],
        6
    );
}

#[test]
fn pull_follows_has_more_and_stores_the_cursor_with_each_page() {
    let mut s = Store::open_in_memory().unwrap();
    let t = Fake::new(
        Box::new(applied_all),
        Box::new(|since, _| Ok(page(since, 2, since < 4))),
    );
    let r = pull_all(&mut s, &t).unwrap();
    assert_eq!(
        r,
        PullReport {
            pages: 3,
            changes: 6,
            cursor: 6,
            replica_reset: false
        }
    );
    assert_eq!(t.log(), ["pull:0", "pull:2", "pull:4"]);
    assert_eq!(s.cursor().unwrap(), 6);
    assert_eq!(s.clients().unwrap().len(), 6);
}

#[test]
fn client_visibility_change_purges_the_previous_replica_and_keeps_the_outbox() {
    let mut store = Store::open_in_memory().unwrap();
    let allowed = Fake::new(
        Box::new(applied_all),
        Box::new(|since, _| {
            let mut response = page(since, 1, false);
            response.client_directory = Some(true);
            response.calendar_scope = Some("all".into());
            Ok(response)
        }),
    );
    pull_all(&mut store, &allowed).unwrap();
    assert_eq!(
        crate::calendar::directory_clients(&store)
            .unwrap()
            .clients
            .len(),
        1
    );
    let id = crate::ops::create_directory_client(&mut store, "Walk in", "", "", "").unwrap();
    let denied = Fake::new(
        Box::new(applied_all),
        Box::new(|_, _| {
            Ok(PullResponse {
                generation: None,
                changes: vec![],
                next_cursor: 1,
                has_more: false,
                head_seq: 1,
                refresh: vec![],
                time_off_scope: None,
                client_directory: Some(false),
                gift_cards_scope: None,
                client_groups: None,
                calendar_scope: Some("staff".into()),
                viewer_role: None,
                viewer_edit_catalogue: None,
                peak_prices: None,
                peak_price_access: None,
                resource_pools: None,
                combinations: None,
                viewer_write_inventory: None,
                portfolio_uploads: None,
                viewer_read_inventory: None,
            })
        }),
    );
    assert!(pull_all(&mut store, &denied).unwrap().replica_reset);
    assert!(!store.client_directory_enabled().unwrap());
    assert!(store.clients().unwrap().is_empty());
    assert_eq!(store.outbox(10).unwrap()[0].entity_id, id);
    assert!(pull_all(&mut store, &allowed).unwrap().replica_reset);
    assert_eq!(
        crate::calendar::directory_clients(&store)
            .unwrap()
            .clients
            .len(),
        2
    );
}

#[test]
fn the_next_session_resumes_from_the_persisted_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("r.db");
    {
        let mut s = Store::open(&path).unwrap();
        let t = Fake::new(
            Box::new(applied_all),
            Box::new(|since, _| Ok(page(since, 3, false))),
        );
        pull_all(&mut s, &t).unwrap();
    }
    let mut s = Store::open(&path).unwrap();
    let t = Fake::new(Box::new(applied_all), Box::new(empty_pull));
    pull_all(&mut s, &t).unwrap();
    assert_eq!(t.log(), ["pull:3"]);
}

#[test]
fn tombstones_in_a_pull_remove_local_rows() {
    let mut s = Store::open_in_memory().unwrap();
    s.apply_page(&page(0, 2, false).changes, 2).unwrap();
    let t = Fake::new(
        Box::new(applied_all),
        Box::new(|_since, _| {
            Ok(PullResponse {
                generation: None,
                changes: vec![RawChange {
                    seq: 3,
                    entity: "client".into(),
                    id: "c1".into(),
                    op: "delete".into(),
                    data: None,
                }],
                next_cursor: 3,
                has_more: false,
                refresh: vec![],
                time_off_scope: None,
                client_directory: None,
                gift_cards_scope: None,
                client_groups: None,
                calendar_scope: None,
                viewer_role: None,
                viewer_edit_catalogue: None,
                peak_prices: None,
                peak_price_access: None,
                resource_pools: None,
                combinations: None,
                viewer_write_inventory: None,
                portfolio_uploads: None,
                viewer_read_inventory: None,
                head_seq: 3,
            })
        }),
    );
    pull_all(&mut s, &t).unwrap();
    assert_eq!(s.clients().unwrap().len(), 1);
}

#[test]
fn a_cursor_ahead_of_the_server_resets_the_replica_and_resyncs_from_zero_keeping_the_outbox() {
    struct RestoredPeer(Fake);

    impl Transport for RestoredPeer {
        fn push(&self, request: &PushRequest) -> Result<PushResponse, TransportError> {
            self.0.push(request)
        }

        fn pull(&self, since: i64, limit: u32) -> Result<PullResponse, TransportError> {
            self.0.pull(since, limit)
        }

        fn pull_with_catalog_colors(
            &self,
            since: i64,
            limit: u32,
        ) -> Result<(PullResponse, Option<CatalogColors>), TransportError> {
            self.0.log.lock().unwrap().push(format!("colors:{since}"));
            Ok((self.pull(since, limit)?, Some(CatalogColors::new())))
        }
    }

    let mut s = Store::open_in_memory().unwrap();
    s.apply_page(&page(0, 2, false).changes, 99).unwrap();
    s.apply_catalog_colors(&CatalogColors::new(), None).unwrap();
    enqueue_clients(&mut s, 1);
    let t = RestoredPeer(Fake::new(
        Box::new(applied_all),
        Box::new(|since, _| {
            if since > 10 {
                Err(TransportError::CursorAhead)
            } else {
                Ok(page(since, 1, false))
            }
        }),
    ));
    let r = pull_all(&mut s, &t).unwrap();
    assert!(r.replica_reset);
    assert_eq!(t.0.log(), ["pull:99", "colors:0", "pull:0"]);
    assert!(s.get_meta(CATALOG_COLORS_CACHED).unwrap().is_some());
    assert_eq!(s.cursor().unwrap(), 1);
    assert_eq!(s.clients().unwrap().len(), 1);
    assert_eq!(s.outbox_len().unwrap(), 1);
}

#[test]
fn a_server_that_says_has_more_without_progress_cannot_spin_the_client() {
    let mut s = Store::open_in_memory().unwrap();
    let t = Fake::new(
        Box::new(applied_all),
        Box::new(|since, _| {
            Ok(PullResponse {
                generation: None,
                changes: vec![],
                next_cursor: since,
                has_more: true,
                refresh: vec![],
                time_off_scope: None,
                client_directory: None,
                gift_cards_scope: None,
                client_groups: None,
                calendar_scope: None,
                viewer_role: None,
                viewer_edit_catalogue: None,
                peak_prices: None,
                peak_price_access: None,
                resource_pools: None,
                combinations: None,
                viewer_write_inventory: None,
                portfolio_uploads: None,
                viewer_read_inventory: None,
                head_seq: 9,
            })
        }),
    );
    assert!(matches!(
        pull_all(&mut s, &t).unwrap_err(),
        SyncError::Fatal(_)
    ));
}

#[test]
fn empty_pages_that_still_advance_the_cursor_are_followed() {
    let mut s = Store::open_in_memory().unwrap();
    let t = Fake::new(
        Box::new(applied_all),
        Box::new(|since, _| {
            Ok(PullResponse {
                generation: None,
                changes: vec![],
                next_cursor: since + 5,
                has_more: since < 10,
                refresh: vec![],
                time_off_scope: None,
                client_directory: None,
                gift_cards_scope: None,
                client_groups: None,
                calendar_scope: None,
                viewer_role: None,
                viewer_edit_catalogue: None,
                peak_prices: None,
                peak_price_access: None,
                resource_pools: None,
                combinations: None,
                viewer_write_inventory: None,
                portfolio_uploads: None,
                viewer_read_inventory: None,
                head_seq: 15,
            })
        }),
    );
    assert_eq!(pull_all(&mut s, &t).unwrap().cursor, 15);
}

#[test]
fn a_cycle_pushes_before_it_pulls_and_skips_the_pull_when_the_push_fails() {
    let mut s = Store::open_in_memory().unwrap();
    enqueue_clients(&mut s, 2);
    let t = Fake::new(Box::new(applied_all), Box::new(empty_pull));
    let r = sync_cycle(&mut s, &t).unwrap();
    assert_eq!(t.log(), ["push:2", "pull:0"]);
    assert_eq!(r.push.applied, 2);

    enqueue_clients(&mut s, 1);
    let down = Fake::new(
        Box::new(|_| Err(TransportError::Offline("x".into()))),
        Box::new(empty_pull),
    );
    assert!(sync_cycle(&mut s, &down).is_err());
    assert_eq!(down.log(), ["push:1"]);
}

#[test]
fn errors_are_classified_for_the_caller() {
    let mut s = Store::open_in_memory().unwrap();
    enqueue_clients(&mut s, 1);
    let mk = |e: TransportError| Fake::new(Box::new(move |_| Err(e.clone())), Box::new(empty_pull));
    assert!(matches!(
        push_outbox(&mut s, &mk(TransportError::Unauthorized)).unwrap_err(),
        SyncError::AuthRequired
    ));
    assert!(matches!(
        push_outbox(&mut s, &mk(TransportError::RateLimited(Some(Duration::from_secs(7))))).unwrap_err(),
        SyncError::RateLimited(Some(d)) if d == Duration::from_secs(7)
    ));
    assert!(matches!(
        push_outbox(&mut s, &mk(TransportError::Server("500".into()))).unwrap_err(),
        SyncError::Offline(_)
    ));
    assert!(matches!(
        push_outbox(&mut s, &mk(TransportError::Forbidden("no".into()))).unwrap_err(),
        SyncError::Forbidden(_)
    ));
    assert!(matches!(
        push_outbox(&mut s, &mk(TransportError::BadRequest("bad".into()))).unwrap_err(),
        SyncError::Fatal(_)
    ));
    assert_eq!(
        s.outbox_len().unwrap(),
        1,
        "nothing is ever dropped on errors"
    );
}

#[test]
fn offline_create_then_reconnect_applies_and_clears_the_pending_flag() {
    use crate::calendar::day_view;
    let mut s = Store::open_in_memory().unwrap();
    // First sync: catalog arrives.
    let ana = "01a1d81e-0000-7000-8000-000000000001";
    let cut = "01a1d81e-0000-7000-8000-0000000000a1";
    let lucia = "01a1d81e-0000-7000-8000-0000000000c1";
    let t0 = "2026-03-01T10:00:00.000Z";
    let catalog = vec![
        RawChange {
            seq: 1,
            entity: "staff".into(),
            id: ana.into(),
            op: "upsert".into(),
            data: Some(
                json!({"id": ana, "displayName": "Ana", "active": true, "userId": null, "updatedAt": t0}),
            ),
        },
        RawChange {
            seq: 2,
            entity: "service".into(),
            id: cut.into(),
            op: "upsert".into(),
            data: Some(
                json!({"id": cut, "name": "Haircut", "description": null, "durationMinutes": 45, "bufferMinutes": 15, "priceCents": 1, "currency": "ARS", "active": true, "updatedAt": t0, "quoteHash": "a".repeat(64)}),
            ),
        },
        RawChange {
            seq: 3,
            entity: "client".into(),
            id: lucia.into(),
            op: "upsert".into(),
            data: Some(
                json!({"id": lucia, "name": "Lucia", "phone": null, "email": null, "notes": null, "createdAt": t0, "updatedAt": t0}),
            ),
        },
    ];
    s.apply_page(&catalog, 3).unwrap();
    let id = create_appointment(
        &mut s,
        NewAppointment {
            staff_id: ana.into(),
            service_ids: vec![cut.into()],
            starts_at: "2026-03-10T13:00:00Z".parse().unwrap(),
            client_id: lucia.into(),
            notes: None,
            override_notice: false,
        },
    )
    .unwrap();
    let date = "2026-03-10".parse().unwrap();
    assert!(day_view(&s, date).unwrap().columns[0].items[0].pending);

    // Offline attempt fails, nothing changes.
    let down = Fake::new(
        Box::new(|_| Err(TransportError::Offline("no route".into()))),
        Box::new(empty_pull),
    );
    assert!(sync_cycle(&mut s, &down).is_err());
    assert!(day_view(&s, date).unwrap().columns[0].items[0].pending);

    // Reconnect: server applies, and the pull brings the authoritative row (version 1).
    let appt_id = id.clone();
    let up = Fake::new(
        Box::new(applied_all),
        Box::new(move |since, _| {
            Ok(PullResponse {
                generation: None,
                changes: vec![RawChange {
                    seq: 4,
                    entity: "appointment".into(),
                    id: appt_id.clone(),
                    op: "upsert".into(),
                    data: Some(json!({
                    "id": appt_id, "staffId": ana, "clientId": lucia, "startsAt": "2026-03-10T13:00:00.000Z", "endsAt": "2026-03-10T14:00:00.000Z",
                    "status": "booked", "notes": null, "version": 1, "services": [], "createdAt": t0, "updatedAt": t0})),
                }],
                next_cursor: since.max(4),
                has_more: false,
                refresh: vec![],
                time_off_scope: None,
                client_directory: None,
                gift_cards_scope: None,
                client_groups: None,
                calendar_scope: None,
                viewer_role: None,
                viewer_edit_catalogue: None,
                peak_prices: None,
                peak_price_access: None,
                resource_pools: None,
                combinations: None,
                viewer_write_inventory: None,
                portfolio_uploads: None,
                viewer_read_inventory: None,
                head_seq: 4,
            })
        }),
    );
    sync_cycle(&mut s, &up).unwrap();
    let v = day_view(&s, date).unwrap();
    assert_eq!(v.columns[0].items.len(), 1);
    assert!(!v.columns[0].items[0].pending);
}
