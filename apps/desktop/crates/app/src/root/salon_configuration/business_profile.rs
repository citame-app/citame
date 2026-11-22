use super::*;
use sob_core::http::{BusinessAmenity, BusinessProfile};

const FIELDS: [(Key, usize); 9] = [
    (Key::BusinessCategory, 80),
    (Key::BusinessDescription, 600),
    (Key::BusinessAddress, 240),
    (Key::BusinessPhone, 32),
    (Key::BusinessEmail, 254),
    (Key::BusinessWebsite, 500),
    (Key::BusinessShop, 500),
    (Key::BusinessInstagram, 500),
    (Key::BusinessRules, 400),
];
const AMENITIES: [(BusinessAmenity, Key); 6] = [
    (BusinessAmenity::Wifi, Key::BusinessWifi),
    (BusinessAmenity::Parking, Key::BusinessParking),
    (
        BusinessAmenity::AccessibleEntrance,
        Key::BusinessAccessibleEntrance,
    ),
    (BusinessAmenity::CardPayments, Key::BusinessCardPayments),
    (
        BusinessAmenity::ChildrenWelcome,
        Key::BusinessChildrenWelcome,
    ),
    (BusinessAmenity::PetsWelcome, Key::BusinessPetsWelcome),
];

pub(super) struct BusinessEditor {
    inputs: [Entity<TextField>; FIELDS.len()],
    published: bool,
    mobile_service: bool,
    amenities: [bool; AMENITIES.len()],
}

impl BusinessEditor {
    pub(super) fn new(profile: &BusinessProfile, cx: &mut Context<Root>) -> Self {
        let values = [
            &profile.category,
            &profile.description,
            &profile.address,
            &profile.phone,
            &profile.email,
            &profile.website,
            &profile.shop,
            &profile.instagram,
            &profile.rules,
        ];
        let inputs = values.map(|value| {
            let field = cx.new(|cx| {
                let mut field = TextField::new("", false, cx);
                field.set_text(value.as_deref().unwrap_or_default(), cx);
                field
            });
            cx.observe(&field, |_, _, cx| cx.notify()).detach();
            field
        });
        Self {
            inputs,
            published: profile.published,
            mobile_service: profile.mobile_service,
            amenities: AMENITIES.map(|(value, _)| profile.amenities.contains(&value)),
        }
    }

    pub(super) fn draft(&self, cx: &App) -> Option<BusinessProfile> {
        let values = self
            .inputs
            .each_ref()
            .map(|input| input.read(cx).text().trim());
        if values.iter().zip(FIELDS).any(|(value, (_, limit))| {
            value.encode_utf16().count() > limit
                || value
                    .chars()
                    .any(|ch| ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}'))
        }) {
            return None;
        }
        let [
            category,
            description,
            address,
            phone,
            email,
            website,
            shop,
            instagram,
            rules,
        ] = values;
        let valid_phone =
            phone.is_empty()
                || (phone.bytes().filter(u8::is_ascii_digit).count() >= 6
                    && phone.strip_prefix('+').unwrap_or(phone).chars().all(|ch| {
                        ch.is_ascii_digit() || ch.is_whitespace() || "().-".contains(ch)
                    }));
        let valid_email = email.is_empty()
            || email.split_once('@').is_some_and(|(local, domain)| {
                !local.is_empty()
                    && domain.contains('.')
                    && !domain.contains('@')
                    && !email.chars().any(char::is_whitespace)
            });
        let valid_links = [website, shop, instagram].into_iter().all(|value| {
            value.is_empty()
                || url::Url::parse(value).is_ok_and(|url| {
                    url.scheme() == "https"
                        && url.host_str().is_some()
                        && url.username().is_empty()
                        && url.password().is_none()
                })
        });
        if !(valid_phone && valid_email && valid_links) {
            return None;
        }
        let filled = |value: &str| (!value.is_empty()).then(|| value.to_owned());
        Some(BusinessProfile {
            category: filled(category),
            description: filled(description),
            address: filled(address),
            phone: filled(phone),
            email: filled(email),
            website: filled(website),
            shop: filled(shop),
            instagram: filled(instagram),
            rules: filled(rules),
            published: self.published,
            mobile_service: self.mobile_service,
            amenities: AMENITIES
                .iter()
                .zip(self.amenities)
                .filter_map(|((value, _), selected)| selected.then_some(*value))
                .collect(),
        })
    }
}

