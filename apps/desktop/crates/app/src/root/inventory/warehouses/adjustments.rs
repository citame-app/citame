use super::*;

const ADJUSTMENT_KINDS: [StockKind; 3] = [StockKind::Receive, StockKind::Consume, StockKind::Count];

pub(super) fn adjustment_label(kind: StockKind) -> Key {
    match kind {
        StockKind::Receive => Key::InventoryStockReceive,
        StockKind::Consume => Key::InventoryStockConsume,
        StockKind::Count => Key::InventoryStockCount,
        _ => Key::InventoryWarehouseAdjust,
    }
}

pub(super) struct AdjustmentEditor {
    id: Uuid,
    location: WarehouseLocation,
    balance: WarehouseBalance,
    kind: StockKind,
    quantity: Entity<TextField>,
    reason: Entity<TextField>,
}

impl AdjustmentEditor {
    pub(super) fn proposal(&self, cx: &App) -> Option<WarehouseAdjustment> {
        Some(WarehouseAdjustment {
            id: self.id,
            warehouse_id: self.location,
            product_id: self.balance.product_id,
            kind: self.kind,
            quantity: self.quantity.read(cx).text().trim().parse().ok()?,
            reviewed_on_hand: self.balance.on_hand,
            version: self.balance.version,
            reason: self.reason.read(cx).text().to_owned(),
        })
    }

    pub(super) fn reviewed(
        command: WarehouseAdjustment,
        balance: WarehouseBalance,
        cx: &mut Context<Root>,
    ) -> Self {
        let quantity = cx.new(|cx| TextField::new("", false, cx));
        quantity.update(cx, |input, cx| {
            input.set_text(&command.quantity.to_string(), cx)
        });
        let reason = cx.new(|cx| TextField::new("", false, cx));
        reason.update(cx, |input, cx| input.set_text(&command.reason, cx));
        Self {
            id: command.id,
            location: command.warehouse_id,
            kind: command.kind,
            balance,
            quantity,
            reason,
        }
    }
}

impl Root {
    pub(in crate::root) fn warehouse_adjustment_description(
        &self,
        adjustment: &WarehouseAdjustment,
    ) -> String {
        let location_id = adjustment.warehouse_id.0;
        let list = self.svc.store.cached_warehouses().ok().flatten();
        let warehouse = location_id.map_or_else(
            || self.t(Key::InventoryWarehouseMain).to_owned(),
            |id| {
                list.as_ref()
                    .and_then(|list| list.warehouses.iter().find(|row| row.id == Some(id)))
                    .map(|row| self.warehouse_name(row).to_owned())
                    .unwrap_or_else(|| id.to_string())
            },
        );
        let product = self
            .svc
            .store
            .cached_warehouse_balance(location_id, adjustment.product_id)
            .ok()
            .flatten()
            .map_or_else(
                || adjustment.product_id.to_string(),
                |row| format!("{} ({})", row.name, row.sku),
            );
        format!(
            "{warehouse} · {product} · {} {} · {}",
            self.t(adjustment_label(adjustment.kind)),
            adjustment.quantity,
            adjustment.reason
        )
    }

    pub(super) fn start_warehouse_adjustment(
        &mut self,
        balance: WarehouseBalance,
        cx: &mut Context<Self>,
    ) {
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let Some(panel) = self.warehouse_panel() else {
            return;
        };
        let Some(stock) = &panel.stock else { return };
        if panel.request.is_some() || panel.draft.is_some() || !stock.warehouse.active {
            return;
        }
        panel.generation = Some(stock.generation.clone());
        panel.draft = Some(Draft::Adjustment(AdjustmentEditor {
            id: Uuid::now_v7(),
            location: WarehouseLocation(stock.warehouse.id),
            balance,
            kind: StockKind::Receive,
            quantity: cx.new(|cx| TextField::new("", false, cx)),
            reason: cx.new(|cx| TextField::new("", false, cx)),
        }));
        panel.notice = None;
        cx.notify();
    }

    pub(super) fn render_adjustment(
        &self,
        form: &AdjustmentEditor,
        panel: &Panel,
        can_write: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let warehouse = panel
            .locations
            .as_ref()
            .and_then(|list| list.warehouses.iter().find(|row| row.id == form.location.0));
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(format!("{} · {}", form.balance.name, form.balance.sku)),
            )
            .when_some(warehouse, |body, row| {
                body.child(self.warehouse_name(row).to_owned())
            })
            .child(div().text_sm().text_color(theme::muted()).child(format!(
                "{} {} · {} {}",
                form.balance.on_hand,
                self.t(Key::InventoryWarehouseOnHand),
                form.balance.reserved,
                self.t(Key::InventoryWarehouseReserved),
            )))
            .child(
                div().flex().flex_wrap().gap_2().children(
                    ADJUSTMENT_KINDS
                        .into_iter()
                        .enumerate()
                        .map(|(index, kind)| {
                            self.button(
                                ("warehouse-adjustment-kind", index),
                                self.t(adjustment_label(kind)),
                                if kind == form.kind {
                                    Kind::Primary
                                } else {
                                    Kind::Ghost
                                },
                                cx.listener(move |root, _, _, cx| {
                                    if let Some(panel) = root.warehouse_panel()
                                        && let Some(Draft::Adjustment(editor)) = &mut panel.draft
                                    {
                                        if (editor.kind == StockKind::Count)
                                            != (kind == StockKind::Count)
                                        {
                                            editor
                                                .quantity
                                                .update(cx, |input, cx| input.set_text("", cx));
                                        }
                                        editor.kind = kind;
                                        cx.notify();
                                    }
                                }),
                            )
                        }),
                ),
            )
            .child(self.label(self.adjustment_quantity_label(form.kind)))
            .child(form.quantity.clone())
            .child(self.label(Key::InventoryWarehouseAdjustReason))
            .child(form.reason.clone())
            .when(warehouse.is_some_and(|row| !row.active), |body| {
                body.child(self.t(Key::InventoryWarehouseArchived))
            })
            .when(
                can_write && panel.generation.is_some() && warehouse.is_some_and(|row| row.active),
                |body| {
                    body.child(self.button(
                        "warehouse-save-adjustment",
                        self.t(Key::InventoryWarehouseSave),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.queue_warehouse_draft(cx)),
                    ))
                },
            )
    }

    fn adjustment_quantity_label(&self, kind: StockKind) -> Key {
        if kind == StockKind::Count {
            Key::InventoryWarehousePhysicalCount
        } else {
            Key::InventoryStockQuantity
        }
    }
}
