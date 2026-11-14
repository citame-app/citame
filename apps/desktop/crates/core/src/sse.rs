//! Minimal Server-Sent Events line parser for `GET /sync/stream`.

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SseEvent {
    pub event: Option<String>,
    pub id: Option<String>,
    pub data: String,
}

#[derive(Debug, Default)]
pub struct SseParser {
    current: SseEvent,
    has_data: bool,
}

impl SseParser {
    /// Feeds one line (without its line terminator). Returns an event when a blank line
    /// completes one. Comment lines (`: ping`) are ignored.
    pub fn feed_line(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            let had = std::mem::take(&mut self.has_data);
            let ev = std::mem::take(&mut self.current);
            return had.then_some(ev);
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.current.event = Some(value.to_owned()),
            "id" => self.current.id = Some(value.to_owned()),
            "data" => {
                if self.has_data {
                    self.current.data.push('\n');
                }
                self.current.data.push_str(value);
                self.has_data = true;
            }
            _ => {}
        }
        None
    }
}

/// Extracts the head `seq` from a `change` event payload (`{"seq": 415}`).
pub fn nudge_seq(event: &SseEvent) -> Option<i64> {
    let v: serde_json::Value = serde_json::from_str(&event.data).ok()?;
    v.get("seq")?.as_i64()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(lines: &[&str]) -> Vec<SseEvent> {
        let mut p = SseParser::default();
        lines.iter().filter_map(|l| p.feed_line(l)).collect()
    }

    #[test]
    fn parses_the_server_change_event() {
        let evs = feed(&["event: change", "id: 415", "data: {\"seq\":415}", ""]);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].event.as_deref(), Some("change"));
        assert_eq!(evs[0].id.as_deref(), Some("415"));
        assert_eq!(nudge_seq(&evs[0]), Some(415));
    }

    #[test]
    fn ignores_ping_comments_and_blank_lines_without_data() {
        assert!(feed(&[": ping", "", ": ping", ""]).is_empty());
    }

    #[test]
    fn joins_multiple_data_lines() {
        let evs = feed(&["data: a", "data: b", ""]);
        assert_eq!(evs[0].data, "a\nb");
    }

    #[test]
    fn handles_fields_without_space_and_resets_between_events() {
        let evs = feed(&["event:change", "data:{\"seq\":1}", "", "data: {\"seq\":2}", ""]);
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[1].event, None);
        assert_eq!(nudge_seq(&evs[1]), Some(2));
    }

    #[test]
    fn garbage_data_gives_no_seq() {
        let evs = feed(&["event: change", "data: nope", ""]);
        assert_eq!(nudge_seq(&evs[0]), None);
    }
}