impl Root {
    fn edit_business_profile(
        &mut self,
        cx: &mut Context<Self>,
        edit: impl FnOnce(&mut BusinessEditor),
    ) {
        if let Overlay::SalonConfiguration(desk) = &mut self.overlay
            && desk.editable()
            && let Some(profile) = desk
                .editor
                .as_mut()
                .and_then(|editor| editor.profile.as_mut())
        {
            edit(profile);
            cx.notify();
        }
    }

    pub(super) fn render_business_profile(
        &self,
        editor: &BusinessEditor,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .id("business-profile-editor")
            .debug_selector(|| "business-profile-editor".to_string())
            .flex()
            .flex_col()
            .gap_2()
            .min_h(px(0.))
            .flex_shrink()
            .overflow_y_scroll()
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::BusinessProfileHelp)),
            )
            .children(
                FIELDS
                    .iter()
                    .zip(&editor.inputs)
                    .map(|((label, _), input)| {
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(div().text_sm().child(self.t(*label)))
                            .child(input.clone())
                    }),
            )
            .child(div().text_sm().child(self.t(Key::BusinessAmenities)))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(AMENITIES.iter().enumerate().map(|(index, (_, label))| {
                        self.chip(
                            ("business-amenity", index),
                            self.t(*label),
                            editor.amenities[index],
                            cx.listener(move |root, _, _, cx| {
                                root.edit_business_profile(cx, |profile| {
                                    profile.amenities[index] = !profile.amenities[index]
                                })
                            }),
                        )
                    })),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.chip(
                        "business-mobile",
                        self.t(Key::BusinessMobileService),
                        editor.mobile_service,
                        cx.listener(|root, _, _, cx| {
                            root.edit_business_profile(cx, |profile| {
                                profile.mobile_service = !profile.mobile_service
                            })
                        }),
                    ))
                    .child(self.chip(
                        "business-publish",
                        self.t(Key::BusinessPublish),
                        editor.published,
                        cx.listener(|root, _, _, cx| {
                            root.edit_business_profile(cx, |profile| {
                                profile.published = !profile.published
                            })
                        }),
                    )),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn the_business_profile_can_be_drafted_offline_and_queued_field_by_field(
        cx: &mut TestAppContext,
    ) {
        let (_directory, window) = super::super::super::tests::open(cx);
        window.update(cx, |root, _, cx| {
            let saved: ReviewedSalonConfiguration = serde_json::from_value(serde_json::json!({
                "name": "Studio", "timezone": "Europe/Madrid", "slotGranularityMinutes": 15,
                "minNoticeMinutes": 30, "maxDaysAhead": 60, "onlineBookingEnabled": true,
                "reminderFirstLeadMinutes": null, "reminderSecondLeadMinutes": null,
                "businessProfile": BusinessProfile::default(),
                "revision": "2026-11-21T00:00:00Z", "generation": "initial",
            })).unwrap();
            root.svc.store.cache_salon_configuration(&saved).unwrap();
            root.status.connectivity = Connectivity::Offline;
            root.open_salon_configuration(cx);
            let Overlay::SalonConfiguration(desk) = &mut root.overlay else { panic!("Missing editor") };
            assert!(desk.editable());
            let editor = desk.editor.as_mut().unwrap();
            editor.show_profile = true;
            let profile = editor.profile.as_mut().unwrap();
            profile.inputs[5].update(cx, |field, cx| field.set_text("javascript:alert(1)", cx));
            assert!(profile.draft(cx).is_none());
            profile.inputs[5].update(cx, |field, cx| field.set_text("https://example.test", cx));
            profile.inputs[2].update(cx, |field, cx| field.set_text("9 Test Street", cx));
            root.save_salon_configuration(cx);
            let SalonConfigurationWork::Pending(Some(write)) = root.svc.store.salon_configuration_work().unwrap() else {
                panic!("Offline edit did not persist")
            };
            assert_eq!(serde_json::to_value(&write).unwrap()["changes"], serde_json::json!({
                "businessProfile": {"address": "9 Test Street", "website": "https://example.test"}
            }));
        }).unwrap();
    }
}
