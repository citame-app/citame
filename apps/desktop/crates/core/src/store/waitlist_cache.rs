use rusqlite::{Connection, TransactionBehavior, params};

use super::{CALENDAR_VISIBILITY_EPOCH, CalendarCacheScope, Store};
use crate::error::Result;
use crate::waitlist::{WaitlistPage, WaitlistView};

const LEGACY_FIRST_ACTIVE_PAGE: &str = "desk_waitlist";
const RECENT_PAGES_PER_TAB: i64 = 7;

#[derive(Debug, Default)]
pub struct SavedWaitlistPages {
    pub current: Option<WaitlistPage>,
    pub pages: Vec<u32>,
    pub scope: Option<CalendarCacheScope>,
}

fn prefix(view: WaitlistView) -> String {
    match view {
        WaitlistView::Active => "desk_waitlist:active:".into(),
        WaitlistView::History => "desk_waitlist:history:".into(),
        WaitlistView::Calendar(range) => {
            format!("desk_waitlist:calendar:{}:{}:", range.from, range.to)
        }
    }
}

pub(super) fn clear(db: &Connection) -> Result<()> {
    db.execute(
        "DELETE FROM meta WHERE key=?1 OR key GLOB 'desk_waitlist:*'",
        [LEGACY_FIRST_ACTIVE_PAGE],
    )?;
    Ok(())
}

pub(super) fn invalidate_visibility(db: &Connection) -> Result<()> {
    clear(db)?;
    db.execute(
        "INSERT INTO meta(key,value) VALUES (?1,'1')
         ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
        [CALENDAR_VISIBILITY_EPOCH],
    )?;
    Ok(())
}

fn saved_pages(db: &Connection, view: WaitlistView) -> Result<Vec<u32>> {
    let prefix = prefix(view);
    let mut query = db.prepare("SELECT key FROM meta WHERE key GLOB ?1")?;
    let keys = query.query_map([format!("{prefix}*")], |row| row.get::<_, String>(0))?;
    let mut pages = keys
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .filter_map(|key| key.strip_prefix(&prefix)?.parse().ok())
        .collect::<Vec<u32>>();
    if view == WaitlistView::Active
        && !pages.contains(&1)
        && Store::meta_at(db, LEGACY_FIRST_ACTIVE_PAGE)?.is_some()
    {
        pages.push(1);
    }
    pages.sort_unstable();
    Ok(pages)
}

impl Store {
    pub fn waitlist_cache(&self, view: WaitlistView, page: u32) -> Result<SavedWaitlistPages> {
        let tx = self.conn.unchecked_transaction()?;
        let scope = CalendarCacheScope::read(&tx)?;
        if !scope.permits_read() {
            return Ok(SavedWaitlistPages {
                scope: Some(scope),
                ..SavedWaitlistPages::default()
            });
        }
        let pages = saved_pages(&tx, view)?;
        let mut raw = Self::meta_at(&tx, &format!("{}{page}", prefix(view)))?;
        if view == WaitlistView::Active && page == 1 && raw.is_none() {
            raw = Self::meta_at(&tx, LEGACY_FIRST_ACTIVE_PAGE)?;
        }
        let current = raw
            .map(|json| serde_json::from_str::<WaitlistPage>(&json))
            .transpose()?
            .filter(|data| data.page == page);
        tx.commit()?;
        Ok(SavedWaitlistPages {
            current,
            pages,
            scope: Some(scope),
        })
    }

