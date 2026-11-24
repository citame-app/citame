use super::*;
use sob_core::http::marketing::{EmailBlock, EmailEmphasis};

pub(super) struct LayoutEditor {
    heading: Entity<TextField>,
    preheader: Entity<TextField>,
    blocks: Vec<(usize, BlockEditor)>,
    next_id: usize,
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

    fn change_block(&mut self, id: usize, change: impl FnOnce(&mut Self, usize)) {
        if let Some(index) = self.blocks.iter().position(|(key, _)| *key == id) {
            change(self, index);
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
}

impl Root {
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
                                        row.child(self.marketing_button(
                                            SharedString::from(format!("email-remove-{id}")),
                                            Key::MarketingRemoveEmailBlock,
                                            Kind::Ghost,
                                            move |root, cx| {
                                                root.edit_email_layout(cx, |layout, _| {
                                                    if layout.blocks.len() > 1 {
                                                        layout.blocks.retain(|(key, _)| *key != id);
                                                    }
                                                })
                                            },
                                            cx,
                                        ))
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
            move |root, cx| {
                root.edit_email_layout(cx, |layout, _| {
                    layout.change_block(id, |layout, index| {
                        let target = index.checked_add_signed(if down { 1 } else { -1 });
                        if let Some(target) = target.filter(|&target| target < layout.blocks.len())
                        {
                            layout.blocks.swap(index, target);
                        }
                    });
                })
            },
            cx,
        )
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
                        root.edit_email_layout(cx, |layout, _| {
                            layout.change_block(id, |layout, index| {
                                if let BlockEditor::Paragraph(_, emphasis) =
                                    &mut layout.blocks[index].1
                                {
                                    *emphasis = style;
                                }
                            });
                        });
                    }),
                )
                .tab_index(0)
                .focus(|style| style.border_color(theme::text()))
            }),
        )
    }

    pub(super) fn preview_email_layout(&self, layout: &LayoutEditor, cx: &App) -> gpui::Div {
        let layout = layout.packet(cx);
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
