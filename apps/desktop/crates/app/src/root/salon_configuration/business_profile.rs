use super::*;
use sob_core::http::{BusinessAmenity, BusinessProfile, OpeningSchedule};
use std::{cell::Cell, rc::Rc};

mod opening_hours;
use opening_hours::HoursEditor;

struct TextSpec {
    label: Key,
    limit: usize,
    read: fn(&BusinessProfile) -> &Option<String>,
    write: fn(&mut BusinessProfile, Option<String>),
}

const FIELDS: [TextSpec; 8] = [
    TextSpec {
        label: Key::BusinessCategory,
        limit: 80,
        read: |profile| &profile.category,
        write: |profile, value| profile.category = value,
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

const DESCRIPTION_LIMIT: usize = 2_000;
const DESCRIPTION_LINES: usize = 64;

fn valid_description_text(value: &str) -> bool {
    !value
        .chars()
        .any(|ch| ch != '\n' && (ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}')))
}

fn description_within_bounds(value: &str) -> bool {
    value.split('\n').count() <= DESCRIPTION_LINES
        && value.encode_utf16().count() <= DESCRIPTION_LIMIT
        && valid_description_text(value)
}

struct DescriptionLine {
    input: Entity<TextField>,
    _events: Subscription,
}

struct DescriptionEditor {
    lines: Vec<DescriptionLine>,
    remaining: Rc<Cell<usize>>,
    paste_rejected: bool,
}

impl DescriptionEditor {
    fn new(value: &str, cx: &mut Context<Root>) -> Self {
        let remaining = Rc::new(Cell::new(
            DESCRIPTION_LINES.saturating_sub(value.split('\n').count()),
        ));
        Self {
            lines: value
                .split('\n')
                .map(|line| description_line(line, remaining.clone(), cx))
                .collect(),
            remaining,
            paste_rejected: false,
        }
    }

    fn draft(&self, cx: &App) -> Result<Option<String>, Key> {
        let value = self
            .lines
            .iter()
            .map(|line| line.input.read(cx).text())
            .collect::<Vec<_>>()
            .join("\n");
        if !description_within_bounds(&value) {
            return Err(Key::BusinessDescription);
        }
        let value = value.trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}');
        Ok((!value.is_empty()).then(|| value.to_owned()))
    }

    fn paste_all(&mut self, text: &str, cx: &mut Context<Root>) {
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        if !description_within_bounds(&normalized) {
            self.paste_rejected = true;
            return;
        }
        *self = Self::new(&normalized, cx);
    }

    fn add_line(&mut self, cx: &mut Context<Root>) {
        if let Some(next) = self.remaining.get().checked_sub(1) {
            self.remaining.set(next);
            self.lines
                .push(description_line("", self.remaining.clone(), cx));
            self.paste_rejected = false;
        }
    }

    fn remove_line(&mut self, index: usize) {
        if self.lines.len() > 1 && index < self.lines.len() {
            self.lines.remove(index);
            self.remaining
                .set(DESCRIPTION_LINES.saturating_sub(self.lines.len()));
            self.paste_rejected = false;
        }
    }
}

fn description_line(
    value: &str,
    remaining: Rc<Cell<usize>>,
    cx: &mut Context<Root>,
) -> DescriptionLine {
    let input = cx.new(|cx| {
        let mut input = TextField::new("", false, cx).with_validated_bounded_line_paste(
            DESCRIPTION_LIMIT,
            remaining,
            valid_description_text,
        );
        input.set_text(value, cx);
        input
    });
    cx.observe(&input, |_, _, cx| cx.notify()).detach();
    let events = cx.subscribe(&input, |root, origin, event, cx| {
        root.edit_business_profile(cx, |editor, cx| {
            let description = &mut editor.description;
            let Some(index) = description
                .lines
                .iter()
                .position(|line| line.input == origin)
            else {
                return;
            };
            match event {
                FieldEvent::PasteLines(tail) => {
                    let remaining = description.remaining.clone();
                    description.lines.splice(
                        index + 1..index + 1,
                        tail.iter()
                            .map(|value| description_line(value, remaining.clone(), cx)),
                    );
                    description.paste_rejected = false;
                }
                FieldEvent::PasteTooLong | FieldEvent::InvalidPaste => {
                    description.paste_rejected = true
                }
                FieldEvent::Changed => description.paste_rejected = false,
                FieldEvent::Submit => {}
            }
        });
    });
    DescriptionLine {
        input,
        _events: events,
    }
}

pub(super) struct BusinessEditor {
    inputs: [Entity<TextField>; FIELDS.len()],
    description: DescriptionEditor,
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
            description: DescriptionEditor::new(
                profile.description.as_deref().unwrap_or_default(),
                cx,
            ),
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
            description: self.description.draft(cx)?,
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
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().text_sm().child(self.t(Key::BusinessDescription)))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .when(editor.description.remaining.get() > 0, |row| {
                                row.child(self.button(
                                    "business-description-add",
                                    self.t(Key::BusinessDescriptionAddLine),
                                    Kind::Ghost,
                                    cx.listener(|root, _, _, cx| {
                                        root.edit_business_profile(cx, |profile, cx| {
                                            profile.description.add_line(cx)
                                        });
                                    }),
                                ))
                            })
                            .child(self.button(
                                "business-description-paste-all",
                                self.t(Key::BusinessDescriptionPasteAll),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| {
                                    if let Some(text) =
                                        cx.read_from_clipboard().and_then(|item| item.text())
                                    {
                                        root.edit_business_profile(cx, |profile, cx| {
                                            profile.description.paste_all(&text, cx)
                                        });
                                    }
                                }),
                            )),
                    )
                    .children(
                        editor
                            .description
                            .lines
                            .iter()
                            .enumerate()
                            .map(|(index, line)| {
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .child(div().flex_1().min_w(px(0.)).child(line.input.clone()))
                                    .when(editor.description.lines.len() > 1, |row| {
                                        row.child(self.button(
                                            ("business-description-remove", index),
                                            self.t(Key::BusinessDescriptionRemoveLine),
                                            Kind::Ghost,
                                            cx.listener(move |root, _, _, cx| {
                                                root.edit_business_profile(cx, |profile, _| {
                                                    profile.description.remove_line(index)
                                                });
                                            }),
                                        ))
                                    })
                            }),
                    )
                    .when(
                        invalid == Some(Key::BusinessDescription)
                            || editor.description.paste_rejected,
                        |row| {
                            row.child(
                                div()
                                    .text_sm()
                                    .text_color(theme::muted())
                                    .child(self.t(Key::BusinessProfileInvalid)),
                            )
                        },
                    ),
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
        window
            .update(cx, |root, native_window, cx| {
                let saved: ReviewedSalonConfiguration = serde_json::from_value(serde_json::json!({
                    "name": "Studio", "timezone": "Europe/Madrid", "slotGranularityMinutes": 15,
                    "minNoticeMinutes": 30, "maxDaysAhead": 60, "onlineBookingEnabled": true,
                    "reminderFirstLeadMinutes": null, "reminderSecondLeadMinutes": null,
                    "businessProfile": BusinessProfile::default(),
                    "revision": "2026-11-21T00:00:00Z", "generation": "initial",
                }))
                .unwrap();
                root.svc.store.cache_salon_configuration(&saved).unwrap();
                root.status.connectivity = Connectivity::Offline;
                root.open_salon_configuration(cx);
                let Overlay::SalonConfiguration(desk) = &mut root.overlay else {
                    panic!("Missing editor")
                };
                assert!(desk.editable());
                let editor = desk.editor.as_mut().unwrap();
                editor.show_profile = true;
                let profile = editor.profile.as_mut().unwrap();
                profile.description.lines[0]
                    .input
                    .read(cx)
                    .focus(native_window);
            })
            .unwrap();
        cx.run_until_parked();
        cx.write_to_clipboard(gpui::ClipboardItem::new_string("A\0B\nC".into()));
        cx.simulate_keystrokes(window.into(), "ctrl-v");
        cx.run_until_parked();
        window
            .update(cx, |root, _, cx| {
                let Overlay::SalonConfiguration(desk) = &mut root.overlay else {
                    panic!("Missing editor")
                };
                let profile = desk.editor.as_mut().unwrap().profile.as_mut().unwrap();
                assert!(profile.description.paste_rejected);
                assert!(profile.description.draft(cx).unwrap().is_none());
            })
            .unwrap();
        let description = format!("{}\n\n{}", "a".repeat(720), "b".repeat(720));
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(
            description.replace('\n', "\r\n"),
        ));
        cx.simulate_keystrokes(window.into(), "ctrl-v");
        cx.run_until_parked();
        window.update(cx, |root, _, cx| {
            let Overlay::SalonConfiguration(desk) = &mut root.overlay else { panic!("Missing editor") };
            let profile = desk.editor.as_mut().unwrap().profile.as_mut().unwrap();
            assert!(!profile.description.paste_rejected);
            assert_eq!(profile.description.lines.len(), 3);
            profile.description.paste_all(&"line\n".repeat(64), cx);
            assert!(profile.description.paste_rejected);
            assert_eq!(profile.description.draft(cx).unwrap().as_deref(), Some(description.as_str()));
            profile.description.paste_all(&format!("{}line", "line\n".repeat(63)), cx);
            assert_eq!(profile.description.remaining.get(), 0);
            profile.description.remove_line(0);
            assert_eq!(profile.description.remaining.get(), 1);
            profile.description.add_line(cx);
            assert_eq!(profile.description.remaining.get(), 0);
            profile.description.paste_all(&description, cx);
            assert_eq!(profile.description.lines.len(), 3);
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
                "businessProfile": {"address": "9 Test Street", "website": "https://example.test", "description": description}
            }));
        }).unwrap();
    }
}
