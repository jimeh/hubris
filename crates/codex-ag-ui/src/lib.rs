use std::collections::{HashMap, HashSet};

use agui_rs_core::types::{AssistantMessage, ReasoningMessage, UserMessage};
use agui_rs_core::{
    Event, Message, RunAgentInput, RunFinishedOutcome, TextMessageRole, UserMessageContent,
    event_factories as factory,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub use agui_rs_core;

/// Role for a Codex transcript message normalized for AG-UI output.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexAgUiMessageRole {
    /// A user-authored message.
    User,
    /// A Codex-authored assistant message.
    Assistant,
}

/// Lifecycle state for a Codex transcript message.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexAgUiMessageStatus {
    /// The message has been created but not started.
    Pending,
    /// The message is currently receiving content.
    Streaming,
    /// The message completed normally.
    Completed,
    /// The message was interrupted before completion.
    Interrupted,
    /// The message failed.
    Failed,
}

impl CodexAgUiMessageStatus {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Interrupted | Self::Failed)
    }
}

/// A Codex transcript message in the translator's input model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CodexAgUiMessage {
    /// Stable Hubris/Codex message identifier.
    pub id: String,
    /// Message author role.
    pub role: CodexAgUiMessageRole,
    /// Current message lifecycle state.
    pub status: CodexAgUiMessageStatus,
    /// Visible message text.
    pub content: String,
    /// Optional reasoning text associated with the message.
    pub reasoning: String,
    /// Stable ordering value within the conversation.
    pub sequence: u32,
}

/// Lifecycle state for a non-message Codex activity.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexAgUiActivityStatus {
    /// The activity has started.
    Started,
    /// The activity is currently streaming output or progress.
    Streaming,
    /// The activity completed normally.
    Completed,
    /// The activity failed.
    Failed,
}

/// A Codex work item normalized as an AG-UI activity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CodexAgUiActivity {
    /// Stable Hubris/Codex activity identifier.
    pub id: String,
    /// Namespaced AG-UI activity type.
    pub activity_type: String,
    /// Current activity lifecycle state.
    pub status: CodexAgUiActivityStatus,
    /// Optional short display title.
    pub title: Option<String>,
    /// Optional short display summary.
    pub summary: Option<String>,
    /// Structured activity payload.
    pub content: Map<String, Value>,
    /// Stable ordering value within the conversation.
    pub sequence: u32,
}

/// Current Codex run terminal state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CodexAgUiRunStatus {
    /// Whether the run failed.
    pub failed: bool,
    /// Whether the run was interrupted.
    pub interrupted: bool,
    /// Whether no more events are expected for the run.
    pub terminal: bool,
    /// Optional terminal error message.
    pub error: Option<String>,
}

/// Complete Codex conversation state used to seed an AG-UI stream.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CodexAgUiSnapshot {
    /// AG-UI thread identifier.
    pub thread_id: String,
    /// AG-UI run identifier.
    pub run_id: String,
    /// Ordered transcript messages.
    pub messages: Vec<CodexAgUiMessage>,
    /// Ordered non-message activities.
    pub activities: Vec<CodexAgUiActivity>,
    /// Latest run status when known.
    pub run_status: Option<CodexAgUiRunStatus>,
    /// Arbitrary AG-UI agent state snapshot.
    pub state: Value,
}

/// Incremental Codex conversation update translated into AG-UI events.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CodexAgUiUpdate {
    /// A streamed assistant text delta.
    MessageDelta { message_id: String, delta: String },
    /// A full message update.
    MessageUpdated(CodexAgUiMessage),
    /// A full activity update.
    ActivityUpdated(CodexAgUiActivity),
    /// A run status update.
    RunUpdated(CodexAgUiRunStatus),
    /// A terminal stream error.
    Error { message: String },
}

/// Stateful translator from normalized Codex chat updates to AG-UI events.
#[derive(Debug, Default)]
pub struct CodexAgUiTranslator {
    started_text_messages: HashSet<String>,
    ended_text_messages: HashSet<String>,
    started_reasoning_messages: HashSet<String>,
    ended_reasoning_messages: HashSet<String>,
    reasoning_text_lengths: HashMap<String, usize>,
}

impl CodexAgUiTranslator {
    /// Creates an empty translator.
    pub fn new() -> Self {
        Self::default()
    }

