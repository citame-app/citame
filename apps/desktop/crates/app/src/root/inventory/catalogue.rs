use super::*;

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

impl Facet {
    fn active(self, query: &ProductQuery) -> &Option<String> {
        match self {
            Self::Category => &query.category,
            Self::Brand => &query.brand,
        }
    }

    fn set(self, query: &mut ProductQuery, value: Option<String>) {
        match self {
            Self::Category => query.category = value,
            Self::Brand => query.brand = value,
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
            .when_some(desk.catalogue_tools.facets.as_ref(), |body, facets| {
                body.child(self.render_inventory_facet(
                    query,
                    Facet::Category,
                    &facets.categories,
                    cx,
                ))
                .child(self.render_inventory_facet(
                    query,
                    Facet::Brand,
                    &facets.brands,
                    cx,
                ))
            })
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
        values: &[String],
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
                    .children(values.iter().enumerate().map(|(i, value)| {
                        let chosen = value.clone();
                        self.button(
                            (id, i + 1),
                            value.clone(),
                            selected(active.as_ref() == Some(value)),
                            cx.listener(move |root, _, _, cx| {
                                root.filter_inventory_catalogue(
                                    |query| facet.set(query, Some(chosen.clone())),
                                    cx,
                                )
                            }),
                        )
                    })),
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
