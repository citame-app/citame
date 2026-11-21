use super::*;
use sob_core::inventory::{Product, ProductQuery};
use sob_core::loyalty::stamps::RewardKind;

const SERVICES_PER_PAGE: usize = 12;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Scope {
    Qualifying,
    RewardService,
    RewardProduct,
}

#[derive(Clone)]
pub(super) struct Choice {
    pub(super) id: Uuid,
    pub(super) label: String,
}

pub(super) struct Picker {
    pub(super) scope: Scope,
    search: Entity<TextField>,
    page: u32,
    submitted: String,
    products: Vec<Choice>,
    more: bool,
    busy: bool,
    token: Arc<()>,
    failure: bool,
}

pub(super) struct Catalogue {
    pub(super) services: Vec<Choice>,
    pub(super) picker: Option<Picker>,
    pub(super) target: Option<Choice>,
}

pub(super) fn product_choice(product: Product) -> Choice {
    Choice {
        id: product.id,
        label: format!("{} · {}", product.name, product.sku),
    }
}

pub(super) fn service_choices(root: &Root) -> Option<Vec<Choice>> {
    let mut services: Vec<_> = root
        .svc
        .store
        .services()
        .ok()?
        .into_iter()
        .filter(|service| service.active)
        .filter_map(|service| {
            Some(Choice {
                id: Uuid::parse_str(&service.id).ok()?,
                label: match service.category.filter(|value| !value.is_empty()) {
                    Some(category) => format!("{} · {category}", service.name),
                    None => service.name,
                },
            })
        })
        .collect();
    services.sort_by_cached_key(|choice| choice.label.to_lowercase());
    Some(services)
}

impl Catalogue {
    pub(super) fn new(root: &Root) -> Self {
        Self {
            services: service_choices(root).unwrap_or_default(),
            picker: None,
            target: None,
        }
    }

    pub(super) fn clear_picker(&mut self) {
        self.picker = None;
    }

    pub(super) fn name(&self, id: Uuid, kind: RewardKind) -> Option<&str> {
        if kind == RewardKind::Product {
            self.target
                .as_ref()
                .filter(|choice| choice.id == id)
                .map(|choice| choice.label.as_str())
        } else {
            self.services
                .iter()
                .find(|choice| choice.id == id)
                .map(|choice| choice.label.as_str())
        }
    }
}

impl Root {
    pub(super) fn open_stamp_catalogue(&mut self, scope: Scope, cx: &mut Context<Self>) {
        let label = self.t(Key::StampProgrammeSearch);
        let search = cx.new(|cx| TextField::new(label, false, cx));
        cx.subscribe(&search, |root, _, event, cx| {
            if matches!(event, FieldEvent::Submit) {
                root.load_stamp_products(1, true, cx);
            } else if matches!(event, FieldEvent::Changed) {
                if let Some(picker) = root
                    .stamp_programme()
                    .and_then(|editor| editor.catalogue.picker.as_mut())
                    .filter(|picker| picker.scope != Scope::RewardProduct)
                {
                    picker.page = 1;
                }
                cx.notify();
            }
        })
        .detach();
        let Some(editor) = self
            .stamp_programme()
            .filter(|editor| !editor.busy && editor.review.is_none() && editor.draft.is_some())
        else {
            return;
        };
        editor.catalogue.picker = Some(Picker {
            scope,
            search,
            page: 1,
            submitted: String::new(),
            products: Vec::new(),
            more: false,
            busy: false,
            token: Arc::new(()),
            failure: false,
        });
        if scope == Scope::RewardProduct {
            self.load_stamp_products(1, true, cx);
        }
        cx.notify();
    }

