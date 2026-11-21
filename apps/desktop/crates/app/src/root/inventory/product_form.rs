use super::*;
use sob_core::error::CoreError;
use sob_core::product_editor::{CREATE, ProductDraft, ProductProposal, ProductReview, UPDATE};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Input {
    Name,
    Sku,
    Barcode,
    Category,
    Brand,
    Location,
    Unit,
    Price,
    Cost,
    Tax,
    Quantity,
    PackUnit,
    Threshold,
    Target,
    Opening,
}

const GROUPS: &[(Key, &[Input])] = &[
    (
        Key::InventoryProductDetails,
        &[
            Input::Name,
            Input::Sku,
            Input::Barcode,
            Input::Category,
            Input::Brand,
        ],
    ),
    (
        Key::InventoryProductPricing,
        &[Input::Price, Input::Tax, Input::Cost],
    ),
    (
        Key::InventoryStockHistory,
        &[
            Input::Unit,
            Input::Quantity,
            Input::PackUnit,
            Input::Location,
            Input::Threshold,
            Input::Target,
            Input::Opening,
        ],
    ),
];

impl Input {
    fn label(self) -> Key {
        match self {
            Self::Name => Key::InventoryProductName,
            Self::Sku => Key::InventoryProductSku,
            Self::Barcode => Key::InventoryProductBarcode,
            Self::Category => Key::InventoryCategoryFilter,
            Self::Brand => Key::InventoryBrandFilter,
            Self::Location => Key::InventoryLocation,
            Self::Unit => Key::InventoryProductUnit,
            Self::Price => Key::InventoryProductPrice,
            Self::Cost => Key::InventoryUnitCost,
            Self::Tax => Key::InventoryTax,
            Self::Quantity => Key::InventoryPackQuantity,
            Self::PackUnit => Key::InventoryPackUnit,
            Self::Threshold => Key::InventoryThreshold,
            Self::Target => Key::InventoryTarget,
            Self::Opening => Key::InventoryStockOpening,
        }
    }

    fn value(self, fields: &ProductDraft, locale: Locale) -> String {
        let amount = |value: u32| {
            let separator = if locale == Locale::EsAr { ',' } else { '.' };
            format!("{}{separator}{:02}", value / 100, value % 100)
        };
        match self {
            Self::Name => fields.name.clone(),
            Self::Sku => fields.sku.clone().unwrap_or_default(),
            Self::Barcode => fields.barcode.clone().unwrap_or_default(),
            Self::Category => fields.category.clone().unwrap_or_default(),
            Self::Brand => fields.brand.clone().unwrap_or_default(),
            Self::Location => fields.storage_location.clone().unwrap_or_default(),
            Self::Unit => fields.unit_label.clone(),
            Self::Price => amount(fields.price_cents),
            Self::Cost => fields.cost_cents.map(amount).unwrap_or_default(),
            Self::Tax => amount(fields.tax_basis_points),
            Self::Quantity => fields
                .package_content
                .as_ref()
                .map_or(String::new(), |pack| pack.quantity.clone()),
            Self::PackUnit => fields
                .package_content
                .as_ref()
                .map_or(String::new(), |pack| pack.unit.clone()),
            Self::Threshold => fields.low_stock_threshold.to_string(),
            Self::Target => fields
                .target_stock
                .map(|stock| stock.to_string())
                .unwrap_or_default(),
            Self::Opening => fields.opening_stock.to_string(),
        }
    }
}

struct NetPrice {
    amount: u32,
    tax: u32,
    gross: u32,
}

pub(super) struct Panel {
    id: ProductId,
    generation: String,
    locale: Locale,
    baseline: Option<ProductReview>,
    opened: ProductDraft,
    inputs: Vec<(Input, Entity<TextField>)>,
    description: Vec<Entity<TextField>>,
    net_price: Option<NetPrice>,
    resellable: bool,
    active: bool,
    conflict: Option<String>,
    needs_review: bool,
    restored: bool,
    missing_after_restore: bool,
    reviewed: Option<ProductReview>,
    request: Option<Arc<()>>,
    discard: bool,
    error: Option<Key>,
}

