use super::*;
use crate::{
    http::gift_cards::{GiftOfferReview, GiftPurchase, offer_save_is_terminal},
    sync::TransportError,
};

impl Store {
    pub fn pending_gift_offer(&self, actor: &str) -> Result<Option<GiftOfferReview>> {
        self.get_meta(&format!("gift_offer_pending:{actor}"))?
            .map(|value| Ok(serde_json::from_str(&value)?))
            .transpose()
    }

    pub fn reserve_gift_offer(&self, actor: &str, offer: &GiftOfferReview) -> Result<bool> {
        let identity = format!("gift_offer_pending:{actor}");
        let data = serde_json::to_string(offer)?;
        Ok(self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value = excluded.value",
            params![identity, data],
        )? == 1)
    }

    pub fn settle_gift_offer(
        &self,
        actor: &str,
        offer: &GiftOfferReview,
        result: std::result::Result<(), &TransportError>,
    ) -> Result<()> {
        if offer_save_is_terminal(result) {
            self.conn.execute(
                "DELETE FROM meta WHERE key = ?1 AND value = ?2",
                params![
                    format!("gift_offer_pending:{actor}"),
                    serde_json::to_string(offer)?
                ],
            )?;
        }
        Ok(())
    }

    pub fn pending_gift_purchase(&self, actor: &str) -> Result<Option<GiftPurchase>> {
        self.get_meta(&format!("gift_purchase_pending:{actor}"))?
            .map(|value| {
                let (generation, mut purchase): (String, GiftPurchase) =
                    serde_json::from_str(&value)?;
                purchase.generation = generation;
                Ok(purchase)
            })
            .transpose()
    }

    pub fn reserve_gift_purchase(&self, actor: &str, purchase: &GiftPurchase) -> Result<bool> {
        let key = format!("gift_purchase_pending:{actor}");
        Ok(self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
            params![
                key,
                serde_json::to_string(&(&purchase.generation, purchase))?
            ],
        )? == 1)
    }

    pub fn settle_gift_purchase(
        &self,
        actor: &str,
        purchase: &GiftPurchase,
        result: std::result::Result<(), &TransportError>,
    ) -> Result<bool> {
        if !matches!(result, Ok(()) | Err(TransportError::BadRequest(_))) {
            return Ok(false);
        }
        self.clear_gift_purchase(actor, purchase)?;
        Ok(true)
    }

    pub fn clear_gift_purchase(&self, actor: &str, purchase: &GiftPurchase) -> Result<()> {
        self.conn.execute(
            "DELETE FROM meta WHERE key = ?1 AND value = ?2",
            params![
                format!("gift_purchase_pending:{actor}"),
                serde_json::to_string(&(&purchase.generation, purchase))?
            ],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unconfirmed_gift_template_survives_restart_under_its_own_actor() {
        use crate::http::gift_cards::{GiftOffer, GiftOfferTerms, GiftOfferTheme};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("replica.db");
        let review = GiftOfferReview {
            generation: "reviewed".into(),
            catalogue_revision: "f".repeat(64),
            proposal: GiftOffer {
                id: uuid::Uuid::now_v7(),
                version: 0,
                terms: GiftOfferTerms {
                    name: "Reviewed gift".into(),
                    description: String::new(),
                    theme: GiftOfferTheme::Rose,
                    amount_cents: 3000,
                    price_cents: 2200,
                    validity_days: Some(30),
                    eligible_service_ids: Vec::new(),
                    published: true,
                },
            },
        };
        {
            let store = Store::open(&path).unwrap();
            assert!(store.reserve_gift_offer("owner", &review).unwrap());
        }
        let store = Store::open(&path).unwrap();
        let recovered = store.pending_gift_offer("owner").unwrap().unwrap();
        assert!(recovered == review);
        assert!(store.pending_gift_offer("another").unwrap().is_none());
        assert!(store.reserve_gift_offer("owner", &recovered).unwrap());
        let mut other = recovered.clone();
        other.proposal.id = uuid::Uuid::now_v7();
        assert!(!store.reserve_gift_offer("owner", &other).unwrap());
        store.settle_gift_offer("owner", &other, Ok(())).unwrap();
        assert!(store.pending_gift_offer("owner").unwrap().is_some());
        store
            .settle_gift_offer("owner", &recovered, Ok(()))
            .unwrap();
        assert!(store.pending_gift_offer("owner").unwrap().is_none());
    }

    #[test]
    fn gift_purchase_survives_a_restart_and_clears_only_the_exact_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("replica.db");
        let purchase = GiftPurchase {
            eligible_service_ids: Vec::new(),
            amount_cents: 3500,
            purchase_price_cents: Some(2700),
            label: "Synthetic gift".into(),
            buyer_client_id: None,
            expires_at: None,
            idempotency_key: uuid::Uuid::now_v7(),
            generation: "reviewed".into(),
        };
        let store = Store::open(&database).unwrap();
        assert!(store.reserve_gift_purchase("owner", &purchase).unwrap());
        let mut other = purchase.clone();
        other.idempotency_key = uuid::Uuid::now_v7();
        assert!(!store.reserve_gift_purchase("owner", &other).unwrap());
        drop(store);

        let store = Store::open(&database).unwrap();
        assert!(
            store
                .pending_gift_purchase("other-owner")
                .unwrap()
                .is_none()
        );
        store.clear_gift_purchase("owner", &other).unwrap();
        let reopened = store.pending_gift_purchase("owner").unwrap().unwrap();
        assert_eq!(reopened.idempotency_key, purchase.idempotency_key);
        assert_eq!(reopened.generation, "reviewed");
        assert_eq!(reopened.price_cents(), 2700);
        assert_eq!(reopened.amount_cents, 3500);
        let timeout = TransportError::Offline("timed out".into());
        assert!(
            !store
                .settle_gift_purchase("owner", &reopened, Err(&timeout))
                .unwrap()
        );
        assert!(store.pending_gift_purchase("owner").unwrap().is_some());
        assert!(
            store
                .settle_gift_purchase("owner", &reopened, Ok(()))
                .unwrap()
        );
        assert!(store.pending_gift_purchase("owner").unwrap().is_none());
    }
}
