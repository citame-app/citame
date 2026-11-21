use super::*;

mod controls;

const PAGE_SIZE: usize = 20;

pub(super) struct Directory {
    search: Entity<TextField>,
    _search: Subscription,
    page: usize,
    clients: Vec<Client>,
    form: Option<Form>,
    history: Vec<Appointment>,
    pub(super) intake: Option<intake_record::Desk>,
    controls: Option<controls::Desk>,
    error: Option<String>,
}

struct Form {
    previous: Option<Client>,
    name: Entity<TextField>,
    phone: Entity<TextField>,
    email: Entity<TextField>,
    notes: Entity<TextField>,
}

impl Directory {
    pub(super) fn has_controls(&self) -> bool {
        self.controls.is_some()
    }
}

fn phone_digits(value: &str) -> String {
    value.chars().filter(char::is_ascii_digit).collect()
}

fn matches_query(client: &Client, query: &str, digits: &str) -> bool {
    client.name.to_lowercase().contains(query)
        || client
            .email
            .as_ref()
            .is_some_and(|email| email.to_lowercase().contains(query))
        || client.phone.as_ref().is_some_and(|phone| {
            phone.contains(query) || (!digits.is_empty() && phone_digits(phone).contains(digits))
        })
}

impl Root {
    pub(super) fn directory_enabled(&self) -> bool {
        self.svc.store.client_directory_enabled().unwrap_or(false)
    }

    pub(super) fn open_directory(&mut self, cx: &mut Context<Self>) {
        if !self.directory_enabled() {
            return;
        }
        let search = cx.new(|cx| TextField::new(self.t(Key::DirectorySearch), false, cx));
        let subscription = cx.subscribe(&search, |this: &mut Root, _, event, cx| {
            if matches!(event, FieldEvent::Changed)
                && let Overlay::Directory(desk) = &mut this.overlay
            {
                desk.page = 0;
                cx.notify();
            }
        });
        self.overlay = Overlay::Directory(Box::new(Directory {
            search,
            _search: subscription,
            page: 0,
            clients: vec![],
            form: None,
            history: vec![],
            intake: None,
            controls: None,
            error: None,
        }));
        self.reload_directory();
        cx.notify();
    }

    pub(super) fn reload_directory(&mut self) {
        if !matches!(self.overlay, Overlay::Directory(_)) {
            return;
        }
        if !self.directory_enabled() {
            self.overlay = Overlay::None;
            return;
        }
        if let Overlay::Directory(desk) = &mut self.overlay {
            desk.clients = calendar::directory_clients(&self.svc.store).unwrap_or_default();
            if let Some(intake) = &mut desk.intake {
                intake.subject_visibility(&desk.clients);
            }
            if let Some(previous) = desk.form.as_ref().and_then(|form| form.previous.as_ref()) {
                if desk.clients.iter().all(|client| client.id != previous.id) {
                    desk.form = None;
                    desk.controls = None;
                    desk.history.clear();
                } else {
                    desk.history = self
                        .svc
                        .store
                        .client_history(&previous.id)
                        .unwrap_or_default();
                }
            }
        }
    }

    fn directory_form(&mut self, id: Option<&str>, cx: &mut Context<Self>) {
        let labels = [
            self.t(Key::ClientName),
            self.t(Key::ClientPhone),
            self.t(Key::Email),
            self.t(Key::DirectoryNotes),
        ];
        let Overlay::Directory(desk) = &mut self.overlay else {
            return;
        };
        let previous =
            id.and_then(|id| desk.clients.iter().find(|client| client.id == id).cloned());
        if id.is_some() && previous.is_none() {
            return;
        }
        let values = [
            previous.as_ref().map(|client| client.name.as_str()),
            previous.as_ref().and_then(|client| client.phone.as_deref()),
            previous.as_ref().and_then(|client| client.email.as_deref()),
            previous.as_ref().and_then(|client| client.notes.as_deref()),
        ];
        let [name, phone, email, notes] = std::array::from_fn(|i| {
            cx.new(|cx| {
                let mut field = TextField::new(labels[i], false, cx);
                field.set_text(values[i].unwrap_or_default(), cx);
                field
            })
        });
        desk.form = Some(Form {
            previous,
            name,
            phone,
            email,
            notes,
        });
        desk.error = None;
        desk.history = id
            .and_then(|id| self.svc.store.client_history(id).ok())
            .unwrap_or_default();
        cx.notify();
    }

    fn save_directory_client(&mut self, cx: &mut Context<Self>) {
        let Overlay::Directory(desk) = &mut self.overlay else {
            return;
        };
        let Some(form) = &desk.form else {
            return;
        };
        let name = form.name.read(cx).text();
        let phone = form.phone.read(cx).text();
        let notes = form.notes.read(cx).text();
        let result = if let Some(previous) = &form.previous {
            ops::update_directory_client(&mut self.svc.store, previous, name, phone, notes)
        } else {
            ops::create_directory_client(
                &mut self.svc.store,
                name,
                phone,
                form.email.read(cx).text(),
                notes,
            )
            .map(|_| ())
        };
        match result {
            Ok(()) => {
                desk.form = None;
                desk.error = None;
                desk.search.update(cx, |field, cx| field.clear(cx));
                self.edited(cx);
            }
            Err(error) => {
                desk.error = Some(error.to_string());
                cx.notify();
            }
        }
    }