impl Panel {
    fn text<'a>(&'a self, name: Input, cx: &'a App) -> &'a str {
        self.inputs
            .iter()
            .find(|(input, _)| *input == name)
            .map(|(_, field)| field.read(cx).text())
            .unwrap_or_default()
    }

    fn draft(&self, cx: &App) -> Option<ProductDraft> {
        let text = |name| self.text(name, cx);
        let optional = |name| ProductDraft::optional(text(name));
        let tax = ProductDraft::money(text(Input::Tax)).filter(|value| *value <= 10_000)?;
        let price = ProductDraft::money(text(Input::Price))?;
        Some(ProductDraft {
            name: text(Input::Name).to_owned(),
            sku: optional(Input::Sku).or_else(|| {
                self.baseline
                    .as_ref()
                    .and_then(|row| row.fields.sku.clone())
            }),
            barcode: optional(Input::Barcode),
            category: optional(Input::Category),
            brand: optional(Input::Brand),
            storage_location: optional(Input::Location),
            description: ProductDraft::optional(
                &self
                    .description
                    .iter()
                    .map(|line| line.read(cx).text())
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            unit_label: text(Input::Unit).to_owned(),
            package_content: PackageContent::parse(text(Input::Quantity), text(Input::PackUnit))
                .ok()?,
            price_cents: self.gross_price(price, tax)?,
            cost_cents: match optional(Input::Cost) {
                Some(value) => Some(ProductDraft::money(&value)?),
                None => None,
            },
            tax_basis_points: tax,
            low_stock_threshold: ProductDraft::units(text(Input::Threshold))?,
            target_stock: match optional(Input::Target) {
                Some(value) => Some(ProductDraft::units(&value)?),
                None => None,
            },
            opening_stock: if self.baseline.is_none() {
                ProductDraft::units(text(Input::Opening))?
            } else {
                0
            },
            resellable: self.resellable,
            active: self.active,
        })
    }

    fn gross_price(&self, price: u32, tax: u32) -> Option<u32> {
        match &self.net_price {
            None => Some(price),
            Some(anchor) if anchor.amount == price && anchor.tax == tax => Some(anchor.gross),
            Some(_) => ProductDraft::gross_from_net(price, tax),
        }
    }

    fn populate(&mut self, draft: &ProductDraft, cx: &mut Context<Root>) {
        for (input, field) in &self.inputs {
            field.update(cx, |field, cx| {
                field.set_text(&input.value(draft, self.locale), cx)
            });
        }
        self.description = description_fields(draft.description.as_deref(), cx);
        self.resellable = draft.resellable;
        self.active = draft.active;
        self.net_price = None;
    }

    pub(super) fn dismiss(&mut self, cx: &App) -> bool {
        if self.request.is_some() {
            return false;
        }
        if self.discard {
            self.discard = false;
            return false;
        }
        if self.draft(cx).as_ref() == Some(&self.opened) {
            return true;
        }
        self.discard = true;
        false
    }
}

fn description_fields(value: Option<&str>, cx: &mut Context<Root>) -> Vec<Entity<TextField>> {
    value
        .unwrap_or_default()
        .split('\n')
        .map(|line| description_field(line, cx))
        .collect()
}

fn description_field(value: &str, cx: &mut Context<Root>) -> Entity<TextField> {
    let field = cx.new(|cx| {
        let mut field = text_input(value, "", cx).with_line_paste(1000);
        field.set_text(value, cx);
        field
    });
    cx.subscribe(&field, |root, field, event, cx| {
        if let FieldEvent::PasteLines(lines) = event {
            root.edit_product_form(cx, |form, cx| {
                if let Some(index) = form.description.iter().position(|line| *line == field)
                    && form.description.len() + lines.len() <= 1001
                {
                    form.description.splice(
                        index + 1..index + 1,
                        lines.iter().map(|line| description_field(line, cx)),
                    );
                }
            });
        }
    })
    .detach();
    field
}

impl Root {
    pub(super) fn begin_product_form(&mut self, edit: bool, cx: &mut Context<Self>) {
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let Overlay::Inventory(desk) = &self.overlay else {
            return;
        };
        if desk.request.is_some()
            || desk.product_form.is_some()
            || desk.editor.is_some()
            || desk.stock.is_some()
        {
            return;
        }
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let Some(generation) = generation else { return };
        let (id, baseline, draft) = if edit {
            let Some(product) = desk.product.as_ref().filter(|product| product.can_manage) else {
                return;
            };
            let Ok(baseline) = ProductReview::new(product) else {
                return;
            };
            if baseline.generation != generation {
                return;
            }
            (product.id, Some(baseline.clone()), baseline.fields)
        } else {
            (uuid::Uuid::now_v7(), None, ProductDraft::default())
        };
        if self
            .svc
            .store
            .pending_product_edits()
            .ok()
            .is_none_or(|pending| pending.iter().any(|row| row.id == id))
        {
            return;
        }
        self.install_product_form(generation, id, baseline, draft, None, cx);
    }

