use super::*;
use sob_core::inventory_classifications::ClassificationKind;
use uuid::Uuid;

#[derive(Default)]
pub(super) struct Tools {
    pub(super) facets: Option<InventoryFacets>,
    pub(super) report: Option<InventoryReport>,
    filters_open: bool,
    export: Option<Arc<()>>,
    export_notice: Option<Key>,
}

#[derive(Clone, Copy)]
enum Facet {
    Category,
    Brand,
}

#[derive(Clone, PartialEq, Eq)]
enum FilterValue {
    Managed(Uuid),
    Label(String),
}

impl Facet {
    fn active(self, query: &ProductQuery) -> Option<FilterValue> {
        let (id, label) = match self {
            Self::Category => (query.category_id, &query.category),
            Self::Brand => (query.brand_id, &query.brand),
        };
        id.map(FilterValue::Managed)
            .or_else(|| label.clone().map(FilterValue::Label))
    }

    fn set(self, query: &mut ProductQuery, value: Option<FilterValue>) {
        let (id, label) = match value {
            Some(FilterValue::Managed(id)) => (Some(id), None),
            Some(FilterValue::Label(label)) => (None, Some(label)),
            None => (None, None),
        };
        match self {
            Self::Category => {
                query.category_id = id;
                query.category = label;
            }
            Self::Brand => {
                query.brand_id = id;
                query.brand = label;
            }
        }
    }
}

