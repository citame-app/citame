use super::*;
use sob_core::http::{
    InventoryNumberingSeries as Series, InventoryNumberingSnapshot, ReviewedInventorySeries,
};

const SERIES: [(Series, Key, &str); 2] = [
    (Series::Orders, Key::NumberingOrders, "numbering-orders"),
    (
        Series::Receipts,
        Key::NumberingReceipts,
        "numbering-receipts",
    ),
];

#[derive(Default)]
pub(super) struct NumberingDesk {
    pub open: bool,
    pub busy: bool,
    snapshot: Option<InventoryNumberingSnapshot>,
    draft: Option<Draft>,
    notice: Option<Key>,
    needs_review: bool,
    commerce_revision: Option<i64>,
    refresh_pending: bool,
}

struct Draft {
    base: ReviewedInventorySeries,
    input: Entity<TextField>,
}

impl NumberingDesk {
    pub fn dirty(&self) -> bool {
        self.draft.is_some()
    }

    pub fn reset_request(&mut self) {
        self.busy = false;
        self.snapshot = None;
        self.refresh_pending = true;
        self.needs_review = true;
    }
}

enum Request {
    Load,
    Review,
    Save,
}

impl Root {
    pub(super) fn open_numbering(&mut self, cx: &mut Context<Self>) {
        let Overlay::SalonConfiguration(desk) = &mut self.overlay else {
            return;
        };
        desk.numbering.open = true;
        cx.notify();
        self.request_numbering(Request::Load, cx);
    }

    pub(super) fn refresh_numbering(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let Overlay::SalonConfiguration(desk) = &mut self.overlay else {
            return;
        };
        let panel = &mut desk.numbering;
        if !panel.open {
            return;
        }
        let revision = self.svc.store.live_view_revision("commerce").ok();
        panel.refresh_pending |= panel.commerce_revision != revision || reconnected;
        if panel.refresh_pending && !panel.busy {
            self.request_numbering(Request::Load, cx);
        }
    }

    fn edit_numbering(&mut self, series: Series, cx: &mut Context<Self>) {
        let placeholder = self.t(Key::NumberingNext);
        let Overlay::SalonConfiguration(desk) = &mut self.overlay else {
            return;
        };
        let panel = &mut desk.numbering;
        let Some(snapshot) = panel.snapshot.as_ref().filter(|_| !panel.busy) else {
            return;
        };
        let Some(base) = snapshot.review(series) else {
            return;
        };
        let input = cx.new(|cx| TextField::new(placeholder, false, cx));
        cx.observe(&input, |_, _, cx| cx.notify()).detach();
        panel.draft = Some(Draft { base, input });
        panel.needs_review = false;
        panel.notice = None;
        cx.notify();
    }

    fn request_numbering(&mut self, request: Request, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let session = self.svc.session.clone();
        let Overlay::SalonConfiguration(desk) = &mut self.overlay else {
            return;
        };
        let instance = desk.instance.clone();
        let panel = &mut desk.numbering;
        if !panel.open || panel.busy {
            return;
        }
        let writing = matches!(request, Request::Save);
        let write = if writing {
            let Some(snapshot) = panel.snapshot.clone() else {
                return;
            };
            let Some(draft) = panel.draft.as_ref().filter(|_| !panel.needs_review) else {
                return;
            };
            let Some(candidate) = draft.base.candidate(draft.input.read(cx).text()) else {
                panel.notice = Some(Key::NumberingInvalid);
                cx.notify();
                return;
            };
            Some((snapshot, draft.base.clone(), candidate))
        } else {
            None
        };
        panel.commerce_revision = self.svc.store.live_view_revision("commerce").ok();
        panel.refresh_pending = false;
        panel.busy = true;
        if !matches!(request, Request::Load) || panel.notice == Some(Key::NumberingLoadFailed) {
            panel.notice = None;
        }
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match write {
                        Some((mut snapshot, base, next)) => transport
                            .advance_inventory_numbering(&base, next)
                            .map(|state| {
                                snapshot.set_series(base.series, state);
                                snapshot
                            }),
                        None => transport.inventory_numbering(),
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) {
                    return;
                }
                let Overlay::SalonConfiguration(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&desk.instance, &instance) {
                    return;
                }
                let panel = &mut desk.numbering;
                panel.busy = false;
                panel.accept(request, result.ok());
                cx.notify();
                root.refresh_numbering(false, cx);
            });
        })
        .detach();
    }

    pub(super) fn render_numbering(
        &self,
        panel: &NumberingDesk,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let format_number =
            |number: Option<u32>| number.map_or("—".to_owned(), |n| n.to_string());
        div()
            .p_1()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::NumberingTitle)),
            )
            .child(self.t(Key::NumberingIntro))
            .when(!online, |body| body.child(self.t(Key::NumberingOffline)))
            .when(panel.busy, |body| {
                body.child(self.t(Key::CloudWorkspacesLoading))
            })
            .when_some(panel.notice, |body, notice| body.child(self.t(notice)))
            .when_some(panel.snapshot.as_ref(), |body, snapshot| {
                body.children(SERIES.map(|(series, title, id)| {
                    let state = snapshot.series(series);
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .p_3()
                        .rounded_md()
                        .border_1()
                        .border_color(theme::line())
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(self.t(title)))
                        .child(format!(
                            "{} · {}",
                            self.t(Key::NumberingLast),
                            format_number(state.last_issued_number)
                        ))
                        .child(if state.next_number.is_some() {
                            format!(
                                "{} · {}",
                                self.t(Key::NumberingNext),
                                format_number(state.next_number)
                            )
                        } else {
                            self.t(Key::NumberingExhausted).to_owned()
                        })
                        .when(
                            online
                                && !panel.busy
                                && panel.draft.is_none()
                                && state.next_number.is_some(),
                            |card| {
                                card.child(
                                    self.button(
                                        id,
                                        self.t(Key::FormEdit),
                                        Kind::Ghost,
                                        cx.listener(move |root, _, _, cx| {
                                            root.edit_numbering(series, cx)
                                        }),
                                    )
                                    .debug_selector(move || id.to_owned()),
                                )
                            },
                        )
                }))
            })
            .when_some(
                panel.draft.as_ref().filter(|_| !panel.busy),
                |body, draft| {
                    let title = match draft.base.series {
                        Series::Orders => Key::NumberingOrders,
                        Series::Receipts => Key::NumberingReceipts,
                    };
                    body.child(div().font_weight(FontWeight::SEMIBOLD).child(self.t(title)))
                        .child(draft.input.clone())
                        .when(panel.needs_review, |body| {
                            body.child(self.t(Key::NumberingReview))
                        })
                        .when(online && !panel.needs_review, |body| {
                            body.child(
                                self.button(
                                    "numbering-save",
                                    self.t(Key::SalonSave),
                                    Kind::Primary,
                                    cx.listener(|root, _, _, cx| {
                                        root.request_numbering(Request::Save, cx)
                                    }),
                                )
                                .debug_selector(|| "numbering-save".into()),
                            )
                        })
                        .child(self.button(
                            "numbering-cancel",
                            self.t(Key::Cancel),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::SalonConfiguration(desk) = &mut root.overlay {
                                    desk.numbering.draft = None;
                                    desk.numbering.notice = None;
                                }
                                cx.notify();
                            }),
                        ))
                },
            )
            .when(!panel.busy, |body| {
                body.when(online, |body| {
                    body.child(self.button(
                        "numbering-reload",
                        self.t(if panel.dirty() {
                            Key::SalonReloadReview
                        } else {
                            Key::FormReload
                        }),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.request_numbering(Request::Review, cx)),
                    ))
                })
                .child(self.button(
                    "numbering-back",
                    self.t(Key::Close),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        if let Overlay::SalonConfiguration(desk) = &mut root.overlay {
                            if desk.numbering.dirty() {
                                desk.confirm_close = true;
                            } else {
                                desk.numbering.open = false;
                            }
                        }
                        cx.notify();
                    }),
                ))
            })
    }
}