    #[allow(clippy::too_many_arguments)]
    fn install_product_form(
        &mut self,
        generation: String,
        id: ProductId,
        baseline: Option<ProductReview>,
        draft: ProductDraft,
        conflict: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let inputs = GROUPS
            .iter()
            .flat_map(|(_, group)| group.iter().copied())
            .map(|input| {
                let field = cx.new(|cx| text_input(&input.value(&draft, self.locale), "", cx));
                cx.observe(&field, |_, _, cx| cx.notify()).detach();
                (input, field)
            })
            .collect();
        let description = description_fields(draft.description.as_deref(), cx);
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        desk.error = None;
        desk.product_form = Some(Box::new(Panel {
            id,
            generation,
            locale: self.locale,
            baseline,
            inputs,
            description,
            net_price: None,
            resellable: draft.resellable,
            active: draft.active,
            opened: draft,
            needs_review: conflict.is_some(),
            restored: false,
            missing_after_restore: false,
            conflict,
            reviewed: None,
            request: None,
            discard: false,
            error: None,
        }));
        cx.notify();
    }

    pub(in crate::root) fn open_product_conflict(
        &mut self,
        mutation_id: &str,
        cx: &mut Context<Self>,
    ) {
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let Some(row) = self.svc.store.conflict(mutation_id).ok().flatten() else {
            return;
        };
        if !matches!(row.kind.as_str(), CREATE | UPDATE) {
            return;
        }
        let restored = row.requires_restored_review();
        let Ok(proposal) = serde_json::from_value::<ProductProposal>(row.payload) else {
            return;
        };
        let Ok(generation) = self.svc.store.verified_reviewed_generation() else {
            return;
        };
        let creating = proposal.reviewed.is_none() && !restored;
        self.prepare_inventory(cx);
        self.install_product_form(
            generation,
            proposal.id,
            proposal.reviewed,
            proposal.fields,
            Some(mutation_id.into()),
            cx,
        );
        self.edit_product_form(cx, |form, _| form.restored = restored);
        if creating {
            self.edit_product_form(cx, |form, _| form.needs_review = false);
        } else {
            self.fetch_product_review(cx);
        }
    }

    fn edit_product_form(
        &mut self,
        cx: &mut Context<Self>,
        update: impl FnOnce(&mut Panel, &mut Context<Self>),
    ) {
        if let Overlay::Inventory(desk) = &mut self.overlay
            && let Some(form) = &mut desk.product_form
            && form.request.is_none()
            && self.svc.store.can_queue_product_edits()
        {
            update(form, cx);
            cx.notify();
        }
    }

