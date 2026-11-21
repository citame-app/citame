use super::*;
use sob_core::backoff::Backoff;
use sob_core::inventory::{
    ContentWriteError, InventoryFacets, InventoryReport, LIVE_TOPIC, LedgerPage, LedgerQuery,
    MovementPage, PackageContent, PendingStock, Product, ProductActivity, ProductId, ProductPage,
    ProductPageSize, ProductQuery, ProductSort, StockWriteError,
};
use sob_core::sync::TransportError;

mod catalogue;
mod ledger;
mod stock;

pub(super) struct Desk {
    search: Entity<TextField>,
    _search_subscription: Subscription,
    query: ProductQuery,
    page: u32,
    catalog: Option<ProductPage>,
    catalogue_tools: catalogue::Tools,
    ledger: Option<ledger::Panel>,
    product: Option<Product>,
    editor: Option<Editor>,
    stock: Option<stock::Panel>,
    request: Option<Arc<()>>,
    saving: bool,
    discard: bool,
    conflict: bool,
    error: Option<Key>,
    observed_revision: i64,
    observed_staff_revision: i64,
    retry: Option<(Instant, Action)>,
    backoff: Backoff,
}

struct Editor {
    quantity: Entity<TextField>,
    unit: Entity<TextField>,
    original: Option<PackageContent>,
}

impl Editor {
    fn content(
        &self,
        cx: &App,
    ) -> Result<Option<PackageContent>, sob_core::inventory::InvalidPackageContent> {
        PackageContent::parse(self.quantity.read(cx).text(), self.unit.read(cx).text())
    }
}

impl Desk {
    fn redact_costs(&mut self) {
        self.catalogue_tools.report = None;
        if let Some(page) = &mut self.catalog {
            for product in &mut page.products {
                product.cost_cents = None;
            }
        }
        if let Some(product) = &mut self.product {
            product.cost_cents = None;
        }
    }

    fn retry_after(&mut self, action: Action, error: &TransportError) -> bool {
        let minimum = match error {
            TransportError::RateLimited(minimum) => *minimum,
            TransportError::Offline(_) | TransportError::Server(_) => None,
            _ => return false,
        };
        let delay = self.backoff.next_delay().max(Duration::from_millis(500));
        let now = Instant::now();
        let deadline = now
            .checked_add(Backoff::at_least(delay, minimum))
            .unwrap_or(now + Duration::from_secs(60));
        self.retry = Some((deadline, action));
        true
    }

    pub(super) fn dismiss_editor(&mut self, cx: &App) -> bool {
        if self.stock.is_some() {
            if !self.saving {
                self.request = None;
                self.retry = None;
                self.stock = None;
                self.error = None;
                self.observed_revision = -1;
            }
            return true;
        }
        let Some(editor) = &self.editor else {
            return false;
        };
        if self.request.is_none() {
            if self.discard {
                self.discard = false;
            } else if editor.content(cx).ok().as_ref() == Some(&editor.original) {
                self.editor = None;
                self.conflict = false;
                self.error = None;
            } else {
                self.discard = true;
            }
        }
        true
    }

    fn action_for_current_view(&self) -> Action {
        match &self.product {
            Some(product) => Action::Product(product.id),
            None => self.navigation_action(),
        }
    }

    fn reload_action(&self) -> Action {
        self.retry.as_ref().map_or_else(
            || self.action_for_current_view(),
            |(_, action)| action.clone(),
        )
    }

    fn navigation_action(&self) -> Action {
        self.ledger.as_ref().map_or_else(
            || Action::Catalog(self.query.clone(), self.page),
            |panel| Action::Ledger(panel.query.clone(), panel.page),
        )
    }
}

#[derive(Clone)]
enum Action {
    Catalog(ProductQuery, u32),
    Ledger(LedgerQuery, u32),
    Product(ProductId),
    ReviewVersion(ProductId),
    StockProduct(ProductId),
    Movements(ProductId, u32),
    MoveStock(PendingStock),
    Save {
        id: ProductId,
        version: u32,
        content: Option<PackageContent>,
    },
}

