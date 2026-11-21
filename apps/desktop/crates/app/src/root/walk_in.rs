use super::*;
use sob_core::billing::{SaleItem, WalkInSale, parse_reviewed_amount};
use sob_core::inventory::{ProductPage, ProductQuery};
use sob_core::sync::TransportError;
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq)]
enum CatalogTab {
    Services,
    Products,
    Clients,
    Staff,
    Custom,
}

enum CatalogItem {
    Service(Uuid),
    Product(Uuid),
    Custom(u32),
}

struct Line {
    item: CatalogItem,
    name: String,
    quantity: u32,
    limit: u32,
}

pub(super) struct SaleDesk {
    tab: CatalogTab,
    search: Entity<TextField>,
    discount: Entity<TextField>,
    tip: Entity<TextField>,
    description: Entity<TextField>,
    amount: Entity<TextField>,
    _changed: Vec<Subscription>,
    lines: Vec<Line>,
    client: Option<(Uuid, String)>,
    staff: Option<(Uuid, String)>,
    use_client_discount: bool,
    can_assign_staff: bool,
    access_request: Arc<()>,
    products: Option<ProductPage>,
    product_query: ProductQuery,
    loading_products: Option<Arc<()>>,
    product_error: bool,
    pending: Option<WalkInSale>,
    submitting: bool,
    error: Option<String>,
}

impl SaleDesk {
    pub(super) fn can_dismiss(&self) -> bool {
        self.pending.is_none()
    }

    fn adjustments(&self, cx: &App) -> Option<(u32, u32)> {
        if self.lines.is_empty() {
            return None;
        }
        let amount = |value: &Entity<TextField>| {
            let text = value.read(cx).text().trim();
            if text.is_empty() {
                Some(0)
            } else {
                parse_reviewed_amount(text)
            }
        };
        let discount = if self.use_client_discount {
            0
        } else {
            amount(&self.discount)?
        };
        Some((discount, amount(&self.tip)?))
    }

    fn build_sale(&self, cx: &App) -> Option<WalkInSale> {
        let (discount_cents, tip_cents) = self.adjustments(cx)?;
        Some(WalkInSale {
            idempotency_key: Uuid::now_v7(),
            lines: self
                .lines
                .iter()
                .map(|line| match line.item {
                    CatalogItem::Service(service_id) => SaleItem::Service {
                        service_id,
                        quantity: line.quantity,
                    },
                    CatalogItem::Product(product_id) => SaleItem::Product {
                        product_id,
                        quantity: line.quantity,
                    },
                    CatalogItem::Custom(unit_amount_cents) => SaleItem::Custom {
                        description: line.name.clone(),
                        unit_amount_cents,
                        quantity: line.quantity,
                    },
                })
                .collect(),
            client_id: self.client.as_ref().map(|(id, _)| *id),
            staff_id: self.staff.as_ref().map(|(id, _)| *id),
            use_client_discount: self.use_client_discount.then_some(true),
            discount_cents,
            tip_cents,
        })
    }

    fn add(&mut self, item: CatalogItem, name: String, limit: u32) {
        if self.pending.is_some() || limit == 0 {
            return;
        }
        let previous = self
            .lines
            .iter_mut()
            .find(|line| match (&line.item, &item) {
                (CatalogItem::Service(left), CatalogItem::Service(right))
                | (CatalogItem::Product(left), CatalogItem::Product(right)) => left == right,
                _ => false,
            });
        if let Some(line) = previous {
            line.quantity = (line.quantity + 1).min(limit);
            line.limit = limit;
        } else if self.lines.len() < 100 {
            self.lines.push(Line {
                item,
                name,
                quantity: 1,
                limit,
            });
        }
        self.error = None;
    }

    fn step_quantity(&mut self, index: usize, step: i32) {
        if self.pending.is_some() {
            return;
        }
        let Some(line) = self.lines.get_mut(index) else {
            return;
        };
        line.quantity = line.quantity.saturating_add_signed(step).min(line.limit);
        if line.quantity == 0 {
            self.lines.remove(index);
        }
    }
}

