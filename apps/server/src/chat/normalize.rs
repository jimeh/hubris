use super::*;

pub(super) fn derive_chat_title(text: &str) -> String {
    const MAX_LEN: usize = 48;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return DEFAULT_CHAT_TITLE.to_string();
    }
    let collapsed = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title = collapsed.chars().take(MAX_LEN).collect::<String>();
    if collapsed.chars().count() > MAX_LEN {
        title.push('…');
    }
    title
}

pub(super) fn extract_thread_id(value: &Value) -> Option<String> {
    value
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| value.get("id").and_then(Value::as_str).map(str::to_string))
}

pub(super) fn extract_turn_id(value: &Value) -> Option<String> {
    value
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| value.get("id").and_then(Value::as_str).map(str::to_string))
}

pub(super) fn extract_model(value: &Value) -> Option<String> {
    value
        .get("model")
        .and_then(Value::as_str)
        .and_then(|model| normalize_model_ref(Some(model)).map(str::to_string))
}

pub(super) fn normalize_model_override(value: Option<String>) -> Option<String> {
    value.and_then(|model| {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_model_ref(value: Option<&str>) -> Option<&str> {
    value.and_then(|model| {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(model)
        }
    })
}

pub(super) fn extract_reasoning_effort(value: &Value) -> Option<ChatReasoningEffort> {
    value
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .map(parse_reasoning_effort)
}

pub(super) fn apply_thread_permission_mode(
    params: &mut serde_json::Map<String, Value>,
    permission_mode: Option<ChatPermissionMode>,
) {
    if matches!(permission_mode, Some(ChatPermissionMode::FullAccess)) {
        params.insert(
            "approvalPolicy".to_string(),
            Value::String("never".to_string()),
        );
        params.insert(
            "sandbox".to_string(),
            Value::String("danger-full-access".to_string()),
        );
    }
}

fn apply_turn_permission_mode(
    params: &mut serde_json::Map<String, Value>,
    permission_mode: Option<ChatPermissionMode>,
) {
    if matches!(permission_mode, Some(ChatPermissionMode::FullAccess)) {
        params.insert(
            "approvalPolicy".to_string(),
            Value::String("never".to_string()),
        );
        params.insert(
            "sandboxPolicy".to_string(),
            json!({
                "type": "dangerFullAccess",
            }),
        );
    }
}

pub(super) async fn start_provider_thread(
    app_server: &Arc<CodexAppServerManager>,
    worktree_path: &str,
    selected_model: Option<&str>,
    permission_mode: Option<ChatPermissionMode>,
) -> Result<(String, Value), ChatServiceError> {
    let params = build_thread_start_params(worktree_path, selected_model, permission_mode);
    let result = app_server
        .request("thread/start", Value::Object(params))
        .await?;
    let thread_id = extract_thread_id(&result).ok_or_else(|| {
        ChatServiceError::new(
            ChatErrorKind::Upstream,
            "codex app-server did not return a thread id",
        )
    })?;
    Ok((thread_id, result))
}

fn build_thread_start_params(
    worktree_path: &str,
    selected_model: Option<&str>,
    permission_mode: Option<ChatPermissionMode>,
) -> serde_json::Map<String, Value> {
    let mut params = serde_json::Map::new();
    params.insert("cwd".to_string(), Value::String(worktree_path.to_string()));
    if let Some(model) = normalize_model_ref(selected_model) {
        params.insert("model".to_string(), Value::String(model.to_string()));
    }
    apply_thread_permission_mode(&mut params, permission_mode);
    params
}

pub(super) fn build_turn_start_params(
    thread_id: &str,
    worktree_path: &str,
    text: &str,
    conversation: &ChatConversationSummary,
) -> serde_json::Map<String, Value> {
    let mut params = serde_json::Map::new();
    params.insert("cwd".to_string(), Value::String(worktree_path.to_string()));
    params.insert("threadId".to_string(), Value::String(thread_id.to_string()));
    params.insert(
        "input".to_string(),
        json!([
            {
                "type": "text",
                "text": text,
            }
        ]),
    );
    if let Some(model) = normalize_model_ref(conversation.selected_model.as_deref()) {
        params.insert("model".to_string(), Value::String(model.to_string()));
    }
    if let Some(effort) = conversation.selected_effort {
        params.insert(
            "effort".to_string(),
            Value::String(effort.as_str().to_string()),
        );
    }
    apply_turn_permission_mode(&mut params, conversation.selected_permission_mode);
    params
}

pub(super) fn has_blank_model_field(value: &Value) -> bool {
    value
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| model.trim().is_empty())
}

pub(super) fn item_kind_from_params(value: &Value) -> ChatItemKind {
    let item_type = value
        .get("item")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        .or_else(|| value.get("type").and_then(Value::as_str));
    match item_type {
        Some("agentMessage") => ChatItemKind::AgentMessage,
        Some("reasoning") | Some("reasoningSummary") => ChatItemKind::Reasoning,
        Some("commandExecution") | Some("command_execution") | Some("exec") => {
            ChatItemKind::CommandExecution
        }
        Some("fileChange") | Some("file_change") => ChatItemKind::FileChange,
        Some("mcpToolCall") | Some("mcp_tool_call") => ChatItemKind::McpToolCall,
        Some("dynamicToolCall") | Some("dynamic_tool_call") => ChatItemKind::DynamicToolCall,
        Some("webSearch") | Some("web_search") => ChatItemKind::WebSearch,
        Some("imageView") | Some("image_view") => ChatItemKind::ImageView,
        Some("hook") => ChatItemKind::Hook,
        Some("autoApprovalReview") | Some("auto_approval_review") => {
            ChatItemKind::AutoApprovalReview
        }
        Some("modelReroute") | Some("model_reroute") => ChatItemKind::ModelReroute,
        _ if is_commentary_phase(value) => ChatItemKind::Reasoning,
        _ => ChatItemKind::Unknown,
    }
}

pub(super) fn agent_message_projection_from_value(value: &Value) -> Option<AgentMessageProjection> {
    let item_type = value
        .get("item")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        .or_else(|| value.get("type").and_then(Value::as_str));
    if item_type != Some("agentMessage") {
        return None;
    }

    if is_commentary_phase(value) {
        Some(AgentMessageProjection::Reasoning)
    } else {
        Some(AgentMessageProjection::Response)
    }
}

pub(super) fn is_plan_payload(value: &Value) -> bool {
    let item_type = value
        .get("item")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        .or_else(|| value.get("type").and_then(Value::as_str));
    matches!(item_type, Some("plan" | "proposedPlan" | "proposed_plan"))
}

pub(super) fn normalize_plan_steps_json(value: &Value) -> String {
    let steps = value
        .get("steps")
        .or_else(|| value.get("plan").and_then(|plan| plan.get("steps")))
        .or_else(|| {
            value
                .get("turn")
                .and_then(|turn| turn.get("plan"))
                .and_then(|plan| plan.get("steps"))
        })
        .cloned()
        .unwrap_or_else(|| json!([]));
    serde_json::to_string(&steps).unwrap_or_else(|_| "[]".to_string())
}

pub(super) fn extract_plan_text(value: &Value) -> String {
    value
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("plan")
                .and_then(|plan| plan.get("text"))
                .and_then(Value::as_str)
        })
        .or_else(|| value.get("summary").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

pub(super) fn extract_u32_field(value: &Value, names: &[&str]) -> Option<u32> {
    for name in names {
        if let Some(number) = value.get(*name).and_then(Value::as_u64) {
            return Some(number.min(u32::MAX as u64) as u32);
        }
        if let Some(number) = value
            .get("usage")
            .and_then(|usage| usage.get(*name))
            .and_then(Value::as_u64)
        {
            return Some(number.min(u32::MAX as u64) as u32);
        }
        if let Some(number) = value
            .get("diff")
            .and_then(|diff| diff.get(*name))
            .and_then(Value::as_u64)
        {
            return Some(number.min(u32::MAX as u64) as u32);
        }
    }
    None
}

pub(super) fn extract_f64_field(value: &Value, names: &[&str]) -> Option<f64> {
    for name in names {
        if let Some(number) = value.get(*name).and_then(Value::as_f64) {
            return Some(number);
        }
        if let Some(number) = value
            .get("usage")
            .and_then(|usage| usage.get(*name))
            .and_then(Value::as_f64)
        {
            return Some(number);
        }
    }
    None
}

pub(super) fn extract_diff_files(value: &Value) -> Vec<ChatDiffFileSummary> {
    let files = value
        .get("files")
        .or_else(|| value.get("changedFiles"))
        .or_else(|| value.get("diff").and_then(|diff| diff.get("files")))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    files
        .into_iter()
        .filter_map(|file| {
            if let Some(path) = file.as_str() {
                return Some(ChatDiffFileSummary {
                    path: path.to_string(),
                    original_path: None,
                    change_type: None,
                    additions: None,
                    deletions: None,
                });
            }
            let path = file
                .get("path")
                .and_then(Value::as_str)
                .or_else(|| file.get("newPath").and_then(Value::as_str))
                .or_else(|| file.get("displayPath").and_then(Value::as_str))?;
            Some(ChatDiffFileSummary {
                path: path.to_string(),
                original_path: file
                    .get("originalPath")
                    .and_then(Value::as_str)
                    .or_else(|| file.get("oldPath").and_then(Value::as_str))
                    .map(ToOwned::to_owned),
                change_type: file
                    .get("changeType")
                    .and_then(Value::as_str)
                    .or_else(|| file.get("status").and_then(Value::as_str))
                    .map(ToOwned::to_owned),
                additions: file
                    .get("additions")
                    .and_then(Value::as_u64)
                    .map(|value| value.min(u32::MAX as u64) as u32),
                deletions: file
                    .get("deletions")
                    .and_then(Value::as_u64)
                    .map(|value| value.min(u32::MAX as u64) as u32),
            })
        })
        .take(20)
        .collect()
}

pub(super) fn item_role_for_kind(kind: ChatItemKind) -> Option<ChatMessageRole> {
    match kind {
        ChatItemKind::AgentMessage | ChatItemKind::Reasoning => Some(ChatMessageRole::Assistant),
        ChatItemKind::CommandExecution
        | ChatItemKind::FileChange
        | ChatItemKind::McpToolCall
        | ChatItemKind::DynamicToolCall
        | ChatItemKind::WebSearch
        | ChatItemKind::ImageView
        | ChatItemKind::Hook
        | ChatItemKind::AutoApprovalReview
        | ChatItemKind::ModelReroute
        | ChatItemKind::Unknown => None,
    }
}

pub(super) fn is_global_provider_notification(method: &str) -> bool {
    matches!(
        method,
        "remoteControl/status/changed" | "mcpServer/startupStatus/updated"
    )
}

pub(super) fn item_metadata_json(value: &Value) -> String {
    let item = value.get("item").unwrap_or(value);
    let metadata = json!({
        "type": item.get("type").and_then(Value::as_str),
        "phase": item.get("phase").and_then(Value::as_str)
            .or_else(|| value.get("phase").and_then(Value::as_str)),
        "summaryIndex": value.get("summaryIndex").and_then(Value::as_u64),
        "command": item.get("command").and_then(Value::as_str)
            .or_else(|| value.get("command").and_then(Value::as_str)),
        "cwd": item.get("cwd").and_then(Value::as_str)
            .or_else(|| value.get("cwd").and_then(Value::as_str)),
        "exitCode": item.get("exitCode").and_then(Value::as_i64)
            .or_else(|| value.get("exitCode").and_then(Value::as_i64)),
        "path": item.get("path").and_then(Value::as_str)
            .or_else(|| value.get("path").and_then(Value::as_str)),
        "toolName": item.get("toolName").and_then(Value::as_str)
            .or_else(|| value.get("toolName").and_then(Value::as_str))
            .or_else(|| item.get("name").and_then(Value::as_str)),
        "serverName": item.get("serverName").and_then(Value::as_str)
            .or_else(|| value.get("serverName").and_then(Value::as_str)),
        "fromModel": value.get("fromModel").and_then(Value::as_str)
            .or_else(|| item.get("fromModel").and_then(Value::as_str)),
        "toModel": value.get("toModel").and_then(Value::as_str)
            .or_else(|| item.get("toModel").and_then(Value::as_str)),
    });
    serde_json::to_string(&metadata).unwrap_or_else(|_| "{}".to_string())
}

pub(super) fn item_title_summary(
    kind: ChatItemKind,
    value: &Value,
) -> (Option<String>, Option<String>) {
    let item = value.get("item").unwrap_or(value);
    let title = item
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| value.get("title").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .or_else(|| match kind {
            ChatItemKind::CommandExecution => extract_command(item)
                .or_else(|| extract_command(value))
                .map(|command| format!("Run `{}`", summarize_inline(command, 72))),
            ChatItemKind::FileChange => extract_path(item)
                .or_else(|| extract_path(value))
                .map(|path| format!("Edit {path}"))
                .or_else(|| Some("File change".to_string())),
            ChatItemKind::McpToolCall => extract_tool_name(item)
                .or_else(|| extract_tool_name(value))
                .map(|name| format!("Use {name}"))
                .or_else(|| Some("Tool call".to_string())),
            ChatItemKind::DynamicToolCall => Some("Tool call".to_string()),
            ChatItemKind::WebSearch => Some("Web search".to_string()),
            ChatItemKind::ImageView => Some("View image".to_string()),
            ChatItemKind::Hook => Some("Run hook".to_string()),
            ChatItemKind::AutoApprovalReview => Some("Review permissions".to_string()),
            ChatItemKind::ModelReroute => Some("Model rerouted".to_string()),
            ChatItemKind::AgentMessage | ChatItemKind::Reasoning | ChatItemKind::Unknown => None,
        });
    let summary = item
        .get("summary")
        .and_then(Value::as_str)
        .or_else(|| value.get("summary").and_then(Value::as_str))
        .or_else(|| value.get("message").and_then(Value::as_str))
        .map(summarize_activity_text);
    (title, summary)
}

pub(super) fn extract_activity_delta(value: &Value) -> Option<String> {
    value
        .get("delta")
        .and_then(Value::as_str)
        .or_else(|| value.get("output").and_then(Value::as_str))
        .or_else(|| value.get("text").and_then(Value::as_str))
        .or_else(|| value.get("chunk").and_then(Value::as_str))
        .or_else(|| value.pointer("/item/delta").and_then(Value::as_str))
        .or_else(|| value.pointer("/item/output").and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

pub(super) fn extract_stream_kind(value: &Value) -> Option<&str> {
    value
        .get("stream")
        .and_then(Value::as_str)
        .or_else(|| value.get("streamKind").and_then(Value::as_str))
        .or_else(|| value.get("fd").and_then(Value::as_str))
}

fn extract_command(value: &Value) -> Option<&str> {
    value
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/exec/command").and_then(Value::as_str))
}

fn extract_path(value: &Value) -> Option<&str> {
    value
        .get("path")
        .and_then(Value::as_str)
        .or_else(|| value.get("file").and_then(Value::as_str))
        .or_else(|| value.pointer("/file/path").and_then(Value::as_str))
}

fn extract_tool_name(value: &Value) -> Option<&str> {
    value
        .get("toolName")
        .and_then(Value::as_str)
        .or_else(|| value.get("name").and_then(Value::as_str))
        .or_else(|| value.pointer("/tool/name").and_then(Value::as_str))
}

fn summarize_inline(value: &str, limit: usize) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut summary = collapsed.chars().take(limit).collect::<String>();
    if collapsed.chars().count() > limit {
        summary.push('…');
    }
    summary
}

pub(super) fn summarize_activity_text(value: &str) -> String {
    summarize_inline(value, 240)
}

fn codex_text_trace_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var(CODEX_TEXT_TRACE_ENV)
            .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(false)
    })
}