    fn fetch_product_review(&mut self, cx: &mut Context<Self>) {
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.svc.status().connectivity == Connectivity::Online)
        else {
            return;
        };
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let Some(form) = &mut desk.product_form else {
            return;
        };
        if form.request.is_some() {
            return;
        }
        let request = Arc::new(());
        let id = form.id;
        form.request = Some(request.clone());
        form.reviewed = None;
        form.missing_after_restore = false;
        form.error = None;
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |handle, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.lookup_inventory_product(id) })
                .await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) {
                    return;
                }
                let Overlay::Inventory(desk) = &mut root.overlay else {
                    return;
                };
                let Some(form) = &mut desk.product_form else {
                    return;
                };
                if !form
                    .request
                    .as_ref()
                    .is_some_and(|active| Arc::ptr_eq(active, &request))
                {
                    return;
                }
                form.request = None;
                match result {
                    Ok(Some(product))
                        if product.can_manage && root.svc.store.can_queue_product_edits() =>
                    {
                        form.reviewed = ProductReview::new(&product).ok();
                        let _ = root.svc.store.remember_reviewed_product(&product);
                        desk.product = Some(product);
                    }
                    Ok(None) if form.restored => form.missing_after_restore = true,
                    _ => form.error = Some(Key::InventoryUnavailable),
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(in crate::root) fn preserve_open_product_form(&mut self, generation: Option<&str>) -> bool {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return false;
        };
        if desk.product_form.is_none() {
            return false;
        }
        desk.redact_costs();
        let form = desk.product_form.as_mut().expect("open product form");
        if generation != Some(form.generation.as_str()) {
            form.needs_review = true;
            form.restored = true;
            form.reviewed = None;
            form.request = None;
            form.missing_after_restore = false;
        }
        true
    }

    fn recreate_reviewed_product(&mut self, cx: &mut Context<Self>) {
        let Ok(generation) = self.svc.store.verified_reviewed_generation() else {
            return;
        };
        self.edit_product_form(cx, |form, cx| {
            if !form.missing_after_restore {
                return;
            }
            let Some(draft) = form.draft(cx) else {
                form.error = Some(Key::InventoryProductInvalid);
                return;
            };
            form.generation = generation;
            let opening_stock = if form.baseline.is_none() {
                draft.opening_stock
            } else {
                0
            };
            form.baseline = None;
            form.needs_review = false;
            form.missing_after_restore = false;
            form.populate(
                &ProductDraft {
                    opening_stock,
                    active: true,
                    ..draft
                },
                cx,
            );
        });
    }

    fn accept_product_review(&mut self, keep_overlaps: bool, cx: &mut Context<Self>) {
        self.edit_product_form(cx, |form, cx| {
            let Some(current) = form.reviewed.take() else {
                return;
            };
            let Some(proposed) = form.draft(cx) else {
                form.error = Some(Key::InventoryProductInvalid);
                form.reviewed = Some(current);
                return;
            };
            let original = form
                .baseline
                .as_ref()
                .map(|row| row.fields.clone())
                .unwrap_or_default();
            match proposed.rebase(&original, &current.fields, keep_overlaps) {
                Ok(reviewed) => {
                    form.generation.clone_from(&current.generation);
                    form.baseline = Some(current);
                    form.needs_review = false;
                    form.error = None;
                    form.populate(&reviewed, cx);
                }
                Err(_) => {
                    form.reviewed = Some(current);
                    form.error = Some(Key::InventoryProductInvalid);
                }
            }
        });
    }

    fn save_product_form(&mut self, cx: &mut Context<Self>) {
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let Some(form) = &mut desk.product_form else {
            return;
        };
        if form.request.is_some() || form.needs_review || form.discard {
            return;
        }
        let Some(fields) = form.draft(cx) else {
            form.error = Some(Key::InventoryProductInvalid);
            cx.notify();
            return;
        };
        match self.svc.store.queue_product_edit(
            &form.generation,
            form.id,
            form.baseline.as_ref(),
            fields,
            form.conflict.as_deref(),
        ) {
            Ok(queued) => {
                desk.product_form = None;
                desk.product = None;
                desk.error = queued.then_some(Key::InventoryProductQueued);
                if self.status.connectivity == Connectivity::Online {
                    self.edited(cx);
                } else {
                    self.reload(cx);
                }
            }
            Err(CoreError::CatalogueVersionChanged | CoreError::CalendarGenerationChanged) => {
                form.needs_review = true;
                form.error = Some(Key::InventoryConflict);
            }
            Err(CoreError::CatalogueEditPending) => form.error = Some(Key::InventoryProductQueued),
            Err(_) => form.error = Some(Key::InventoryProductInvalid),
        }
        cx.notify();
    }
}