    fn directory_button(
        &self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        kind: Kind,
        action: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Stateful<gpui::Div> {
        self.button(id, label, kind, action)
            .tab_index(0)
            .focus(|style| style.border_color(theme::text()))
    }

    fn directory_field(&self, label: Key, field: Entity<TextField>) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_1()
            .text_sm()
            .child(self.t(label))
            .child(field)
    }

    pub(super) fn render_directory(
        &self,
        desk: &Directory,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if let Some(record) = &desk.intake {
            return self.render_intake_record(record, viewport, cx);
        }
        if let Some(controls) = &desk.controls {
            return self.render_client_controls(controls, cx);
        }
        let title = |key| {
            div()
                .text_lg()
                .font_weight(FontWeight::SEMIBOLD)
                .child(self.t(key))
        };
        if let Some(form) = &desk.form {
            return self.modal(
                div().child(
                    div()
                        .id("directory-form")
                        .flex()
                        .flex_col()
                        .gap_3()
                        .overflow_y_scroll()
                        .child(title(if form.previous.is_some() {
                            Key::DirectoryEdit
                        } else {
                            Key::DirectoryCreate
                        }))
                        .child(self.directory_field(Key::ClientName, form.name.clone()))
                        .child(self.directory_field(Key::ClientPhone, form.phone.clone()))
                        .when(form.previous.is_none(), |d| {
                            d.child(self.directory_field(Key::Email, form.email.clone()))
                        })
                        .when_some(
                            form.previous.as_ref().and_then(|c| c.email.clone()),
                            |d, email| {
                                d.child(div().text_sm().text_color(theme::muted()).child(email))
                            },
                        )
                        .child(self.directory_field(Key::DirectoryNotes, form.notes.clone()))
                        .when_some(form.previous.as_ref(), |body, client| {
                            let subject = (client.id.clone(), client.name.clone());
                            body.child(self.directory_button(
                                "directory-intake",
                                self.t(Key::RecordHistory),
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    root.open_intake_record(subject.clone(), cx);
                                }),
                            ))
                            .when(
                                self.svc.store.client_is_synced(&client.id).unwrap_or(false),
                                |body| {
                                    body.child(self.directory_button(
                                        "directory-controls",
                                        self.t(Key::ClientControls),
                                        Kind::Ghost,
                                        cx.listener(|root, _, _, cx| root.open_client_controls(cx)),
                                    ))
                                },
                            )
                        })
                        .when_some(desk.error.as_ref(), |d, error| {
                            d.child(
                                div()
                                    .text_sm()
                                    .text_color(theme::conflict_fg())
                                    .child(error.clone()),
                            )
                        })
                        .child(
                            div()
                                .flex()
                                .gap_2()
                                .justify_end()
                                .child(self.directory_button(
                                    "directory-back",
                                    self.t(Key::Back),
                                    Kind::Ghost,
                                    cx.listener(|this, _, _, cx| {
                                        if let Overlay::Directory(desk) = &mut this.overlay {
                                            desk.form = None;
                                            desk.error = None;
                                        }
                                        cx.notify();
                                    }),
                                ))
                                .child(self.directory_button(
                                    "directory-save",
                                    self.t(Key::DirectorySave),
                                    Kind::Primary,
                                    cx.listener(|this, _, _, cx| this.save_directory_client(cx)),
                                )),
                        )
                        .when(form.previous.is_some(), |d| {
                            d.child(title(Key::DirectoryHistory))
                                .when(desk.history.is_empty(), |d| {
                                    d.child(
                                        div()
                                            .text_sm()
                                            .text_color(theme::muted())
                                            .child(self.t(Key::DirectoryNoVisits)),
                                    )
                                })
                                .children(desk.history.iter().map(|visit| {
                                    let id = visit.id.clone();
                                    let start = visit.starts_at;
                                    let names = visit
                                        .services
                                        .iter()
                                        .map(|service| service.name.as_str())
                                        .collect::<Vec<_>>();
                                    let caption = format!(
                                        "{} · {}",
                                        self.date_time_label(start),
                                        names.join(", ")
                                    );
                                    self.directory_button(
                                        SharedString::from(format!("directory-visit-{id}")),
                                        SharedString::from(caption),
                                        Kind::Ghost,
                                        cx.listener(move |this, _, _, cx| {
                                            this.calendar_mode = CalendarMode::Day;
                                            this.overview_staff.clear();
                                            this.pending_local_today = false;
                                            this.date = start.with_timezone(&this.tz).date_naive();
                                            this.reload(cx);
                                            this.open_details(&id, cx);
                                        }),
                                    )
                                }))
                        }),
                ),
            );
        }

        let query = desk.search.read(cx).text().trim().to_lowercase();
        let digits = if query
            .chars()
            .all(|ch| ch.is_ascii_digit() || "+-(). ".contains(ch))
        {
            phone_digits(&query)
        } else {
            String::new()
        };
        let filtered: Vec<_> = desk
            .clients
            .iter()
            .filter(|client| matches_query(client, &query, &digits))
            .collect();
        let pages = filtered.len().div_ceil(PAGE_SIZE).max(1);
        let page = desk.page.min(pages - 1);
        self.modal(
            div()
                .child(title(Key::ClientDirectory))
                .child(desk.search.clone())
                .when(filtered.is_empty(), |d| {
                    d.child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.t(Key::DirectoryEmpty)),
                    )
                })
                .child(
                    div()
                        .id("directory-results")
                        .max_h(px(390.))
                        .overflow_y_scroll()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .children(
                            filtered
                                .into_iter()
                                .skip(page * PAGE_SIZE)
                                .take(PAGE_SIZE)
                                .map(|client| {
                                    let id = client.id.clone();
                                    let contact = client
                                        .phone
                                        .iter()
                                        .chain(client.email.iter())
                                        .map(String::as_str)
                                        .collect::<Vec<_>>();
                                    div()
                                        .flex()
                                        .items_center()
                                        .justify_between()
                                        .gap_2()
                                        .child(
                                            div()
                                                .min_w_0()
                                                .flex_1()
                                                .truncate()
                                                .child(client.name.clone())
                                                .when(!contact.is_empty(), |d| {
                                                    d.child(
                                                        div()
                                                            .text_sm()
                                                            .truncate()
                                                            .text_color(theme::muted())
                                                            .child(contact.join(" · ")),
                                                    )
                                                }),
                                        )
                                        .child(self.directory_button(
                                            SharedString::from(format!("directory-edit-{id}")),
                                            self.t(Key::DirectoryEdit),
                                            Kind::Ghost,
                                            cx.listener(move |this, _, _, cx| {
                                                this.directory_form(Some(&id), cx)
                                            }),
                                        ))
                                }),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .justify_between()
                        .items_center()
                        .gap_2()
                        .child(
                            div()
                                .flex()
                                .gap_2()
                                .when(page > 0, |d| {
                                    d.child(self.directory_button(
                                        "directory-prev",
                                        self.t(Key::InboxPrevious),
                                        Kind::Ghost,
                                        cx.listener(move |this, _, _, cx| {
                                            this.directory_page(page - 1, cx)
                                        }),
                                    ))
                                })
                                .when(page + 1 < pages, |d| {
                                    d.child(self.directory_button(
                                        "directory-next",
                                        self.t(Key::InboxNext),
                                        Kind::Ghost,
                                        cx.listener(move |this, _, _, cx| {
                                            this.directory_page(page + 1, cx)
                                        }),
                                    ))
                                }),
                        )
                        .child(
                            div()
                                .flex()
                                .gap_2()
                                .child(self.directory_button(
                                    "directory-close",
                                    self.t(Key::Close),
                                    Kind::Ghost,
                                    cx.listener(|this, _, _, cx| {
                                        this.overlay = Overlay::None;
                                        cx.notify();
                                    }),
                                ))
                                .child(self.directory_button(
                                    "directory-create",
                                    self.t(Key::DirectoryCreate),
                                    Kind::Primary,
                                    cx.listener(|this, _, _, cx| this.directory_form(None, cx)),
                                )),
                        ),
                ),
        )
    }

    fn directory_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if let Overlay::Directory(desk) = &mut self.overlay {
            desk.page = page;
            cx.notify();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn local_directory_opens_synced_history_and_saves_a_new_contact(cx: &mut TestAppContext) {
        let (_dir, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                assert!(!root.directory_enabled());
                root.svc
                    .store
                    .set_meta("client_directory", "allowed")
                    .unwrap();
                root.open_directory(cx);
                let Overlay::Directory(desk) = &root.overlay else {
                    panic!("directory didn't open");
                };
                let contact_id = desk
                    .clients
                    .iter()
                    .find(|c| c.name == "Lucia")
                    .unwrap()
                    .id
                    .clone();
                root.directory_form(Some(&contact_id), cx);
                let Overlay::Directory(desk) = &root.overlay else {
                    panic!("contact didn't open");
                };
                assert_eq!(desk.history.len(), 1);
                root.directory_form(None, cx);
                let Overlay::Directory(desk) = &root.overlay else {
                    panic!("new contact didn't open");
                };
                desk.form.as_ref().unwrap().name.update(cx, |field, cx| {
                    field.set_text("Native test contact", cx);
                });
                root.save_directory_client(cx);
                assert!(
                    calendar::directory_clients(&root.svc.store)
                        .unwrap()
                        .iter()
                        .any(|contact| contact.name == "Native test contact")
                );
                root.svc
                    .store
                    .set_meta("client_directory", "denied")
                    .unwrap();
                root.reload_directory();
                assert!(matches!(root.overlay, Overlay::None));
            })
            .unwrap();
    }
}
