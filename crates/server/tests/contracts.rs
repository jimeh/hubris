use hubris_server::api::terminal::ServerControlMessage;
use hubris_server::events::EventKind;
use hubris_server::openapi_spec;

#[test]
fn sse_event_uses_type_and_data_envelope() {
    let json = serde_json::to_value(EventKind::TabClosed {
        tab_id: "tab-1".to_string(),
    })
    .unwrap();

    assert_eq!(json["type"], "tab_closed");
    assert_eq!(json["data"]["tab_id"], "tab-1");
}

#[test]
fn ws_server_message_uses_stable_keys() {
    let attached = serde_json::to_value(ServerControlMessage::Attached {
        byte_offset: 42,
        data_lost: true,
    })
    .unwrap();

    assert_eq!(attached["type"], "attached");
    assert_eq!(attached["byte_offset"], 42);
    assert_eq!(attached["data_lost"], true);

    let closed = serde_json::to_value(ServerControlMessage::TabClosed).unwrap();
    assert_eq!(closed["type"], "tab_closed");
    assert!(closed.get("byte_offset").is_none());
}

#[test]
fn openapi_contains_core_paths_and_schemas() {
    let spec = serde_json::to_value(openapi_spec()).unwrap();

    assert!(spec["paths"]["/api/projects"].is_object());
    assert!(spec["paths"]["/api/tabs"].is_object());
    assert!(spec["paths"]["/api/openapi.json"].is_object());

    assert!(spec["components"]["schemas"]["Project"].is_object());
    assert!(spec["components"]["schemas"]["Worktree"].is_object());
    assert!(spec["components"]["schemas"]["TabInfo"].is_object());
}