    /// Converts a full Codex conversation snapshot into initial AG-UI events.
    pub fn snapshot_events(&mut self, snapshot: &CodexAgUiSnapshot) -> Vec<Event> {
        self.seed_from_snapshot(snapshot);
        let mut events = vec![
            factory::create_run_started_event(
                &snapshot.thread_id,
                &snapshot.run_id,
                None,
                None,
                None,
                None,
            ),
            factory::create_state_snapshot_event(snapshot.state.clone(), None, None),
            factory::create_messages_snapshot_event(
                snapshot
                    .messages
                    .iter()
                    .flat_map(to_ag_ui_messages)
                    .collect(),
                None,
                None,
            ),
        ];

        for activity in &snapshot.activities {
            events.push(activity_snapshot(activity));
        }

        if let Some(status) = &snapshot.run_status
            && status.terminal
        {
            events.extend(run_status_events(
                &snapshot.thread_id,
                &snapshot.run_id,
                status,
            ));
        }

        events
    }

    fn seed_from_snapshot(&mut self, snapshot: &CodexAgUiSnapshot) {
        for message in &snapshot.messages {
            if message.role != CodexAgUiMessageRole::Assistant {
                continue;
            }
            if !message.content.is_empty() {
                self.started_text_messages.insert(message.id.clone());
                if message.status.is_terminal() {
                    self.ended_text_messages.insert(message.id.clone());
                }
            }
            if !message.reasoning.is_empty() {
                self.started_reasoning_messages.insert(message.id.clone());
                self.reasoning_text_lengths
                    .insert(message.id.clone(), message.reasoning.len());
                if message.status.is_terminal() {
                    self.ended_reasoning_messages.insert(message.id.clone());
                }
            }
        }
    }

    /// Converts one normalized Codex update into AG-UI events.
    pub fn update_events(
        &mut self,
        thread_id: &str,
        run_id: &str,
        update: CodexAgUiUpdate,
    ) -> Vec<Event> {
        match update {
            CodexAgUiUpdate::MessageDelta { message_id, delta } => {
                if delta.is_empty() {
                    return Vec::new();
                }
                let mut events = Vec::new();
                if self.started_text_messages.insert(message_id.clone()) {
                    events.push(factory::create_text_message_start_event(
                        message_id.clone(),
                        Some(TextMessageRole::Assistant),
                        None,
                        None,
                        None,
                    ));
                }
                events.push(factory::create_text_message_content_event(
                    &message_id,
                    delta,
                    None,
                    None,
                ));
                events
            }
            CodexAgUiUpdate::MessageUpdated(message) => self.message_updated_events(message),
            CodexAgUiUpdate::ActivityUpdated(activity) => {
                vec![activity_snapshot(&activity)]
            }
            CodexAgUiUpdate::RunUpdated(status) => run_status_events(thread_id, run_id, &status),
            CodexAgUiUpdate::Error { message } => {
                vec![factory::create_run_error_event(message, None, None, None)]
            }
        }
    }

    fn message_updated_events(&mut self, message: CodexAgUiMessage) -> Vec<Event> {
        match message.role {
            CodexAgUiMessageRole::User => Vec::new(),
            CodexAgUiMessageRole::Assistant => {
                let mut events = Vec::new();
                let started = self.started_text_messages.insert(message.id.clone());
                if started {
                    events.push(factory::create_text_message_start_event(
                        message.id.clone(),
                        Some(TextMessageRole::Assistant),
                        None,
                        None,
                        None,
                    ));
                    if !message.content.is_empty() {
                        events.push(factory::create_text_message_content_event(
                            &message.id,
                            message.content.clone(),
                            None,
                            None,
                        ));
                    }
                }
                if message.status.is_terminal()
                    && self.ended_text_messages.insert(message.id.clone())
                {
                    events.push(factory::create_text_message_end_event(
                        &message.id,
                        None,
                        None,
                    ));
                }
                if !message.reasoning.is_empty() {
                    if self.started_reasoning_messages.insert(message.id.clone()) {
                        events.extend([
                            factory::create_reasoning_start_event(&message.id, None, None),
                            factory::create_reasoning_message_start_event(
                                &message.id,
                                None,
                                None,
                                None,
                            ),
                        ]);
                    }
                    let previous_len = self
                        .reasoning_text_lengths
                        .get(&message.id)
                        .copied()
                        .unwrap_or(0);
                    if let Some(delta) = message.reasoning.get(previous_len..)
                        && !delta.is_empty()
                    {
                        events.push(factory::create_reasoning_message_content_event(
                            &message.id,
                            delta.to_string(),
                            None,
                            None,
                        ));
                        self.reasoning_text_lengths
                            .insert(message.id.clone(), message.reasoning.len());
                    }
                    if message.status.is_terminal()
                        && self.ended_reasoning_messages.insert(message.id.clone())
                    {
                        events.extend([
                            factory::create_reasoning_message_end_event(&message.id, None, None),
                            factory::create_reasoning_end_event(&message.id, None, None),
                        ]);
                    }
                }
                events
            }
        }
    }
}