enum Loaded {
    Catalog {
        page: ProductPage,
        facets: Option<InventoryFacets>,
        report: Option<InventoryReport>,
        auxiliary_error: Option<TransportError>,
    },
    Ledger(LedgerQuery, u32, LedgerPage),
    Product(Box<Product>),
    Movements(MovementPage),
    Stock(PendingStock, Result<Box<Product>, StockWriteError>),
}

fn optional_catalogue_result<T>(
    result: Result<T, TransportError>,
    auxiliary_error: &mut Option<TransportError>,
) -> Result<Option<T>, TransportError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error @ (TransportError::Forbidden(_) | TransportError::Unauthorized)) => Err(error),
        Err(error) => {
            if auxiliary_error.is_none() || matches!(error, TransportError::RateLimited(_)) {
                *auxiliary_error = Some(error);
            }
            Ok(None)
        }
    }
}

fn text_input(value: &str, placeholder: &'static str, cx: &mut Context<TextField>) -> TextField {
    let mut field = TextField::new(placeholder, false, cx);
    field.set_text(value, cx);
    field
}

impl Root {
    pub(super) fn open_inventory(&mut self, cx: &mut Context<Self>) {
        let prompt = self.t(Key::InventorySearch);
        let search = cx.new(|cx| TextField::new(prompt, false, cx));
        let subscription = cx.subscribe(&search, |root, _, event, cx| {
            if matches!(event, FieldEvent::Submit) {
                root.filter_inventory_catalogue(|_| {}, cx);
            }
        });
        let query = ProductQuery::default();
        self.overlay = Overlay::Inventory(Box::new(Desk {
            search,
            _search_subscription: subscription,
            query: query.clone(),
            page: 1,
            catalog: None,
            catalogue_tools: catalogue::Tools::default(),
            ledger: None,
            product: None,
            editor: None,
            stock: None,
            request: None,
            saving: false,
            discard: false,
            conflict: false,
            error: None,
            observed_revision: 0,
            observed_staff_revision: -1,
            retry: None,
            backoff: Backoff::default(),
        }));
        self.request_inventory(Action::Catalog(query, 1), cx);
    }

    fn page_inventory(&mut self, next: bool, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &self.overlay else {
            return;
        };
        let Some(page) = desk.catalog.as_ref().map(|page| &page.pagination) else {
            return;
        };
        let number = if next && page.has_next() {
            page.page + 1
        } else if !next && page.page > 1 {
            page.page - 1
        } else {
            return;
        };
        self.request_inventory(Action::Catalog(desk.query.clone(), number), cx);
    }

    fn reload_inventory(&mut self, cx: &mut Context<Self>) {
        if let Overlay::Inventory(desk) = &self.overlay
            && desk.editor.is_none()
            && desk.stock.is_none()
        {
            self.request_inventory(desk.reload_action(), cx);
        }
    }

    pub(super) fn refresh_inventory(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let staff_revision = self
            .svc
            .store
            .staff_directory_revision()
            .unwrap_or_default();
        let access_changed = staff_revision != desk.observed_staff_revision;
        if access_changed {
            desk.redact_costs();
        }
        if self.svc.status().connectivity == Connectivity::Online
            && desk.request.is_none()
            && desk.editor.is_none()
            && (reconnected
                || match &desk.retry {
                    Some((deadline, _)) => Instant::now() >= *deadline,
                    None => {
                        access_changed
                            || self
                                .svc
                                .store
                                .live_view_revision(LIVE_TOPIC)
                                .is_ok_and(|revision| revision != desk.observed_revision)
                    }
                })
        {
            if let Some(panel) = &desk.stock {
                if panel.can_refresh()
                    && let Some(product) = &desk.product
                {
                    let action = desk
                        .retry
                        .as_ref()
                        .map_or(Action::StockProduct(product.id), |(_, action)| {
                            action.clone()
                        });
                    self.request_inventory(action, cx);
                }
            } else {
                self.reload_inventory(cx);
            }
        }
    }