fn trace_string_field(value: &Value, path: &str) -> Option<String> {
    let field = if let Some(pointer) = path.strip_prefix('/') {
        value.pointer(&format!("/{pointer}"))
    } else {
        value.get(path)
    };
    field
        .and_then(Value::as_str)
        .map(|text| summarize_inline(text, 160))
}

pub(super) fn trace_codex_text_event(method: &str, conversation_id: &str, params: &Value) {
    if !codex_text_trace_enabled() {
        return;
    }

    let route_hints = RouteHints::from_value(params);
    let item = params.get("item").unwrap_or(&Value::Null);
    let delta_preview = trace_string_field(params, "delta")
        .or_else(|| trace_string_field(params, "text"))
        .or_else(|| trace_string_field(params, "/item/delta"));
    let completed_text_preview = trace_string_field(item, "text")
        .or_else(|| trace_string_field(params, "/item/text"))
        .or_else(|| trace_string_field(params, "/turn/items/0/text"));
    let phase = params
        .get("phase")
        .and_then(|value| value.as_str())
        .or_else(|| item.get("phase").and_then(|value| value.as_str()));
    let item_type = item
        .get("type")
        .and_then(|value| value.as_str())
        .or_else(|| params.get("type").and_then(|value| value.as_str()));
    let item_status = item
        .get("status")
        .and_then(|value| value.as_str())
        .or_else(|| params.get("status").and_then(|value| value.as_str()));
    tracing::info!(
        target: "hubris_server::chat::codex_text_trace",
        method,
        conversation_id,
        thread_id = route_hints.thread_id.as_deref(),
        turn_id = route_hints.turn_id.as_deref(),
        item_id = route_hints.item_id.as_deref(),
        request_id = route_hints.request_id.as_deref(),
        phase,
        item_type,
        item_status,
        delta_preview = delta_preview.as_deref(),
        completed_text_preview = completed_text_preview.as_deref(),
        "codex app-server text event"
    );
}

