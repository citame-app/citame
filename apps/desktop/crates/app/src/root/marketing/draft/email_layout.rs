use super::*;
use sob_core::http::marketing::{EmailBlock, EmailEmphasis, EmailHeaderImage};
use sob_core::staff_portrait_image::prepare_photo_with_limit;

pub(super) struct LayoutEditor {
    heading: Entity<TextField>,
    preheader: Entity<TextField>,
    header: Option<HeaderEditor>,
    remove_header: bool,
    selecting_image: bool,
    image_error: bool,
    identity: Arc<()>,
    blocks: Vec<(usize, BlockEditor)>,
    next_id: usize,
}

struct HeaderEditor {
    description: Entity<TextField>,
    image_base64: String,
    preview: Option<Arc<gpui::Image>>,
}

fn header_preview(image: &EmailHeaderImage) -> Option<Arc<gpui::Image>> {
    let bytes = image.jpeg_bytes()?;
    Some(Arc::new(gpui::Image::from_bytes(
        gpui::ImageFormat::Jpeg,
        bytes,
    )))
}

enum BlockEditor {
    Heading(Entity<TextField>),
    Paragraph(MessageInput, EmailEmphasis),
    Booking(Entity<TextField>),
}

#[derive(Clone, Copy)]
enum BlockKind {
    Heading,
    Paragraph,
    Booking,
}

impl BlockKind {
    fn empty(self) -> EmailBlock {
        match self {
            Self::Heading => EmailBlock::Heading {
                text: String::new(),
            },
            Self::Paragraph => EmailBlock::Paragraph {
                text: String::new(),
                emphasis: EmailEmphasis::None,
            },
            Self::Booking => EmailBlock::Booking {
                label: String::new(),
            },
        }
    }

    fn add_label(self) -> Key {
        match self {
            Self::Heading => Key::MarketingAddEmailHeading,
            Self::Paragraph => Key::MarketingAddEmailParagraph,
            Self::Booking => Key::MarketingAddEmailBooking,
        }
    }
}

impl LayoutEditor {
    pub(super) fn new(layout: EmailLayout, cx: &mut Context<Root>) -> Self {
        let mut editor = Self {
            heading: input(&layout.heading, cx),
            preheader: input(&layout.preheader, cx),
            remove_header: matches!(layout.header_image, Some(None)),
            header: layout.header_image.flatten().map(|image| HeaderEditor {
                description: input(&image.alt, cx),
                preview: header_preview(&image),
                image_base64: image.image_base64,
            }),
            selecting_image: false,
            image_error: false,
            identity: Arc::new(()),
            blocks: Vec::new(),
            next_id: 0,
        };
        for block in layout.blocks {
            editor.push(block, cx);
        }
        editor
    }

    fn push(&mut self, block: EmailBlock, cx: &mut Context<Root>) {
        if self.blocks.len() >= EmailLayout::BLOCK_LIMIT {
            return;
        }
        let id = self.next_id;
        self.next_id += 1;
        let block = match block {
            EmailBlock::Heading { text } => BlockEditor::Heading(input(&text, cx)),
            EmailBlock::Paragraph { text, emphasis } => BlockEditor::Paragraph(
                MessageInput::new(Message::Paragraph(id), &text, cx),
                emphasis,
            ),
            EmailBlock::Booking { label } => BlockEditor::Booking(input(&label, cx)),
        };
        self.blocks.push((id, block));
    }

    fn move_block(&mut self, id: usize, down: bool) {
        let Some(index) = self.blocks.iter().position(|(key, _)| *key == id) else {
            return;
        };
        let target = index.checked_add_signed(if down { 1 } else { -1 });
        if let Some(target) = target.filter(|&target| target < self.blocks.len()) {
            self.blocks.swap(index, target);
        }
    }

    fn set_emphasis(&mut self, id: usize, style: EmailEmphasis) {
        if let Some((_, BlockEditor::Paragraph(_, emphasis))) =
            self.blocks.iter_mut().find(|(key, _)| *key == id)
        {
            *emphasis = style;
        }
    }

