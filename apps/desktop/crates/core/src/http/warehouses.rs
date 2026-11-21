use super::*;
use crate::warehouses::{
    RecordedAdjustment, RecordedWarehouseTransfer, WarehouseList, WarehouseStock, location_key,
};
use url::form_urlencoded;
use uuid::Uuid;

impl HttpTransport {
    pub fn inventory_warehouses(&self) -> Result<WarehouseList, TransportError> {
        read_response(
            self.get(&self.agent, "/admin/inventory/warehouses", None)?,
            false,
        )
    }

    pub fn inventory_warehouse_stock(
        &self,
        warehouse_id: Option<Uuid>,
        search: &str,
        page: u32,
    ) -> Result<WarehouseStock, TransportError> {
        self.read_location_stock(warehouse_id, search, page, None)
    }

    pub fn warehouse_product(
        &self,
        warehouse_id: Option<Uuid>,
        product_id: Uuid,
    ) -> Result<WarehouseStock, TransportError> {
        self.read_location_stock(warehouse_id, "", 1, Some(product_id))
    }

    pub fn inventory_recorded_transfer(
        &self,
        id: Uuid,
    ) -> Result<Option<RecordedWarehouseTransfer>, TransportError> {
        let response = self.get(
            &self.agent,
            &format!("/admin/inventory/transfers/{id}"),
            None,
        )?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        let document: RecordedWarehouseTransfer = read_response(response, false)?;
        if document.id != id {
            return Err(TransportError::Server(
                "Unexpected stock transfer acknowledgement".into(),
            ));
        }
        Ok(Some(document))
    }

    pub fn inventory_recorded_adjustment(
        &self,
        id: Uuid,
    ) -> Result<Option<RecordedAdjustment>, TransportError> {
        let response = self.get(
            &self.agent,
            &format!("/admin/inventory/stock-adjustments/{id}"),
            None,
        )?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        let recorded: RecordedAdjustment = read_response(response, false)?;
        if recorded.movement.id != id {
            return Err(TransportError::Server(
                "Unexpected stock adjustment acknowledgement".into(),
            ));
        }
        Ok(Some(recorded))
    }

    fn read_location_stock(
        &self,
        warehouse_id: Option<Uuid>,
        search: &str,
        page: u32,
        product_id: Option<Uuid>,
    ) -> Result<WarehouseStock, TransportError> {
        let mut query = form_urlencoded::Serializer::new(String::new());
        query
            .append_pair("warehouseId", &location_key(warehouse_id))
            .append_pair("search", search)
            .append_pair("page", &page.to_string());
        if let Some(id) = product_id {
            query.append_pair("productId", &id.to_string());
        } else if warehouse_id.is_some() && !search.is_empty() {
            query.append_pair("includeEmpty", "1");
        }
        let query = query.finish();
        let result: WarehouseStock = read_response(
            self.get(
                &self.agent,
                &format!("/admin/inventory/warehouse-stock?{query}"),
                None,
            )?,
            false,
        )?;
        if result.warehouse.id != warehouse_id
            || result.pagination.page != page
            || product_id.is_some_and(|id| result.products.iter().any(|row| row.product_id != id))
        {
            return Err(TransportError::Server(
                "Unexpected warehouse stock page".into(),
            ));
        }
        Ok(result)
    }
}
