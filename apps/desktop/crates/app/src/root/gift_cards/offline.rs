use super::*;
use sob_core::store::{Store, gift_cache::GiftCacheScope};

pub(super) type CacheVersion = (GiftCacheScope, i64);

enum CachedView {
    List(GiftPage),
    Detail(Box<GiftCard>, Option<GiftMovements>),
    Missing,
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
        let version = (scope, revision);
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
                    if store
                        .gift_catalogue(&session.user_id)
                        .ok()
                        .flatten()
                        .is_some_and(|saved| {
                            saved.revision >= revision
                                && saved.scope == version.0.scope
                                && saved.generation == version.0.generation
                        })
                    {
                        return true;
                    }
                    let Ok(snapshot) =
                        transport.gift_catalogue(&version.0.scope, &version.0.generation)
                    else {
                        return false;
                    };
                    store
                        .save_gift_catalogue(&version.0, &session.user_id, snapshot)
                        .unwrap_or(false)
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

    pub(super) fn show_offline_gift(&mut self, request: Request, cx: &mut Context<Self>) {
        if !matches!(request, Request::List { .. } | Request::Detail(_, _)) {
            return;
        }
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
                    let catalogue = store.gift_catalogue(&session.user_id).ok().flatten()?;
                    let now = Utc::now();
                    let view = match request {
                        Request::List {
                            page,
                            search,
                            status,
                        } => CachedView::List(catalogue.search(page, &search, status, now)),
                        Request::Detail(id, page) => match catalogue.card(id, now) {
                            Some(card) => {
                                let history = store
                                    .gift_movement_history(&session.user_id, id, page)
                                    .ok()
                                    .flatten()
                                    .map(|saved| saved.history);
                                CachedView::Detail(Box::new(card), history)
                            }
                            None => CachedView::Missing,
                        },
                        _ => return None,
                    };
                    Some((catalogue.saved_at, view))
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
                if online {
                    root.refresh_gift_cards(true, cx);
                    return;
                }
                let loaded = scope.is_some() && current == scope;
                let result = if loaded { result } else { None };
                if let Some((at, view)) = result {
                    desk.cached_at = Some(at);
                    match view {
                        CachedView::List(page) => desk.page = Some(page),
                        CachedView::Detail(card, movements) => {
                            desk.card = Some(*card);
                            if movements.is_some() || desk.movements.is_none() {
                                desk.movements = movements;
                            } else {
                                desk.error = Some(Key::GiftOfflineMovements);
                            }
                        }
                        CachedView::Missing => {
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
            });
        })
        .detach();
    }
}
