use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum AppServerMethod {
    Current(&'static str),
    CurrentRequest(&'static str),
    Future(&'static str),
    Unknown(String),
}

impl AppServerMethod {
    pub(super) fn name(&self) -> &str {
        match self {
            Self::Current(method) | Self::CurrentRequest(method) | Self::Future(method) => method,
            Self::Unknown(method) => method,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) enum ParsedLine {
    Response {
        id: u64,
        result: Value,
        error_message: Option<String>,
    },
    ServerRequest {
        id: Value,
        method: String,
        method_kind: AppServerMethod,
        params: Value,
        thread_id: Option<String>,
    },
    Notification {
        method: String,
        method_kind: AppServerMethod,
        params: Value,
        thread_id: Option<String>,
    },
    Malformed {
        reason: String,
    },
    Unsupported {
        reason: String,
    },
}

pub(super) fn parse_jsonrpc_line(line: &str) -> ParsedLine {
    let value = match serde_json::from_str::<Value>(line) {
        Ok(value) => value,
        Err(error) => {
            return ParsedLine::Malformed {
                reason: error.to_string(),
            };
        }
    };

    let Some(object) = value.as_object() else {
        return ParsedLine::Unsupported {
            reason: "message is not a JSON object".to_string(),
        };
    };

    if let Some(method) = object.get("method").and_then(Value::as_str) {
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        let method_kind = classify_method(method);
        let thread_id = extract_thread_id(&params);
        if let Some(id) = object.get("id") {
            return ParsedLine::ServerRequest {
                id: id.clone(),
                method: method.to_string(),
                method_kind,
                params,
                thread_id,
            };
        }

        return ParsedLine::Notification {
            method: method.to_string(),
            method_kind,
            params,
            thread_id,
        };
    }

    if object.contains_key("result") || object.contains_key("error") {
        let Some(id) = object.get("id") else {
            return ParsedLine::Unsupported {
                reason: "response is missing id".to_string(),
            };
        };
        let Some(id) = id.as_u64() else {
            return ParsedLine::Unsupported {
                reason: "response id is not a numeric id".to_string(),
            };
        };
        let error_message = object.get("error").and_then(extract_error_message);
        let result = object.get("result").cloned().unwrap_or(Value::Null);
        return ParsedLine::Response {
            id,
            result,
            error_message,
        };
    }

    ParsedLine::Unsupported {
        reason: "message has no method, result, or error".to_string(),
    }
}

pub(super) fn classify_method(method: &str) -> AppServerMethod {
    match method {
        "error"
        | "item/reasoning/summaryTextDelta"
        | "item/agentMessage/delta"
        | "item/completed"
        | "turn/completed" => AppServerMethod::Current(method_static(method)),
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/tool/requestUserInput" => AppServerMethod::CurrentRequest(method_static(method)),
        "initialize"
        | "thread/start"
        | "thread/resume"
        | "thread/unsubscribe"
        | "thread/status/changed"
        | "thread/tokenUsage/updated"
        | "turn/plan/updated"
        | "item/plan/delta"
        | "turn/diff/updated"
        | "serverRequest/resolved" => AppServerMethod::Future(method_static(method)),
        _ => AppServerMethod::Unknown(method.to_string()),
    }
}

fn method_static(method: &str) -> &'static str {
    match method {
        "error" => "error",
        "item/reasoning/summaryTextDelta" => "item/reasoning/summaryTextDelta",
        "item/agentMessage/delta" => "item/agentMessage/delta",
        "item/completed" => "item/completed",
        "turn/completed" => "turn/completed",
        "item/commandExecution/requestApproval" => "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval" => "item/fileChange/requestApproval",
        "item/tool/requestUserInput" => "item/tool/requestUserInput",
        "initialize" => "initialize",
        "thread/start" => "thread/start",
        "thread/resume" => "thread/resume",
        "thread/unsubscribe" => "thread/unsubscribe",
        "thread/status/changed" => "thread/status/changed",
        "thread/tokenUsage/updated" => "thread/tokenUsage/updated",
        "turn/plan/updated" => "turn/plan/updated",
        "item/plan/delta" => "item/plan/delta",
        "turn/diff/updated" => "turn/diff/updated",
        "serverRequest/resolved" => "serverRequest/resolved",
        _ => unreachable!("unknown methods are handled before static mapping"),
    }
}

fn extract_thread_id(value: &Value) -> Option<String> {
    value
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| value.get("thread_id").and_then(Value::as_str))
        .or_else(|| {
            value
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            value
                .get("turn")
                .and_then(|turn| turn.get("threadId"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            value
                .get("item")
                .and_then(|item| item.get("threadId"))
                .and_then(Value::as_str)
        })
        .map(ToOwned::to_owned)
}

fn extract_error_message(value: &Value) -> Option<String> {
    value
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| value.as_str())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_successful_response() {
        match parse_jsonrpc_line(r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#) {
            ParsedLine::Response {
                id,
                result,
                error_message,
            } => {
                assert_eq!(id, 7);
                assert_eq!(result, json!({ "ok": true }));
                assert_eq!(error_message, None);
            }
            other => panic!("unexpected parsed line: {other:?}"),
        }
    }

    #[test]
    fn parses_error_response() {
        match parse_jsonrpc_line(r#"{"jsonrpc":"2.0","id":8,"error":{"message":"bad request"}}"#) {
            ParsedLine::Response {
                id,
                result,
                error_message,
            } => {
                assert_eq!(id, 8);
                assert_eq!(result, Value::Null);
                assert_eq!(error_message.as_deref(), Some("bad request"));
            }
            other => panic!("unexpected parsed line: {other:?}"),
        }
    }

    #[test]
    fn parses_server_request_before_response() {
        match parse_jsonrpc_line(
            r#"{"jsonrpc":"2.0","id":"req-1","method":"item/tool/requestUserInput","params":{"threadId":"thread-a"}}"#,
        ) {
            ParsedLine::ServerRequest {
                id,
                method,
                method_kind,
                thread_id,
                ..
            } => {
                assert_eq!(id, json!("req-1"));
                assert_eq!(method, "item/tool/requestUserInput");
                assert_eq!(
                    method_kind,
                    AppServerMethod::CurrentRequest("item/tool/requestUserInput")
                );
                assert_eq!(thread_id.as_deref(), Some("thread-a"));
            }
            other => panic!("unexpected parsed line: {other:?}"),
        }
    }

    #[test]
    fn parses_notification() {
        match parse_jsonrpc_line(
            r#"{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"hi","threadId":"thread-b"}}"#,
        ) {
            ParsedLine::Notification {
                method,
                method_kind,
                thread_id,
                ..
            } => {
                assert_eq!(method, "item/agentMessage/delta");
                assert_eq!(
                    method_kind,
                    AppServerMethod::Current("item/agentMessage/delta")
                );
                assert_eq!(thread_id.as_deref(), Some("thread-b"));
            }
            other => panic!("unexpected parsed line: {other:?}"),
        }
    }

    #[test]
    fn reports_malformed_json() {
        match parse_jsonrpc_line("{not-json") {
            ParsedLine::Malformed { reason } => {
                assert!(reason.contains("expected ident") || reason.contains("key"));
            }
            other => panic!("unexpected parsed line: {other:?}"),
        }
    }

    #[test]
    fn reports_non_numeric_response_id_as_unsupported() {
        match parse_jsonrpc_line(r#"{"jsonrpc":"2.0","id":"abc","result":{}}"#) {
            ParsedLine::Unsupported { reason } => {
                assert_eq!(reason, "response id is not a numeric id");
            }
            other => panic!("unexpected parsed line: {other:?}"),
        }
    }

    #[test]
    fn classifies_known_current_and_future_methods() {
        assert_eq!(
            classify_method("turn/completed"),
            AppServerMethod::Current("turn/completed")
        );
        assert_eq!(
            classify_method("item/commandExecution/requestApproval"),
            AppServerMethod::CurrentRequest("item/commandExecution/requestApproval")
        );
        assert_eq!(
            classify_method("thread/unsubscribe"),
            AppServerMethod::Future("thread/unsubscribe")
        );
    }

    #[test]
    fn classifies_unknown_methods_explicitly() {
        assert_eq!(
            classify_method("future/newEvent"),
            AppServerMethod::Unknown("future/newEvent".to_string())
        );
    }

    #[test]
    fn parses_mixed_fake_stream_preserving_routing_metadata() {
        let lines = [
            r#"{"jsonrpc":"2.0","id":1,"result":{"ready":true}}"#,
            r#"{"jsonrpc":"2.0","id":"approval-1","method":"item/commandExecution/requestApproval","params":{"threadId":"thread-a"}}"#,
            r#"{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"thread-b","delta":"hello"}}"#,
            "{bad-json",
        ];
        let parsed = lines
            .into_iter()
            .map(parse_jsonrpc_line)
            .collect::<Vec<_>>();

        assert!(matches!(parsed[0], ParsedLine::Response { id: 1, .. }));
        assert!(matches!(
            &parsed[1],
            ParsedLine::ServerRequest { thread_id, .. }
                if thread_id.as_deref() == Some("thread-a")
        ));
        assert!(matches!(
            &parsed[2],
            ParsedLine::Notification { thread_id, .. }
                if thread_id.as_deref() == Some("thread-b")
        ));
        assert!(matches!(parsed[3], ParsedLine::Malformed { .. }));
    }
}