/// Returns the final user text message from an AG-UI run input.
pub fn input_last_user_text(input: &RunAgentInput) -> Option<(&str, &str)> {
    input.messages.iter().rev().find_map(|message| {
        let Message::User(user) = message else {
            return None;
        };
        let text = match &user.content {
            UserMessageContent::Text(text) => text.as_str(),
            UserMessageContent::Parts(_) => return None,
        };
        Some((user.id.as_str(), text))
    })
}

fn to_ag_ui_messages(message: &CodexAgUiMessage) -> Vec<Message> {
    match message.role {
        CodexAgUiMessageRole::User => vec![Message::User(UserMessage {
            id: message.id.clone(),
            content: UserMessageContent::Text(message.content.clone()),
            name: None,
            encrypted_value: None,
        })],
        CodexAgUiMessageRole::Assistant => {
            let mut messages = Vec::new();
            if !message.content.is_empty() {
                messages.push(Message::Assistant(AssistantMessage {
                    id: message.id.clone(),
                    content: Some(message.content.clone()),
                    name: None,
                    tool_calls: None,
                    encrypted_value: None,
                }));
            }
            if !message.reasoning.is_empty() {
                messages.push(Message::Reasoning(ReasoningMessage {
                    id: message.id.clone(),
                    content: message.reasoning.clone(),
                    encrypted_value: None,
                }));
            }
            if messages.is_empty() {
                messages.push(Message::Assistant(AssistantMessage {
                    id: message.id.clone(),
                    content: Some(String::new()),
                    name: None,
                    tool_calls: None,
                    encrypted_value: None,
                }));
            }
            messages
        }
    }
}

fn activity_snapshot(activity: &CodexAgUiActivity) -> Event {
    let mut content = activity.content.clone();
    content.insert("id".to_string(), Value::String(activity.id.clone()));
    content.insert("status".to_string(), json!(activity.status));
    if let Some(title) = &activity.title {
        content.insert("title".to_string(), Value::String(title.clone()));
    }
    if let Some(summary) = &activity.summary {
        content.insert("summary".to_string(), Value::String(summary.clone()));
    }
    content.insert("sequence".to_string(), json!(activity.sequence));
    factory::create_activity_snapshot_event(
        &activity.id,
        &activity.activity_type,
        content,
        Some(true),
        None,
        None,
    )
}