impl Root {
    pub(super) fn queue_product_status(&mut self, cx: &mut Context<Self>) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        let Some(product) = desk.product.as_ref().filter(|product| product.can_manage) else {
            return;
        };
        let Ok(review) = ProductReview::new(product) else {
            return;
        };
        let fields = ProductDraft {
            active: !review.fields.active,
            ..review.fields.clone()
        };
        match self.svc.store.queue_product_edit(
            &review.generation,
            product.id,
            Some(&review),
            fields,
            None,
        ) {
            Ok(true) => {
                desk.error = Some(Key::InventoryProductQueued);
                if self.status.connectivity == Connectivity::Online {
                    self.edited(cx);
                }
            }
            Ok(false) => (),
            Err(CoreError::CatalogueEditPending) => desk.error = Some(Key::InventoryProductQueued),
            Err(_) => desk.error = Some(Key::InventoryConflict),
        }
        cx.notify();
    }

    fn edit_cached_product(&mut self, id: ProductId, cx: &mut Context<Self>) {
        let Some(product) = self
            .svc
            .store
            .reviewed_products()
            .ok()
            .and_then(|rows| rows.into_iter().find(|product| product.id == id))
        else {
            return;
        };
        if let Overlay::Inventory(desk) = &mut self.overlay {
            desk.product = Some(product);
        }
        self.begin_product_form(true, cx);
    }

    pub(super) fn render_product_writes(&self, desk: &Desk, cx: &mut Context<Self>) -> gpui::Div {
        let content = div().flex().flex_wrap().gap_2();
        if !self.svc.store.can_queue_product_edits() {
            return content;
        }
        let offline_items = if self.status.connectivity != Connectivity::Online {
            self.svc.store.reviewed_products().unwrap_or_default()
        } else {
            Vec::new()
        };
        content
            .when(desk.request.is_none(), |content| {
                content.child(self.button(
                    "inventory-new-product",
                    self.t(Key::InventoryNewProduct),
                    Kind::Primary,
                    cx.listener(|root, _, _, cx| root.begin_product_form(false, cx)),
                ))
            })
            .children(
                self.svc
                    .store
                    .pending_product_edits()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|proposal| {
                        div().text_sm().text_color(theme::muted()).child(format!(
                            "{} · {}",
                            proposal.fields.name,
                            self.t(Key::InventoryProductQueued)
                        ))
                    }),
            )
            .when(!offline_items.is_empty(), |view| {
                view.child(self.label(Key::InventoryOfflineProducts))
                    .children(offline_items.into_iter().map(|product| {
                        let id = product.id;
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .child(self.button(
                                SharedString::from(format!("inventory-edit-cached-{id}")),
                                product.name,
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| root.edit_cached_product(id, cx)),
                            ))
                            .child(self.button(
                                SharedString::from(format!("inventory-photo-cached-{id}")),
                                self.t(Key::InventoryProductPhoto),
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    root.open_cached_product_photo(id, cx)
                                }),
                            ))
                    }))
            })
    }

    fn toggle_net_product_price(&mut self, cx: &mut Context<Self>) {
        self.edit_product_form(cx, |form, cx| {
            let Some(tax) =
                ProductDraft::money(form.text(Input::Tax, cx)).filter(|tax| *tax <= 10_000)
            else {
                form.error = Some(Key::InventoryProductInvalid);
                return;
            };
            let Some(gross) = ProductDraft::money(form.text(Input::Price, cx))
                .and_then(|amount| form.gross_price(amount, tax))
            else {
                form.error = Some(Key::InventoryProductInvalid);
                return;
            };
            form.net_price = if form.net_price.is_some() {
                None
            } else {
                let divisor = 10_000 + u64::from(tax);
                let amount = ((u64::from(gross) * 10_000 + divisor / 2) / divisor) as u32;
                Some(NetPrice { amount, tax, gross })
            };
            let price_cents = form.net_price.as_ref().map_or(gross, |price| price.amount);
            let display = Input::Price.value(
                &ProductDraft {
                    price_cents,
                    ..ProductDraft::default()
                },
                form.locale,
            );
            if let Some((_, field)) = form.inputs.iter().find(|(input, _)| *input == Input::Price) {
                field.update(cx, |field, cx| field.set_text(&display, cx));
            }
            form.error = None;
        });
    }

    pub(super) fn render_product_form(&self, form: &Panel, cx: &mut Context<Self>) -> gpui::Div {
        let allowed = self.svc.store.can_queue_product_edits();
        let body = div().flex().flex_col().gap_3().child(
            div()
                .text_lg()
                .font_weight(FontWeight::SEMIBOLD)
                .child(self.t(if form.baseline.is_some() {
                    Key::InventoryEditProduct
                } else {
                    Key::InventoryNewProduct
                })),
        );
        if form.discard || !allowed {
            return body
                .child(self.t(if allowed {
                    Key::InventoryProductDiscard
                } else {
                    Key::InventoryRestricted
                }))
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .child(self.button(
                            "product-form-discard",
                            self.t(Key::ReviewDiscard),
                            Kind::Danger,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::Inventory(desk) = &mut root.overlay {
                                    desk.product_form = None;
                                    cx.notify();
                                }
                                root.reload_inventory(cx);
                            }),
                        ))
                        .when(allowed, |row| {
                            row.child(self.button(
                                "product-form-continue",
                                self.t(Key::ReviewKeepEditing),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                            ))
                        }),
                );
        }
        let body = body
            .when_some(form.error, |body, error| {
                body.child(
                    div()
                        .text_sm()
                        .text_color(theme::conflict_fg())
                        .child(self.t(error)),
                )
            })
            .when(form.needs_review, |body| {
                body.child(self.render_product_review(form, cx))
            });
        body.children(GROUPS.iter().map(|(title, inputs)| {
            div()
                .rounded_md()
                .border_1()
                .border_color(theme::line())
                .p_2()
                .flex()
                .flex_col()
                .gap_2()
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(self.t(*title)),
                )
                .child(
                    div().flex().flex_wrap().gap_2().children(
                        form.inputs
                            .iter()
                            .filter(|(name, _)| {
                                inputs.contains(name)
                                    && (*name != Input::Opening || form.baseline.is_none())
                            })
                            .map(|(name, field)| {
                                let label = if *name == Input::Price && form.net_price.is_some() {
                                    Key::InventoryProductNetValue
                                } else {
                                    name.label()
                                };
                                div()
                                    .min_w(px(170.))
                                    .flex_1()
                                    .child(self.label(label))
                                    .child(field.clone())
                            }),
                    ),
                )
                .when(*title == Key::InventoryProductPricing, |group| {
                    group
                        .child(self.button(
                            "product-form-price-mode",
                            self.t(if form.net_price.is_some() {
                                Key::InventoryProductGross
                            } else {
                                Key::InventoryProductNet
                            }),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.toggle_net_product_price(cx)),
                        ))
                        .when_some(
                            form.net_price.is_some().then(|| form.draft(cx)).flatten(),
                            |group, draft| {
                                group.child(format!(
                                    "{} · {}",
                                    self.t(Key::InventoryProductPrice),
                                    self.amount_label(i64::from(draft.price_cents), "EUR")
                                ))
                            },
                        )
                })
        }))
        .child(self.label(Key::CatalogDescription))
        .children(form.description.iter().enumerate().map(|(index, field)| {
            div()
                .flex()
                .gap_2()
                .child(div().min_w_0().flex_1().child(field.clone()))
                .when(form.description.len() > 1, |row| {
                    row.child(self.button(
                        ("product-remove-description", index),
                        self.t(Key::RemoveNoteLine),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            root.edit_product_form(cx, |form, _| {
                                if form.description.len() > 1 && index < form.description.len() {
                                    form.description.remove(index);
                                }
                            })
                        }),
                    ))
                })
        }))
        .when(form.description.len() < 1001, |body| {
            body.child(self.button(
                "product-add-description",
                self.t(Key::AddNoteLine),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| {
                    root.edit_product_form(cx, |form, cx| {
                        if form.description.len() < 1001 {
                            form.description.push(description_field("", cx));
                        }
                    })
                }),
            ))
        })
        .child(
            div()
                .flex()
                .flex_wrap()
                .gap_2()
                .child(self.button(
                    "product-toggle-sale",
                    self.t(if form.resellable {
                        Key::InventoryRetail
                    } else {
                        Key::InventoryInternal
                    }),
                    if form.resellable {
                        Kind::Primary
                    } else {
                        Kind::Ghost
                    },
                    cx.listener(|root, _, _, cx| {
                        root.edit_product_form(cx, |form, _| form.resellable = !form.resellable)
                    }),
                ))
                .when(form.baseline.is_some(), |row| {
                    row.child(self.button(
                        "product-toggle-active",
                        self.t(if form.active {
                            Key::InventoryActive
                        } else {
                            Key::InventoryArchivedProduct
                        }),
                        if form.active {
                            Kind::Primary
                        } else {
                            Kind::Ghost
                        },
                        cx.listener(|root, _, _, cx| {
                            root.edit_product_form(cx, |form, _| form.active = !form.active)
                        }),
                    ))
                }),
        )
        .when(!form.needs_review && form.request.is_none(), |body| {
            body.child(self.button(
                "product-form-save",
                self.t(Key::InventoryProductSave),
                Kind::Primary,
                cx.listener(|root, _, _, cx| root.save_product_form(cx)),
            ))
        })
    }

    fn render_product_review(&self, form: &Panel, cx: &mut Context<Self>) -> gpui::Div {
        let content = div()
            .flex()
            .flex_col()
            .gap_2()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .p_2()
            .child(self.t(Key::InventoryConflict));
        if let Some(review) = &form.reviewed {
            let original = form
                .baseline
                .as_ref()
                .map(|row| row.fields.clone())
                .unwrap_or_default();
            return content
                .child(self.label(Key::CatalogCurrent))
                .children(
                    GROUPS
                        .iter()
                        .flat_map(|(_, group)| group.iter())
                        .filter_map(|input| {
                            let before = input.value(&original, form.locale);
                            let value = input.value(&review.fields, form.locale);
                            (before != value).then(|| {
                                div().text_sm().child(format!(
                                    "{} · {} → {}",
                                    self.t(input.label()),
                                    before,
                                    value
                                ))
                            })
                        }),
                )
                .when(original.description != review.fields.description, |body| {
                    body.child(format!(
                        "{} · {}",
                        self.t(Key::CatalogDescription),
                        review.fields.description.as_deref().unwrap_or_default()
                    ))
                })
                .when(original.active != review.fields.active, |body| {
                    body.child(self.t(if review.fields.active {
                        Key::InventoryActive
                    } else {
                        Key::InventoryArchivedProduct
                    }))
                })
                .when(original.resellable != review.fields.resellable, |body| {
                    body.child(self.t(if review.fields.resellable {
                        Key::InventoryRetail
                    } else {
                        Key::InventoryInternal
                    }))
                })
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(self.button(
                            "product-review-local",
                            self.t(Key::CatalogKeepDraftGroups),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.accept_product_review(true, cx)),
                        ))
                        .child(self.button(
                            "product-review-cloud",
                            self.t(Key::CatalogKeepCloudGroups),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.accept_product_review(false, cx)),
                        )),
                );
        }
        if form.request.is_some() {
            return content.child(self.t(Key::InventoryLoading));
        }
        if form.missing_after_restore {
            return content
                .child(self.t(Key::InventoryProductRestoredMissing))
                .child(self.button(
                    "product-review-recreate",
                    self.t(Key::InventoryProductReviewNew),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.recreate_reviewed_product(cx)),
                ));
        }
        content.child(self.button(
            "product-review-latest",
            self.t(Key::InventoryReviewLatest),
            Kind::Ghost,
            cx.listener(|root, _, _, cx| root.fetch_product_review(cx)),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn inspecting_the_net_price_does_not_change_the_queued_gross_price(
        cx: &mut TestAppContext,
    ) {
        let (_directory, window) = crate::root::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                let generation = root.svc.store.verified_reviewed_generation().unwrap();
                root.svc
                    .store
                    .set_meta("inventory_write_access", &generation)
                    .unwrap();
                root.status.connectivity = Connectivity::Offline;
                root.open_inventory(cx);
                root.begin_product_form(false, cx);
                root.edit_product_form(cx, |form, cx| {
                    for (field, text) in [
                        (Input::Name, "Native test product"),
                        (Input::Price, "0.03"),
                        (Input::Tax, "100"),
                        (Input::Opening, "2"),
                    ] {
                        let (_, input) =
                            form.inputs.iter().find(|(name, _)| *name == field).unwrap();
                        input.update(cx, |input, cx| input.set_text(text, cx));
                    }
                });
                root.toggle_net_product_price(cx);
                root.save_product_form(cx);
                let saved = root.svc.store.pending_product_edits().unwrap();
                assert_eq!(saved.len(), 1);
                assert_eq!(saved[0].fields.opening_stock, 2);
                assert_eq!(saved[0].fields.price_cents, 3);
            })
            .unwrap();
    }
}
