use super::*;
use sob_core::booking_links::{BookingLinks, PublicCatalog, Selection, qr_png};
use std::io::Write;
use uuid::Uuid;

const PAGE_SIZE: usize = 10;

pub(super) struct LinkDesk {
    identity: Arc<()>,
    catalog: Option<PublicCatalog>,
    selection: Selection,
    links: Option<BookingLinks>,
    qr: Option<(Arc<Vec<u8>>, Arc<gpui::Image>)>,
    building: bool,
    loading: bool,
    error: Option<Key>,
    notice: Option<Key>,
    search: Entity<TextField>,
    page: usize,
}

impl Root {
    pub(super) fn open_booking_links(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let session = self.svc.session.clone();
        let search_placeholder = self.t(Key::AssignmentSearch);
        let Some(desk) = self.marketing_desk().filter(|desk| !desk.busy) else {
            return;
        };
        let identity = Arc::new(());
        let search = cx.new(|cx| TextField::new(search_placeholder, false, cx));
        cx.subscribe(&search, |root, _, event, cx| {
            if matches!(event, FieldEvent::Changed)
                && let Some(view) = root.booking_links()
            {
                view.page = 0;
                cx.notify();
            }
        })
        .detach();
        desk.links = Some(LinkDesk {
            identity: identity.clone(),
            catalog: None,
            selection: Selection::default(),
            links: None,
            qr: None,
            building: false,
            loading: true,
            error: None,
            notice: None,
            search,
            page: 0,
        });
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.public_booking_catalog() })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let Some(view) = root
                    .booking_links()
                    .filter(|view| Arc::ptr_eq(&identity, &view.identity))
                else {
                    return;
                };
                view.loading = false;
                match result {
                    Ok(catalog) => {
                        view.catalog = Some(catalog);
                        root.update_booking_link(cx);
                    }
                    Err(_) => view.error = Some(Key::BookingLinkLoadFailed),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn booking_links(&mut self) -> Option<&mut LinkDesk> {
        self.marketing_desk()?.links.as_mut()
    }

    fn update_booking_link(&mut self, cx: &mut Context<Self>) {
        let origin = self.svc.config.network_origin();
        let Some(view) = self.booking_links() else {
            return;
        };
        view.links = view
            .catalog
            .as_ref()
            .and_then(|catalog| view.selection.links(&origin, catalog));
        view.qr = None;
        view.building = false;
        view.notice = None;
        view.error = None;
        let Some(link) = view.links.as_ref().map(|links| links.book.clone()) else {
            cx.notify();
            return;
        };
        let identity = view.identity.clone();
        view.building = true;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let request = link.clone();
            let result = cx
                .background_executor()
                .spawn(async move { qr_png(&request) })
                .await;
            let _ = root.update(cx, |root, cx| {
                let Some(view) = root.booking_links().filter(|view| {
                    Arc::ptr_eq(&identity, &view.identity)
                        && view.links.as_ref().is_some_and(|links| links.book == link)
                }) else {
                    return;
                };
                view.building = false;
                if let Some(bytes) = result {
                    let image = Arc::new(gpui::Image::from_bytes(
                        gpui::ImageFormat::Png,
                        bytes.clone(),
                    ));
                    view.qr = Some((Arc::new(bytes), image));
                } else {
                    view.error = Some(Key::BookingLinkQrFailed);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn set_booking_treatment(&mut self, service: Uuid, base: Option<Uuid>, cx: &mut Context<Self>) {
        let Some(view) = self.booking_links() else {
            return;
        };
        let Some(catalog) = &view.catalog else {
            return;
        };
        if view.selection.toggle(catalog, service, base) {
            self.update_booking_link(cx);
        } else {
            view.notice = Some(Key::BookingLinkLimit);
            cx.notify();
        }
    }

    fn set_booking_professional(&mut self, staff: Option<Uuid>, cx: &mut Context<Self>) {
        let Some(view) = self.booking_links() else {
            return;
        };
        view.selection.staff = staff;
        self.update_booking_link(cx);
    }

    fn save_booking_qr(&mut self, cx: &mut Context<Self>) {
        let Some(view) = self.booking_links() else {
            return;
        };
        let Some((bytes, _)) = &view.qr else {
            return;
        };
        let identity = view.identity.clone();
        let bytes = bytes.clone();
        let directory = std::env::home_dir().unwrap_or_else(|| "/".into());
        let picker = cx.prompt_for_new_path(&directory, Some("citame-booking-qr.png"));
        cx.spawn(async move |root, cx| {
            let notice = match picker.await {
                Ok(Ok(Some(path))) => {
                    let current = root
                        .update(cx, |root, _| {
                            root.booking_links().is_some_and(|view| {
                                Arc::ptr_eq(&identity, &view.identity)
                                    && view
                                        .qr
                                        .as_ref()
                                        .is_some_and(|(qr, _)| Arc::ptr_eq(qr, &bytes))
                            })
                        })
                        .unwrap_or(false);
                    if !current {
                        return;
                    }
                    Some(
                        if cx
                            .background_executor()
                            .spawn(async move {
                                sob_core::csv_file::save(&path, |file| file.write_all(&bytes))
                            })
                            .await
                            .is_ok()
                        {
                            Key::BookingLinkQrSaved
                        } else {
                            Key::BookingLinkQrSaveFailed
                        },
                    )
                }
                Ok(Ok(None)) => None,
                _ => Some(Key::BookingLinkQrSaveFailed),
            };
            let _ = root.update(cx, |root, cx| {
                if let Some(view) = root
                    .booking_links()
                    .filter(|view| Arc::ptr_eq(&identity, &view.identity))
                {
                    view.notice = notice;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(super) fn render_booking_links(
        &self,
        view: &LinkDesk,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.label(Key::BookingLinkTitle))
            .when(view.loading, |body| {
                body.child(self.t(Key::MarketingLoading))
            })
            .when_some(view.error, |body, error| {
                body.child(div().text_color(theme::conflict_fg()).child(self.t(error)))
            })
            .when_some(view.notice, |body, notice| {
                body.child(div().text_color(theme::muted()).child(self.t(notice)))
            })
            .when(!view.loading && view.catalog.is_none() && ready, |body| {
                body.child(self.marketing_button(
                    "reload-booking-catalog",
                    Key::CatalogReload,
                    Kind::Ghost,
                    Root::open_booking_links,
                    cx,
                ))
            });
        let Some(catalog) = &view.catalog else {
            return body;
        };
        let active: Vec<_> = view.selection.eligible(catalog).collect();
        let selected: Vec<_> = view.selection.treatments().collect();
        let filter = view.search.read(cx).text().trim().to_lowercase();
        let matching: Vec<_> = catalog
            .services
            .iter()
            .filter(|service| {
                !service.is_extra()
                    && (filter.is_empty()
                        || service.name.to_lowercase().contains(&filter)
                        || service
                            .category
                            .as_ref()
                            .is_some_and(|category| category.to_lowercase().contains(&filter)))
            })
            .collect();
        body.child(
            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(self.label(Key::BookingLinkTreatments))
                .child(view.search.clone())
                .children(
                    matching
                        .iter()
                        .skip(view.page * PAGE_SIZE)
                        .take(PAGE_SIZE)
                        .map(|service| {
                            self.booking_link_chip(
                                SharedString::from(format!("public-treatment-{}", service.id)),
                                service.name.clone(),
                                selected.contains(&service.id),
                                {
                                    let id = service.id;
                                    move |root, cx| root.set_booking_treatment(id, None, cx)
                                },
                                cx,
                            )
                        }),
                )
                .when(
                    view.page > 0 || matching.len() > (view.page + 1) * PAGE_SIZE,
                    |body| {
                        body.child(
                            div()
                                .flex()
                                .gap_2()
                                .when(view.page > 0, |row| {
                                    row.child(self.link_page_button(false, cx))
                                })
                                .when(matching.len() > (view.page + 1) * PAGE_SIZE, |row| {
                                    row.child(self.link_page_button(true, cx))
                                }),
                        )
                    },
                ),
        )
        .when(!selected.is_empty(), |body| {
            body.child(self.label(Key::BookingLinkSelected))
                .children(
                    view.selection
                        .bases()
                        .filter_map(|id| catalog.services.iter().find(|service| service.id == id))
                        .map(|base| {
                            div()
                                .flex()
                                .flex_col()
                                .gap_1()
                                .child(self.booking_link_chip(
                                    SharedString::from(format!("selected-treatment-{}", base.id)),
                                    base.name.clone(),
                                    true,
                                    {
                                        let id = base.id;
                                        move |root, cx| root.set_booking_treatment(id, None, cx)
                                    },
                                    cx,
                                ))
                                .children(
                                    catalog
                                        .services
                                        .iter()
                                        .filter(|extra| {
                                            extra.is_extra()
                                                && view
                                                    .selection
                                                    .compatible_bases(catalog, extra)
                                                    .contains(&base.id)
                                                && (!selected.contains(&extra.id)
                                                    || view
                                                        .selection
                                                        .extras(base.id)
                                                        .contains(&extra.id))
                                        })
                                        .map(|extra| {
                                            let id = extra.id;
                                            let base_id = base.id;
                                            self.booking_link_chip(
                                                SharedString::from(format!("extra-{base_id}-{id}")),
                                                extra.name.clone(),
                                                selected.contains(&id),
                                                move |root, cx| {
                                                    root.set_booking_treatment(
                                                        id,
                                                        Some(base_id),
                                                        cx,
                                                    )
                                                },
                                                cx,
                                            )
                                        }),
                                )
                        }),
                )
                .child(self.marketing_button(
                    "clear-booking-link",
                    Key::BookingLinkClear,
                    Kind::Ghost,
                    |root, cx| {
                        if let Some(view) = root.booking_links() {
                            view.selection = Selection::default();
                            root.update_booking_link(cx);
                        }
                    },
                    cx,
                ))
                .child(self.label(Key::BookingLinkProfessional))
                .child(self.booking_link_chip(
                    "booking-link-any",
                    self.t(Key::BookingLinkAny),
                    view.selection.staff.is_none(),
                    |root, cx| root.set_booking_professional(None, cx),
                    cx,
                ))
                .children(active.iter().map(|staff| {
                    let id = staff.id;
                    self.booking_link_chip(
                        SharedString::from(format!("booking-link-staff-{id}")),
                        staff.display_name.clone(),
                        view.selection.staff == Some(id),
                        move |root, cx| root.set_booking_professional(Some(id), cx),
                        cx,
                    )
                }))
                .when(active.is_empty() || view.links.is_none(), |body| {
                    body.child(div().text_color(theme::conflict_fg()).child(self.t(
                        if active.is_empty() {
                            Key::BookingLinkNoProfessional
                        } else {
                            Key::BookingLinkStaffChanged
                        },
                    )))
                })
        })
        .when_some(view.links.as_ref().filter(|_| ready), |body, links| {
            body.child(self.render_booking_link_output(view, links, cx))
        })
    }

    fn booking_link_chip(
        &self,
        id: impl Into<ElementId>,
        text: impl Into<SharedString>,
        selected: bool,
        action: impl Fn(&mut Root, &mut Context<Root>) + 'static,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        self.chip(
            id,
            text,
            selected,
            cx.listener(move |root, _, _, cx| action(root, cx)),
        )
        .tab_index(0)
        .focus(|style| style.border_color(theme::text()))
    }

    fn link_page_button(&self, next: bool, cx: &mut Context<Self>) -> Stateful<gpui::Div> {
        self.marketing_button(
            if next {
                "booking-link-next"
            } else {
                "booking-link-prev"
            },
            if next {
                Key::MarketingNextPage
            } else {
                Key::MarketingPreviousPage
            },
            Kind::Ghost,
            move |root, cx| {
                if let Some(view) = root.booking_links() {
                    view.page = if next {
                        view.page + 1
                    } else {
                        view.page.saturating_sub(1)
                    };
                    cx.notify();
                }
            },
            cx,
        )
    }

    fn render_booking_link_output(
        &self,
        view: &LinkDesk,
        links: &BookingLinks,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let urls = [
            (Key::BookingLinkOpen, links.book.to_string()),
            (Key::BookingLinkWhatsapp, links.share_url(true).to_string()),
            (Key::BookingLinkFacebook, links.share_url(false).to_string()),
            (Key::BookingLinkWidgetPreview, links.widget.to_string()),
        ];
        div()
            .border_1()
            .border_color(theme::line())
            .rounded_lg()
            .p_3()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.label(Key::BookingLinkPublic))
            .child(div().text_sm().child(links.book.to_string()))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.copy_booking_link(
                        "copy-direct-link",
                        Key::BookingLinkCopy,
                        links.book.to_string(),
                        cx,
                    ))
                    .children(urls.into_iter().enumerate().map(|(index, (label, url))| {
                        self.marketing_button(
                            ("open-booking-link", index),
                            label,
                            Kind::Ghost,
                            move |_, cx| cx.open_url(&url),
                            cx,
                        )
                    }))
                    .child(self.copy_booking_link(
                        "copy-widget-code",
                        Key::BookingLinkCopyWidget,
                        links.snippet.clone(),
                        cx,
                    )),
            )
            .when(view.building, |body| {
                body.child(self.t(Key::MarketingLoading))
            })
            .when_some(view.qr.as_ref(), |body, (_, image)| {
                body.child(gpui::img(image.clone()).w(px(236.)).h(px(236.)))
                    .child(self.marketing_button(
                        "save-booking-qr",
                        Key::BookingLinkSaveQr,
                        Kind::Ghost,
                        Root::save_booking_qr,
                        cx,
                    ))
            })
            .when(view.error == Some(Key::BookingLinkQrFailed), |body| {
                body.child(self.marketing_button(
                    "retry-booking-qr",
                    Key::InboxRefresh,
                    Kind::Ghost,
                    Root::update_booking_link,
                    cx,
                ))
            })
    }

    fn copy_booking_link(
        &self,
        id: &'static str,
        key: Key,
        value: String,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        self.marketing_button(
            id,
            key,
            Kind::Primary,
            move |root, cx| {
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(value.clone()));
                if let Some(view) = root.booking_links() {
                    view.notice = Some(Key::BookingLinkCopied);
                    cx.notify();
                }
            },
            cx,
        )
    }
}
