use super::*;
use sob_core::http::{BusinessAmenity, BusinessProfile, OpeningSchedule};

mod opening_hours;
use opening_hours::HoursEditor;

struct TextSpec {
    label: Key,
    limit: usize,
    read: fn(&BusinessProfile) -> &Option<String>,
    write: fn(&mut BusinessProfile, Option<String>),
}

const FIELDS: [TextSpec; 9] = [
    TextSpec {
        label: Key::BusinessCategory,
        limit: 80,
        read: |profile| &profile.category,
        write: |profile, value| profile.category = value,
    },
    TextSpec {
        label: Key::BusinessDescription,
        limit: 600,
        read: |profile| &profile.description,
        write: |profile, value| profile.description = value,
    },
    TextSpec {
        label: Key::BusinessAddress,
        limit: 240,
        read: |profile| &profile.address,
        write: |profile, value| profile.address = value,
    },
    TextSpec {
        label: Key::BusinessPhone,
        limit: 32,
        read: |profile| &profile.phone,
        write: |profile, value| profile.phone = value,
    },
    TextSpec {
        label: Key::BusinessEmail,
        limit: 254,
        read: |profile| &profile.email,
        write: |profile, value| profile.email = value,
    },
    TextSpec {
        label: Key::BusinessWebsite,
        limit: 500,
        read: |profile| &profile.website,
        write: |profile, value| profile.website = value,
    },
    TextSpec {
        label: Key::BusinessShop,
        limit: 500,
        read: |profile| &profile.shop,
        write: |profile, value| profile.shop = value,
    },
    TextSpec {
        label: Key::BusinessInstagram,
        limit: 500,
        read: |profile| &profile.instagram,
        write: |profile, value| profile.instagram = value,
    },
    TextSpec {
        label: Key::BusinessRules,
        limit: 400,
        read: |profile| &profile.rules,
        write: |profile, value| profile.rules = value,
    },
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
    hours: HoursEditor,
    had_opening_schedule: bool,
}

impl BusinessEditor {
    pub(super) fn new(profile: &BusinessProfile, cx: &mut Context<Root>) -> Self {
        let inputs = FIELDS.map(|field| {
            let value = (field.read)(profile);
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
            hours: HoursEditor::new(
                profile
                    .opening_schedule
                    .as_ref()
                    .unwrap_or(&OpeningSchedule::default()),
                cx,
            ),
            had_opening_schedule: profile.opening_schedule.is_some(),
        }
    }

    pub(super) fn draft(&self, cx: &App) -> Result<BusinessProfile, Key> {
        let mut profile = BusinessProfile {
            published: self.published,
            mobile_service: self.mobile_service,
            amenities: AMENITIES
                .iter()
                .zip(self.amenities)
                .filter_map(|((value, _), selected)| selected.then_some(*value))
                .collect(),
            ..BusinessProfile::default()
        };
        let hours = self.hours.draft(cx).ok_or(Key::OpeningInvalid)?;
        if self.had_opening_schedule || hours != OpeningSchedule::default() {
            profile.opening_schedule = Some(hours);
        }
        for (field, input) in FIELDS.iter().zip(&self.inputs) {
            let value = input.read(cx).text().trim();
            if value.is_empty() {
                continue;
            }
            let valid_format = match field.label {
                Key::BusinessPhone => valid_phone(value),
                Key::BusinessEmail => valid_email(value),
                Key::BusinessWebsite | Key::BusinessShop | Key::BusinessInstagram => {
                    url::Url::parse(value).is_ok_and(|url| {
                        url.scheme() == "https"
                            && url.host_str().is_some()
                            && url.username().is_empty()
                            && url.password().is_none()
                    })
                }
                _ => true,
            };
            if !valid_format
                || value.encode_utf16().count() > field.limit
                || value
                    .chars()
                    .any(|ch| ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}'))
            {
                return Err(field.label);
            }
            (field.write)(&mut profile, Some(value.to_owned()));
        }
        Ok(profile)
    }
}

fn valid_phone(value: &str) -> bool {
    value.bytes().filter(u8::is_ascii_digit).count() >= 6
        && value
            .strip_prefix('+')
            .unwrap_or(value)
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch.is_whitespace() || "().-".contains(ch))
}

// Mirrors the email format in the public profile contract so invalid edits are rejected offline.
fn valid_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    let Some((host, suffix)) = domain.rsplit_once('.') else {
        return false;
    };
    let valid_local = |byte: u8| byte.is_ascii_alphanumeric() || b"_'+-".contains(&byte);
    local
        .split('.')
        .all(|segment| !segment.is_empty() && segment.bytes().all(valid_local))
        && !local.ends_with('\'')
        && suffix.len() >= 2
        && suffix.bytes().all(|byte| byte.is_ascii_alphabetic())
        && host.split('.').all(|label| {
            label
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

impl Root {
    fn edit_business_profile(
        &mut self,
        cx: &mut Context<Self>,
        edit: impl FnOnce(&mut BusinessEditor, &mut Context<Self>),
    ) {
        if let Overlay::SalonConfiguration(desk) = &mut self.overlay
            && desk.editable()
            && let Some(profile) = desk
                .editor
                .as_mut()
                .and_then(|editor| editor.profile.as_mut())
        {
            edit(profile, cx);
            cx.notify();
        }
    }

    pub(super) fn render_business_profile(
        &self,
        editor: &BusinessEditor,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let invalid = editor.draft(cx).err();
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
            .children(FIELDS.iter().zip(&editor.inputs).map(|(field, input)| {
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().text_sm().child(self.t(field.label)))
                    .child(input.clone())
                    .when(invalid == Some(field.label), |row| {
                        row.child(
                            div()
                                .text_sm()
                                .text_color(theme::muted())
                                .child(self.t(Key::BusinessProfileInvalid)),
                        )
                    })
            }))
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
                                root.edit_business_profile(cx, |profile, _| {
                                    profile.amenities[index] = !profile.amenities[index]
                                })
                            }),
                        )
                    })),
            )
            .child(self.render_opening_hours(&editor.hours, cx))
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
                            root.edit_business_profile(cx, |profile, _| {
                                profile.mobile_service = !profile.mobile_service
                            })
                        }),
                    ))
                    .child(self.chip(
                        "business-publish",
                        self.t(Key::BusinessPublish),
                        editor.published,
                        cx.listener(|root, _, _, cx| {
                            root.edit_business_profile(cx, |profile, _| {
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
            let input = |label| profile.inputs[FIELDS.iter().position(|spec| spec.label == label).unwrap()].clone();
            input(Key::BusinessEmail).update(cx, |field, cx| field.set_text("a..b@example.com", cx));
            assert!(matches!(profile.draft(cx), Err(Key::BusinessEmail)));
            input(Key::BusinessEmail).update(cx, |field, cx| field.clear(cx));
            input(Key::BusinessWebsite).update(cx, |field, cx| field.set_text("javascript:alert(1)", cx));
            assert!(matches!(profile.draft(cx), Err(Key::BusinessWebsite)));
            input(Key::BusinessWebsite).update(cx, |field, cx| field.set_text("https://example.test", cx));
            input(Key::BusinessAddress).update(cx, |field, cx| field.set_text("9 Test Street", cx));
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
