//! Dev helper: prepares a data dir (saved session + replica) in an interesting state so the GUI
//! can be started on it and inspected: synced catalog, one booking that lost its slot (a
//! conflict), one pending offline booking and one synced booking.
//!
//! cargo run -p sob-core --example demo_replica -- <data-dir> <api-url> <email> <password>
//! Prints the day (YYYY-MM-DD) to open with SOB_START_DATE.

use std::sync::{Arc, RwLock};

use chrono::{Datelike, Duration, NaiveTime, TimeZone, Utc};
use sob_core::auth::{
    AuthProvider, BetterAuthSession, Credentials, FileTokenStore, TokenStore, replica_path,
    server_data_dir,
};
use sob_core::calendar::salon_tz;
use sob_core::http::HttpTransport;
use sob_core::ops::{self, NewAppointment};
use sob_core::store::Store;
use sob_core::sync;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [dir, api, email, password] = args.as_slice() else {
        eprintln!("usage: demo_replica <data-dir> <api-url> <email> <password>");
        std::process::exit(2);
    };
    let dir = std::path::PathBuf::from(dir);
    let auth = Arc::new(BetterAuthSession::new(api));
    let session = auth
        .sign_in(&Credentials {
            email: email.clone(),
            password: password.clone(),
        })
        .expect("sign in");
    FileTokenStore::new(server_data_dir(&dir, api).join("session.json"))
        .save(&session)
        .expect("save session");
    let path = replica_path(&dir, api, &session);
    let handle = Arc::new(RwLock::new(Some(session)));
    let transport = HttpTransport::new(api, handle, auth);
    let mut store = Store::open(&path).expect("open replica");
    sync::sync_cycle(&mut store, &transport).expect("first sync");

    let tz = salon_tz(&store).unwrap();
    let staff = store.staff().unwrap();
    let (ana, bea) = (staff[0].id.clone(), staff[1].id.clone());
    let service_ids = |names: &[&str]| -> Vec<String> {
        store
            .services()
            .unwrap()
            .into_iter()
            .filter(|s| names.contains(&s.name.as_str()))
            .map(|s| s.id)
            .collect()
    };
    let (hair, nails) = (
        service_ids(&["Haircut", "Blow dry"]),
        service_ids(&["Manicure"]),
    );
    let clients = store.clients().unwrap();
    let client = match clients.first() {
        Some(c) => c.id.clone(),
        None => ops::create_client(&mut store, "Lucia Fernandez", Some("1155550123")).unwrap(),
    };
    let hours = store.working_hours().unwrap();
    let stamp = uuid::Uuid::now_v7().into_bytes();
    let mut day = (Utc::now() + Duration::days(8 + (stamp[15] % 40) as i64))
        .with_timezone(&tz)
        .date_naive();
    while !hours
        .iter()
        .any(|h| h.staff_id == ana && h.weekday == day.weekday().num_days_from_sunday() as i64)
    {
        day += Duration::days(1);
    }
    let at = |h: u32, m: u32| {
        tz.from_local_datetime(&day.and_time(NaiveTime::from_hms_opt(h, m, 0).unwrap()))
            .single()
            .unwrap()
            .with_timezone(&Utc)
    };
    let booking = |staff: &str, services: &[String], when| NewAppointment {
        staff_id: staff.into(),
        service_ids: services.to_vec(),
        starts_at: when,
        client_id: client.clone(),
        notes: None,
        override_notice: false,
    };

    // 1. A booking that is synced and shows up as a normal block.
    ops::create_appointment(&mut store, booking(&bea, &nails, at(15, 0))).unwrap();
    sync::sync_cycle(&mut store, &transport).expect("sync the settled booking");

    // 2. Another desk takes 10:00 with Ana; this device, still offline, booked it too.
    let mut other = Store::open_in_memory().unwrap();
    sync::sync_cycle(&mut other, &transport).unwrap();
    ops::create_appointment(&mut other, booking(&ana, &hair, at(10, 0))).unwrap();
    sync::sync_cycle(&mut other, &transport).unwrap();
    ops::create_appointment(&mut store, booking(&ana, &hair, at(10, 0))).unwrap();
    let report = sync::sync_cycle(&mut store, &transport).unwrap();
    assert_eq!(
        report.push.rejected, 1,
        "expected the slot to be taken: {report:?}"
    );

    // 3. A booking made while offline and not synced yet.
    ops::create_appointment(&mut store, booking(&ana, &hair, at(12, 30))).unwrap();
    println!("{day}");
}