    fn load_stamp_products(&mut self, page: u32, new_search: bool, cx: &mut Context<Self>) {
        let Some(transport) = self.svc.transport().filter(|_| {
            self.can_configure_points() && self.status.connectivity == Connectivity::Online
        }) else {
            return;
        };
        let session = self.svc.session.clone();
        let Some(picker) = self
            .stamp_programme()
            .and_then(|editor| editor.catalogue.picker.as_mut())
            .filter(|picker| picker.scope == Scope::RewardProduct && !picker.busy)
        else {
            return;
        };
        let search = if new_search {
            picker.search.read(cx).text()
        } else {
            &picker.submitted
        };
        let Some(query) = ProductQuery::new(search, false) else {
            picker.failure = true;
            cx.notify();
            return;
        };
        let token = picker.token.clone();
        picker.busy = true;
        picker.failure = false;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let products = transport.inventory_products(&query, page)?;
                    Ok::<_, TransportError>((query.search, products))
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || !root.can_configure_points() {
                    return;
                }
                let Some(picker) = root
                    .stamp_programme()
                    .and_then(|editor| editor.catalogue.picker.as_mut())
                    .filter(|picker| Arc::ptr_eq(&picker.token, &token))
                else {
                    return;
                };
                picker.busy = false;
                match result {
                    Ok((search, result)) => {
                        picker.submitted = search;
                        picker.page = result.pagination.page;
                        picker.more = result.pagination.has_next();
                        picker.products = result
                            .products
                            .into_iter()
                            .filter(|product| product.active)
                            .map(product_choice)
                            .collect();
                    }
                    Err(_) => {
                        picker.products.clear();
                        picker.more = false;
                        picker.failure = true;
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn apply_stamp_choice(&mut self, scope: Scope, choice: Choice, cx: &mut Context<Self>) {
        let Some(editor) = self.stamp_programme().filter(|editor| {
            !editor.busy
                && editor.review.is_none()
                && editor
                    .catalogue
                    .picker
                    .as_ref()
                    .is_some_and(|picker| picker.scope == scope)
        }) else {
            return;
        };
        let Some(draft) = editor.draft.as_mut() else {
            return;
        };
        if scope == Scope::Qualifying {
            let ids = &mut draft.qualifying_service_ids;
            if let Some(index) = ids.iter().position(|id| *id == choice.id) {
                ids.remove(index);
            } else if ids.len() < 50 {
                ids.push(choice.id);
            } else {
                editor.feedback = Some(Key::StampProgrammeServiceLimit);
                cx.notify();
                return;
            }
        } else {
            draft.card.reward.target_id = Some(choice.id);
            editor.catalogue.target = Some(choice);
            editor.catalogue.clear_picker();
        }
        editor.feedback = None;
        cx.notify();
    }

    fn step_stamp_catalogue(&mut self, page: u32, scope: Scope, cx: &mut Context<Self>) {
        if scope == Scope::RewardProduct {
            self.load_stamp_products(page, false, cx);
        } else if let Some(picker) = self
            .stamp_programme()
            .and_then(|editor| editor.catalogue.picker.as_mut())
        {
            picker.page = page;
            cx.notify();
        }
    }

    pub(super) fn render_stamp_catalogue(
        &self,
        editor: &Editor,
        picker: &Picker,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let scope = picker.scope;
        let page = picker.page;
        let product = scope == Scope::RewardProduct;
        let online = self.status.connectivity == Connectivity::Online;
        let draft = editor.draft.as_ref();
        let term = picker.search.read(cx).text().trim().to_lowercase();
        let matches = |choice: &&Choice| choice.label.to_lowercase().contains(&term);
        let start = (page.saturating_sub(1) as usize) * SERVICES_PER_PAGE;
        let visible: Vec<_> = if product {
            picker.products.iter().collect()
        } else {
            editor
                .catalogue
                .services
                .iter()
                .filter(matches)
                .skip(start)
                .take(SERVICES_PER_PAGE + 1)
                .collect()
        };
        let more = if product {
            picker.more
        } else {
            visible.len() > SERVICES_PER_PAGE
        };
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.label(match scope {
                Scope::Qualifying => Key::StampProgrammeQualifying,
                Scope::RewardService => Key::StampServiceReward,
                Scope::RewardProduct => Key::StampProductReward,
            }))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(picker.search.clone())
                    .when(product && !picker.busy && online, |row| {
                        row.child(self.loyalty_button(
                            "stamp-programme-product-search",
                            Key::StampProgrammeSearch,
                            Kind::Ghost,
                            |root, cx| root.load_stamp_products(1, true, cx),
                            cx,
                        ))
                    }),
            )
            .when(picker.busy, |panel| {
                panel.child(self.t(Key::MarketingLoading))
            })
            .when(picker.failure, |panel| {
                panel.child(self.t(Key::StampProgrammeProductError))
            })
            .when(
                !picker.busy && !picker.failure && visible.is_empty(),
                |panel| panel.child(self.t(Key::StampProgrammeNoMatches)),
            )
            .when(!picker.busy, |panel| {
                let choices = visible
                    .into_iter()
                    .take(if product {
                        usize::MAX
                    } else {
                        SERVICES_PER_PAGE
                    })
                    .map(|choice| {
                        let selected = draft.is_some_and(|draft| {
                            if scope == Scope::Qualifying {
                                draft.qualifying_service_ids.contains(&choice.id)
                            } else {
                                draft.card.reward.target_id == Some(choice.id)
                            }
                        });
                        let choice = choice.clone();
                        self.chip(
                            SharedString::from(format!("stamp-programme-choice-{}", choice.id)),
                            choice.label.clone(),
                            selected,
                            cx.listener(move |root, _, _, cx| {
                                root.apply_stamp_choice(scope, choice.clone(), cx)
                            }),
                        )
                        .tab_index(0)
                    })
                    .collect::<Vec<_>>();
                panel.child(div().flex().flex_wrap().gap_2().children(choices))
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .when(!picker.busy && page > 1 && (!product || online), |row| {
                        row.child(self.loyalty_button(
                            "stamp-programme-catalogue-prev",
                            Key::MarketingPreviousPage,
                            Kind::Ghost,
                            move |root, cx| root.step_stamp_catalogue(page - 1, scope, cx),
                            cx,
                        ))
                    })
                    .when(!picker.busy && more && (!product || online), |row| {
                        row.child(self.loyalty_button(
                            "stamp-programme-catalogue-next",
                            Key::MarketingNextPage,
                            Kind::Ghost,
                            move |root, cx| root.step_stamp_catalogue(page + 1, scope, cx),
                            cx,
                        ))
                    })
                    .child(self.loyalty_button(
                        "stamp-programme-catalogue-close",
                        Key::Back,
                        Kind::Ghost,
                        |root, cx| root.close_stamp_programme(false, cx),
                        cx,
                    )),
            )
    }
}