    fn remove_block(&mut self, id: usize) {
        if self.blocks.len() > 1 {
            self.blocks.retain(|(key, _)| *key != id);
        }
    }

    pub(super) fn paragraph_mut(&mut self, id: usize) -> Option<&mut MessageInput> {
        let (_, BlockEditor::Paragraph(message, _)) =
            self.blocks.iter_mut().find(|(key, _)| *key == id)?
        else {
            return None;
        };
        Some(message)
    }

    pub(super) fn packet(&self, cx: &App) -> EmailLayout {
        EmailLayout {
            heading: text(&self.heading, cx),
            preheader: text(&self.preheader, cx),
            header_image: self
                .header
                .as_ref()
                .map(|header| {
                    Some(EmailHeaderImage {
                        alt: text(&header.description, cx),
                        image_base64: header.image_base64.clone(),
                    })
                })
                .or(self.remove_header.then_some(None)),
            blocks: self
                .blocks
                .iter()
                .map(|(_, block)| match block {
                    BlockEditor::Heading(field) => EmailBlock::Heading {
                        text: text(field, cx),
                    },
                    BlockEditor::Paragraph(message, emphasis) => EmailBlock::Paragraph {
                        text: message_text(&message.lines, cx),
                        emphasis: *emphasis,
                    },
                    BlockEditor::Booking(field) => EmailBlock::Booking {
                        label: text(field, cx),
                    },
                })
                .collect(),
        }
    }

    pub(super) fn selecting_image(&self) -> bool {
        self.selecting_image
    }

    fn finish_header_selection(
        &mut self,
        selected: Result<Option<Vec<u8>>, ()>,
        cx: &mut Context<Root>,
    ) {
        self.selecting_image = false;
        match selected {
            Ok(Some(bytes)) => {
                let description = self
                    .header
                    .as_ref()
                    .map(|header| header.description.clone())
                    .unwrap_or_else(|| input("", cx));
                self.header = Some(HeaderEditor {
                    description,
                    image_base64: EmailHeaderImage::from_jpeg(&bytes, String::new()).image_base64,
                    preview: Some(Arc::new(gpui::Image::from_bytes(
                        gpui::ImageFormat::Jpeg,
                        bytes,
                    ))),
                });
            }
            Ok(None) => {}
            Err(()) => self.image_error = true,
        }
    }
}

