use super::*;

mod controls;

const PAGE_SIZE: usize = 20;

pub(super) struct Directory {
    search: Entity<TextField>,
    _search: Subscription,
    page: usize,
    contacts: calendar::ClientDirectory,
    group_filter: Option<String>,
    choosing_group: bool,
    form: Option<Form>,
    history: Vec<Appointment>,
    can_view_financial_reports: bool,
    financial_scope_request: Option<Arc<()>>,
    pub(super) sales_history: Option<transactions::History>,
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

    pub(super) fn close_group_picker(&mut self) -> bool {
        std::mem::take(&mut self.choosing_group)
    }
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
            contacts: calendar::ClientDirectory::default(),
            group_filter: None,
            choosing_group: false,
            form: None,
            history: vec![],
            can_view_financial_reports: false,
            financial_scope_request: None,
            sales_history: None,
            intake: None,
            controls: None,
            error: None,
        }));
        self.reload_directory();
        self.load_directory_financial_scope(cx);
        cx.notify();
    }

    pub(super) fn load_directory_financial_scope(&mut self, cx: &mut Context<Self>) {
        let Overlay::Directory(desk) = &mut self.overlay else {
            return;
        };
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let request = Arc::new(());
        desk.financial_scope_request = Some(request.clone());
        let session = self.svc.session.clone();
        cx.spawn(async move |root, cx| {
            let allowed = cx
                .background_executor()
                .spawn(async move {
                    // The accounting scope grants team-wide access only with financialReports.
                    transport
                        .commission_scope()
                        .map(|scope| scope.can_choose_staff)
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if Arc::ptr_eq(&session, &root.svc.session)
                    && let Overlay::Directory(desk) = &mut root.overlay
                    && desk
                        .financial_scope_request
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &request))
                {
                    desk.financial_scope_request = None;
                    desk.can_view_financial_reports = allowed.unwrap_or(false);
                    cx.notify();
                }
            });
        })
        .detach();
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
            desk.contacts = calendar::directory_clients(&self.svc.store).unwrap_or_default();
            if let Some(intake) = &mut desk.intake {
                intake.subject_visibility(&desk.contacts.clients);
            }
            if let Some(previous) = desk.form.as_ref().and_then(|form| form.previous.as_ref()) {
                if let Some(client) = desk.contacts.find(&previous.id) {
                    if let Some(history) = &mut desk.sales_history {
                        history.refresh_client(client);
                    }
                    desk.history = self
                        .svc
                        .store
                        .client_history(&previous.id)
                        .unwrap_or_default();
                } else {
                    desk.form = None;
                    desk.controls = None;
                    desk.sales_history = None;
                    desk.history.clear();
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
        let previous = id.and_then(|id| desk.contacts.find(id).cloned());
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
        desk.sales_history = None;
        desk.error = None;
        desk.history = id
            .and_then(|id| self.svc.store.client_history(id).ok())
            .unwrap_or_default();
        cx.notify();
    }

    fn open_client_transactions(&mut self, cx: &mut Context<Self>) {
        if !self.directory_enabled() {
            return;
        }
        let Overlay::Directory(desk) = &self.overlay else {
            return;
        };
        let Some(client) = desk.form.as_ref().and_then(|form| form.previous.as_ref()) else {
            return;
        };
        let Some(subject) = transactions::HistoryClient::from_profile(client) else {
            return;
        };
        if !self.svc.store.client_is_synced(&client.id).unwrap_or(false) {
            return;
        }
        let history = self.new_sales_history(Some(subject), cx);
        if let Overlay::Directory(desk) = &mut self.overlay {
            desk.sales_history = Some(history);
        }
        self.load_sales_history(transactions::HistoryLoad::ApplyFilters, cx);
        cx.notify();
    }

    fn open_directory_client_sales(&mut self, cx: &mut Context<Self>) {
        if !self.directory_enabled() {
            return;
        }
        let Overlay::Directory(desk) = &self.overlay else {
            return;
        };
        let Some(client) = desk.form.as_ref().and_then(|form| form.previous.as_ref()) else {
            return;
        };
        if !desk.can_view_financial_reports
            || !self.svc.store.client_is_synced(&client.id).unwrap_or(false)
        {
            return;
        }
        let client_id = client.id.clone();
        if let Overlay::Directory(directory) = std::mem::replace(&mut self.overlay, Overlay::None) {
            self.open_client_sales(client_id, directory, cx);
        }
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
            let email = previous.email_editable.then(|| form.email.read(cx).text());
            ops::update_directory_client(&mut self.svc.store, previous, name, phone, email, notes)
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
        if let Some(history) = &desk.sales_history {
            return self.render_sales_history(history, viewport, cx);
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
                        .when(
                            form.previous.as_ref().is_none_or(|c| c.email_editable),
                            |d| d.child(self.directory_field(Key::Email, form.email.clone())),
                        )
                        .when(
                            form.previous.as_ref().is_some_and(|c| c.email_editable),
                            |d| d.child(self.label(Key::DirectoryEmailHelp)),
                        )
                        .when_some(
                            form.previous
                                .as_ref()
                                .filter(|c| !c.email_editable)
                                .and_then(|c| c.email.clone()),
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
                                    .child(
                                        self.directory_button(
                                            "directory-transactions",
                                            self.t(Key::SalesHistory),
                                            Kind::Ghost,
                                            cx.listener(|root, _, _, cx| {
                                                root.open_client_transactions(cx)
                                            }),
                                        )
                                        .debug_selector(|| "directory-transactions".to_owned()),
                                    )
                                    .when(
                                        desk.can_view_financial_reports,
                                        |body| {
                                            body.child(
                                                self.directory_button(
                                                    "directory-client-sales",
                                                    self.t(Key::ClientSalesReport),
                                                    Kind::Ghost,
                                                    cx.listener(|root, _, _, cx| {
                                                        root.open_directory_client_sales(cx);
                                                    }),
                                                )
                                                .debug_selector(|| {
                                                    "directory-client-sales".to_owned()
                                                }),
                                            )
                                        },
                                    )
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

        if desk.choosing_group {
            return self.render_directory_groups(desk, cx);
        }
        let filtered = calendar::search_directory(
            &desk.contacts,
            desk.search.read(cx).text(),
            desk.group_filter.as_deref(),
        );
        let pages = filtered.len().div_ceil(PAGE_SIZE).max(1);
        let page = desk.page.min(pages - 1);
        self.modal(
            div()
                .child(title(Key::ClientDirectory))
                .child(desk.search.clone())
                .child(self.directory_button(
                    "directory-groups",
                    desk.group_filter.as_ref().map_or_else(
                        || self.t(Key::DirectoryGroups).to_owned(),
                        |group| format!("{} · {group}", self.t(Key::DirectoryGroups)),
                    ),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        if let Overlay::Directory(desk) = &mut root.overlay {
                            desk.choosing_group = true;
                            cx.notify();
                        }
                    }),
                ))
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

    fn select_directory_group(&mut self, group: Option<String>, cx: &mut Context<Self>) {
        if let Overlay::Directory(desk) = &mut self.overlay {
            desk.group_filter = group;
            desk.search.update(cx, |field, cx| field.set_text("", cx));
            desk.page = 0;
            desk.close_group_picker();
            cx.notify();
        }
    }

    fn render_directory_groups(&self, desk: &Directory, cx: &mut Context<Self>) -> gpui::Div {
        let groups = calendar::directory_groups(&desk.contacts.clients);
        let message = match &groups {
            None => Some(Key::DirectoryGroupsAwaitSync),
            Some(groups) if groups.is_empty() => Some(Key::DirectoryGroupsEmpty),
            Some(_) => None,
        };
        let group_choices = div()
            .id("directory-group-choices")
            .max_h(px(360.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_1()
            .child(self.directory_button(
                "directory-all-groups",
                self.t(Key::DirectoryAllGroups),
                if desk.group_filter.is_none() {
                    Kind::Primary
                } else {
                    Kind::Ghost
                },
                cx.listener(|root, _, _, cx| root.select_directory_group(None, cx)),
            ))
            .children(groups.into_iter().flatten().map(|(name, count)| {
                let group = name.to_owned();
                self.directory_button(
                    SharedString::from(format!("directory-group-{name}")),
                    format!("{name} · {count}"),
                    if desk.group_filter.as_deref() == Some(name) {
                        Kind::Primary
                    } else {
                        Kind::Ghost
                    },
                    cx.listener(move |root, _, _, cx| {
                        root.select_directory_group(Some(group.clone()), cx)
                    }),
                )
            }));
        self.modal(
            div()
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(self.t(Key::DirectoryGroups)),
                )
                .when_some(message, |body, message| {
                    body.child(div().text_sm().child(self.t(message)))
                })
                .child(group_choices)
                .child(div().flex().justify_end().child(self.directory_button(
                    "directory-groups-back",
                    self.t(Key::Back),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                ))),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    async fn client_transactions_keep_the_contact_draft_and_close_on_access_loss(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (entity, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(780.), px(860.)));
        let client_id = entity.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Offline;
            root.svc
                .store
                .set_meta("client_directory", "allowed")
                .unwrap();
            root.open_directory(cx);
            let Overlay::Directory(desk) = &root.overlay else {
                panic!("directory didn't open");
            };
            let id = desk
                .contacts
                .clients
                .iter()
                .find(|client| client.name == "Lucia")
                .unwrap()
                .id
                .clone();
            root.directory_form(Some(&id), cx);
            let Overlay::Directory(desk) = &root.overlay else {
                panic!("client didn't open");
            };
            desk.form.as_ref().unwrap().name.update(cx, |field, cx| {
                field.set_text("Unsubmitted client edit", cx);
            });
            id.parse::<uuid::Uuid>().unwrap()
        });
        cx.run_until_parked();
        let action = cx
            .debug_bounds("directory-transactions")
            .expect("transactions action");
        cx.simulate_click(action.center(), Default::default());
        cx.run_until_parked();
        entity.update(cx, |root, cx| {
            let history = root
                .overlay
                .sales_history_mut()
                .expect("client transactions");
            assert_eq!(history.client_id(), Some(client_id));
            history.receipt = Some(checkout::CheckoutReview::Failed);
            assert!(root.checkout_review_mut().is_some());
            root.dismiss_overlay(cx);
            assert!(root.overlay.sales_history().is_some());
            assert!(root.checkout_review_mut().is_none());
            root.dismiss_overlay(cx);
            let Overlay::Directory(desk) = &root.overlay else {
                panic!("didn't return to the client");
            };
            assert!(desk.sales_history.is_none());
            assert_eq!(
                desk.form.as_ref().unwrap().name.read(cx).text(),
                "Unsubmitted client edit"
            );
            root.open_client_transactions(cx);
            assert!(root.overlay.sales_history().is_some());
            root.svc
                .store
                .set_meta("client_directory", "denied")
                .unwrap();
            root.reload_directory();
            assert!(matches!(root.overlay, Overlay::None));
        });
    }
    use gpui::TestAppContext;

    #[gpui::test]
    async fn financial_access_opens_a_scoped_report_and_keeps_the_client_draft(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (entity, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(780.), px(860.)));
        entity.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Offline;
            root.svc
                .store
                .set_meta("client_directory", "allowed")
                .unwrap();
            root.open_directory(cx);
            let Overlay::Directory(desk) = &root.overlay else {
                panic!("missing directory");
            };
            let id = desk
                .contacts
                .clients
                .iter()
                .find(|client| client.name == "Lucia")
                .unwrap()
                .id
                .clone();
            root.directory_form(Some(&id), cx);
            root.open_directory_client_sales(cx);
            let Overlay::Directory(desk) = &mut root.overlay else {
                panic!("opened without financial access");
            };
            desk.can_view_financial_reports = true;
            desk.form.as_ref().unwrap().name.update(cx, |field, cx| {
                field.set_text("Unsubmitted client edit", cx);
            });
            cx.notify();
        });
        cx.run_until_parked();
        let action = cx
            .debug_bounds("directory-client-sales")
            .expect("client sales action");
        cx.simulate_click(action.center(), Default::default());
        cx.run_until_parked();
        entity.read_with(cx, |root, _| {
            assert!(matches!(root.overlay, Overlay::Reports(_)))
        });
        let back = cx
            .debug_bounds("reports-back-to-client")
            .expect("return to client action");
        cx.simulate_click(back.center(), Default::default());
        cx.run_until_parked();
        entity.read_with(cx, |root, cx| {
            let Overlay::Directory(desk) = &root.overlay else {
                panic!("missing client profile");
            };
            assert_eq!(
                desk.form.as_ref().unwrap().name.read(cx).text(),
                "Unsubmitted client edit"
            );
        });
    }

    #[gpui::test]
    async fn choosing_a_client_group_resets_the_search_and_page(cx: &mut TestAppContext) {
        let (_dir, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.svc
                    .store
                    .set_meta("client_directory", "allowed")
                    .unwrap();
                root.open_directory(cx);
                let Overlay::Directory(desk) = &mut root.overlay else {
                    panic!("directory didn't open");
                };
                desk.search
                    .update(cx, |field, cx| field.set_text("Old search", cx));
                desk.page = 3;
                desk.choosing_group = true;
                root.select_directory_group(Some("vip".into()), cx);
                let Overlay::Directory(desk) = &root.overlay else {
                    panic!("directory didn't return after selection");
                };
                assert_eq!(desk.group_filter.as_deref(), Some("vip"));
                assert_eq!(desk.page, 0);
                assert!(desk.search.read(cx).text().is_empty());
                assert!(!desk.choosing_group);
            })
            .unwrap();
    }

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
                    .contacts
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
                        .clients
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