    fn request_inventory(&mut self, action: Action, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        if desk.request.is_some() {
            return;
        }
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.svc.status().connectivity == Connectivity::Online)
        else {
            desk.error = Some(Key::InventoryOffline);
            cx.notify();
            return;
        };
        let revision = self
            .svc
            .store
            .live_view_revision(LIVE_TOPIC)
            .unwrap_or_default();
        let staff_revision = self
            .svc
            .store
            .staff_directory_revision()
            .unwrap_or_default();
        if staff_revision != desk.observed_staff_revision {
            desk.redact_costs();
        }
        let request = Arc::new(());
        desk.request = Some(request.clone());
        desk.retry = None;
        let moving = matches!(action, Action::MoveStock(_));
        let keeping_stock = matches!(action, Action::StockProduct(_));
        let saving = moving || matches!(action, Action::Save { .. });
        let reviewing = matches!(action, Action::ReviewVersion(_));
        desk.saving = saving;
        desk.error = None;
        let auth = self.svc.session.clone();
        let catalog = match &action {
            Action::Catalog(query, page) => Some((query.clone(), *page)),
            _ => None,
        };
        let attempted = action.clone();
        cx.notify();
        cx.spawn(async move |handle, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match action {
                        Action::Catalog(query, page) => transport
                            .inventory_products(&query, page)
                            .and_then(|page| {
                                let mut auxiliary_error = None;
                                let facets = optional_catalogue_result(
                                    transport.inventory_facets(),
                                    &mut auxiliary_error,
                                )?;
                                let report = optional_catalogue_result(
                                    transport.inventory_report(&query),
                                    &mut auxiliary_error,
                                )?;
                                Ok(Loaded::Catalog {
                                    page,
                                    facets,
                                    report,
                                    auxiliary_error,
                                })
                            })
                            .map_err(ContentWriteError::from),
                        Action::Ledger(query, page) => transport
                            .inventory_ledger(&query, page)
                            .map(|result| Loaded::Ledger(query, page, result))
                            .map_err(ContentWriteError::from),
                        Action::Product(id)
                        | Action::ReviewVersion(id)
                        | Action::StockProduct(id) => transport
                            .inventory_product(id)
                            .map(Box::new)
                            .map(Loaded::Product)
                            .map_err(ContentWriteError::from),
                        Action::Movements(id, page) => transport
                            .inventory_movements(id, page)
                            .map(Loaded::Movements)
                            .map_err(ContentWriteError::from),
                        Action::MoveStock(pending) => {
                            let result = transport.move_inventory_stock(&pending).map(Box::new);
                            Ok(Loaded::Stock(pending, result))
                        }
                        Action::Save {
                            id,
                            version,
                            content,
                        } => transport
                            .update_inventory_content(id, version, content.as_ref())
                            .map(Box::new)
                            .map(Loaded::Product),
                    }
                })
                .await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &auth) {
                    return;
                }
                let Overlay::Inventory(desk) = &mut root.overlay else {
                    return;
                };
                if !desk
                    .request
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &request))
                {
                    return;
                }
                desk.request = None;
                desk.saving = false;
                let stale_access =
                    root.svc.store.staff_directory_revision().ok() != Some(staff_revision);
                if stale_access {
                    desk.redact_costs();
                }
                if result.is_ok() && !keeping_stock {
                    desk.observed_revision = revision;
                    desk.observed_staff_revision = staff_revision;
                    if !matches!(
                        result,
                        Ok(Loaded::Catalog {
                            auxiliary_error: Some(_),
                            ..
                        })
                    ) {
                        desk.backoff.reset();
                    }
                }
                match result {
                    Ok(Loaded::Stock(pending, mut outcome)) => {
                        if stale_access && let Ok(product) = &mut outcome {
                            product.cost_cents = None;
                        }
                        root.finish_stock_movement(pending, outcome, cx);
                        return;
                    }
                    Ok(Loaded::Movements(movements)) => {
                        if let Some(stock) = &mut desk.stock {
                            if desk
                                .product
                                .as_ref()
                                .map(|product| &product.inventory_generation)
                                == Some(&movements.inventory_generation)
                            {
                                stock.history = Some(movements);
                            } else {
                                stock.history = None;
                                stock.needs_refresh = true;
                                desk.error = Some(Key::InventoryStockGenerationChanged);
                            }
                        }
                    }
                    Ok(Loaded::Catalog {
                        page: loaded,
                        facets,
                        report,
                        auxiliary_error,
                    }) => {
                        if let Some((query, page)) = catalog {
                            desk.query = query;
                            desk.page = page;
                        }
                        desk.product = None;
                        desk.catalog = Some(loaded);
                        desk.catalogue_tools.facets = facets;
                        desk.catalogue_tools.report = report;
                        if stale_access {
                            desk.redact_costs();
                        }
                        if let Some(error) = auxiliary_error {
                            desk.error = Some(Key::InventoryCatalogueIncomplete);
                            desk.retry_after(attempted, &error);
                        }
                    }
                    Ok(Loaded::Ledger(mut query, page, loaded)) => {
                        if let Some(panel) = &mut desk.ledger {
                            desk.product = None;
                            query.anchor = loaded.anchor.clone();
                            panel.query = query;
                            panel.page = page;
                            panel.results = Some(loaded);
                        }
                    }
                    Ok(Loaded::Product(mut product)) => {
                        if stale_access {
                            product.cost_cents = None;
                        }
                        if reviewing && product.can_manage {
                            if let Some(editor) = desk.editor.as_mut() {
                                editor.original = product.package_content.clone();
                            }
                            desk.error = Some(Key::InventoryReviewed);
                        } else {
                            desk.error = reviewing.then_some(Key::InventoryRestricted);
                            desk.editor = None;
                        }
                        let id = product.id;
                        desk.product = Some(*product);
                        desk.conflict = false;
                        if keeping_stock && let Some(stock) = &mut desk.stock {
                            stock.needs_refresh = false;
                            stock.history = None;
                            root.request_inventory(Action::Movements(id, 1), cx);
                            return;
                        }
                    }
                    Err(ContentWriteError::Conflict) => {
                        desk.conflict = true;
                        desk.error = Some(Key::InventoryConflict);
                    }
                    Err(ContentWriteError::Transport(TransportError::ReplicaGenerationChanged))
                        if matches!(attempted, Action::Ledger(..)) =>
                    {
                        desk.product = None;
                        if let Some(panel) = &mut desk.ledger {
                            panel.results = None;
                        }
                        desk.observed_revision = revision;
                        desk.error = Some(Key::InventoryLedgerRestored);
                    }
                    Err(ContentWriteError::Transport(
                        TransportError::Forbidden(_) | TransportError::Unauthorized,
                    )) => {
                        desk.observed_revision = revision;
                        desk.observed_staff_revision = staff_revision;
                        desk.catalog = None;
                        desk.catalogue_tools = catalogue::Tools::default();
                        desk.ledger = None;
                        desk.product = None;
                        desk.editor = None;
                        desk.stock = None;
                        desk.discard = false;
                        desk.conflict = false;
                        desk.error = Some(Key::InventoryRestricted);
                    }
                    Err(_) if saving => {
                        desk.conflict = true;
                        desk.error = Some(Key::InventorySaveUnavailable);
                    }
                    Err(ContentWriteError::Transport(error)) => {
                        desk.error = Some(if matches!(error, TransportError::Offline(_)) {
                            Key::InventoryOffline
                        } else {
                            Key::InventoryUnavailable
                        });
                        if reviewing || !desk.retry_after(attempted, &error) {
                            desk.observed_revision = revision;
                            desk.observed_staff_revision = staff_revision;
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn edit_package_content(&mut self, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        if desk.request.is_some() || desk.editor.is_some() || desk.stock.is_some() {
            return;
        }
        let Some(product) = desk.product.as_ref().filter(|product| product.can_manage) else {
            return;
        };
        let original = product.package_content.clone();
        desk.editor = Some(Editor {
            quantity: cx
                .new(|cx| text_input(original.as_ref().map_or("", |c| &c.quantity), "", cx)),
            unit: cx.new(|cx| text_input(original.as_ref().map_or("", |c| &c.unit), "", cx)),
            original,
        });
        desk.error = None;
        cx.notify();
    }

    fn save_package_content(&mut self, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        if desk.request.is_some() {
            return;
        }
        let (Some(product), Some(editor)) = (&desk.product, &desk.editor) else {
            return;
        };
        if desk.discard || desk.conflict || !product.can_manage {
            return;
        }
        let Ok(content) = editor.content(cx) else {
            desk.error = Some(Key::InventoryInvalidPack);
            cx.notify();
            return;
        };
        if content == editor.original {
            desk.editor = None;
            desk.error = None;
            cx.notify();
            return;
        }
        let action = Action::Save {
            id: product.id,
            version: product.version,
            content,
        };
        self.request_inventory(action, cx);
    }

    pub(super) fn render_inventory(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let width = px(720.).min((viewport.width - px(24.)).max(px(240.)));
        let height = px(720.).min((viewport.height - px(24.)).max(px(170.)));
        let online = self.status.connectivity == Connectivity::Online;
        let ready = online && desk.request.is_none();
        let title = desk.product.as_ref().map_or_else(
            || {
                self.t(if desk.ledger.is_some() {
                    Key::InventoryLedger
                } else {
                    Key::Inventory
                })
            },
            |product| &product.name,
        );
        let header = div()
            .flex()
            .items_center()
            .justify_between()
            .gap_2()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::BOLD)
                    .child(title.to_owned()),
            )
            .when(
                ready && desk.editor.is_none() && desk.stock.is_none(),
                |header| {
                    header.child(self.button(
                        "inventory-refresh",
                        self.t(Key::InventoryRefresh),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.reload_inventory(cx)),
                    ))
                },
            )
            .when(!desk.saving, |header| {
                header.child(self.button(
                    "inventory-close",
                    self.t(Key::Close),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                ))
            });
        let content = match &desk.product {
            Some(product) => self.render_inventory_product(desk, product, ready, cx),
            None => match &desk.ledger {
                Some(panel) => self.render_inventory_ledger(panel, ready, cx),
                None => self.render_inventory_catalog(desk, ready, cx),
            },
        };
        let body = div()
            .child(header)
            .when_some(
                desk.error
                    .or_else(|| (!online).then_some(Key::InventoryOffline)),
                |body, key| {
                    body.child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.t(key)),
                    )
                },
            )
            .when(desk.request.is_some(), |body| {
                body.child(div().text_sm().text_color(theme::muted()).child(self.t(
                    if desk.saving && desk.stock.is_some() {
                        Key::InventoryStockSaving
                    } else if desk.saving {
                        Key::InventoryPackSaving
                    } else {
                        Key::InventoryLoading
                    },
                )))
            })
            .child(
                div()
                    .id("inventory-scroll")
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(content),
            );
        self.modal_with_height(body, width, height, Some(cx))
    }

    fn render_inventory_catalog(
        &self,
        desk: &Desk,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(div().min_w(px(140.)).flex_1().child(desk.search.clone()))
                    .when(ready, |row| {
                        row.child(self.button(
                            "inventory-search",
                            self.t(Key::InventoryFind),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| {
                                root.filter_inventory_catalogue(|_| {}, cx)
                            }),
                        ))
                        .when(desk.catalog.is_some(), |row| {
                            row.child(self.button(
                                "inventory-ledger",
                                self.t(Key::InventoryLedger),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| root.open_inventory_ledger(cx)),
                            ))
                        })
                    }),
            )
            .child(self.render_catalogue_tools(desk, ready, cx))
            .when_some(desk.catalog.as_ref(), |body, page| {
                body.when(page.products.is_empty(), |body| {
                    body.child(self.t(Key::InventoryEmpty))
                })
                .children(page.products.iter().map(|product| {
                    let title = format!("{} · {}", product.name, product.sku);
                    let id = product.id;
                    let summary = format!(
                        "{} {} {}",
                        self.t(Key::InventoryAvailable),
                        product.available,
                        product.unit_label
                    );
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .border_b_1()
                        .border_color(theme::line())
                        .py_2()
                        .child(
                            div()
                                .flex_1()
                                .child(title)
                                .child(div().text_sm().text_color(theme::muted()).child(summary))
                                .when(product.low_stock, |card| {
                                    card.child(
                                        div()
                                            .text_sm()
                                            .text_color(theme::conflict_fg())
                                            .child(self.t(Key::InventoryLowStock)),
                                    )
                                }),
                        )
                        .when(ready, |row| {
                            row.child(self.button(
                                SharedString::from(format!("inventory-product-{id}")),
                                self.t(Key::InventoryProductDetails),
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    root.request_inventory(Action::Product(id), cx)
                                }),
                            ))
                        })
                }))
                .when(ready, |body| {
                    body.child(
                        div()
                            .flex()
                            .gap_2()
                            .when(page.pagination.page > 1, |row| {
                                row.child(self.button(
                                    "inventory-prev",
                                    self.t(Key::InboxPrevious),
                                    Kind::Ghost,
                                    cx.listener(|root, _, _, cx| root.page_inventory(false, cx)),
                                ))
                            })
                            .when(page.pagination.has_next(), |row| {
                                row.child(self.button(
                                    "inventory-next",
                                    self.t(Key::InboxNext),
                                    Kind::Ghost,
                                    cx.listener(|root, _, _, cx| root.page_inventory(true, cx)),
                                ))
                            }),
                    )
                })
            })
    }

    fn render_inventory_product(
        &self,
        desk: &Desk,
        product: &Product,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let amount = |key, n| format!("{} · {n} {}", self.t(key), product.unit_label);
        let pack = match &product.package_content {
            Some(content) => format!(
                "{} {}",
                if self.locale == Locale::EsAr {
                    content.quantity.replace('.', ",")
                } else {
                    content.quantity.clone()
                },
                content.unit
            ),
            None => self.t(Key::InventoryUnknownContent).to_owned(),
        };
        let details = div()
            .flex()
            .flex_col()
            .gap_2()
            .child(product.sku.clone())
            .when_some(product.barcode.clone(), |body, value| body.child(value))
            .child(
                [product.brand.as_deref(), product.category.as_deref()]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · "),
            )
            .when_some(product.storage_location.clone(), |body, value| {
                body.child(format!("{} · {value}", self.t(Key::InventoryLocation)))
            })
            .when_some(product.description.clone(), |body, value| body.child(value))
            .when(!product.active, |body| {
                body.child(self.t(Key::InventoryArchivedProduct))
            })
            .child(self.amount_label(product.price_cents, &product.currency))
            .child(self.t(if product.resellable {
                Key::InventoryRetail
            } else {
                Key::InventoryInternal
            }))
            .child(format!(
                "{} · {}{}{:02} %",
                self.t(Key::InventoryTax),
                product.tax_basis_points / 100,
                if self.locale == Locale::EsAr {
                    ','
                } else {
                    '.'
                },
                product.tax_basis_points % 100,
            ))
            .when_some(product.cost_cents, |body, cents| {
                body.child(format!(
                    "{} · {}",
                    self.t(Key::InventoryUnitCost),
                    self.amount_label(cents, &product.currency)
                ))
            })
            .child(amount(Key::InventoryOnHand, product.stock_on_hand))
            .child(amount(Key::InventoryReserved, product.stock_reserved))
            .child(amount(Key::InventoryAvailable, product.available))
            .child(amount(Key::InventoryThreshold, product.low_stock_threshold))
            .when_some(product.target_stock, |body, target| {
                body.child(amount(Key::InventoryTarget, target))
            })
            .child(format!("{} · {pack}", self.t(Key::InventoryContent)));
        if let Some(stock) = &desk.stock {
            return details.child(self.render_stock_panel(
                stock,
                product,
                desk.request.is_none(),
                ready,
                cx,
            ));
        }
        if let Some(editor) = &desk.editor {
            if desk.saving {
                return details;
            }
            if desk.discard {
                return details.child(self.t(Key::InventoryDiscardPack)).child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(self.button(
                            "inventory-keep-pack",
                            self.t(Key::ReviewKeepEditing),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                        ))
                        .child(self.button(
                            "inventory-discard-pack",
                            self.t(Key::ReviewDiscard),
                            Kind::Danger,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::Inventory(desk) = &mut root.overlay {
                                    desk.editor = None;
                                    desk.discard = false;
                                    desk.conflict = false;
                                    desk.error = None;
                                    cx.notify();
                                }
                                root.reload_inventory(cx);
                            }),
                        )),
                );
            }
            return details
                .child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::InventoryPackHelp)),
                )
                .child(div().text_sm().child(self.t(Key::InventoryPackQuantity)))
                .child(editor.quantity.clone())
                .child(div().text_sm().child(self.t(Key::InventoryPackUnit)))
                .child(editor.unit.clone())
                .when(ready, |body| {
                    if desk.conflict {
                        let id = product.id;
                        body.child(self.button(
                            "inventory-review-pack",
                            self.t(Key::InventoryReviewLatest),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                root.request_inventory(Action::ReviewVersion(id), cx)
                            }),
                        ))
                    } else {
                        body.child(self.button(
                            "inventory-save-pack",
                            self.t(Key::InventorySavePack),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.save_package_content(cx)),
                        ))
                    }
                });
        }
        details.when(desk.request.is_none(), |body| {
            body.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .when(ready, |row| {
                        row.child(self.button(
                            "inventory-back",
                            self.t(if desk.ledger.is_some() {
                                Key::InventoryBackToLedger
                            } else {
                                Key::InventoryProductList
                            }),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::Inventory(desk) = &root.overlay {
                                    root.request_inventory(desk.navigation_action(), cx);
                                }
                            }),
                        ))
                    })
                    .child(self.button(
                        "inventory-stock",
                        self.t(Key::InventoryStockHistory),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.open_stock_panel(cx)),
                    ))
                    .when(ready && product.can_manage, |row| {
                        row.child(self.button(
                            "inventory-edit-pack",
                            self.t(Key::InventoryEditContent),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.edit_package_content(cx)),
                        ))
                    }),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn package_editor_respects_permissions_and_preserves_an_offline_draft(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.open_inventory(cx);
            let product: Product = serde_json::from_value(serde_json::json!({
                "id": "0198f5a0-7b1c-7000-8000-000000000001",
                "name": "Synthetic pack",
                "sku": "TEST-PACK",
                "stockOnHand": 3,
                "stockReserved": 1,
                "available": 2,
                "unitLabel": "pack",
                "packageContent": {"quantity": "150", "unit": "ml"},
                "priceCents": 1200,
                "currency": "EUR",
                "active": true,
                "version": 4
            }))
            .unwrap();
            let Overlay::Inventory(desk) = &mut root.overlay else {
                panic!("missing inventory")
            };
            desk.product = Some(product);
            root.edit_package_content(cx);
            let Overlay::Inventory(desk) = &mut root.overlay else {
                panic!("missing inventory")
            };
            assert!(desk.editor.is_none());
            desk.product.as_mut().unwrap().can_manage = true;
            root.edit_package_content(cx);
            let Overlay::Inventory(desk) = &root.overlay else {
                panic!("missing inventory")
            };
            desk.editor
                .as_ref()
                .unwrap()
                .quantity
                .clone()
                .update(cx, |field, cx| {
                    field.set_text("12,50", cx);
                });
            root.save_package_content(cx);
            root.refresh_inventory(true, cx);
            root.dismiss_overlay(cx);
            let Overlay::Inventory(desk) = &root.overlay else {
                panic!("lost the draft")
            };
            assert!(desk.discard);
            assert_eq!(desk.error, Some(Key::InventoryOffline));
            assert_eq!(desk.product.as_ref().unwrap().version, 4);
            assert_eq!(
                desk.editor
                    .as_ref()
                    .unwrap()
                    .content(cx)
                    .unwrap()
                    .unwrap()
                    .quantity,
                "12.5",
            );
        });
    }
}