impl NumberingDesk {
    fn accept(&mut self, request: Request, result: Option<InventoryNumberingSnapshot>) {
        let Some(snapshot) = result else {
            self.notice = Some(if matches!(request, Request::Save) {
                self.needs_review = true;
                Key::NumberingWriteFailed
            } else {
                Key::NumberingLoadFailed
            });
            return;
        };
        match request {
            Request::Save => {
                self.draft = None;
                self.needs_review = false;
                self.notice = Some(Key::NumberingSaved);
            }
            Request::Review => {
                if let Some(draft) = &mut self.draft {
                    if let Some(base) = snapshot.review(draft.base.series) {
                        draft.base = base;
                    } else {
                        self.draft = None;
                    }
                }
                self.needs_review = false;
            }
            Request::Load => {
                if let Some(draft) = &self.draft {
                    self.needs_review |=
                        snapshot.review(draft.base.series).as_ref() != Some(&draft.base);
                }
            }
        }
        self.snapshot = Some(snapshot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use sob_core::http::InventoryNumberingState;

    fn snapshot(next: u32) -> InventoryNumberingSnapshot {
        InventoryNumberingSnapshot {
            generation: "initial".into(),
            orders: InventoryNumberingState {
                next_number: Some(next),
                last_issued_number: Some(next - 1),
            },
            receipts: InventoryNumberingState {
                next_number: Some(2),
                last_issued_number: Some(1),
            },
        }
    }

    #[gpui::test]
    async fn document_issuance_disables_a_stale_save_until_the_native_draft_is_reviewed(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            root.status.connectivity = Connectivity::Offline;
            root.open_salon_configuration(cx);
            root.open_numbering(cx);
            let Overlay::SalonConfiguration(desk) = &mut root.overlay else {
                panic!("Expected settings");
            };
            desk.numbering.accept(Request::Load, Some(snapshot(8)));
            root.status.connectivity = Connectivity::Online;
            cx.notify();
        });
        cx.run_until_parked();
        let edit = cx.debug_bounds("numbering-orders").unwrap();
        cx.simulate_click(edit.center(), Default::default());
        cx.run_until_parked();
        assert!(cx.debug_bounds("numbering-save").is_some());
        root.update(cx, |root, cx| {
            let Overlay::SalonConfiguration(desk) = &mut root.overlay else {
                panic!("Expected settings");
            };
            let panel = &mut desk.numbering;
            let draft = panel.draft.as_ref().expect("order series draft");
            draft.input.update(cx, |input, cx| input.set_text("18", cx));
            panel.accept(Request::Load, Some(snapshot(9)));
            cx.notify();
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("numbering-save").is_none());
        root.update(cx, |root, cx| {
            let Overlay::SalonConfiguration(desk) = &mut root.overlay else {
                panic!("Expected settings");
            };
            let panel = &mut desk.numbering;
            panel.accept(Request::Review, Some(snapshot(9)));
            let draft = panel.draft.as_ref().expect("reviewed draft");
            assert_eq!(draft.input.read(cx).text(), "18");
            assert_eq!(draft.base.candidate("18"), Some(18));
            cx.notify();
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("numbering-save").is_some());
    }
}
