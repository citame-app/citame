use super::*;
use sob_core::warehouses::{
    TransferLine, Warehouse, WarehouseBalance, WarehouseEdit, WarehouseList, WarehouseStock,
    WarehouseTransfer,
};
use uuid::Uuid;

#[derive(Clone, Default)]
struct StockQuery {
    location: Option<Uuid>,
    search: String,
    page: u32,
}

struct PickedLine {
    balance: WarehouseBalance,
    quantity: Entity<TextField>,
}

enum Draft {
    Location {
        warehouse: WarehouseEdit,
        name: Entity<TextField>,
    },
    Transfer {
        id: Uuid,
        source: Option<Uuid>,
        destination: Option<Option<Uuid>>,
        reason: Entity<TextField>,
        lines: Vec<PickedLine>,
    },
}

pub(super) struct Panel {
    search: Entity<TextField>,
    _search_subscription: Subscription,
    query: StockQuery,
    locations: Option<WarehouseList>,
    stock: Option<WarehouseStock>,
    draft: Option<Draft>,
    generation: Option<String>,
    replaces: Option<String>,
    discard: bool,
    notice: Option<Key>,
    request: Option<Arc<()>>,
    observed_revision: i64,
    observed_staff: i64,
}

impl Panel {
    pub(super) fn dismiss(&mut self) -> bool {
        if self.draft.is_none() {
            return true;
        }
        self.discard = !self.discard;
        false
    }
}

impl Root {
    fn warehouse_panel(&mut self) -> Option<&mut Panel> {
        match &mut self.overlay {
            Overlay::Inventory(desk) => desk.warehouses.as_deref_mut(),
            _ => None,
        }
    }

    pub(super) fn open_warehouses(&mut self, cx: &mut Context<Self>) {
        self.prepare_warehouse_panel(cx);
        self.load_warehouse_stock(cx);
    }

    fn prepare_warehouse_panel(&mut self, cx: &mut Context<Self>) {
        let label = self.t(Key::InventorySearch);
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let search = cx.new(|cx| TextField::new(label, false, cx));
        let subscription = cx.subscribe(&search, |root, _, event, cx| {
            if matches!(event, FieldEvent::Submit) {
                root.search_warehouse_stock(cx);
            }
        });
        desk.warehouses = Some(Box::new(Panel {
            search,
            _search_subscription: subscription,
            query: StockQuery {
                page: 1,
                ..StockQuery::default()
            },
            locations: None,
            stock: None,
            draft: None,
            generation: None,
            replaces: None,
            discard: false,
            notice: None,
            request: None,
            observed_revision: -1,
            observed_staff: -1,
        }));
    }

    pub(in crate::root) fn preserve_warehouse_panel(&mut self) -> bool {
        let Some(panel) = self.warehouse_panel() else {
            return false;
        };
        panel.locations = None;
        panel.stock = None;
        panel.request = None;
        panel.generation = None;
        panel.observed_revision = -1;
        panel.notice = Some(Key::InventoryWarehouseChanged);
        true
    }

    pub(super) fn refresh_warehouses(&mut self, reconnected: bool, cx: &mut Context<Self>) -> bool {
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
        let allowed = self.svc.store.can_read_cached_orders();
        let Some(panel) = self.warehouse_panel() else {
            return false;
        };
        let staff_changed = staff_revision != panel.observed_staff;
        if !allowed || staff_changed {
            panel.locations = None;
            panel.stock = None;
        }
        if allowed
            && panel.request.is_none()
            && (staff_changed
                || panel.draft.is_none() && (reconnected || revision != panel.observed_revision))
        {
            self.load_warehouse_stock(cx);
        }
        true
    }

    fn search_warehouse_stock(&mut self, cx: &mut Context<Self>) {
        let Some(panel) = self.warehouse_panel() else {
            return;
        };
        let search = panel.search.read(cx).text().trim().to_owned();
        if search.encode_utf16().count() > 100 {
            panel.notice = Some(Key::InventorySearchInvalid);
            cx.notify();
            return;
        }
        panel.query.search = search;
        panel.query.page = 1;
        self.load_warehouse_stock(cx);
    }

