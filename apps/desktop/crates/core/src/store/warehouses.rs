use super::*;
use crate::warehouses::{
    PendingWarehouseChange, RecordedWarehouseTransfer, SAVE, TRANSFER, WarehouseBalance,
    WarehouseEdit, WarehouseList, WarehouseStock, WarehouseTransfer, location_key,
};
use serde::de::DeserializeOwned;
use uuid::Uuid;

fn stock_key(id: Option<Uuid>, search: &str, page: u32) -> String {
    format!("warehouse:page:{}:{page}:{search}", location_key(id))
}

fn balance_key(id: Option<Uuid>, product: Uuid) -> String {
    format!("warehouse:balance:{}:{product}", location_key(id))
}

impl Store {
    fn read_warehouse_cache<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        self.get_meta(key)?
            .map(|value| Ok(serde_json::from_str(&value)?))
            .transpose()
    }

    pub fn pending_warehouse_changes(&self) -> Result<Vec<PendingWarehouseChange>> {
        if !self.can_read_cached_orders() {
            return Ok(Vec::new());
        }
        let mut statement = self
            .conn
            .prepare("SELECT kind, payload FROM outbox WHERE kind IN (?1, ?2) ORDER BY seq")?;
        let rows = statement.query_map(params![SAVE, TRANSFER], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (kind, payload) = row?;
            if kind == SAVE {
                Ok(PendingWarehouseChange::Edit(serde_json::from_str(
                    &payload,
                )?))
            } else {
                Ok(PendingWarehouseChange::Transfer(serde_json::from_str(
                    &payload,
                )?))
            }
        })
        .collect()
    }

    pub fn cached_warehouses(&self) -> Result<Option<WarehouseList>> {
        if !self.can_read_cached_orders() {
            return Ok(None);
        }
        self.read_warehouse_cache("warehouse:list")
    }

    pub fn cached_warehouse_stock(
        &self,
        id: Option<Uuid>,
        search: &str,
        page: u32,
    ) -> Result<Option<WarehouseStock>> {
        if !self.can_read_cached_orders() {
            return Ok(None);
        }
        self.read_warehouse_cache(&stock_key(id, search, page))
    }

    pub fn cache_warehouses(
        &mut self,
        list: &WarehouseList,
        stock: &WarehouseStock,
        search: &str,
    ) -> Result<()> {
        self.write_transaction(|store| {
            if list.generation != stock.generation
                || store.verified_reviewed_generation()? != list.generation
                || !store.can_read_cached_orders()
            {
                return Err(CoreError::CalendarGenerationChanged);
            }
            Self::set_meta_at(&store.conn, "warehouse:list", &serde_json::to_string(list)?)?;
            Self::set_meta_at(
                &store.conn,
                &stock_key(stock.warehouse.id, search, stock.pagination.page),
                &serde_json::to_string(stock)?,
            )?;
            store.cache_warehouse_balances(stock)
        })
    }

    fn cache_warehouse_balances(&self, stock: &WarehouseStock) -> Result<()> {
        for row in &stock.products {
            let key = balance_key(stock.warehouse.id, row.product_id);
            if self
                .read_warehouse_cache::<WarehouseBalance>(&key)?
                .is_none_or(|current| current.version <= row.version)
            {
                Self::set_meta_at(&self.conn, &key, &serde_json::to_string(row)?)?;
            }
        }
        Ok(())
    }

    pub fn cache_warehouse_review(
        &mut self,
        list: &WarehouseList,
        balances: &[WarehouseStock],
    ) -> Result<()> {
        self.write_transaction(|store| {
            if !store.can_read_cached_orders()
                || store.verified_reviewed_generation()? != list.generation
                || balances
                    .iter()
                    .any(|page| page.generation != list.generation)
            {
                return Err(CoreError::CalendarGenerationChanged);
            }
            Self::set_meta_at(&store.conn, "warehouse:list", &serde_json::to_string(list)?)?;
            for page in balances {
                store.cache_warehouse_balances(page)?;
            }
            Ok(())
        })
    }

    pub fn finish_warehouse_transfer_review(
        &mut self,
        generation: &str,
        conflict: &str,
        recorded: &RecordedWarehouseTransfer,
    ) -> Result<()> {
        self.write_transaction(|store| {
            if store.verified_reviewed_generation()? != generation
                || !store.can_read_cached_orders()
            {
                return Err(CoreError::CalendarGenerationChanged);
            }
            let row = store
                .conflict(conflict)?
                .filter(|row| row.kind == TRANSFER)
                .ok_or_else(|| CoreError::NotFound("warehouse transfer".into()))?;
            let proposal: WarehouseTransfer = serde_json::from_value(row.payload)?;
            if !recorded.matches(&proposal) {
                return Err(CoreError::CatalogueVersionChanged);
            }
            store.resolve_conflict(conflict, "recorded")
        })
    }

    pub fn queue_warehouse_edit(
        &mut self,
        generation: &str,
        mut edit: WarehouseEdit,
        replaces: Option<&str>,
    ) -> Result<()> {
        if !edit.normalize() {
            return Err(CoreError::Invalid("Invalid warehouse name".into()));
        }
        self.write_transaction(|store| {
            let list = store.warehouses_for_write(generation)?;
            let id = edit.id.to_string();
            if edit.version
                != list
                    .warehouses
                    .iter()
                    .find(|row| row.id == Some(edit.id))
                    .map_or(0, |row| row.version)
            {
                return Err(CoreError::CatalogueVersionChanged);
            }
            if store.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM outbox WHERE kind = ?1 AND entity_id = ?2)",
                params![SAVE, id],
                |row| row.get::<_, bool>(0),
            )? {
                return Err(CoreError::CatalogueEditPending);
            }
            if let Some(previous) = replaces {
                store
                    .conflict(previous)?
                    .filter(|row| row.kind == SAVE && row.entity_id == id)
                    .ok_or_else(|| CoreError::NotFound("warehouse proposal".into()))?;
                store.resolve_conflict(previous, "resubmitted")?;
            }
            store.enqueue(SAVE, &id, serde_json::to_value(edit)?)?;
            Ok(())
        })
    }

    pub fn queue_warehouse_transfer(
        &mut self,
        generation: &str,
        mut transfer: WarehouseTransfer,
        replaces: Option<&str>,
    ) -> Result<()> {
        if !transfer.normalize() {
            return Err(CoreError::Invalid("Invalid warehouse transfer".into()));
        }
        self.write_transaction(|store| {
            let list = store.warehouses_for_write(generation)?;
            for id in [transfer.source_id, transfer.destination_id] {
                if !list.warehouses.iter().any(|row| row.id == id && row.active) {
                    return Err(CoreError::CatalogueVersionChanged);
                }
            }
            for line in &transfer.lines {
                let current = store.read_warehouse_cache::<WarehouseBalance>(
                    &balance_key(transfer.source_id, line.product_id),
                )?;
                if !current.is_some_and(|row| row.version == line.version && row.available() >= line.quantity) {
                    return Err(CoreError::CatalogueVersionChanged);
                }
                if store.conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM outbox, json_each(outbox.payload, '$.lines') AS line
                     WHERE outbox.kind IN (?1, 'stock.receipt') AND json_extract(line.value, '$.productId') = ?2)",
                    params![TRANSFER, line.product_id.to_string()],
                    |row| row.get::<_, bool>(0),
                )? {
                    return Err(CoreError::CatalogueEditPending);
                }
            }
            if let Some(previous) = replaces {
                store.conflict(previous)?
                    .filter(|row| row.kind == TRANSFER && row.entity_id == transfer.id.to_string())
                    .ok_or_else(|| CoreError::NotFound("warehouse proposal".into()))?;
                store.resolve_conflict(previous, "resubmitted")?;
            }
            store.enqueue(TRANSFER, &transfer.id.to_string(), serde_json::to_value(transfer)?)?;
            Ok(())
        })
    }

    fn warehouses_for_write(&self, generation: &str) -> Result<WarehouseList> {
        if self.verified_reviewed_generation()? != generation || !self.can_queue_product_edits() {
            return Err(CoreError::CalendarGenerationChanged);
        }
        self.cached_warehouses()?
            .filter(|list| list.generation == generation)
            .ok_or(CoreError::CalendarGenerationChanged)
    }
}
