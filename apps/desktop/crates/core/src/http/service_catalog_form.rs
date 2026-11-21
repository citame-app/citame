use super::service_catalog::{CatalogPrice, ServiceDetails};
use crate::billing::parse_reviewed_amount;
use crate::model::ProcessingTime;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ServiceField {
    Name,
    Description,
    Category,
    Color,
    Order,
    Duration,
    Buffer,
    ProcessingStart,
    ProcessingLength,
    BookingInterval,
    Instructions,
    Price,
    Currency,
}

impl ServiceField {
    pub const COUNT: usize = 13;
    pub const ALL: [Self; Self::COUNT] = [
        Self::Name,
        Self::Description,
        Self::Category,
        Self::Color,
        Self::Order,
        Self::Duration,
        Self::Buffer,
        Self::ProcessingStart,
        Self::ProcessingLength,
        Self::BookingInterval,
        Self::Instructions,
        Self::Price,
        Self::Currency,
    ];

    pub fn index(self) -> usize {
        self as usize
    }
}

#[derive(PartialEq, Eq)]
pub struct CatalogForm {
    pub fields: [String; ServiceField::COUNT],
    pub price_type: CatalogPrice,
    pub online_booking: bool,
    pub active: bool,
}

impl From<&ServiceDetails> for CatalogForm {
    fn from(service: &ServiceDetails) -> Self {
        let duration = |value: Option<u32>| value.map(|n| n.to_string()).unwrap_or_default();
        Self {
            fields: [
                service.name.clone(),
                service.description.clone().unwrap_or_default(),
                service.category.clone().unwrap_or_default(),
                service.color.clone().unwrap_or_default(),
                service.sort_order.to_string(),
                service.duration_minutes.to_string(),
                service.buffer_minutes.to_string(),
                service
                    .processing
                    .as_ref()
                    .map(|p| p.starts_after_minutes.to_string())
                    .unwrap_or_default(),
                service
                    .processing
                    .as_ref()
                    .map(|p| p.minutes.to_string())
                    .unwrap_or_default(),
                duration(service.booking_interval_minutes),
                service.client_instructions.clone().unwrap_or_default(),
                format!(
                    "{}.{:02}",
                    service.price_cents / 100,
                    service.price_cents % 100
                ),
                service.currency.clone(),
            ],
            price_type: service.price_type,
            online_booking: service.online_booking,
            active: service.active,
        }
    }
}

impl CatalogForm {
    fn text(&self, field: ServiceField) -> &str {
        &self.fields[field.index()]
    }

    pub fn details(&self, saved: &ServiceDetails) -> Option<ServiceDetails> {
        use ServiceField::*;
        let original = Self::from(saved);
        let text = |field| self.text(field).trim();
        let nullable = |field, existing: &Option<String>| {
            let value = text(field);
            if self.text(field) == original.text(field) {
                existing.clone()
            } else {
                (!value.is_empty()).then(|| value.to_owned())
            }
        };
        let name = if self.text(Name) == original.text(Name) {
            saved.name.clone()
        } else {
            text(Name).to_owned()
        };
        let currency = if self.text(Currency) == original.text(Currency) {
            saved.currency.clone()
        } else {
            text(Currency).to_ascii_uppercase()
        };
        if name.is_empty() || currency.len() != 3 {
            return None;
        }
        let (start, exposure) = (text(ProcessingStart), text(ProcessingLength));
        let interval = text(BookingInterval);
        Some(ServiceDetails {
            name,
            currency,
            description: nullable(Description, &saved.description),
            category: nullable(Category, &saved.category),
            color: nullable(Color, &saved.color),
            sort_order: text(Order).parse().ok()?,
            duration_minutes: text(Duration).parse().ok()?,
            buffer_minutes: text(Buffer).parse().ok()?,
            processing: if start.is_empty() && exposure.is_empty() {
                None
            } else {
                Some(ProcessingTime {
                    starts_after_minutes: start.parse().ok()?,
                    minutes: exposure.parse().ok()?,
                })
            },
            booking_interval_minutes: if interval.is_empty() {
                None
            } else {
                Some(interval.parse().ok()?)
            },
            client_instructions: nullable(Instructions, &saved.client_instructions),
            price_type: self.price_type,
            price_cents: if !self.price_type.requires_amount() {
                0
            } else if self.text(Price) == original.text(Price) {
                saved.price_cents
            } else {
                parse_catalogue_amount(text(Price))?
            },
            online_booking: self.online_booking,
            active: self.active,
        })
    }

    /// Keep edits to money and processing together when reviewing a changed base.
    pub fn review(mut self, before: &Self, latest: Self) -> Self {
        use ServiceField::*;
        let edited = |fields: &[ServiceField]| {
            fields
                .iter()
                .any(|field| self.text(*field) != before.text(*field))
        };
        let price_edited = self.price_type != before.price_type || edited(&[Price, Currency]);
        let processing_edited = edited(&[ProcessingStart, ProcessingLength]);
        for field in ServiceField::ALL {
            let keep = match field {
                Price | Currency => price_edited,
                ProcessingStart | ProcessingLength => processing_edited,
                _ => self.text(field) != before.text(field),
            };
            if !keep {
                self.fields[field.index()] = latest.fields[field.index()].clone();
            }
        }
        if !price_edited {
            self.price_type = latest.price_type;
        }
        if self.online_booking == before.online_booking {
            self.online_booking = latest.online_booking;
        }
        if self.active == before.active {
            self.active = latest.active;
        }
        self
    }
}

fn parse_catalogue_amount(input: &str) -> Option<u32> {
    // A final separator with one or two digits is decimal. Any thousands groups must
    // have exactly three digits and use one consistent separator.
    let decimal_at = input
        .rfind(['.', ','])
        .filter(|&index| matches!(input.len() - index - 1, 1 | 2));
    let (whole, fractional) =
        decimal_at.map_or((input, ""), |index| (&input[..index], &input[index + 1..]));
    if let Some(group) = whole
        .find(['.', ','])
        .map(|index| whole.as_bytes()[index] as char)
    {
        if decimal_at.is_some_and(|index| input.as_bytes()[index] as char == group) {
            return None;
        }
        let mut groups = whole.split(group);
        let first = groups.next()?;
        if !(1..=3).contains(&first.len()) || !groups.all(|part| part.len() == 3) {
            return None;
        }
        let normalized = whole.replace(group, "");
        return parse_reviewed_amount(&format!(
            "{normalized}.{}",
            if fractional.is_empty() {
                "00"
            } else {
                fractional
            }
        ));
    }
    parse_reviewed_amount(input)
}

#[cfg(test)]
mod tests {
    use super::parse_catalogue_amount;

    #[test]
    fn grouped_prices_match_the_web_catalogue() {
        assert_eq!(parse_catalogue_amount("1.234,50"), Some(123450));
        assert_eq!(parse_catalogue_amount("1,234.50"), Some(123450));
        assert_eq!(parse_catalogue_amount("12.345"), Some(1234500));
        assert_eq!(parse_catalogue_amount("1,23,50"), None);
        assert_eq!(parse_catalogue_amount("2.50"), Some(250));
    }
}
