use super::orders::order_status_key;
use super::*;

impl Root {
    fn document_field(&self, label: Key, field: &Entity<TextField>) -> gpui::Div {
        div()
            .min_w(px(180.))
            .flex_1()
            .child(self.label(label))
            .child(field.clone())
    }

    pub(in crate::root::inventory) fn render_inventory_documents(
        &self,
        panel: &Panel,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let writable = self.svc.store.can_queue_product_edits();
        let busy = panel.request.is_some();
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(panel.tab.title())),
            )
            .when_some(panel.notice, |body, notice| {
                body.child(div().text_sm().child(self.t(notice)))
            })
            .when(busy, |body| body.child(self.t(Key::InventoryLoading)));
        if panel.confirm_discard {
            return body.child(self.t(Key::ReviewDiscardConfirm)).child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.button(
                        "document-keep",
                        self.t(Key::ReviewKeepEditing),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                    ))
                    .child(self.button(
                        "document-discard-draft",
                        self.t(Key::ReviewDiscard),
                        Kind::Danger,
                        cx.listener(|root, _, _, cx| root.close_inventory_document_editor(cx)),
                    )),
            );
        }
        if let Some(editor) = &panel.editor {
            if !writable {
                return body.child(self.t(Key::InventoryRestricted));
            }
            return body.child(match editor {
                Editor::Supplier(form) => self.render_supplier_editor(form, online, busy, cx),
                Editor::Receipt(form) => {
                    self.render_receipt_editor(form, panel.order.as_ref(), online, busy, cx)
                }
            });
        }
        if let Some(receipt) = &panel.detail {
            return body.child(if online || writable {
                self.render_receipt_detail(receipt, online, cx)
            } else {
                div().child(self.t(Key::InventoryRestricted))
            });
        }
        if let Some(order) = &panel.order {
            return body.child(if online || self.svc.store.can_read_cached_orders() {
                self.render_order_detail(panel, order, writable, busy, cx)
            } else {
                div().child(self.t(Key::InventoryRestricted))
            });
        }
        if let Some((_, draft)) = &panel.order_conflict {
            let id = draft.id;
            return body
                .child(self.t(Key::InventoryDocumentChanged))
                .child(self.button(
                    "order-conflict-back",
                    self.t(Key::Back),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                ))
                .when(online && !busy, |body| {
                    body.child(self.button(
                        "order-conflict-review",
                        self.t(Key::InventoryDocumentReview),
                        Kind::Primary,
                        cx.listener(move |root, _, _, cx| root.open_order(id, cx)),
                    ))
                });
        }
        let cached = self.svc.store.cached_suppliers().unwrap_or_default();
        let pending = self
            .svc
            .store
            .pending_inventory_documents()
            .unwrap_or_default();
        let controls = div()
            .flex()
            .flex_wrap()
            .gap_2()
            .items_center()
            .child(self.button(
                "documents-back",
                self.t(Key::InventoryDocumentBack),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
            ))
            .when(online && !busy, |row| {
                row.child(self.button(
                    "documents-reload",
                    self.t(Key::InventoryRefresh),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        let Some(page) = root.document_panel().map(|panel| panel.page) else {
                            return;
                        };
                        root.load_document_list(page, cx);
                    }),
                ))
            })
            .when(writable && !busy, |row| {
                row.child(match panel.tab {
                    Tab::Suppliers => self.button(
                        "supplier-new",
                        self.t(Key::InventorySupplierNew),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| {
                            root.edit_inventory_supplier(Supplier::new(), None, cx)
                        }),
                    ),
                    Tab::Orders => self.button(
                        "order-new",
                        self.t(Key::InventoryOrderNew),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.edit_order(None, cx)),
                    ),
                    Tab::Receipts => self.button(
                        "receipt-new",
                        self.t(Key::InventoryReceiptNew),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.edit_inventory_receipt(None, cx)),
                    ),
                })
            });
        let body = body
            .child(controls)
            .children(pending.iter().filter_map(|entry| {
                let label = match (panel.tab, entry) {
                    (Tab::Suppliers, DocumentProposal::Supplier(row)) => row.fields.name.clone(),
                    (Tab::Orders, DocumentProposal::PurchaseOrder(row)) => match &row.action {
                        PurchaseOrderAction::Save(fields) => fields
                            .supplier_reference
                            .clone()
                            .unwrap_or_else(|| self.t(Key::InventoryOrderDraft).into()),
                        PurchaseOrderAction::Order => self.t(Key::InventoryOrderPlace).into(),
                        PurchaseOrderAction::Cancel => self.t(Key::InventoryOrderCancel).into(),
                    },
                    (Tab::Orders, DocumentProposal::Receipt(row))
                        if row.purchase_order.is_some() =>
                    {
                        format!(
                            "{} · {}",
                            row.received_on,
                            self.t(Key::InventoryOrderReceive)
                        )
                    }
                    (Tab::Receipts, DocumentProposal::Receipt(row))
                        if row.purchase_order.is_none() =>
                    {
                        format!(
                            "{} · {} · {}",
                            row.received_on,
                            row.invoice_reference.as_deref().unwrap_or(""),
                            row.lines.len()
                        )
                    }
                    _ => return None,
                };
                Some(div().p_2().bg(theme::panel()).child(format!(
                    "{} · {label}",
                    self.t(Key::InventoryDocumentQueued)
                )))
            }));
        match panel.tab {
            Tab::Orders => body.child(self.render_order_list(panel, online, busy, cx)),
            Tab::Suppliers => {
                let term = panel.search.read(cx).text().trim().to_lowercase();
                let rows: Vec<_> = match (&panel.view, online) {
                    (Some(View::Suppliers(page)), true) => page.suppliers.iter().collect(),
                    _ => cached
                        .iter()
                        .filter(|row| {
                            panel
                                .supplier_filter
                                .is_none_or(|active| row.fields.active == active)
                        })
                        .filter(|row| row.matches_search(&term))
                        .collect(),
                };
                let filters = div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .items_center()
                    .child(div().flex_1().min_w(px(160.)).child(panel.search.clone()))
                    .when(online && !busy, |row| {
                        row.child(self.button(
                            "supplier-search",
                            self.t(Key::InventoryFind),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.load_document_list(1, cx)),
                        ))
                    })
                    .when(!busy, |row| {
                        row.children(
                            [
                                (None, Key::InventorySuppliersAll),
                                (Some(true), Key::InventorySupplierActive),
                                (Some(false), Key::InventorySupplierArchived),
                            ]
                            .into_iter()
                            .map(|(active, label)| {
                                self.button(
                                    ("supplier-filter", label as usize),
                                    self.t(label),
                                    if panel.supplier_filter == active {
                                        Kind::Primary
                                    } else {
                                        Kind::Ghost
                                    },
                                    cx.listener(move |root, _, _, cx| {
                                        if let Some(panel) = root.document_panel() {
                                            panel.supplier_filter = active;
                                        }
                                        root.load_document_list(1, cx);
                                    }),
                                )
                            }),
                        )
                    });
                let blank = rows.is_empty() && !busy;
                body.child(filters)
                    .when(blank, |body| {
                        body.child(self.t(Key::InventorySuppliersEmpty))
                    })
                    .children(rows.into_iter().map(|row| {
                        let supplier = row.clone();
                        let enabled =
                            writable && !busy && !pending.iter().any(|entry| entry.id() == row.id);
                        div()
                            .flex()
                            .flex_wrap()
                            .justify_between()
                            .items_center()
                            .gap_2()
                            .py_2()
                            .border_b_1()
                            .border_color(theme::line())
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .child(row.fields.name.clone())
                                    .child(div().text_sm().child(
                                        row.fields.email.as_deref().unwrap_or("").to_owned(),
                                    ))
                                    .when(!row.fields.active, |body| {
                                        body.child(self.t(Key::InventorySupplierArchived))
                                    }),
                            )
                            .when(enabled, |item| {
                                item.child(self.button(
                                    SharedString::from(format!("supplier-{}", row.id)),
                                    self.t(Key::InventorySupplierEdit),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        root.edit_inventory_supplier(supplier.clone(), None, cx)
                                    }),
                                ))
                            })
                    }))
                    .when(online && !busy && panel.view.is_some(), |body| {
                        body.child(self.document_pager(
                            panel.view.as_ref().unwrap().page(),
                            None,
                            cx,
                        ))
                    })
            }
            Tab::Receipts => {
                let receipts = match &panel.view {
                    Some(View::Receipts(page)) if online || writable => page.receipts.as_slice(),
                    _ => &[],
                };
                body.when(receipts.is_empty() && !busy, |body| {
                    body.child(self.t(Key::InventoryReceiptsEmpty))
                })
                .children(receipts.iter().map(|row| {
                    let id = row.id;
                    div()
                        .flex()
                        .flex_wrap()
                        .justify_between()
                        .items_center()
                        .gap_2()
                        .py_2()
                        .border_b_1()
                        .border_color(theme::line())
                        .child(format!(
                            "#{} · {} · {}",
                            row.number,
                            row.received_on,
                            row.supplier_name
                                .as_deref()
                                .unwrap_or(self.t(Key::InventoryNoSupplier))
                        ))
                        .when(
                            !busy
                                && (online
                                    || self.svc.store.cached_receipt(id).ok().flatten().is_some()),
                            |item| {
                                item.child(self.button(
                                    SharedString::from(format!("receipt-{id}")),
                                    self.t(Key::InventoryReceiptView),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        root.open_document_receipt(id, cx)
                                    }),
                                ))
                            },
                        )
                }))
                .when(!busy && panel.view.is_some(), |body| {
                    body.child(self.document_pager(panel.view.as_ref().unwrap().page(), None, cx))
                })
            }
        }
    }

    fn document_pager(
        &self,
        pagination: &Pagination,
        picker: Option<bool>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let page = pagination.page;
        let scope = match picker {
            None => 0usize,
            Some(true) => 1,
            Some(false) => 2,
        };
        let move_page = move |root: &mut Root, next, cx: &mut Context<Root>| match picker {
            Some(supplier) => root.search_document_picker(supplier, next, cx),
            None => root.load_document_list(next, cx),
        };
        div()
            .flex()
            .gap_2()
            .items_center()
            .when(page > 1, |row| {
                row.child(self.button(
                    ("documents-prev", scope),
                    "‹",
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| move_page(root, page - 1, cx)),
                ))
            })
            .child(page.to_string())
            .when(pagination.has_next(), |row| {
                row.child(self.button(
                    ("documents-next", scope),
                    "›",
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| move_page(root, page + 1, cx)),
                ))
            })
    }

    fn render_receipt_detail(
        &self,
        receipt: &Receipt,
        online: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let header = &receipt.header;
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.button(
                "receipt-detail-back",
                self.t(Key::Back),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
            ))
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(format!("#{} · {}", header.number, header.received_on)),
            )
            .child(
                header
                    .supplier_name
                    .as_deref()
                    .unwrap_or(self.t(Key::InventoryNoSupplier))
                    .to_owned(),
            )
            .when_some(header.invoice_reference.as_ref(), |body, reference| {
                body.child(format!(
                    "{} · {reference}",
                    self.t(Key::InventoryInvoiceReference)
                ))
            })
            .when_some(header.purchase_order_id, |body, order| {
                body.child(self.button(
                    "receipt-linked-order",
                    self.t(Key::InventoryOrderView),
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| {
                        if root.prepare_inventory_documents(Tab::Orders, cx) {
                            root.open_order(order, cx);
                        }
                    }),
                ))
            })
            .when_some(header.notes.as_ref(), |body, notes| {
                body.child(notes.clone())
            })
            .children(receipt.lines.iter().map(|line| {
                let label = format!("{} · {} · {}", line.name, line.sku, line.quantity);
                div()
                    .flex()
                    .justify_between()
                    .gap_2()
                    .py_2()
                    .border_b_1()
                    .border_color(theme::line())
                    .child(label)
                    .when_some(line.unit_cost_cents.filter(|_| online), |row, cents| {
                        row.child(format!(
                            "{} · {:.2} EUR",
                            self.t(Key::InventoryUnitCost),
                            cents as f64 / 100.
                        ))
                    })
            }))
    }

    fn render_supplier_editor(
        &self,
        form: &SupplierForm,
        online: bool,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if form.confirm_archive {
            return div()
                .flex()
                .flex_col()
                .gap_2()
                .child(self.t(Key::InventorySupplierArchiveConfirm))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(self.button(
                            "supplier-archive-cancel",
                            self.t(Key::ReviewKeepEditing),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                        ))
                        .child(self.button(
                            "supplier-archive-confirm",
                            self.t(Key::InventorySupplierArchive),
                            Kind::Danger,
                            cx.listener(|root, _, _, cx| root.save_inventory_document(true, cx)),
                        )),
                );
        }
        let fields = div()
            .flex()
            .flex_wrap()
            .gap_2()
            .child(self.document_field(Key::InventorySupplierName, &form.name))
            .child(self.document_field(Key::InventorySupplierEmail, &form.email))
            .child(self.document_field(Key::InventorySupplierPhone, &form.phone))
            .child(self.document_field(Key::InventorySupplierTaxId, &form.tax_id));
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(div().font_weight(FontWeight::SEMIBOLD).child(self.t(
                if form.original.version == 0 {
                    Key::InventorySupplierNew
                } else {
                    Key::InventorySupplierEdit
                },
            )))
            .child(fields)
            .child(self.document_field(Key::InventoryDocumentNotes, &form.notes))
            .when(form.original.version > 0, |body| {
                body.child(self.button(
                    "supplier-active",
                    self.t(if form.active {
                        Key::InventorySupplierActive
                    } else {
                        Key::InventorySupplierArchived
                    }),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        if let Some(panel) = root.document_panel()
                            && let Some(Editor::Supplier(form)) = &mut panel.editor
                        {
                            form.active = !form.active;
                        }
                        cx.notify();
                    }),
                ))
            })
            .when_some(form.reviewed.as_ref(), |body, row| {
                body.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(format!(
                            "{} · {}",
                            self.t(Key::InventoryDocumentCurrent),
                            if row.version == 0 {
                                self.t(Key::InventoryDocumentMissing)
                            } else {
                                &row.fields.name
                            }
                        ))
                        .children(
                            [
                                row.fields.email.as_ref(),
                                row.fields.phone.as_ref(),
                                row.fields.tax_id.as_ref(),
                                row.fields.notes.as_ref(),
                            ]
                            .into_iter()
                            .flatten()
                            .cloned(),
                        )
                        .when(row.version != 0, |section| {
                            section.child(self.t(if row.fields.active {
                                Key::InventorySupplierActive
                            } else {
                                Key::InventorySupplierArchived
                            }))
                        })
                        .child(self.button(
                            "supplier-use-review",
                            self.t(Key::InventoryDocumentReviewed),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.adopt_document_review(cx)),
                        )),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.button(
                        "supplier-back",
                        self.t(Key::Back),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                    ))
                    .when(online && !busy && form.generation.is_none(), |row| {
                        row.child(self.button(
                            "supplier-review",
                            self.t(Key::InventoryDocumentReview),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.review_document_draft(cx)),
                        ))
                    })
                    .when(!busy && form.generation.is_some(), |row| {
                        row.child(self.button(
                            "supplier-save",
                            self.t(Key::InventorySupplierSave),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.save_inventory_document(false, cx)),
                        ))
                    }),
            )
    }

    fn render_receipt_editor(
        &self,
        form: &ReceiptForm,
        reviewed_order: Option<&PurchaseOrder>,
        online: bool,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let draft_order = form.draft_order.is_some();
        let closed = form
            .purchase_order
            .as_ref()
            .is_some_and(|order| !order.header.status.allows_delivery());
        let linked = form.link().is_some();
        let product_search = form.product_search.read(cx).text().trim().to_lowercase();
        let supplier_search = form.supplier_search.read(cx).text().trim().to_lowercase();
        let products = self.svc.store.reviewed_products().unwrap_or_default();
        let suppliers = self.svc.store.cached_suppliers().unwrap_or_default();
        let product_results = form
            .product_page
            .as_ref()
            .filter(|_| online)
            .map_or(products.as_slice(), |page| page.products.as_slice());
        let supplier_results = form
            .supplier_page
            .as_ref()
            .filter(|_| online)
            .map_or(suppliers.as_slice(), |page| page.suppliers.as_slice());
        let selected = form
            .supplier_id
            .and_then(|id| suppliers.iter().find(|supplier| supplier.id == id));
        let supplier_name = if let Some(order) = &form.purchase_order {
            order.header.supplier_name.as_str()
        } else {
            selected.map_or_else(
                || {
                    self.t(if form.supplier_id.is_some() {
                        Key::InventoryDocumentMissing
                    } else {
                        Key::InventoryNoSupplier
                    })
                },
                |supplier| supplier.fields.name.as_str(),
            )
        };
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(if draft_order {
                        Key::InventoryOrderSave
                    } else if linked {
                        Key::InventoryOrderReceive
                    } else {
                        Key::InventoryReceiptNew
                    })),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.document_field(
                        if draft_order {
                            Key::InventoryOrderExpected
                        } else {
                            Key::InventoryDeliveryDate
                        },
                        &form.date,
                    ))
                    .child(self.document_field(
                        if draft_order {
                            Key::InventoryOrderReference
                        } else {
                            Key::InventoryInvoiceReference
                        },
                        &form.invoice,
                    )),
            )
            .child(self.document_field(Key::InventoryDocumentNotes, &form.notes))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(format!(
                        "{} · {supplier_name}",
                        self.t(Key::InventorySupplier)
                    ))
                    .when(!linked, |picker| {
                        picker
                            .child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .gap_2()
                                    .items_center()
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w(px(130.))
                                            .child(form.supplier_search.clone()),
                                    )
                                    .when(online && !busy, |row| {
                                        row.child(self.button(
                                            "receipt-search-supplier",
                                            self.t(Key::InventoryFind),
                                            Kind::Ghost,
                                            cx.listener(|root, _, _, cx| {
                                                root.search_document_picker(true, 1, cx)
                                            }),
                                        ))
                                    })
                                    .when(form.supplier_id.is_some() && !busy, |row| {
                                        row.child(self.button(
                                            "receipt-clear-supplier",
                                            self.t(Key::InventoryNoSupplier),
                                            Kind::Ghost,
                                            cx.listener(|root, _, _, cx| {
                                                if let Some(panel) = root.document_panel()
                                                    && let Some(Editor::Receipt(form)) =
                                                        &mut panel.editor
                                                {
                                                    form.supplier_id = None;
                                                }
                                                cx.notify();
                                            }),
                                        ))
                                    }),
                            )
                            .children(
                                supplier_results
                                    .iter()
                                    .filter(|row| {
                                        row.fields.active
                                            && (online && form.supplier_page.is_some()
                                                || row.matches_search(&supplier_search))
                                    })
                                    .take(20)
                                    .map(|row| {
                                        let id = row.id;
                                        div().when(!busy, |div| {
                                            div.child(self.button(
                                                SharedString::from(format!(
                                                    "receipt-supplier-{id}"
                                                )),
                                                format!(
                                                "{} · {}",
                                                row.fields.name,
                                                row.fields
                                                    .tax_id
                                                    .as_deref()
                                                    .or(row.fields.email.as_deref())
                                                    .unwrap_or("")
                                            ),
                                                if form.supplier_id == Some(id) {
                                                    Kind::Primary
                                                } else {
                                                    Kind::Ghost
                                                },
                                                cx.listener(move |root, _, _, cx| {
                                                    if let Some(panel) = root.document_panel()
                                                        && let Some(Editor::Receipt(form)) =
                                                            &mut panel.editor
                                                    {
                                                        form.supplier_id = Some(id);
                                                    }
                                                    cx.notify();
                                                }),
                                            ))
                                        })
                                    }),
                            )
                            .when(online && !busy && form.supplier_page.is_some(), |row| {
                                row.child(self.document_pager(
                                    &form.supplier_page.as_ref().unwrap().pagination,
                                    Some(true),
                                    cx,
                                ))
                            })
                    }),
            )
            .when(!linked, |body| {
                body.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(self.label(Key::InventoryProductName))
                        .child(
                            div()
                                .flex()
                                .gap_2()
                                .items_center()
                                .child(div().flex_1().child(form.product_search.clone()))
                                .when(online && !busy && form.lines.len() < MAX_LINES, |row| {
                                    row.child(self.button(
                                        "receipt-search-product",
                                        self.t(Key::InventoryFind),
                                        Kind::Ghost,
                                        cx.listener(|root, _, _, cx| {
                                            root.search_document_picker(false, 1, cx)
                                        }),
                                    ))
                                }),
                        )
                        .children(
                            product_results
                                .iter()
                                .filter(|product| {
                                    product.active
                                        && !form.lines.iter().any(|line| line.id == product.id)
                                        && (online && form.product_page.is_some()
                                            || product
                                                .name
                                                .to_lowercase()
                                                .contains(&product_search)
                                            || product.sku.to_lowercase().contains(&product_search))
                                })
                                .take(20)
                                .map(|item| {
                                    let product = item.clone();
                                    div().when(!busy && form.lines.len() < MAX_LINES, |row| {
                                        row.child(self.button(
                                            SharedString::from(format!(
                                                "receipt-product-{}",
                                                item.id
                                            )),
                                            format!("{} · {}", item.name, item.sku),
                                            Kind::Ghost,
                                            cx.listener(move |root, _, _, cx| {
                                                if root.svc.status().connectivity
                                                    == Connectivity::Online
                                                {
                                                    root.request_document(
                                                        Request::Product(product.id),
                                                        cx,
                                                    );
                                                } else {
                                                    root.add_document_product(product.clone(), cx);
                                                }
                                            }),
                                        ))
                                    })
                                }),
                        )
                        .when(online && !busy && form.product_page.is_some(), |row| {
                            row.child(self.document_pager(
                                &form.product_page.as_ref().unwrap().pagination,
                                Some(false),
                                cx,
                            ))
                        }),
                )
            })
            .when(closed, |body| {
                body.child(self.t(Key::InventoryDocumentChanged))
            })
            .when_some(
                reviewed_order.filter(|_| draft_order && form.needs_confirmation),
                |body, reviewed| {
                    body.child(
                        div()
                            .p_2()
                            .bg(theme::panel())
                            .child(format!(
                                "#{} · {} · {}",
                                reviewed.header.number,
                                reviewed.header.supplier_name,
                                self.t(order_status_key(reviewed.header.status))
                            ))
                            .children(reviewed.header.supplier_reference.clone())
                            .children(reviewed.header.expected_on.clone())
                            .children(reviewed.header.notes.clone())
                            .children(reviewed.lines.iter().map(|line| {
                                div().child(format!("{} · {}", line.name, line.quantity))
                            })),
                    )
                },
            )
            .children(form.lines.iter().map(|line| {
                let id = line.id;
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .items_center()
                    .p_2()
                    .border_b_1()
                    .border_color(theme::line())
                    .child(line.current.as_ref().map_or_else(
                        || {
                            reviewed_order
                                .and_then(|order| {
                                    order.lines.iter().find(|item| item.product_id == id)
                                })
                                .map_or_else(
                                    || format!("{id} · {}", self.t(Key::InventoryDocumentMissing)),
                                    |item| format!("{} · {}", item.name, item.sku),
                                )
                        },
                        |row| {
                            format!(
                                "{} · {} · {} {}",
                                row.name,
                                row.sku,
                                self.t(Key::InventoryAvailable),
                                row.available
                            )
                        },
                    ))
                    .when_some(
                        form.purchase_order.as_ref().and_then(|order| {
                            order.lines.iter().find(|item| item.product_id == id)
                        }),
                        |row, item| {
                            row.child(format!(
                                "{} · {}: {}",
                                item.name,
                                self.t(Key::InventoryOrderRemaining),
                                item.remaining()
                            ))
                        },
                    )
                    .child(self.document_field(Key::InventoryReceiptQuantity, &line.quantity))
                    .when(!busy && !linked, |row| {
                        row.child(self.button(
                            SharedString::from(format!("receipt-remove-{id}")),
                            self.t(Key::InventoryReceiptRemoveLine),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                if let Some(panel) = root.document_panel()
                                    && let Some(Editor::Receipt(form)) = &mut panel.editor
                                {
                                    form.lines.retain(|line| line.id != id);
                                }
                                cx.notify();
                            }),
                        ))
                    })
            }));
        body.child(
            div()
                .flex()
                .flex_wrap()
                .gap_2()
                .items_center()
                .child(self.button(
                    "receipt-editor-back",
                    self.t(Key::Back),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                ))
                .when(online && !busy && form.generation.is_none(), |row| {
                    row.child(self.button(
                        "receipt-review",
                        self.t(Key::InventoryDocumentReview),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.review_document_draft(cx)),
                    ))
                })
                .when(
                    !busy && !closed && form.needs_confirmation && form.generation.is_some(),
                    |row| {
                        row.child(self.button(
                            "receipt-approve-review",
                            self.t(Key::InventoryDocumentReviewed),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.adopt_document_review(cx)),
                        ))
                    },
                )
                .when(
                    !busy
                        && !closed
                        && !form.needs_confirmation
                        && form.generation.is_some()
                        && !form.lines.is_empty(),
                    |row| {
                        row.child(self.button(
                            "receipt-save",
                            self.t(if draft_order {
                                Key::InventoryOrderSave
                            } else {
                                Key::InventoryReceiptSave
                            }),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.save_inventory_document(false, cx)),
                        ))
                    },
                ),
        )
    }
}

