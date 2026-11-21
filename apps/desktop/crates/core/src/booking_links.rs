use crate::model::ServiceOption;
use qrcode::{EcLevel, QrCode};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::io::Cursor;
use url::Url;
use uuid::Uuid;

const MAX_SERVICES: usize = 24;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicTreatment {
    pub id: Uuid,
    pub name: String,
    pub category: Option<String>,
    currency: String,
    catalog: Option<ServiceOption>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProfessional {
    pub id: Uuid,
    pub display_name: String,
    service_ids: BTreeSet<Uuid>,
}

pub struct PublicCatalog {
    pub services: Vec<PublicTreatment>,
    pub staff: Vec<PublicProfessional>,
    pub salon_name: String,
}

impl PublicTreatment {
    pub fn display_name(&self) -> String {
        match &self.catalog {
            Some(ServiceOption::Variant { option_label, .. }) if option_label != &self.name => {
                format!("{} · {option_label}", self.name)
            }
            _ => self.name.clone(),
        }
    }

    pub fn is_extra(&self) -> bool {
        matches!(self.catalog, Some(ServiceOption::Addon { .. }))
    }

    fn family(&self) -> String {
        match &self.catalog {
            Some(ServiceOption::Variant {
                parent_service_id, ..
            }) => parent_service_id.clone(),
            _ => self.id.to_string(),
        }
    }

    pub fn fits_base(&self, base: &Self) -> bool {
        matches!(&self.catalog, Some(ServiceOption::Addon { allowed_service_ids })
            if self.currency == base.currency && (allowed_service_ids.contains(&base.id.to_string())
                || allowed_service_ids.contains(&base.family())))
    }
}

#[derive(Default)]
pub struct Selection {
    segments: Vec<(Uuid, Vec<Uuid>)>,
    pub staff: Option<Uuid>,
}

impl Selection {
    pub fn treatments(&self) -> impl Iterator<Item = Uuid> + '_ {
        self.segments
            .iter()
            .flat_map(|(base, extras)| std::iter::once(*base).chain(extras.iter().copied()))
    }

    pub fn eligible<'a>(
        &'a self,
        catalog: &'a PublicCatalog,
    ) -> impl Iterator<Item = &'a PublicProfessional> {
        catalog
            .staff
            .iter()
            .filter(|staff| self.treatments().all(|id| staff.service_ids.contains(&id)))
    }

    pub fn bases(&self) -> impl Iterator<Item = Uuid> + '_ {
        self.segments.iter().map(|(base, _)| *base)
    }

    pub fn extras(&self, base: Uuid) -> &[Uuid] {
        self.segments
            .iter()
            .find(|(id, _)| *id == base)
            .map_or(&[], |(_, extras)| extras)
    }

    pub fn compatible_bases(&self, catalog: &PublicCatalog, extra: &PublicTreatment) -> Vec<Uuid> {
        self.bases()
            .filter(|id| {
                catalog
                    .services
                    .iter()
                    .any(|service| service.id == *id && extra.fits_base(service))
            })
            .collect()
    }

    pub fn toggle(&mut self, catalog: &PublicCatalog, id: Uuid, base: Option<Uuid>) -> bool {
        let Some(item) = catalog.services.iter().find(|service| service.id == id) else {
            return false;
        };
        let count = self.treatments().count();
        if item.is_extra() {
            if let Some((_, extras)) = self
                .segments
                .iter_mut()
                .find(|(_, extras)| extras.contains(&id))
            {
                extras.retain(|extra| *extra != id);
            } else if count < MAX_SERVICES {
                let Some(base) =
                    base.filter(|base| self.compatible_bases(catalog, item).contains(base))
                else {
                    return false;
                };
                if let Some((_, extras)) = self
                    .segments
                    .iter_mut()
                    .find(|(selected, _)| *selected == base)
                {
                    extras.push(id);
                }
            } else {
                return false;
            }
        } else {
            let family = item.family();
            if !self.bases().any(|base| base == id)
                && self.bases().any(|base| {
                    catalog.services.iter().any(|selected| {
                        selected.id == base
                            && selected.family() != family
                            && selected.currency != item.currency
                    })
                })
            {
                return false;
            }
            let existing = self.segments.iter().position(|(base, _)| {
                catalog
                    .services
                    .iter()
                    .any(|service| service.id == *base && service.family() == family)
            });
            match existing {
                Some(index) if self.segments[index].0 == id => {
                    self.segments.remove(index);
                }
                Some(index) => {
                    let (base, extras) = &mut self.segments[index];
                    *base = id;
                    extras.retain(|extra| {
                        catalog
                            .services
                            .iter()
                            .any(|service| service.id == *extra && service.fits_base(item))
                    });
                }
                None if count < MAX_SERVICES => self.segments.push((id, Vec::new())),
                _ => return false,
            }
        }
        if self.segments.is_empty() {
            self.staff = None;
        }
        true
    }

    pub fn links(&self, origin: &str, catalog: &PublicCatalog) -> Option<BookingLinks> {
        if self.treatments().next().is_some() {
            let mut families = BTreeSet::new();
            let mut currency = None;
            for (base, extras) in &self.segments {
                let service = catalog
                    .services
                    .iter()
                    .find(|service| service.id == *base && !service.is_extra())?;
                if !families.insert(service.family())
                    || currency.is_some_and(|value| value != &service.currency)
                    || extras.iter().any(|id| {
                        !catalog
                            .services
                            .iter()
                            .any(|extra| extra.id == *id && extra.fits_base(service))
                    })
                {
                    return None;
                }
                currency = Some(&service.currency);
            }
            let mut eligible = self.eligible(catalog);
            if !eligible.any(|person| self.staff.is_none_or(|id| id == person.id)) {
                return None;
            }
        } else if self.staff.is_some() {
            return None;
        }
        let mut book = public_origin(origin)?.join("/book").ok()?;
        let services = self
            .treatments()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        if !services.is_empty() {
            book.query_pairs_mut().append_pair("services", &services);
        }
        if let Some(staff) = self.staff {
            book.query_pairs_mut()
                .append_pair("staff", &staff.to_string());
        }
        let mut widget = book.clone();
        widget.set_path("/widget");
        let snippet = format!(
            "<iframe src=\"{}\" title=\"{}\" width=\"100%\" height=\"640\" loading=\"lazy\" referrerpolicy=\"strict-origin-when-cross-origin\" style=\"border:0;border-radius:16px\"></iframe>",
            escape_attribute(widget.as_str()),
            escape_attribute(&catalog.salon_name),
        );
        Some(BookingLinks {
            book,
            widget,
            snippet,
        })
    }
}