impl Root {
    pub(super) fn open_walk_in(&mut self, cx: &mut Context<Self>) {
        let search = cx.new(|cx| TextField::new(self.t(Key::SaleSearch), false, cx));
        let discount = cx.new(|cx| TextField::new("0,00 EUR", false, cx));
        let tip = cx.new(|cx| TextField::new("0,00 EUR", false, cx));
        let description = cx.new(|cx| TextField::new(self.t(Key::SaleItemDescription), false, cx));
        let amount = cx.new(|cx| TextField::new("EUR", false, cx));
        let mut changed: Vec<_> = [&search, &discount, &tip, &description, &amount]
            .into_iter()
            .map(|field| cx.observe(field, |_, _, cx| cx.notify()))
            .collect();
        changed.push(cx.subscribe(&search, |root, _, event, cx| {
            if matches!(event, FieldEvent::Submit)
                && matches!(&root.overlay, Overlay::WalkIn(sale) if sale.tab == CatalogTab::Products)
                && root.status.connectivity == Connectivity::Online
            {
                root.search_sale_products(1, cx);
            }
        }));
        let access_request = Arc::new(());
        self.overlay = Overlay::WalkIn(Box::new(SaleDesk {
            tab: CatalogTab::Services,
            search,
            discount,
            tip,
            description,
            amount,
            _changed: changed,
            lines: vec![],
            client: None,
            staff: None,
            use_client_discount: false,
            can_assign_staff: false,
            access_request: access_request.clone(),
            products: None,
            loading_products: None,
            product_query: ProductQuery::default(),
            product_error: false,
            pending: None,
            submitting: false,
            error: None,
        }));
        cx.notify();
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let session = self.svc.session.clone();
        cx.spawn(async move |root, cx| {
            let allowed = cx
                .background_executor()
                .spawn(async move { transport.can_assign_walk_in_sales().unwrap_or(false) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                if let Overlay::WalkIn(sale) = &mut root.overlay
                    && Arc::ptr_eq(&sale.access_request, &access_request)
                {
                    sale.can_assign_staff = allowed;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn search_sale_products(&mut self, page: u32, cx: &mut Context<Self>) {
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Overlay::WalkIn(sale) = &mut self.overlay else {
            return;
        };
        let query = if page == 1 {
            let Some(query) = ProductQuery::new(sale.search.read(cx).text(), false) else {
                sale.product_error = true;
                cx.notify();
                return;
            };
            query
        } else {
            sale.product_query.clone()
        };
        sale.product_query = query.clone();
        let request = Arc::new(());
        sale.loading_products = Some(request.clone());
        sale.product_error = false;
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.products_for_sale(&query, page) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Overlay::WalkIn(sale) = &mut root.overlay else {
                    return;
                };
                if !sale
                    .loading_products
                    .as_ref()
                    .is_some_and(|active| Arc::ptr_eq(active, &request))
                {
                    return;
                }
                sale.loading_products = None;
                sale.product_error = result.is_err();
                sale.products = result.ok();
                cx.notify();
            });
        })
        .detach();
    }

    fn submit_walk_in(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let Overlay::WalkIn(sale) = &mut self.overlay else {
            return;
        };
        if sale.submitting {
            return;
        }
        let Some(draft) = sale.pending.clone().or_else(|| sale.build_sale(cx)) else {
            return;
        };
        let key = draft.idempotency_key;
        sale.pending = Some(draft.clone());
        sale.submitting = true;
        sale.error = None;
        let revision = self
            .svc
            .store
            .live_view_revision("commerce")
            .unwrap_or_default();
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.create_walk_in_sale(&draft) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let fallback = root.t(Key::SaleUnconfirmed);
                let Overlay::WalkIn(sale) = &mut root.overlay else {
                    return;
                };
                if !sale
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.idempotency_key == key)
                {
                    return;
                }
                sale.submitting = false;
                match result {
                    Ok(receipt) => {
                        root.overlay = Overlay::WalkInReceipt(
                            checkout::CheckoutReview::from_receipt(receipt, revision, cx),
                        );
                        root.svc.wake(Wake::Manual);
                    }
                    Err(
                        TransportError::BadRequest(message) | TransportError::Forbidden(message),
                    ) => {
                        sale.pending = None;
                        sale.error = Some(message);
                    }
                    Err(_) => sale.error = Some(fallback.to_owned()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_walk_in(
        &self,
        sale: &SaleDesk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let controls = div().flex().flex_wrap().gap_2().children(
            [
                (CatalogTab::Services, Key::SaleServices),
                (CatalogTab::Products, Key::SaleProducts),
                (CatalogTab::Clients, Key::ClientDirectory),
                (CatalogTab::Staff, Key::Staff),
                (CatalogTab::Custom, Key::SaleCustomItem),
            ]
            .into_iter()
            .enumerate()
            .filter(|(_, (tab, _))| match tab {
                CatalogTab::Clients => self.directory_enabled(),
                CatalogTab::Staff => sale.can_assign_staff,
                _ => true,
            })
            .map(|(index, (tab, label))| {
                self.button(
                    ("sale-tab", index),
                    self.t(label),
                    if sale.tab == tab {
                        Kind::Primary
                    } else {
                        Kind::Ghost
                    },
                    cx.listener(move |root, _, _, cx| {
                        let Overlay::WalkIn(sale) = &mut root.overlay else {
                            return;
                        };
                        if sale.pending.is_some() {
                            return;
                        }
                        sale.tab = tab;
                        sale.search.update(cx, |field, cx| field.set_text("", cx));
                        if tab == CatalogTab::Products
                            && sale.products.is_none()
                            && root.status.connectivity == Connectivity::Online
                        {
                            root.search_sale_products(1, cx);
                        }
                        cx.notify();
                    }),
                )
            }),
        );
        let mut editor = div().flex().flex_col().gap_2();
        if sale.pending.is_none() {
            editor = editor.child(controls);
            if sale.tab != CatalogTab::Custom {
                editor = editor.child(sale.search.clone());
            }
            editor = editor.child(self.render_sale_choices(sale, online, cx));
        }
        let receipt = div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .text_base()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::SaleCart)),
            )
            .when_some(sale.client.as_ref(), |view, (_, label)| {
                view.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(label.clone())
                        .when(sale.pending.is_none(), |view| {
                            view.child(self.button(
                                "sale-remove-client",
                                self.t(Key::SaleRemove),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| {
                                    if let Overlay::WalkIn(sale) = &mut root.overlay {
                                        sale.client = None;
                                        sale.use_client_discount = false;
                                        cx.notify();
                                    }
                                }),
                            ))
                        }),
                )
            })
            .when_some(sale.staff.as_ref(), |view, (_, name)| {
                view.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(format!("{} · {name}", self.t(Key::Staff)))
                        .when(sale.pending.is_none(), |view| {
                            view.child(self.button(
                                "sale-remove-staff",
                                self.t(Key::SaleRemove),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| {
                                    if let Overlay::WalkIn(sale) = &mut root.overlay {
                                        sale.staff = None;
                                        cx.notify();
                                    }
                                }),
                            ))
                        }),
                )
            })
            .children(sale.lines.iter().enumerate().map(|(index, line)| {
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(div().child(format!("{} × {}", line.quantity, line.name)))
                    .when(sale.pending.is_none(), |view| {
                        view.child(
                            div().flex().gap_2().children(
                                [(-1, "−"), (1, "+")]
                                    .into_iter()
                                    .filter(|(step, _)| *step < 0 || line.quantity < line.limit)
                                    .map(|(step, label)| {
                                        self.button(
                                            (
                                                if step > 0 {
                                                    "sale-increase"
                                                } else {
                                                    "sale-decrease"
                                                },
                                                index,
                                            ),
                                            label,
                                            Kind::Ghost,
                                            cx.listener(move |root, _, _, cx| {
                                                if let Overlay::WalkIn(sale) = &mut root.overlay {
                                                    sale.step_quantity(index, step);
                                                    cx.notify();
                                                }
                                            }),
                                        )
                                    }),
                            ),
                        )
                    })
            }))
            .when(sale.pending.is_none(), |view| {
                view.when(sale.client.is_some(), |view| {
                    view.child(self.button(
                        "sale-client-discount",
                        self.t(Key::SaleClientDiscount),
                        if sale.use_client_discount {
                            Kind::Primary
                        } else {
                            Kind::Ghost
                        },
                        cx.listener(|root, _, _, cx| {
                            if let Overlay::WalkIn(sale) = &mut root.overlay
                                && sale.client.is_some()
                                && sale.pending.is_none()
                            {
                                sale.use_client_discount = !sale.use_client_discount;
                                cx.notify();
                            }
                        }),
                    ))
                })
                .when(!sale.use_client_discount, |view| {
                    view.child(self.label(Key::CheckoutDiscount))
                        .child(sale.discount.clone())
                })
                .child(self.label(Key::SaleTip))
                .child(sale.tip.clone())
            });
        let content = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::BOLD)
                    .child(self.t(Key::WalkInSale)),
            )
            .child(
                div()
                    .id("walk-in-scroll")
                    .overflow_y_scroll()
                    .max_h((viewport.height - px(170.)).max(px(105.)))
                    .child(div().flex().flex_col().gap_4().child(editor).child(receipt)),
            )
            .when(!online, |view| view.child(self.t(Key::CheckoutOffline)))
            .when(sale.submitting, |view| {
                view.child(self.t(Key::CheckoutLoading))
            })
            .when_some(sale.error.as_ref(), |view, error| {
                view.child(div().text_color(theme::conflict_fg()).child(error.clone()))
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .when(sale.can_dismiss(), |view| {
                        view.child(self.button(
                            "close-walk-in",
                            self.t(Key::Back),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                        ))
                    })
                    .when(
                        online
                            && !sale.submitting
                            && (sale.pending.is_some() || sale.adjustments(cx).is_some()),
                        |view| {
                            view.child(self.button(
                                "create-walk-in-receipt",
                                self.t(if sale.pending.is_some() {
                                    Key::SaleRetry
                                } else {
                                    Key::SaleCreateReceipt
                                }),
                                Kind::Primary,
                                cx.listener(|root, _, _, cx| root.submit_walk_in(cx)),
                            ))
                        },
                    ),
            );
        self.modal_with_height(
            content,
            (viewport.width - px(32.)).max(px(240.)).min(px(680.)),
            (viewport.height - px(24.)).max(px(180.)),
            None,
        )
    }

    fn render_sale_choices(
        &self,
        sale: &SaleDesk,
        online: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let mut view = div().flex().flex_col().gap_1();
        let needle = sale.search.read(cx).text().trim().to_lowercase();
        match sale.tab {
            CatalogTab::Services => {
                for service in self
                    .services
                    .iter()
                    .filter(|s| {
                        s.active && s.currency == "EUR" && s.name.to_lowercase().contains(&needle)
                    })
                    .take(12)
                {
                    let Ok(id) = Uuid::parse_str(&service.id) else {
                        continue;
                    };
                    let label = service.name.clone();
                    view = view.child(self.sale_choice(id, label, 1000, false, cx));
                }
            }
            CatalogTab::Clients => {
                for (id, name) in self
                    .clients
                    .iter()
                    .filter(|(_, name)| name.to_lowercase().contains(&needle))
                    .take(12)
                {
                    let Ok(id) = Uuid::parse_str(id) else {
                        continue;
                    };
                    let label = name.clone();
                    view = view.child(self.button(
                        SharedString::from(format!("sale-client-{id}")),
                        name.clone(),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            if let Overlay::WalkIn(sale) = &mut root.overlay
                                && sale.pending.is_none()
                            {
                                sale.client = Some((id, label.clone()));
                                sale.use_client_discount = false;
                                cx.notify();
                            }
                        }),
                    ));
                }
            }
            CatalogTab::Staff => {
                for member in self
                    .staff
                    .iter()
                    .filter(|member| {
                        member.active && member.display_name.to_lowercase().contains(&needle)
                    })
                    .take(12)
                {
                    let Ok(id) = Uuid::parse_str(&member.id) else {
                        continue;
                    };
                    let label = member.display_name.clone();
                    view = view.child(self.button(
                        SharedString::from(format!("sale-staff-{id}")),
                        label.clone(),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            if let Overlay::WalkIn(sale) = &mut root.overlay
                                && sale.can_assign_staff
                                && sale.pending.is_none()
                            {
                                sale.staff = Some((id, label.clone()));
                                cx.notify();
                            }
                        }),
                    ));
                }
            }
            CatalogTab::Products => {
                if online {
                    view = view.child(self.button(
                        "sale-product-search",
                        self.t(Key::SaleSearch),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.search_sale_products(1, cx)),
                    ));
                }
                if sale.loading_products.is_some() {
                    return view.child(self.t(Key::CheckoutLoading));
                }
                if sale.product_error {
                    return view.child(self.t(Key::CheckoutUnavailable));
                }
                if let Some(page) = &sale.products {
                    for product in page.products.iter().filter(|p| {
                        p.sellable_available.unwrap_or(p.available) > 0 && p.currency == "EUR"
                    }) {
                        view = view.child(
                            self.sale_choice(
                                product.id,
                                product.name.clone(),
                                product
                                    .sellable_available
                                    .unwrap_or(product.available)
                                    .min(1000),
                                true,
                                cx,
                            ),
                        );
                    }
                    let number = page.pagination.page;
                    let paging = div()
                        .flex()
                        .gap_2()
                        .when(online && number > 1, |view| {
                            view.child(self.button(
                                "sale-prev-products",
                                "<",
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    root.search_sale_products(number - 1, cx)
                                }),
                            ))
                        })
                        .when(online && page.pagination.has_next(), |view| {
                            view.child(self.button(
                                "sale-next-products",
                                ">",
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    root.search_sale_products(number + 1, cx)
                                }),
                            ))
                        });
                    view = view.child(paging);
                }
            }
            CatalogTab::Custom => {
                view = view
                    .child(sale.description.clone())
                    .child(sale.amount.clone());
                let label = sale.description.read(cx).text().trim().to_owned();
                if let Some(cents) = parse_reviewed_amount(sale.amount.read(cx).text())
                    && (1..=200).contains(&label.encode_utf16().count())
                {
                    view = view.child(self.button(
                        "sale-add-custom",
                        self.t(Key::SaleAddItem),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            if let Overlay::WalkIn(sale) = &mut root.overlay {
                                sale.add(CatalogItem::Custom(cents), label.clone(), 1000);
                                sale.description
                                    .update(cx, |field, cx| field.set_text("", cx));
                                sale.amount.update(cx, |field, cx| field.set_text("", cx));
                                cx.notify();
                            }
                        }),
                    ));
                }
            }
        }
        view
    }

    fn sale_choice(
        &self,
        id: Uuid,
        name: String,
        limit: u32,
        is_product: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        let kind = if is_product {
            "sale-product"
        } else {
            "sale-service"
        };
        self.button(
            SharedString::from(format!("{kind}-{id}")),
            name.clone(),
            Kind::Ghost,
            cx.listener(move |root, _, _, cx| {
                if let Overlay::WalkIn(sale) = &mut root.overlay {
                    let item = if is_product {
                        CatalogItem::Product(id)
                    } else {
                        CatalogItem::Service(id)
                    };
                    sale.add(item, name.clone(), limit);
                    cx.notify();
                }
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    async fn cart_respects_available_stock_and_freezes_reviewed_adjustments(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, window) = crate::root::tests::open(cx);
        window.update(cx, |root, _, cx| {
            root.open_walk_in(cx);
            let Overlay::WalkIn(desk) = &mut root.overlay else { panic!("sale did not open") };
            let product = Uuid::now_v7();
            desk.add(CatalogItem::Product(product), "Retail product".into(), 2);
            desk.add(CatalogItem::Product(product), "Retail product".into(), 2);
            desk.add(CatalogItem::Product(product), "Retail product".into(), 2);
            desk.discount.update(cx, |field, cx| field.set_text("3,20", cx));
            desk.tip.update(cx, |field, cx| field.set_text("1.05", cx));
            let draft = desk.build_sale(cx).unwrap();
            assert_eq!(draft.discount_cents, 320);
            assert_eq!(draft.tip_cents, 105);
            assert!(matches!(draft.lines.as_slice(), [SaleItem::Product { product_id, quantity: 2 }] if *product_id == product));
            desk.pending = Some(draft);
            desk.step_quantity(0, -1);
            assert_eq!(desk.lines[0].quantity, 2);
        }).unwrap();
    }
}