impl Root {
    fn render_order_list(
        &self,
        panel: &Panel,
        online: bool,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let entries = match &panel.view {
            Some(View::Orders(page)) => page.orders.as_slice(),
            _ => &[],
        };
        let rows = entries.iter();
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .items_center()
                    .child(div().flex_1().min_w(px(170.)).child(panel.search.clone()))
                    .when(!busy, |row| {
                        row.child(self.button(
                            "order-search",
                            self.t(Key::InventoryFind),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.load_document_list(1, cx)),
                        ))
                    }),
            )
            .child(
                div().flex().flex_wrap().gap_2().children(
                    [
                        None,
                        Some(PurchaseOrderStatus::Draft),
                        Some(PurchaseOrderStatus::Ordered),
                        Some(PurchaseOrderStatus::PartiallyReceived),
                        Some(PurchaseOrderStatus::Received),
                        Some(PurchaseOrderStatus::Cancelled),
                    ]
                    .into_iter()
                    .map(|status| {
                        self.button(
                            SharedString::from(format!("order-filter-{status:?}")),
                            self.t(status.map_or(Key::InventoryOrderAll, order_status_key)),
                            if status == panel.order_filter {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |root, _, _, cx| {
                                if let Some(panel) = root.document_panel()
                                    && panel.request.is_none()
                                {
                                    panel.order_filter = status;
                                    root.load_document_list(1, cx);
                                }
                            }),
                        )
                    }),
                ),
            )
            .when(!busy && rows.clone().next().is_none(), |body| {
                body.child(self.t(Key::InventoryOrderEmpty))
            })
            .children(rows.map(|order| {
                let id = order.id;
                div()
                    .flex()
                    .flex_wrap()
                    .justify_between()
                    .items_center()
                    .gap_2()
                    .border_b_1()
                    .border_color(theme::line())
                    .py_2()
                    .child(format!(
                        "#{} · {} · {}",
                        order.number,
                        order.supplier_name,
                        self.t(order_status_key(order.status))
                    ))
                    .when(
                        !busy
                            && (online
                                || self
                                    .svc
                                    .store
                                    .cached_purchase_order(id)
                                    .ok()
                                    .flatten()
                                    .is_some()),
                        |row| {
                            row.child(self.button(
                                SharedString::from(format!("order-{id}")),
                                self.t(Key::InventoryOrderView),
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| root.open_order(id, cx)),
                            ))
                        },
                    )
            }))
            .when(!busy && panel.view.is_some(), |body| {
                body.child(self.document_pager(panel.view.as_ref().unwrap().page(), None, cx))
            })
    }

    fn render_order_detail(
        &self,
        panel: &Panel,
        order: &PurchaseOrder,
        writable: bool,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let status = order.header.status;
        let mut body = div()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.button(
                "order-back",
                self.t(Key::Back),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
            ))
            .child(div().font_weight(FontWeight::SEMIBOLD).child(format!(
                "#{} · {} · {}",
                order.header.number,
                order.header.supplier_name,
                self.t(order_status_key(status))
            )))
            .children(order.header.expected_on.clone())
            .children(order.header.supplier_reference.clone())
            .children(order.header.notes.clone())
            .children(order.lines.iter().map(|line| {
                div()
                    .p_2()
                    .border_b_1()
                    .border_color(theme::line())
                    .child(format!("{} · {}", line.name, line.sku))
                    .child(div().text_sm().child(format!(
                        "{}: {} · {}: {} · {}: {}",
                        self.t(Key::InventoryOrderRequested),
                        line.quantity,
                        self.t(Key::InventoryOrderDelivered),
                        line.received_quantity,
                        self.t(Key::InventoryOrderRemaining),
                        if status == PurchaseOrderStatus::Cancelled {
                            0
                        } else {
                            line.remaining()
                        },
                    )))
            }))
            .children(order.receipts.iter().map(|receipt| {
                let id = receipt.id;
                self.button(
                    SharedString::from(format!("order-receipt-{id}")),
                    format!(
                        "{} #{} · {}",
                        self.t(Key::InventoryReceipts),
                        receipt.number,
                        receipt.received_on
                    ),
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| root.open_linked_inventory_receipt(id, cx)),
                )
            }));
        if !writable || busy {
            return body;
        }
        if self
            .svc
            .store
            .has_pending_purchase_order(order.header.id)
            .unwrap_or(true)
        {
            return body.child(self.t(Key::InventoryOrderPending));
        }
        if let Some((_, proposal)) = &panel.order_conflict {
            body = body.child(self.t(match proposal.action {
                PurchaseOrderAction::Save(_) => Key::InventoryOrderEdit,
                PurchaseOrderAction::Order => Key::InventoryOrderPlace,
                PurchaseOrderAction::Cancel => Key::InventoryOrderCancel,
            }));
        }
        if let Some((_, action)) = &panel.order_transition {
            let cancel = matches!(action, PurchaseOrderAction::Cancel);
            return body
                .child(self.t(if cancel {
                    Key::InventoryOrderCancelConfirm
                } else {
                    Key::InventoryOrderPlaceConfirm
                }))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(self.button(
                            "order-transition-back",
                            self.t(Key::Back),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                        ))
                        .child(self.button(
                            "order-transition-confirm",
                            self.t(if cancel {
                                Key::InventoryOrderCancel
                            } else {
                                Key::InventoryOrderPlace
                            }),
                            if cancel { Kind::Danger } else { Kind::Primary },
                            cx.listener(|root, _, _, cx| root.confirm_order_transition(cx)),
                        )),
                );
        }
        let order_version = PurchaseOrderLink {
            id: order.header.id,
            version: order.header.version,
        };
        let action_at_issue = panel
            .order_conflict
            .as_ref()
            .map(|(_, proposal)| &proposal.action);
        if status == PurchaseOrderStatus::Draft && action_at_issue.is_none() {
            let reviewed = order.clone();
            body = body.child(self.button(
                "order-edit",
                self.t(Key::InventoryOrderEdit),
                Kind::Ghost,
                cx.listener(move |root, _, _, cx| root.edit_order(Some(reviewed.clone()), cx)),
            ));
            body = body.child(self.button(
                "order-place",
                self.t(Key::InventoryOrderPlace),
                Kind::Primary,
                cx.listener(move |root, _, _, cx| {
                    if let Some(panel) = root.document_panel() {
                        panel.order_transition = Some((order_version, PurchaseOrderAction::Order));
                    }
                    cx.notify();
                }),
            ));
        }
        if status == PurchaseOrderStatus::Draft
            && matches!(action_at_issue, Some(PurchaseOrderAction::Order))
        {
            body = body.child(self.button(
                "order-place-retry",
                self.t(Key::InventoryOrderPlace),
                Kind::Primary,
                cx.listener(move |root, _, _, cx| {
                    if let Some(panel) = root.document_panel() {
                        panel.order_transition = Some((order_version, PurchaseOrderAction::Order));
                    }
                    cx.notify();
                }),
            ));
        }
        if status.allows_delivery() && action_at_issue.is_none() {
            let reviewed = order.clone();
            body = body.child(self.button(
                "order-receive",
                self.t(Key::InventoryOrderReceive),
                Kind::Primary,
                cx.listener(move |root, _, _, cx| root.start_order_delivery(reviewed.clone(), cx)),
            ));
        }
        if status.allows_cancel()
            && (action_at_issue.is_none()
                || matches!(action_at_issue, Some(PurchaseOrderAction::Cancel)))
        {
            body = body.child(self.button(
                "order-cancel",
                self.t(Key::InventoryOrderCancel),
                Kind::Ghost,
                cx.listener(move |root, _, _, cx| {
                    if let Some(panel) = root.document_panel() {
                        panel.order_transition = Some((order_version, PurchaseOrderAction::Cancel));
                    }
                    cx.notify();
                }),
            ));
        }
        body
    }
}