impl Root {
    pub(super) fn filter_inventory_catalogue(
        &mut self,
        update: impl FnOnce(&mut ProductQuery),
        cx: &mut Context<Self>,
    ) {
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return;
        };
        if desk.request.is_some() || desk.product.is_some() || desk.ledger.is_some() {
            return;
        }
        let Some(mut query) = desk.query.clone().with_search(desk.search.read(cx).text()) else {
            desk.error = Some(Key::InventorySearchInvalid);
            cx.notify();
            return;
        };
        update(&mut query);
        self.request_inventory(Action::Catalog(query, 1), cx);
    }

    fn export_inventory_products(&mut self, cx: &mut Context<Self>) {
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
        if desk.request.is_some() || desk.catalog.is_none() || desk.catalogue_tools.export.is_some()
        {
            return;
        }
        let query = desk.query.clone();
        let token = Arc::new(());
        desk.catalogue_tools.export = Some(token.clone());
        desk.catalogue_tools.export_notice = None;
        cx.notify();
        prompt_csv_export(
            "citame-products.csv",
            |_| true,
            move |output| {
                transport
                    .write_inventory_products_csv(&query, output)
                    .map_err(std::io::Error::other)
            },
            move |root, notice, cx| {
                if let Overlay::Inventory(desk) = &mut root.overlay
                    && desk
                        .catalogue_tools
                        .export
                        .as_ref()
                        .is_some_and(|active| Arc::ptr_eq(&token, active))
                {
                    desk.catalogue_tools.export = None;
                    desk.catalogue_tools.export_notice = notice;
                    cx.notify();
                }
            },
            cx,
        );
    }

    pub(super) fn render_catalogue_tools(
        &self,
        desk: &Desk,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let tools = &desk.catalogue_tools;
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.button(
                        "catalogue-filters-toggle",
                        self.t(Key::InventoryFilters),
                        if tools.filters_open {
                            Kind::Primary
                        } else {
                            Kind::Ghost
                        },
                        cx.listener(|root, _, _, cx| {
                            if let Overlay::Inventory(desk) = &mut root.overlay {
                                desk.catalogue_tools.filters_open =
                                    !desk.catalogue_tools.filters_open;
                                cx.notify();
                            }
                        }),
                    ))
                    .when(
                        ready && desk.catalog.is_some() && tools.export.is_none(),
                        |row| {
                            row.child(self.button(
                                "catalogue-export",
                                self.t(Key::ReportExport),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| root.export_inventory_products(cx)),
                            ))
                        },
                    ),
            )
            .when(tools.filters_open, |body| {
                body.child(self.render_catalogue_filters(desk, cx))
            })
            .when_some(tools.report.as_ref(), |body, report| {
                body.child(self.render_inventory_totals(report))
            })
            .when_some(tools.export_notice, |body, notice| {
                body.child(self.t(notice))
            })
    }

    fn render_subcategory_filter(&self, query: &ProductQuery, cx: &mut Context<Self>) -> gpui::Div {
        let entries = self
            .svc
            .store
            .displayed_inventory_classifications()
            .ok()
            .flatten()
            .map(|list| list.entries)
            .unwrap_or_default();
        let children = entries
            .iter()
            .filter_map(|row| {
                let parent = entries
                    .iter()
                    .find(|entry| Some(entry.id) == row.parent_id)?;
                Some((Some(row.id), format!("{} / {}", parent.name, row.name)))
            })
            .collect::<Vec<_>>();
        if children.is_empty() && query.subcategory_id.is_none() {
            return div();
        }
        div()
            .child(self.label(Key::InventoryClassificationSubcategory))
            .child(
                div().flex().flex_wrap().gap_2().children(
                    std::iter::once((
                        None,
                        self.t(Key::InventoryClassificationEverySubcategory)
                            .to_owned(),
                    ))
                    .chain(children)
                    .enumerate()
                    .map(|(index, (id, label))| {
                        self.button(
                            ("inventory-subcategory-filter", index),
                            label,
                            selected(id == query.subcategory_id),
                            cx.listener(move |root, _, _, cx| {
                                root.filter_inventory_catalogue(
                                    |query| {
                                        query.subcategory_id = id;
                                    },
                                    cx,
                                )
                            }),
                        )
                    }),
                ),
            )
    }

    fn render_catalogue_filters(&self, desk: &Desk, cx: &mut Context<Self>) -> gpui::Div {
        let query = &desk.query;
        const ACTIVITY: [(ProductActivity, Key); 3] = [
            (ProductActivity::Active, Key::InventoryActive),
            (ProductActivity::Archived, Key::InventoryOnlyArchived),
            (ProductActivity::All, Key::InventoryAllProducts),
        ];
        const SALE: [(Option<bool>, Key); 3] = [
            (None, Key::InventoryAnyUse),
            (Some(true), Key::InventoryRetail),
            (Some(false), Key::InventoryInternal),
        ];
        const SORT: [(ProductSort, Key); 4] = [
            (ProductSort::NameAscending, Key::InventorySortName),
            (ProductSort::NameDescending, Key::InventorySortNameReverse),
            (ProductSort::Updated, Key::InventorySortUpdated),
            (ProductSort::Stock, Key::InventorySortStock),
        ];
        const SIZES: [ProductPageSize; 3] = [
            ProductPageSize::Twenty,
            ProductPageSize::Fifty,
            ProductPageSize::Hundred,
        ];
        div()
            .flex()
            .flex_col()
            .gap_2()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .p_2()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children(
                        ACTIVITY
                            .into_iter()
                            .enumerate()
                            .map(|(i, (activity, label))| {
                                self.button(
                                    ("inventory-activity", i),
                                    self.t(label),
                                    selected(query.activity == activity),
                                    cx.listener(move |root, _, _, cx| {
                                        root.filter_inventory_catalogue(
                                            |q| q.activity = activity,
                                            cx,
                                        )
                                    }),
                                )
                            }),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children(
                        SALE.into_iter()
                            .enumerate()
                            .map(|(i, (resellable, label))| {
                                self.button(
                                    ("inventory-resellable", i),
                                    self.t(label),
                                    selected(query.resellable == resellable),
                                    cx.listener(move |root, _, _, cx| {
                                        root.filter_inventory_catalogue(
                                            |q| q.resellable = resellable,
                                            cx,
                                        )
                                    }),
                                )
                            }),
                    )
                    .child(self.button(
                        "inventory-low-stock",
                        self.t(Key::InventoryLowStock),
                        selected(query.low_stock),
                        cx.listener(|root, _, _, cx| {
                            root.filter_inventory_catalogue(|q| q.low_stock = !q.low_stock, cx)
                        }),
                    )),
            )
            .child(self.render_inventory_facet(query, Facet::Category, cx))
            .child(self.render_inventory_facet(query, Facet::Brand, cx))
            .child(self.render_subcategory_filter(query, cx))
            .child(self.label(Key::InventorySort))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children(SORT.into_iter().enumerate().map(|(i, (sort, label))| {
                        self.button(
                            ("inventory-sort", i),
                            self.t(label),
                            selected(query.sort == sort),
                            cx.listener(move |root, _, _, cx| {
                                root.filter_inventory_catalogue(|q| q.sort = sort, cx)
                            }),
                        )
                    })),
            )
            .child(self.label(Key::InventoryRowsPerPage))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children(SIZES.into_iter().enumerate().map(|(i, size)| {
                        self.button(
                            ("inventory-page-size", i),
                            size.number().to_string(),
                            selected(query.page_size == size),
                            cx.listener(move |root, _, _, cx| {
                                root.filter_inventory_catalogue(|q| q.page_size = size, cx)
                            }),
                        )
                    })),
            )
    }

    fn render_inventory_facet(
        &self,
        query: &ProductQuery,
        facet: Facet,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let (id, heading, any) = match facet {
            Facet::Category => (
                "inventory-category",
                Key::InventoryCategoryFilter,
                Key::InventoryAnyCategory,
            ),
            Facet::Brand => (
                "inventory-brand",
                Key::InventoryBrandFilter,
                Key::InventoryAnyBrand,
            ),
        };
        let legacy = match &self.overlay {
            Overlay::Inventory(desk) => desk.catalogue_tools.facets.as_ref(),
            _ => None,
        };
        let labels = legacy.map_or(&[][..], |facets| match facet {
            Facet::Category => &facets.categories,
            Facet::Brand => &facets.brands,
        });
        let kind = match facet {
            Facet::Category => ClassificationKind::Category,
            Facet::Brand => ClassificationKind::Brand,
        };
        let roots = self
            .svc
            .store
            .displayed_inventory_classifications()
            .ok()
            .flatten()
            .map(|catalogue| catalogue.entries)
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| entry.kind == kind && entry.parent_id.is_none())
            .collect::<Vec<_>>();
        let managed = roots
            .iter()
            .map(|entry| (FilterValue::Managed(entry.id), entry.name.clone()));
        let legacy = labels
            .iter()
            .filter(|label| {
                let normalized = label.trim().to_lowercase();
                !roots
                    .iter()
                    .any(|entry| entry.name.to_lowercase() == normalized)
            })
            .map(|label| (FilterValue::Label(label.clone()), label.clone()));
        let active = facet.active(query);
        div().child(self.label(heading)).child(
            div().id(id).max_h(px(108.)).overflow_y_scroll().child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .child(self.button(
                        (id, 0usize),
                        self.t(any),
                        selected(active.is_none()),
                        cx.listener(move |root, _, _, cx| {
                            root.filter_inventory_catalogue(|query| facet.set(query, None), cx)
                        }),
                    ))
                    .children(
                        managed
                            .chain(legacy)
                            .enumerate()
                            .map(|(i, (value, label))| {
                                let is_selected = active.as_ref() == Some(&value);
                                self.button(
                                    (id, i + 1),
                                    label,
                                    selected(is_selected),
                                    cx.listener(move |root, _, _, cx| {
                                        root.filter_inventory_catalogue(
                                            |query| facet.set(query, Some(value.clone())),
                                            cx,
                                        )
                                    }),
                                )
                            }),
                    ),
            ),
        )
    }

    fn render_inventory_totals(&self, report: &InventoryReport) -> gpui::Div {
        let metric = |label, value: String| {
            div()
                .min_w(px(110.))
                .flex_1()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(label)),
                )
                .child(div().font_weight(FontWeight::SEMIBOLD).child(value))
        };
        div()
            .flex()
            .flex_wrap()
            .gap_3()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .p_2()
            .child(metric(
                Key::InventoryProductCount,
                report.products.to_string(),
            ))
            .child(metric(Key::InventoryOnHand, report.on_hand.to_string()))
            .child(metric(Key::InventoryReserved, report.reserved.to_string()))
            .child(metric(
                Key::InventoryAvailable,
                report.on_hand.saturating_sub(report.reserved).to_string(),
            ))
            .child(metric(
                Key::InventoryLowStock,
                report.low_stock_products.to_string(),
            ))
            .when_some(report.valuation.as_ref(), |body, value| {
                body.when_some(format_valuation(self.locale, value), |body, amount| {
                    body.child(metric(Key::InventoryValuation, amount))
                })
                .child(metric(
                    Key::InventoryMissingCost,
                    value.products_missing_cost.to_string(),
                ))
            })
    }
}

fn selected(active: bool) -> Kind {
    if active { Kind::Primary } else { Kind::Ghost }
}

fn format_valuation(
    locale: Locale,
    valuation: &sob_core::inventory::InventoryValuation,
) -> Option<String> {
    let value: u128 = valuation.known_cost_cents.parse().ok()?;
    if let Ok(value) = i64::try_from(value) {
        return Some(i18n::amount_label(locale, value, &valuation.currency));
    }
    let decimal = if locale == Locale::EsAr { ',' } else { '.' };
    Some(format!(
        "{}{}{:02} {}",
        value / 100,
        decimal,
        value % 100,
        valuation.currency
    ))
}