impl Root {
    fn select_campaign_header_image(&mut self, cx: &mut Context<Self>) {
        let prompt = self.t(Key::MarketingEmailImageChoose);
        let Some(layout) = self
            .marketing_desk()
            .and_then(|desk| desk.editor.as_mut())
            .and_then(|editor| editor.email_layout.as_mut())
            .filter(|layout| !layout.selecting_image)
        else {
            return;
        };
        layout.selecting_image = true;
        layout.image_error = false;
        let identity = layout.identity.clone();
        let picker = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(prompt.into()),
        });
        cx.notify();
        cx.spawn(async move |root, cx| {
            let selected = match picker.await {
                Ok(Ok(paths)) => match paths.and_then(|paths| paths.into_iter().next()) {
                    None => Ok(None),
                    Some(path) => {
                        cx.background_executor()
                            .spawn(async move {
                                prepare_photo_with_limit(&path, 15 * 1024 * 1024)
                                    .map(Some)
                                    .ok_or(())
                            })
                            .await
                    }
                },
                _ => Err(()),
            };
            let _ = root.update(cx, |root, cx| {
                root.edit_email_layout(cx, |layout, cx| {
                    if !Arc::ptr_eq(&layout.identity, &identity) {
                        return;
                    }
                    layout.finish_header_selection(selected, cx);
                });
            });
        })
        .detach();
    }

    fn edit_email_layout(
        &mut self,
        cx: &mut Context<Self>,
        apply: impl FnOnce(&mut LayoutEditor, &mut Context<Self>),
    ) {
        if let Some(layout) = self
            .marketing_desk()
            .and_then(|desk| desk.editor.as_mut())
            .and_then(|editor| editor.email_layout.as_mut())
        {
            apply(layout, cx);
            cx.notify();
        }
    }

    pub(super) fn render_email_editor(&self, editor: &Editor, cx: &mut Context<Self>) -> gpui::Div {
        let formatted = editor.email_layout.is_some();
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.label(Key::MarketingEmailFormat))
            .child(
                div().flex().flex_wrap().gap_2().children(
                    [
                        (false, Key::MarketingPlainEmail),
                        (true, Key::MarketingFormattedEmail),
                    ]
                    .into_iter()
                    .map(|(layout, key)| {
                        self.chip(
                            ("marketing-email-format", usize::from(layout)),
                            self.t(key),
                            formatted == layout,
                            cx.listener(move |root, _, _, cx| {
                                let Some(editor) =
                                    root.marketing_desk().and_then(|desk| desk.editor.as_mut())
                                else {
                                    return;
                                };
                                if layout && editor.email_layout.is_none() {
                                    let body = message_text(&editor.email.lines, cx);
                                    editor.email_layout = Some(LayoutEditor::new(
                                        EmailLayout {
                                            heading: String::new(),
                                            preheader: String::new(),
                                            header_image: None,
                                            blocks: vec![EmailBlock::Paragraph {
                                                text: body,
                                                emphasis: EmailEmphasis::None,
                                            }],
                                        },
                                        cx,
                                    ));
                                } else if !layout && let Some(current) = editor.email_layout.take()
                                {
                                    let body = current.packet(cx).plain_text();
                                    editor.email = MessageInput::new(Message::Email, &body, cx);
                                }
                                cx.notify();
                            }),
                        )
                        .tab_index(0)
                        .focus(|style| style.border_color(theme::text()))
                        .debug_selector(move || format!("marketing-email-format-{layout}"))
                    }),
                ),
            )
            .child(if let Some(layout) = &editor.email_layout {
                self.render_formatted_email(layout, cx)
            } else {
                self.edit_message(Message::Email, &editor.email.lines, cx)
            })
    }

    fn render_formatted_email(&self, layout: &LayoutEditor, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.label(Key::MarketingEmailHeading))
            .child(layout.heading.clone())
            .child(self.label(Key::MarketingEmailPreheader))
            .child(layout.preheader.clone())
            .child(self.label(Key::MarketingEmailImage))
            .child(if layout.selecting_image {
                div().child(self.t(Key::MarketingEmailImagePreparing))
            } else {
                div().child(
                    self.marketing_button(
                        "choose-campaign-header-image",
                        if layout.header.is_some() {
                            Key::MarketingEmailImageReplace
                        } else {
                            Key::MarketingEmailImageChoose
                        },
                        Kind::Ghost,
                        Root::select_campaign_header_image,
                        cx,
                    )
                    .debug_selector(|| "choose-campaign-header-image".into()),
                )
            })
            .when(layout.image_error, |body| {
                body.child(
                    div()
                        .text_color(theme::conflict_fg())
                        .child(self.t(Key::MarketingEmailImageInvalid)),
                )
            })
            .when_some(layout.header.as_ref(), |body, header| {
                body.when_some(header.preview.as_ref(), |body, preview| {
                    body.child(campaign_header_image(preview.clone()))
                })
                .child(self.label(Key::MarketingEmailImageAlt))
                .child(header.description.clone())
                .when(!layout.selecting_image, |body| {
                    body.child(
                        self.marketing_button(
                            "remove-campaign-header-image",
                            Key::MarketingEmailImageRemove,
                            Kind::Ghost,
                            |root, cx| {
                                root.edit_email_layout(cx, |layout, _| {
                                    layout.header = None;
                                    layout.remove_header = true;
                                    layout.image_error = false;
                                })
                            },
                            cx,
                        )
                        .debug_selector(|| "remove-campaign-header-image".into()),
                    )
                })
            })
            .children(
                layout
                    .blocks
                    .iter()
                    .enumerate()
                    .map(|(index, (id, block))| {
                        let id = *id;
                        let at_end = index + 1 == layout.blocks.len();
                        div()
                            .flex()
                            .flex_col()
                            .gap_2()
                            .p_3()
                            .rounded_md()
                            .border_1()
                            .border_color(theme::line())
                            .child(match block {
                                BlockEditor::Heading(field) => div()
                                    .flex()
                                    .flex_col()
                                    .gap_2()
                                    .child(self.label(Key::MarketingEmailSubtitle))
                                    .child(field.clone()),
                                BlockEditor::Booking(field) => div()
                                    .flex()
                                    .flex_col()
                                    .gap_2()
                                    .child(self.label(Key::MarketingEmailBooking))
                                    .child(field.clone()),
                                BlockEditor::Paragraph(message, emphasis) => self
                                    .edit_message(Message::Paragraph(id), &message.lines, cx)
                                    .child(self.label(Key::MarketingEmailEmphasis))
                                    .child(self.email_emphasis_options(id, *emphasis, cx)),
                            })
                            .child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .gap_2()
                                    .when(index > 0, |row| {
                                        row.child(self.email_move_button(id, false, cx))
                                    })
                                    .when(!at_end, |row| {
                                        row.child(self.email_move_button(id, true, cx))
                                    })
                                    .when(layout.blocks.len() > 1, |row| {
                                        row.child(
                                            self.marketing_button(
                                                SharedString::from(format!("email-remove-{id}")),
                                                Key::MarketingRemoveEmailBlock,
                                                Kind::Ghost,
                                                move |root, cx| {
                                                    root.edit_email_layout(cx, |layout, _| {
                                                        layout.remove_block(id);
                                                    })
                                                },
                                                cx,
                                            )
                                            .debug_selector(move || format!("email-remove-{id}")),
                                        )
                                    }),
                            )
                    }),
            )
            .when(layout.blocks.len() < EmailLayout::BLOCK_LIMIT, |body| {
                body.child(
                    div().flex().flex_wrap().gap_2().children(
                        [BlockKind::Paragraph, BlockKind::Heading, BlockKind::Booking]
                            .into_iter()
                            .enumerate()
                            .map(|(index, kind)| {
                                self.marketing_button(
                                    ("email-block-add", index),
                                    kind.add_label(),
                                    Kind::Ghost,
                                    move |root, cx| {
                                        root.edit_email_layout(cx, |layout, cx| {
                                            layout.push(kind.empty(), cx)
                                        })
                                    },
                                    cx,
                                )
                                .debug_selector(move || format!("email-block-add-{index}"))
                            }),
                    ),
                )
            })
    }

    fn email_move_button(
        &self,
        id: usize,
        down: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        self.marketing_button(
            SharedString::from(format!("email-move-{id}-{down}")),
            if down {
                Key::FormMoveDown
            } else {
                Key::FormMoveUp
            },
            Kind::Ghost,
            move |root, cx| root.edit_email_layout(cx, |layout, _| layout.move_block(id, down)),
            cx,
        )
        .debug_selector(move || format!("email-move-{id}-{down}"))
    }

    fn email_emphasis_options(
        &self,
        id: usize,
        emphasis: EmailEmphasis,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        div().flex().flex_wrap().gap_2().children(
            [
                (EmailEmphasis::None, Key::MarketingEmailStyleNormal),
                (EmailEmphasis::Strong, Key::MarketingEmailStyleBold),
                (EmailEmphasis::Italic, Key::MarketingEmailStyleItalic),
            ]
            .into_iter()
            .enumerate()
            .map(|(index, (style, key))| {
                self.chip(
                    (SharedString::from(format!("email-emphasis-{id}")), index),
                    self.t(key),
                    style == emphasis,
                    cx.listener(move |root, _, _, cx| {
                        root.edit_email_layout(cx, |layout, _| layout.set_emphasis(id, style));
                    }),
                )
                .tab_index(0)
                .focus(|style| style.border_color(theme::text()))
                .debug_selector(move || format!("email-emphasis-{id}-{index}"))
            }),
        )
    }

    pub(in crate::root::marketing) fn render_email_layout_preview(
        &self,
        layout: &EmailLayout,
        image: Option<Arc<gpui::Image>>,
    ) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .when(!layout.preheader.is_empty(), |body| {
                body.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(preview_message(&layout.preheader)),
                )
            })
            .when_some(layout.header_image(), |body, header| {
                body.when_some(image, |body, image| {
                    body.child(campaign_header_image(image))
                })
                .child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(header.alt.clone()),
                )
            })
            .when(!layout.heading.is_empty(), |body| {
                body.child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(preview_message(&layout.heading)),
                )
            })
            .children(layout.blocks.iter().map(|block| {
                match block {
                    EmailBlock::Heading { text } => div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(preview_message(text)),
                    EmailBlock::Paragraph { text, emphasis } => div()
                        .when(*emphasis == EmailEmphasis::Strong, |line| {
                            line.font_weight(FontWeight::BOLD)
                        })
                        .when(*emphasis == EmailEmphasis::Italic, |line| line.italic())
                        .child(preview_message(text)),
                    EmailBlock::Booking { label } => div().flex().child(
                        div()
                            .rounded_md()
                            .px_3()
                            .py_2()
                            .border_1()
                            .border_color(theme::line())
                            .child(preview_message(label)),
                    ),
                }
            }))
    }
}

