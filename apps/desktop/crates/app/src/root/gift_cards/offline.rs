use super::*;
use sob_core::store::{
    Store,
    gift_cache::{GiftCacheScope, OfflineGiftQuery, OfflineGiftView},
};

#[derive(Clone, PartialEq, Eq)]
pub(super) struct CacheVersion {
    scope: GiftCacheScope,
    minimum_seq: i64,
}

impl Root {
    pub(super) fn refresh_gift_catalogue(&mut self, cx: &mut Context<Self>) {
        let Ok(Some(scope)) = self.svc.store.gift_cache_scope() else {
            return;
        };
        let Some(session) = self.svc.current_session() else {
            return;
        };
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let revision = self.svc.store.live_view_revision("commerce").unwrap_or(0);
        let version = CacheVersion {
            scope,
            minimum_seq: revision,
        };
        let Some(desk) = self.gift_cards_desk() else {
            return;
        };
        if desk.catalogue_job.is_some()
            || desk.catalogue_version.as_ref() == Some(&version)
            || desk.catalogue_retry.is_some_and(|at| Instant::now() < at)
        {
            return;
        }
        let token = Arc::new(());
        desk.catalogue_job = Some(token.clone());
        let path = self.svc.config.db_path(&session);
        let identity = self.svc.session.clone();
        let requested = version.clone();
        cx.spawn(async move |root, cx| {
            let saved = cx
                .background_executor()
                .spawn(async move {
                    let Ok(mut store) = Store::open(&path) else {
                        return false;
                    };
                    store.refresh_gift_register(
                        &transport,
                        &version.scope,
                        &session.user_id,
                        version.minimum_seq,
                    )
                })
                .await;
            let _ = root.update(cx, |root, _| {
                if !Arc::ptr_eq(&identity, &root.svc.session) {
                    return;
                }
                if let Some(desk) = root.gift_cards_desk()
                    && desk
                        .catalogue_job
                        .as_ref()
                        .is_some_and(|job| Arc::ptr_eq(job, &token))
                {
                    desk.catalogue_job = None;
                    if saved {
                        desk.catalogue_version = Some(requested);
                        desk.catalogue_retry = None;
                    } else {
                        desk.catalogue_retry = Some(Instant::now() + Duration::from_secs(15));
                    }
                }
            });
        })
        .detach();
    }

    pub(super) fn show_saved_gift(
        &mut self,
        request: Request,
        refresh_online: bool,
        cx: &mut Context<Self>,
    ) {
        let query = match request {
            Request::List {
                page,
                search,
                status,
                pending_orders,
            } => OfflineGiftQuery::List {
                page,
                search,
                status,
                pending_orders,
            },
            Request::Detail(id, page) => OfflineGiftQuery::Detail(id, page),
            _ => return,
        };
        let Some(session) = self.svc.current_session() else {
            return;
        };
        let scope = self.svc.store.gift_cache_scope().ok().flatten();
        let Some(desk) = self.gift_cards_desk().filter(|desk| desk.request.is_none()) else {
            return;
        };
        let token = Arc::new(());
        desk.request = Some(token.clone());
        desk.error = None;
        let identity = self.svc.session.clone();
        let path = self.svc.config.db_path(&session);
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let store = Store::open(&path).ok()?;
                    store
                        .read_offline_gift_register(&session.user_id, query, Utc::now())
                        .ok()
                        .flatten()
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&identity, &root.svc.session) {
                    return;
                }
                let current = root.svc.store.gift_cache_scope().ok().flatten();
                let online = root.status.connectivity == Connectivity::Online;
                let Some(desk) = root.gift_cards_desk().filter(|desk| {
                    desk.request
                        .as_ref()
                        .is_some_and(|active| Arc::ptr_eq(active, &token))
                }) else {
                    return;
                };
                desk.request = None;
                let loaded = scope.is_some() && current == scope;
                let result = if loaded { result } else { None };
                if let Some((at, view)) = result {
                    desk.cached_at = Some(at);
                    match view {
                        OfflineGiftView::List(page) => desk.page = Some(page),
                        OfflineGiftView::Detail {
                            card,
                            movements,
                            saved_pages,
                        } => {
                            desk.card = Some(*card);
                            desk.saved_movement_pages = saved_pages;
                            desk.movements_saved_at =
                                movements.as_ref().map(|saved| saved.saved_at);
                            desk.movements = movements.map(|saved| saved.history);
                        }
                        OfflineGiftView::Missing => {
                            desk.card = None;
                            desk.movements = None;
                        }
                    }
                } else {
                    desk.cached_at = None;
                    desk.page = None;
                    desk.card = None;
                    desk.movements = None;
                }
                cx.notify();
                if online && refresh_online {
                    root.refresh_gift_cards(true, cx);
                }
            });
        })
        .detach();
    }
}