pub(super) fn is_commentary_phase(value: &Value) -> bool {
    value.get("phase").and_then(Value::as_str) == Some("commentary")
        || value.pointer("/item/phase").and_then(Value::as_str) == Some("commentary")
}

pub(super) fn extract_error_message(value: &Value) -> Option<String> {
    if let Some(message) = value.as_str() {
        let message = message.trim();
        if !message.is_empty() {
            return Some(message.to_string());
        }
    }

    let message = value
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())?;
    let details = value
        .get("additionalDetails")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|details| !details.is_empty());

    Some(match details {
        Some(details) => format!("{message}: {details}"),
        None => message.to_string(),
    })
}

pub(super) fn extract_turn_text(turn: &Value) -> Option<String> {
    turn.pointer("/items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().rev().find_map(|item| {
                (item.get("type").and_then(Value::as_str) == Some("agentMessage"))
                    .then(|| item.get("text").and_then(Value::as_str))
                    .flatten()
                    .map(str::to_string)
            })
        })
}

pub(super) fn thread_read_turns(value: &Value) -> Vec<Value> {
    value
        .pointer("/thread/turns")
        .or_else(|| value.get("turns"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub(super) fn provider_turn_items(turn: &Value) -> Vec<Value> {
    turn.pointer("/items")
        .or_else(|| turn.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub(super) fn replay_item_params(item: &Value, provider_turn_id: Option<&str>) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("item".to_string(), item.clone());
    if let Some(provider_turn_id) = provider_turn_id {
        params.insert(
            "turnId".to_string(),
            Value::String(provider_turn_id.to_string()),
        );
    }
    Value::Object(params)
}

pub(super) fn replay_item_status(item: &Value) -> ChatItemStatus {
    match item.get("status").and_then(Value::as_str) {
        Some("failed" | "error") => ChatItemStatus::Failed,
        Some("started") => ChatItemStatus::Started,
        Some("streaming" | "in_progress") => ChatItemStatus::Streaming,
        _ => ChatItemStatus::Completed,
    }
}

pub(super) fn replay_reasoning_text(item: &Value) -> Option<String> {
    item.get("text")
        .and_then(Value::as_str)
        .or_else(|| item.get("summary").and_then(Value::as_str))
        .or_else(|| item.get("summaryText").and_then(Value::as_str))
        .map(str::to_string)
}

pub(super) fn extract_thread_read_text(value: &Value) -> Option<String> {
    value
        .pointer("/thread/turns")
        .and_then(Value::as_array)
        .and_then(|turns| turns.iter().rev().find_map(extract_turn_text))
}

pub(super) fn model_option_from_value(value: &Value) -> Option<ChatModelOption> {
    let supported_reasoning_efforts = value
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    Some(ChatModelReasoningEffortOption {
                        reasoning_effort: parse_reasoning_effort(
                            option.get("reasoningEffort")?.as_str()?,
                        ),
                        description: option.get("description")?.as_str()?.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some(ChatModelOption {
        id: value.get("id")?.as_str()?.to_string(),
        model: value.get("model")?.as_str()?.to_string(),
        display_name: value.get("displayName")?.as_str()?.to_string(),
        description: value.get("description")?.as_str()?.to_string(),
        is_default: value.get("isDefault")?.as_bool()?,
        hidden: value.get("hidden")?.as_bool()?,
        default_reasoning_effort: parse_reasoning_effort(
            value.get("defaultReasoningEffort")?.as_str()?,
        ),
        supported_reasoning_efforts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::test_support::*;

    #[test]
    fn extract_model_ignores_blank_values() {
        assert_eq!(extract_model(&json!({ "model": "" })), None);
        assert_eq!(extract_model(&json!({ "model": "   " })), None);
        assert_eq!(
            extract_model(&json!({ "model": "gpt-5.5" })),
            Some("gpt-5.5".to_string()),
        );
    }

    #[test]
    fn normalize_model_override_trims_and_drops_empty_values() {
        assert_eq!(normalize_model_override(None), None);
        assert_eq!(normalize_model_override(Some(String::new())), None);
        assert_eq!(normalize_model_override(Some("  ".to_string())), None);
        assert_eq!(
            normalize_model_override(Some("  gpt-5.5  ".to_string())),
            Some("gpt-5.5".to_string()),
        );
    }

    #[test]
    fn has_blank_model_field_detects_broken_thread_resume() {
        assert!(has_blank_model_field(&json!({ "model": "" })));
        assert!(has_blank_model_field(&json!({ "model": "  " })));
        assert!(!has_blank_model_field(&json!({ "model": "gpt-5.5" })));
        assert!(!has_blank_model_field(&json!({})));
    }

    #[test]
    fn extract_error_message_formats_app_server_errors() {
        assert_eq!(
            extract_error_message(&json!({
                "message": "request failed",
                "additionalDetails": "bad model"
            })),
            Some("request failed: bad model".to_string()),
        );
        assert_eq!(
            extract_error_message(&json!("plain failure")),
            Some("plain failure".to_string()),
        );
    }

    #[test]
    fn thread_start_params_include_absolute_worktree_cwd() {
        let params = build_thread_start_params(
            "/Users/me/project-worktree",
            Some("gpt-5.5"),
            Some(ChatPermissionMode::FullAccess),
        );

        assert_eq!(
            params.get("cwd").and_then(Value::as_str),
            Some("/Users/me/project-worktree"),
        );
        assert_eq!(params.get("model").and_then(Value::as_str), Some("gpt-5.5"));
        assert_eq!(
            params.get("sandbox").and_then(Value::as_str),
            Some("danger-full-access"),
        );
    }

    #[test]
    fn turn_start_params_include_absolute_worktree_cwd() {
        let mut conversation = test_conversation();
        conversation.selected_model = Some("gpt-5.5".to_string());
        conversation.selected_effort = Some(ChatReasoningEffort::High);
        let params = build_turn_start_params(
            "thread-1",
            "/Users/me/other-worktree",
            "Run tests",
            &conversation,
        );

        assert_eq!(
            params.get("cwd").and_then(Value::as_str),
            Some("/Users/me/other-worktree"),
        );
        assert_eq!(
            params.get("threadId").and_then(Value::as_str),
            Some("thread-1"),
        );
        assert_eq!(params.get("model").and_then(Value::as_str), Some("gpt-5.5"));
        assert_eq!(params.get("effort").and_then(Value::as_str), Some("high"));
    }
}