impl LayoutEditor {
    pub(super) fn image_preview(&self) -> Option<Arc<gpui::Image>> {
        self.header.as_ref()?.preview.clone()
    }
}

pub(in crate::root::marketing) fn saved_header_preview(
    layout: &EmailLayout,
) -> Option<Arc<gpui::Image>> {
    header_preview(layout.header_image()?)
}

fn campaign_header_image(image: Arc<gpui::Image>) -> gpui::Img {
    gpui::img(image)
        .w_full()
        .h(px(160.))
        .object_fit(gpui::ObjectFit::Contain)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click_control(cx: &mut gpui::VisualTestContext, selector: &'static str) {
        let viewport = cx.debug_bounds("marketing-body").unwrap();
        let center = cx.debug_bounds(selector).unwrap().center();
        if center.y < viewport.top() || center.y > viewport.bottom() {
            cx.simulate_event(gpui::ScrollWheelEvent {
                position: viewport.center(),
                delta: gpui::ScrollDelta::Pixels(gpui::point(
                    px(0.),
                    viewport.center().y - center.y,
                )),
                ..Default::default()
            });
            cx.run_until_parked();
        }
        let center = cx.debug_bounds(selector).unwrap().center();
        assert!(
            center.y >= viewport.top() && center.y <= viewport.bottom(),
            "{selector}"
        );
        cx.simulate_click(center, Default::default());
        cx.run_until_parked();
    }

    #[gpui::test]
    async fn native_campaign_header_can_be_selected_described_and_removed(
        cx: &mut gpui::TestAppContext,
    ) {
        let (directory, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| {
            let mut root = Root::new(config, window, cx);
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Offline;
            root.open_marketing(cx);
            root.status.connectivity = Connectivity::Online;
            root.open_campaign_editor(EditorMode::Create(Trigger::Manual), cx);
            root
        });
        let path = directory.path().join("camera.png");
        std::fs::write(
            &path,
            [
                137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 12, 0, 0, 0,
                6, 8, 2, 0, 0, 0, 120, 140, 232, 214, 0, 0, 0, 9, 112, 72, 89, 115, 0, 0, 3, 232,
                0, 0, 3, 232, 1, 181, 123, 82, 107, 0, 0, 0, 17, 73, 68, 65, 84, 8, 153, 99, 152,
                101, 17, 71, 16, 49, 12, 85, 69, 0, 38, 105, 85, 129, 246, 211, 109, 122, 0, 0, 0,
                0, 73, 69, 78, 68, 174, 66, 96, 130,
            ],
        )
        .unwrap();
        cx.simulate_resize(gpui::size(px(1100.), px(740.)));
        cx.run_until_parked();
        click_control(cx, "marketing-email-format-true");
        assert!(cx.debug_bounds("choose-campaign-header-image").is_some());
        let prepared = prepare_photo_with_limit(&path, 15 * 1024 * 1024).unwrap();
        // GPUI's TestPlatform does not implement opening the system picker.
        root.update(cx, |root, cx| {
            root.edit_email_layout(cx, |layout, cx| {
                layout.finish_header_selection(Ok(Some(prepared)), cx)
            })
        });
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            let editor = root.marketing_desk().unwrap().editor.as_ref().unwrap();
            assert!(editor.packet(cx).is_none());
            let header = editor
                .email_layout
                .as_ref()
                .unwrap()
                .header
                .as_ref()
                .unwrap();
            assert!(header.preview.is_some());
            header
                .description
                .update(cx, |field, cx| field.set_text("Studio exterior", cx));
            let layout = editor
                .packet(cx)
                .unwrap()
                .draft
                .email_layout
                .unwrap()
                .unwrap();
            assert_eq!(layout.header_image().unwrap().alt, "Studio exterior");
            assert!(
                layout
                    .header_image()
                    .unwrap()
                    .jpeg_bytes()
                    .unwrap()
                    .starts_with(&[255, 216, 255])
            );
        });
        click_control(cx, "remove-campaign-header-image");
        root.update(cx, |root, cx| {
            let editor = root.marketing_desk().unwrap().editor.as_ref().unwrap();
            let layout = editor
                .packet(cx)
                .unwrap()
                .draft
                .email_layout
                .unwrap()
                .unwrap();
            assert_eq!(layout.header_image, Some(None));
        });
    }

    #[gpui::test]
    async fn native_campaign_controls_create_style_reorder_and_remove_blocks(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_directory, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| {
            let mut root = Root::new(config, window, cx);
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Offline;
            root.open_marketing(cx);
            root.status.connectivity = Connectivity::Online;
            root.open_campaign_editor(EditorMode::Create(Trigger::Manual), cx);
            root
        });
        cx.simulate_resize(gpui::size(px(1100.), px(740.)));
        cx.run_until_parked();
        click_control(cx, "marketing-email-format-true");
        click_control(cx, "email-emphasis-0-1");
        click_control(cx, "email-block-add-2");
        click_control(cx, "email-move-1-false");
        root.update(cx, |root, cx| {
            let editor = root.marketing_desk().unwrap().editor.as_ref().unwrap();
            let layout = editor.email_layout.as_ref().unwrap();
            assert!(matches!(layout.blocks[0].1, BlockEditor::Booking(_)));
            let BlockEditor::Booking(label) = &layout.blocks[0].1 else {
                unreachable!();
            };
            label.update(cx, |field, cx| field.set_text("Book an appointment", cx));
            let packet = editor
                .packet(cx)
                .unwrap()
                .draft
                .email_layout
                .unwrap()
                .unwrap();
            assert!(matches!(
                packet.blocks[1],
                EmailBlock::Paragraph {
                    emphasis: EmailEmphasis::Strong,
                    ..
                }
            ));
        });
        click_control(cx, "email-remove-1");
        root.update(cx, |root, cx| {
            let editor = root.marketing_desk().unwrap().editor.as_ref().unwrap();
            let packet = editor
                .packet(cx)
                .unwrap()
                .draft
                .email_layout
                .unwrap()
                .unwrap();
            assert_eq!(packet.blocks.len(), 1);
        });
    }
}
