//! Selection for the same catalogue used by the cloud form recorder.
//! Service IDs are sent in visit order, with extras following their base.

use serde::Deserialize;

pub const MAX_RECORD_SERVICES: usize = 24;

#[derive(Deserialize)]
pub struct RecordingCatalog {
    pub services: Vec<RecordingService>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingService {
    pub id: String,
    pub name: String,
    pub duration_minutes: i64,
    currency: String,
    catalog: Option<CatalogRelation>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum CatalogRelation {
    Variant { parent_service_id: String },
    Addon { allowed_service_ids: Vec<String> },
}

impl RecordingService {
    fn family(&self) -> &str {
        match &self.catalog {
            Some(CatalogRelation::Variant { parent_service_id }) => parent_service_id,
            _ => &self.id,
        }
    }

    fn is_addon(&self) -> bool {
        matches!(&self.catalog, Some(CatalogRelation::Addon { .. }))
    }

    fn applies_to(&self, base: &Self) -> bool {
        matches!(&self.catalog, Some(CatalogRelation::Addon { allowed_service_ids })
            if self.currency == base.currency
                && (allowed_service_ids.contains(&base.id)
                    || allowed_service_ids.iter().any(|id| id == base.family())))
    }
}

impl RecordingCatalog {
    pub fn get(&self, id: &str) -> Option<&RecordingService> {
        self.services.iter().find(|service| service.id == id)
    }

    /// Returns the next valid selection, including family replacement and clearing extras
    /// made inapplicable when the base changes. A rejected option leaves the old packet intact.
    pub fn selection_after(
        &self,
        selected: &[String],
        service: &RecordingService,
    ) -> Option<Vec<String>> {
        let mut next: Vec<_> = selected
            .iter()
            .map(|id| self.get(id))
            .collect::<Option<_>>()?;
        if service.is_addon() {
            if let Some(index) = next.iter().position(|selected| selected.id == service.id) {
                next.remove(index);
            } else {
                let base = next
                    .iter()
                    .position(|base| !base.is_addon() && service.applies_to(base))?;
                let insert_at = segment_end(&next, base);
                next.insert(insert_at, service);
            }
        } else if let Some(base) = next
            .iter()
            .position(|base| !base.is_addon() && base.family() == service.family())
        {
            let end = segment_end(&next, base);
            let replacement = if next[base].id == service.id {
                Vec::new()
            } else {
                std::iter::once(service)
                    .chain(
                        next[base + 1..end]
                            .iter()
                            .copied()
                            .filter(|addon| addon.applies_to(service)),
                    )
                    .collect()
            };
            next.splice(base..end, replacement);
        } else {
            next.push(service);
        }
        if next.len() > MAX_RECORD_SERVICES
            || next
                .first()
                .is_some_and(|first| next.iter().any(|entry| entry.currency != first.currency))
        {
            return None;
        }
        Some(next.into_iter().map(|service| service.id.clone()).collect())
    }
}

fn segment_end(selection: &[&RecordingService], base: usize) -> usize {
    base + 1
        + selection[base + 1..]
            .iter()
            .take_while(|entry| entry.is_addon())
            .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selection_replaces_family_preserves_compatible_extras_and_keeps_visit_order() {
        let catalog: RecordingCatalog = serde_json::from_value(json!({"services": [
            {"id":"base","name":"Base","currency":"EUR","durationMinutes":30},
            {"id":"variant","name":"Variant","currency":"EUR","durationMinutes":40,
                "catalog":{"kind":"variant","parentServiceId":"base"}},
            {"id":"extra","name":"Extra","currency":"EUR","durationMinutes":10,
                "catalog":{"kind":"addon","allowedServiceIds":["base"]}},
            {"id":"only-variant","name":"Only variant","currency":"EUR","durationMinutes":5,
                "catalog":{"kind":"addon","allowedServiceIds":["variant"]}},
            {"id":"other","name":"Other","currency":"EUR","durationMinutes":30},
            {"id":"different-currency","name":"Different","currency":"USD","durationMinutes":30}
        ]}))
        .unwrap();
        let choose =
            |selected: &[String], id| catalog.selection_after(selected, catalog.get(id).unwrap());
        assert!(choose(&[], "extra").is_none());
        let mut selected = choose(&[], "variant").unwrap();
        selected = choose(&selected, "other").unwrap();
        assert!(choose(&selected, "different-currency").is_none());
        selected = choose(&selected, "extra").unwrap();
        selected = choose(&selected, "only-variant").unwrap();
        assert_eq!(selected, ["variant", "extra", "only-variant", "other"]);
        selected = choose(&selected, "base").unwrap();
        assert_eq!(selected, ["base", "extra", "other"]);
        assert_eq!(choose(&selected, "base").unwrap(), ["other"]);
    }
}