fn run_status_events(thread_id: &str, run_id: &str, status: &CodexAgUiRunStatus) -> Vec<Event> {
    if status.failed {
        return vec![factory::create_run_error_event(
            status
                .error
                .clone()
                .unwrap_or_else(|| "Codex run failed".to_string()),
            None,
            None,
            None,
        )];
    }
    if status.terminal {
        let outcome = if status.interrupted {
            RunFinishedOutcome::Interrupt { interrupts: vec![] }
        } else {
            RunFinishedOutcome::Success
        };
        return vec![factory::create_run_finished_event(
            thread_id,
            run_id,
            None,
            Some(outcome),
            None,
            None,
        )];
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_includes_messages_and_run_start() {
        let mut translator = CodexAgUiTranslator::new();
        let snapshot = CodexAgUiSnapshot {
            thread_id: "thread-1".to_string(),
            run_id: "run-1".to_string(),
            messages: vec![CodexAgUiMessage {
                id: "msg-1".to_string(),
                role: CodexAgUiMessageRole::User,
                status: CodexAgUiMessageStatus::Completed,
                content: "hello".to_string(),
                reasoning: String::new(),
                sequence: 0,
            }],
            activities: vec![],
            run_status: None,
            state: json!({ "conversationId": "chat-1" }),
        };

        let events = translator.snapshot_events(&snapshot);

        assert!(matches!(events[0], Event::RunStarted(_)));
        assert!(matches!(events[2], Event::MessagesSnapshot(_)));
    }

    #[test]
    fn assistant_delta_starts_message_once() {
        let mut translator = CodexAgUiTranslator::new();

        let first = translator.update_events(
            "thread-1",
            "run-1",
            CodexAgUiUpdate::MessageDelta {
                message_id: "msg-1".to_string(),
                delta: "hel".to_string(),
            },
        );
        let second = translator.update_events(
            "thread-1",
            "run-1",
            CodexAgUiUpdate::MessageDelta {
                message_id: "msg-1".to_string(),
                delta: "lo".to_string(),
            },
        );

        assert!(matches!(first[0], Event::TextMessageStart(_)));
        assert_eq!(first.len(), 2);
        assert_eq!(second.len(), 1);
        assert!(matches!(second[0], Event::TextMessageContent(_)));
    }

    #[test]
    fn snapshot_seeds_started_messages() {
        let mut translator = CodexAgUiTranslator::new();
        let snapshot = CodexAgUiSnapshot {
            thread_id: "thread-1".to_string(),
            run_id: "run-1".to_string(),
            messages: vec![CodexAgUiMessage {
                id: "msg-1".to_string(),
                role: CodexAgUiMessageRole::Assistant,
                status: CodexAgUiMessageStatus::Streaming,
                content: "hello".to_string(),
                reasoning: "checking".to_string(),
                sequence: 0,
            }],
            activities: vec![],
            run_status: None,
            state: json!({}),
        };

        let snapshot_events = translator.snapshot_events(&snapshot);
        let update_events = translator.update_events(
            "thread-1",
            "run-1",
            CodexAgUiUpdate::MessageUpdated(CodexAgUiMessage {
                id: "msg-1".to_string(),
                role: CodexAgUiMessageRole::Assistant,
                status: CodexAgUiMessageStatus::Streaming,
                content: "hello".to_string(),
                reasoning: "checking more".to_string(),
                sequence: 0,
            }),
        );

        assert!(matches!(snapshot_events[2], Event::MessagesSnapshot(_)));
        assert!(
            !update_events
                .iter()
                .any(|event| matches!(event, Event::TextMessageStart(_)))
        );
        assert!(update_events.iter().any(|event| {
            matches!(
                event,
                Event::ReasoningMessageContent(content) if content.delta == " more"
            )
        }));
    }

    #[test]
    fn assistant_snapshot_preserves_content_and_reasoning() {
        let message = CodexAgUiMessage {
            id: "msg-1".to_string(),
            role: CodexAgUiMessageRole::Assistant,
            status: CodexAgUiMessageStatus::Completed,
            content: "visible".to_string(),
            reasoning: "private work".to_string(),
            sequence: 0,
        };

        let messages = to_ag_ui_messages(&message);

        assert_eq!(messages.len(), 2);
        assert!(matches!(messages[0], Message::Assistant(_)));
        assert!(matches!(messages[1], Message::Reasoning(_)));
    }

    #[test]
    fn reasoning_update_emits_suffix_until_terminal() {
        let mut translator = CodexAgUiTranslator::new();

        let first = translator.update_events(
            "thread-1",
            "run-1",
            CodexAgUiUpdate::MessageUpdated(CodexAgUiMessage {
                id: "msg-1".to_string(),
                role: CodexAgUiMessageRole::Assistant,
                status: CodexAgUiMessageStatus::Streaming,
                content: String::new(),
                reasoning: "one".to_string(),
                sequence: 0,
            }),
        );
        let second = translator.update_events(
            "thread-1",
            "run-1",
            CodexAgUiUpdate::MessageUpdated(CodexAgUiMessage {
                id: "msg-1".to_string(),
                role: CodexAgUiMessageRole::Assistant,
                status: CodexAgUiMessageStatus::Completed,
                content: String::new(),
                reasoning: "one two".to_string(),
                sequence: 0,
            }),
        );

        assert!(matches!(first[0], Event::TextMessageStart(_)));
        assert!(first.iter().any(|event| {
            matches!(
                event,
                Event::ReasoningMessageContent(content) if content.delta == "one"
            )
        }));
        assert!(second.iter().any(|event| {
            matches!(
                event,
                Event::ReasoningMessageContent(content) if content.delta == " two"
            )
        }));
        assert!(
            second
                .iter()
                .any(|event| matches!(event, Event::ReasoningMessageEnd(_)))
        );
    }
}