pub(crate) fn public_origin(value: &str) -> Option<Url> {
    let value = value.trim();
    if value.bytes().any(|b| b <= 32 || b == 127 || b == b'*') {
        return None;
    }
    let url = Url::parse(value).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.has_host()
        && url.path() == "/"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&#39;")
}

pub struct BookingLinks {
    pub book: Url,
    pub widget: Url,
    pub snippet: String,
}

impl BookingLinks {
    pub fn share_url(&self, whatsapp: bool) -> Url {
        let (base, parameter) = if whatsapp {
            ("https://wa.me/", "text")
        } else {
            ("https://www.facebook.com/sharer/sharer.php", "u")
        };
        let mut share = Url::parse(base).expect("valid fixed sharing service");
        share
            .query_pairs_mut()
            .append_pair(parameter, self.book.as_str());
        share
    }
}

pub fn qr_png(link: &Url) -> Option<Vec<u8>> {
    let code = QrCode::with_error_correction_level(link.as_str().as_bytes(), EcLevel::Q).ok()?;
    let bitmap = code
        .render::<image::Luma<u8>>()
        .min_dimensions(512, 512)
        .build();
    let mut output = Cursor::new(Vec::new());
    bitmap.write_to(&mut output, image::ImageFormat::Png).ok()?;
    Some(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn uid(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    #[test]
    fn variants_extras_and_professionals_match_public_selection_rules() {
        let base = uid(1);
        let variant = uid(2);
        let extra = uid(3);
        let staff = uid(4);
        let other_currency = uid(5);
        let mut catalog = PublicCatalog {
            services: serde_json::from_value(json!([
                {"id":base,"name":"Gel","currency":"EUR"},
                {"id":variant,"name":"Gel French","currency":"EUR","catalog":{"kind":"variant","parentServiceId":base,"optionLabel":"French"}},
                {"id":extra,"name":"Deco","currency":"EUR","catalog":{"kind":"addon","allowedServiceIds":[base]}},
                {"id":other_currency,"name":"Other service","currency":"USD"},
            ])).unwrap(),
            staff: serde_json::from_value(json!([
                {"id":staff,"displayName":"Synthetic","serviceIds":[base,extra]},
            ])).unwrap(),
            salon_name: r#"Citame "&<>"'"#.into(),
        };
        let mut selection = Selection::default();
        assert!(!selection.toggle(&catalog, extra, Some(base)));
        assert!(selection.toggle(&catalog, base, None));
        assert!(!selection.toggle(&catalog, other_currency, None));
        assert!(selection.toggle(&catalog, extra, Some(base)));
        selection.staff = Some(staff);
        let links = selection.links("https://example.com", &catalog).unwrap();
        assert_eq!(links.book.path(), "/book");
        assert_eq!(links.widget.path(), "/widget");
        let expected = format!("services={base}%2C{extra}&staff={staff}");
        assert_eq!(links.book.query(), Some(expected.as_str()));
        assert_eq!(links.widget.query(), Some(expected.as_str()));
        assert!(links.snippet.contains("&amp;staff="));
        assert!(links.snippet.contains("&quot;&amp;&lt;&gt;&quot;&#39;"));
        assert_eq!(
            links.share_url(true).query_pairs().next().unwrap().1,
            links.book.as_str()
        );
        assert!(
            qr_png(&links.book)
                .unwrap()
                .starts_with(b"\x89PNG\r\n\x1a\n")
        );

        let available = std::mem::take(&mut catalog.staff);
        assert!(selection.links("https://example.com", &catalog).is_none());
        catalog.staff = available;
        let available = std::mem::take(&mut catalog.services);
        assert!(selection.links("https://example.com", &catalog).is_none());
        catalog.services = available;
        assert!(selection.toggle(&catalog, variant, None));
        assert_eq!(selection.treatments().collect::<Vec<_>>(), [variant, extra]);
        assert!(selection.links("https://example.com", &catalog).is_none());
        assert!(selection.toggle(&catalog, variant, None));
        assert_eq!(selection.staff, None);
    }

    #[test]
    fn public_booking_uses_an_exact_origin_and_no_private_query() {
        let catalog = PublicCatalog {
            services: Vec::new(),
            staff: Vec::new(),
            salon_name: "Citame".into(),
        };
        let selection = Selection::default();
        for origin in [
            "https://example.com/path",
            "https://alice:secret@example.com",
            "https://example.com/?token=secret",
            "https://example.com/#secret",
            "file:///tmp/citame",
        ] {
            assert!(selection.links(origin, &catalog).is_none(), "{origin}");
        }
        let links = selection.links("http://127.0.0.1:4275", &catalog).unwrap();
        assert_eq!(links.book.as_str(), "http://127.0.0.1:4275/book");
    }
}