    fn choose_warehouse(&mut self, id: Option<Uuid>, cx: &mut Context<Self>) {
        if let Some(panel) = self.warehouse_panel()
            && panel.draft.is_none()
        {
            panel.query.location = id;
            panel.query.page = 1;
            self.load_warehouse_stock(cx);
        }
    }

    fn warehouse_page(&mut self, page: u32, cx: &mut Context<Self>) {
        if let Some(panel) = self.warehouse_panel() {
            panel.query.page = page;
            self.load_warehouse_stock(cx);
        }
    }

    fn load_warehouse_stock(&mut self, cx: &mut Context<Self>) {
        let Some(query) = self.warehouse_panel().map(|panel| panel.query.clone()) else {
            return;
        };
        let locations = self.svc.store.cached_warehouses().ok().flatten();
        let stock = self
            .svc
            .store
            .cached_warehouse_stock(query.location, &query.search, query.page)
            .ok()
            .flatten();
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
        let transport = self
            .svc
            .transport()
            .filter(|_| self.svc.status().connectivity == Connectivity::Online);
        let session = self.svc.session.clone();
        let Some(panel) = self.warehouse_panel() else {
            return;
        };
        panel.locations = locations;
        panel.stock = stock;
        panel.observed_revision = revision;
        panel.observed_staff = staff_revision;
        let token = Arc::new(());
        panel.request = transport.as_ref().map(|_| token.clone());
        cx.notify();
        let Some(transport) = transport else { return };
        cx.spawn(async move |handle, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let list = transport.inventory_warehouses()?;
                    let stock = transport.inventory_warehouse_stock(
                        query.location,
                        &query.search,
                        query.page,
                    )?;
                    Ok::<_, TransportError>((list, stock, query.search))
                })
                .await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session)
                    || !root.warehouse_panel().is_some_and(|panel| {
                        panel
                            .request
                            .as_ref()
                            .is_some_and(|request| Arc::ptr_eq(request, &token))
                    })
                {
                    return;
                }
                if matches!(
                    result,
                    Err(TransportError::Unauthorized | TransportError::Forbidden(_))
                ) {
                    let _ = root.svc.store.withdraw_inventory_access();
                }
                let allowed = root.svc.store.can_read_cached_orders()
                    && root
                        .svc
                        .store
                        .staff_directory_revision()
                        .unwrap_or_default()
                        == staff_revision;
                let refreshed = match result {
                    Ok((list, stock, search)) if allowed => root
                        .svc
                        .store
                        .cache_warehouses(&list, &stock, &search)
                        .ok()
                        .map(|_| (list, stock)),
                    _ => None,
                };
                if let Some(panel) = root.warehouse_panel() {
                    panel.request = None;
                    if let Some((list, stock)) = refreshed {
                        panel.locations = Some(list);
                        panel.stock = Some(stock);
                    } else {
                        panel.notice = Some(Key::InventoryWarehouseUnavailable);
                        if !allowed {
                            panel.locations = None;
                            panel.stock = None;
                        }
                    }
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn edit_warehouse(&mut self, current: Option<Warehouse>, cx: &mut Context<Self>) {
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let label = self.t(Key::InventoryWarehouseName);
        let Some(panel) = self.warehouse_panel() else {
            return;
        };
        let Some(list) = &panel.locations else { return };
        let id = current
            .as_ref()
            .and_then(|row| row.id)
            .unwrap_or_else(Uuid::now_v7);
        let version = current.as_ref().map_or(0, |row| row.version);
        let active = current.as_ref().is_none_or(|row| row.active);
        let name = current.and_then(|row| row.name).unwrap_or_default();
        let input = cx.new(|cx| TextField::new(label, false, cx));
        input.update(cx, |input, cx| input.set_text(&name, cx));
        panel.draft = Some(Draft::Location {
            warehouse: WarehouseEdit {
                id,
                name,
                version,
                active,
            },
            name: input,
        });
        panel.generation = Some(list.generation.clone());
        panel.notice = None;
        cx.notify();
    }

    fn start_stock_transfer(&mut self, cx: &mut Context<Self>) {
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let label = self.t(Key::InventoryWarehouseReason);
        let Some(panel) = self.warehouse_panel() else {
            return;
        };
        let Some(stock) = &panel.stock else { return };
        if !stock.warehouse.active {
            return;
        }
        panel.generation = Some(stock.generation.clone());
        panel.notice = None;
        panel.draft = Some(Draft::Transfer {
            id: Uuid::now_v7(),
            source: stock.warehouse.id,
            destination: None,
            reason: cx.new(|cx| TextField::new(label, false, cx)),
            lines: Vec::new(),
        });
        cx.notify();
    }

    fn add_transfer_line(&mut self, balance: WarehouseBalance, cx: &mut Context<Self>) {
        let label = self.t(Key::InventoryStockQuantity);
        let Some(panel) = self.warehouse_panel() else {
            return;
        };
        let Some(Draft::Transfer { lines, .. }) = &mut panel.draft else {
            return;
        };
        if lines.len() >= 50
            || lines
                .iter()
                .any(|row| row.balance.product_id == balance.product_id)
        {
            return;
        }
        let quantity = cx.new(|cx| TextField::new(label, false, cx));
        quantity.update(cx, |input, cx| input.set_text("1", cx));
        lines.push(PickedLine { balance, quantity });
        cx.notify();
    }

    fn queue_warehouse_draft(&mut self, cx: &mut Context<Self>) {
        let Some(panel) = self.warehouse_panel() else {
            return;
        };
        let Some(generation) = panel.generation.clone() else {
            panel.notice = Some(Key::InventoryWarehouseChanged);
            cx.notify();
            return;
        };
        let replaces = panel.replaces.clone();
        let result = match &panel.draft {
            Some(Draft::Location { warehouse, name }) => {
                let mut warehouse = warehouse.clone();
                warehouse.name = name.read(cx).text().to_owned();
                self.svc
                    .store
                    .queue_warehouse_edit(&generation, warehouse, replaces.as_deref())
            }
            Some(Draft::Transfer {
                id,
                source,
                destination: Some(destination),
                reason,
                lines,
            }) => {
                let lines = lines
                    .iter()
                    .map(|line| {
                        Some(TransferLine {
                            product_id: line.balance.product_id,
                            version: line.balance.version,
                            quantity: line.quantity.read(cx).text().trim().parse().ok()?,
                        })
                    })
                    .collect::<Option<Vec<_>>>();
                let Some(lines) = lines else {
                    panel.notice = Some(Key::InventoryWarehouseInvalid);
                    cx.notify();
                    return;
                };
                let command = WarehouseTransfer {
                    id: *id,
                    source_id: *source,
                    destination_id: *destination,
                    reason: reason.read(cx).text().to_owned(),
                    lines,
                };
                self.svc
                    .store
                    .queue_warehouse_transfer(&generation, command, replaces.as_deref())
            }
            _ => {
                panel.notice = Some(Key::InventoryWarehouseInvalid);
                cx.notify();
                return;
            }
        };
        if let Some(panel) = self.warehouse_panel() {
            panel.notice = Some(match result {
                Ok(()) => {
                    panel.draft = None;
                    panel.generation = None;
                    panel.replaces = None;
                    Key::InventoryDocumentQueued
                }
                Err(CoreError::CatalogueEditPending) => Key::InventoryWarehousePending,
                Err(CoreError::Invalid(_)) => Key::InventoryWarehouseInvalid,
                Err(_) => Key::InventoryWarehouseChanged,
            });
        }
        if result.is_ok() && self.svc.status().connectivity == Connectivity::Online {
            self.edited(cx);
        }
        cx.notify();
    }

    fn warehouse_name<'a>(&self, row: &'a Warehouse) -> &'a str {
        row.name
            .as_deref()
            .unwrap_or_else(|| self.t(Key::InventoryWarehouseMain))
    }
}

mod review;
mod view;