    pub fn cache_waitlist(
        &mut self,
        scope: &CalendarCacheScope,
        view: WaitlistView,
        page: &WaitlistPage,
    ) -> Result<Option<Vec<u32>>> {
        if !scope.permits_read() || page.page == 0 {
            return Ok(None);
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if &CalendarCacheScope::read(&tx)? != scope {
            return Ok(None);
        }
        let prefix = prefix(view);
        let first = format!("{prefix}1");
        let mut saved = page.clone();
        if !view.active() || saved.page != 1 {
            saved.imported.clear();
        }
        tx.execute(
            "INSERT OR REPLACE INTO meta (key,value) VALUES (?1,?2)",
            params![
                format!("{prefix}{}", saved.page),
                serde_json::to_string(&saved)?
            ],
        )?;
        if view == WaitlistView::Active && page.page == 1 {
            tx.execute("DELETE FROM meta WHERE key=?1", [LEGACY_FIRST_ACTIVE_PAGE])?;
        }
        if view.range().is_some() {
            tx.execute(
                "DELETE FROM meta WHERE key IN (
                    SELECT key FROM meta WHERE key GLOB 'desk_waitlist:calendar:*'
                    ORDER BY rowid DESC LIMIT -1 OFFSET ?1
                )",
                [RECENT_PAGES_PER_TAB + 1],
            )?;
        } else {
            // Keep the entry point to the tab plus its last seven successful page reads.
            tx.execute(
                "DELETE FROM meta WHERE key IN (
                 SELECT key FROM meta WHERE key GLOB ?1 AND key<>?2
                 ORDER BY rowid DESC LIMIT -1 OFFSET ?3
             )",
                params![format!("{prefix}*"), first, RECENT_PAGES_PER_TAB],
            )?;
        }
        let pages = saved_pages(&tx, view)?;
        tx.commit()?;
        Ok(Some(pages))
    }

    pub fn clear_waitlist_cache(&self) -> Result<()> {
        clear(&self.conn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::INITIAL_GENERATION;
    use crate::waitlist::WaitlistPolicy;

    fn page(page: u32) -> WaitlistPage {
        WaitlistPage {
            page,
            page_size: 15,
            total: 200,
            policy: WaitlistPolicy {
                enabled: true,
                offer_minutes: 30,
                version: 1,
            },
            entries: vec![],
            imported: vec![],
        }
    }

    #[test]
    fn calendar_pages_are_isolated_by_period_and_bounded_across_periods() {
        use crate::waitlist::WaitlistRange;

        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("calendar-waitlist.db")).unwrap();
        let scope = store.calendar_cache_scope().unwrap();
        let date: chrono::NaiveDate = "2026-03-01".parse().unwrap();
        let view = |offset| {
            let day = date + chrono::Duration::days(offset);
            WaitlistView::Calendar(WaitlistRange { from: day, to: day })
        };
        store
            .cache_waitlist(&scope, WaitlistView::Active, &page(1))
            .unwrap();
        for offset in 0..9 {
            store
                .cache_waitlist(&scope, view(offset), &page(2))
                .unwrap();
        }
        assert!(store.waitlist_cache(view(0), 2).unwrap().pages.is_empty());
        assert_eq!(store.waitlist_cache(view(1), 2).unwrap().pages, [2]);
        assert!(store.waitlist_cache(view(8), 2).unwrap().current.is_some());
        assert!(
            store
                .waitlist_cache(WaitlistView::Active, 1)
                .unwrap()
                .current
                .is_some()
        );
        store.reset_replica().unwrap();
        assert!(store.waitlist_cache(view(8), 2).unwrap().pages.is_empty());
    }

    #[test]
    fn pages_survive_restart_with_separate_bounded_tabs_and_the_legacy_first_page() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("desk.sqlite3");
        let mut store = Store::open(&path).unwrap();
        store
            .set_meta(
                LEGACY_FIRST_ACTIVE_PAGE,
                &serde_json::to_string(&page(1)).unwrap(),
            )
            .unwrap();
        let scope = store.calendar_cache_scope().unwrap();
        for number in 2..=10 {
            store
                .cache_waitlist(&scope, WaitlistView::Active, &page(number))
                .unwrap();
        }
        store
            .cache_waitlist(&scope, WaitlistView::History, &page(2))
            .unwrap();
        drop(store);

        let store = Store::open(&path).unwrap();
        let first = store.waitlist_cache(WaitlistView::Active, 1).unwrap();
        assert_eq!(first.current, Some(page(1)));
        assert_eq!(first.pages, [1, 4, 5, 6, 7, 8, 9, 10]);
        assert!(
            store
                .waitlist_cache(WaitlistView::Active, 2)
                .unwrap()
                .current
                .is_none()
        );
        let history = store.waitlist_cache(WaitlistView::History, 2).unwrap();
        assert_eq!(history.current, Some(page(2)));
        assert_eq!(history.pages, [2]);
    }

    #[test]
    fn scope_changes_remove_both_tabs_and_reject_old_responses_after_permissions_return() {
        for cursor in ["0", "10"] {
            let mut store = Store::open_in_memory().unwrap();
            store
                .apply_visibility_scopes(Some(true), Some("all"), INITIAL_GENERATION)
                .unwrap();
            store.set_meta("cursor", cursor).unwrap();
            let old_scope = store.calendar_cache_scope().unwrap();
            store
                .cache_waitlist(&old_scope, WaitlistView::Active, &page(1))
                .unwrap();
            store
                .cache_waitlist(&old_scope, WaitlistView::History, &page(3))
                .unwrap();
            assert_eq!(
                store
                    .apply_visibility_scopes(Some(false), Some("own"), INITIAL_GENERATION)
                    .unwrap(),
                cursor != "0"
            );
            assert!(!store.calendar_cache_scope().unwrap().permits_read());
            store
                .apply_visibility_scopes(Some(true), Some("all"), INITIAL_GENERATION)
                .unwrap();

            assert!(
                store
                    .waitlist_cache(WaitlistView::Active, 1)
                    .unwrap()
                    .pages
                    .is_empty()
            );
            assert!(
                store
                    .waitlist_cache(WaitlistView::History, 3)
                    .unwrap()
                    .pages
                    .is_empty()
            );
            assert_eq!(
                store
                    .cache_waitlist(&old_scope, WaitlistView::History, &page(3))
                    .unwrap(),
                None
            );
        }
    }
}
