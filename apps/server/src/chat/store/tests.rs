use super::*;
use crate::chat::test_support::*;

#[tokio::test]
async fn create_conversation_emits_the_returned_summary() {
    let service = test_service().await;
    let mut events = service.events.subscribe();

    let returned = create_persisted_conversation(&service).await;
    let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
        .await
        .unwrap()
        .unwrap();
    let EventKind::ChatConversationCreated { conversation, .. } = &event.kind else {
        panic!("expected chat_conversation_created event");
    };

    assert_eq!(conversation, &returned);
}

#[tokio::test]
async fn update_conversation_settings_preserves_not_found_errors() {
    let service = test_service().await;

    let error = service
        .update_conversation_settings(
            "missing",
            ChatConversationSettingsPatch {
                selected_model: None,
                selected_effort: None,
                selected_permission_mode: None,
            },
        )
        .await
        .unwrap_err();

    assert!(matches!(error.kind, ChatErrorKind::NotFound));
}

#[test]
fn compact_payload_json_truncates_unicode_at_a_char_boundary() {
    let payload = Value::String("é".repeat(32_768));

    let compacted = compact_payload_json(&payload);
    let wrapper: Value = serde_json::from_str(&compacted).unwrap();

    assert_eq!(wrapper["truncated"], true);
}

#[tokio::test]
async fn conversation_branch_scope_archive_and_delete_round_trip() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    assert_eq!(conversation.branch_name.as_deref(), Some("main"));
    assert_eq!(conversation.archived_at, None);

    let branch_chats = service
        .list_conversations(
            "project-1",
            "worktree-1",
            "main",
            "default",
            ChatConversationListScope::Branch,
            false,
        )
        .await
        .unwrap();
    assert_eq!(branch_chats.len(), 1);

    let other_branch_chats = service
        .list_conversations(
            "project-1",
            "worktree-2",
            "feature",
            "default",
            ChatConversationListScope::Branch,
            false,
        )
        .await
        .unwrap();
    assert!(other_branch_chats.is_empty());

    let archived = service
        .set_conversation_archived(&conversation.id, true)
        .await
        .unwrap();
    assert!(archived.archived_at.is_some());
    let hidden = service
        .list_conversations(
            "project-1",
            "worktree-1",
            "main",
            "default",
            ChatConversationListScope::Branch,
            false,
        )
        .await
        .unwrap();
    assert!(hidden.is_empty());
    let visible_with_archive = service
        .list_conversations(
            "project-1",
            "worktree-1",
            "main",
            "default",
            ChatConversationListScope::Branch,
            true,
        )
        .await
        .unwrap();
    assert_eq!(visible_with_archive.len(), 1);

    let unarchived = service
        .set_conversation_archived(&conversation.id, false)
        .await
        .unwrap();
    assert_eq!(unarchived.archived_at, None);

    service.delete_conversation(&conversation.id).await.unwrap();
    assert!(
        service
            .get_conversation_summary(&conversation.id)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn legacy_conversation_branch_backfills_on_open() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    sqlx::query("UPDATE chat_conversations SET branch_name = NULL WHERE id = ?")
        .bind(&conversation.id)
        .execute(&service.pool)
        .await
        .unwrap();

    let backfilled = service
        .backfill_conversation_branch(&conversation.id, "feature/demo")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(backfilled.branch_name.as_deref(), Some("feature/demo"));
}

#[tokio::test]
async fn persist_run_start_creates_turn_and_links_messages_and_run() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let user_message_id = "user-1";
    let assistant_message_id = "assistant-1";
    let run_id = "run-1";
    let turn_id = "turn-local-1";

    service
        .persist_run_start(
            &conversation,
            user_message_id,
            assistant_message_id,
            run_id,
            turn_id,
            "What changed?",
        )
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detail.turns.len(), 1);
    assert_eq!(detail.turns[0].run_id, run_id);
    assert_eq!(detail.turns[0].user_message_id, user_message_id);
    assert_eq!(detail.turns[0].assistant_message_id, assistant_message_id);
    assert_eq!(detail.messages.len(), 2);
    assert!(
        detail
            .messages
            .iter()
            .all(|message| { message.turn_id.as_deref() == Some(turn_id) })
    );
    assert_eq!(detail.latest_run.unwrap().turn_id.as_deref(), Some(turn_id));
}

#[tokio::test]
async fn attach_turn_to_run_sets_provider_turn_on_turn_run_and_messages() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    let (_, assistant_message_id, run_id, turn_id) =
        start_test_run(&service, &conversation, &runtime).await;

    service
        .attach_turn_to_run(
            &conversation.id,
            &run_id,
            &turn_id,
            &assistant_message_id,
            Some("provider-turn-1"),
        )
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        detail.turns[0].provider_turn_id.as_deref(),
        Some("provider-turn-1")
    );
    assert_eq!(
        detail.latest_run.unwrap().provider_turn_id.as_deref(),
        Some("provider-turn-1")
    );
    assert!(
        detail
            .messages
            .iter()
            .all(|message| { message.provider_turn_id.as_deref() == Some("provider-turn-1") })
    );
}

#[tokio::test]
async fn attach_turn_to_run_rolls_back_when_a_related_update_fails() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    let (_, assistant_message_id, run_id, turn_id) =
        start_test_run(&service, &conversation, &runtime).await;
    sqlx::query(
        "
        CREATE TRIGGER reject_turn_attachment
        BEFORE UPDATE OF provider_turn_id ON chat_turns
        BEGIN
            SELECT RAISE(ABORT, 'reject turn attachment');
        END
        ",
    )
    .execute(&service.pool)
    .await
    .unwrap();

    let result = service
        .attach_turn_to_run(
            &conversation.id,
            &run_id,
            &turn_id,
            &assistant_message_id,
            Some("provider-turn-1"),
        )
        .await;
    assert!(result.is_err());

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detail.turns[0].provider_turn_id, None);
    assert_eq!(detail.turns[0].status, ChatTurnStatus::Starting);
    assert_eq!(detail.latest_run.as_ref().unwrap().provider_turn_id, None);
    assert_eq!(detail.latest_run.unwrap().status, ChatRunStatus::Starting);
    assert!(
        detail
            .messages
            .iter()
            .all(|message| message.provider_turn_id.is_none())
    );
}

#[tokio::test]
async fn pending_request_terminal_transition_does_not_overwrite_a_winner() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    let request = service
        .persist_provider_request(
            &conversation.id,
            &runtime,
            PersistProviderRequest {
                jsonrpc_id: json!(42),
                method: "item/commandExecution/requestApproval".to_string(),
                params: json!({ "command": "echo test" }),
                route_hints: route_hints(Some("thread-1"), Some("turn-1"), Some("item-1"), None),
                status: ChatPendingRequestStatus::Pending,
                decision: None,
                error_message: None,
            },
        )
        .await
        .unwrap();
    let winner = service
        .update_pending_request_terminal(
            &conversation.id,
            &request.id,
            ChatPendingRequestStatus::Resolved,
            Some(&ChatPendingRequestDecision::Accept),
            Some(&json!({ "decision": "accept" })),
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(winner.transitioned);

    let responder = PendingServerResponder {
        jsonrpc_id: json!(42),
        conversation_id: conversation.id.clone(),
        provider_request_id: request.provider_request_id.clone(),
        owner_generation: 1,
    };
    service
        .pending_server_responders
        .insert(request.id.clone(), responder.clone());
    service
        .pending_server_responders
        .insert(request.provider_request_id.clone(), responder);

    let loser = service
        .update_pending_request_terminal(
            &conversation.id,
            &request.id,
            ChatPendingRequestStatus::Stale,
            None,
            None,
            Some("late stale transition"),
        )
        .await
        .unwrap()
        .unwrap();

    assert!(!loser.transitioned);
    assert_eq!(loser.request.status, ChatPendingRequestStatus::Resolved);
    assert!(service.pending_server_responders.contains_key(&request.id));
}

#[tokio::test]
async fn finalize_run_returns_the_targeted_run() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    service
        .persist_run_start(
            &conversation,
            "user-a",
            "assistant-a",
            "run-a",
            "turn-a",
            "first",
        )
        .await
        .unwrap();
    service
        .persist_run_start(
            &conversation,
            "user-z",
            "assistant-z",
            "run-z",
            "turn-z",
            "second",
        )
        .await
        .unwrap();

    let (finalized, _) = service
        .finalize_run(
            &conversation.id,
            "run-a",
            ChatRunStatus::Completed,
            None,
            None,
        )
        .await
        .unwrap();

    assert_eq!(finalized.id, "run-a");
}

#[tokio::test]
async fn finalize_run_rolls_back_when_a_related_update_fails() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    service
        .persist_run_start(
            &conversation,
            "user-1",
            "assistant-1",
            "run-1",
            "turn-1",
            "hello",
        )
        .await
        .unwrap();
    sqlx::query(
        "
        CREATE TRIGGER reject_conversation_finalization
        BEFORE UPDATE OF last_run_state ON chat_conversations
        BEGIN
            SELECT RAISE(ABORT, 'reject conversation finalization');
        END
        ",
    )
    .execute(&service.pool)
    .await
    .unwrap();

    let result = service
        .finalize_run(
            &conversation.id,
            "run-1",
            ChatRunStatus::Completed,
            None,
            Some(("assistant-1", "Done", ChatMessageStatus::Completed)),
        )
        .await;
    assert!(result.is_err());

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detail.latest_run.unwrap().status, ChatRunStatus::Starting);
    assert_eq!(detail.turns[0].status, ChatTurnStatus::Starting);
    assert_eq!(detail.conversation.last_run_state, ChatRunStatus::Starting);
    let assistant_message = detail
        .messages
        .iter()
        .find(|message| message.id == "assistant-1")
        .unwrap();
    assert_eq!(assistant_message.status, ChatMessageStatus::Streaming);
    assert_eq!(assistant_message.content_text, "");
}

#[tokio::test]
async fn agent_message_delta_creates_item_and_preserves_transcript_projection() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    let (_, assistant_message_id, _, turn_id) =
        start_test_run(&service, &conversation, &runtime).await;

    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "item/agentMessage/delta",
            json!({
                "threadId": "thread-1",
                "turnId": "provider-turn-1",
                "itemId": "item-1",
                "delta": "Hello"
            }),
        )
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    let message = detail
        .messages
        .iter()
        .find(|message| message.id == assistant_message_id)
        .unwrap();
    assert_eq!(message.content_text, "Hello");
    assert_eq!(message.reasoning_text, "");
    assert_eq!(message.provider_item_id.as_deref(), Some("item-1"));
    assert_eq!(detail.items.len(), 1);
    assert_eq!(detail.items[0].kind, ChatItemKind::AgentMessage);
    assert_eq!(detail.items[0].status, ChatItemStatus::Streaming);
    assert_eq!(detail.items[0].turn_id.as_deref(), Some(turn_id.as_str()));
}

#[tokio::test]
async fn streaming_snapshot_throttle_allows_message_deltas_to_merge() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    let (_, assistant_message_id, _, _) = start_test_run(&service, &conversation, &runtime).await;
    let mut events = service.events.subscribe();
    service.events.emit(EventKind::ProjectRemoved {
        project_id: "test-barrier".to_string(),
    });
    loop {
        let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        if matches!(
            &event.kind,
            EventKind::ProjectRemoved { project_id } if project_id == "test-barrier"
        ) {
            break;
        }
    }

    for delta in ["one ", "two ", "three"] {
        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/agentMessage/delta",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "itemId": "item-1",
                    "delta": delta
                }),
            )
            .await
            .unwrap();
    }

    let snapshot = tokio::time::timeout(Duration::from_secs(1), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(snapshot.kind, EventKind::ChatItemUpdated { .. }));

    let merged_delta = tokio::time::timeout(Duration::from_secs(1), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        &merged_delta.kind,
        EventKind::ChatMessageDelta {
            message_id,
            delta,
            ..
        } if message_id == &assistant_message_id && delta == "one two three"
    ));
}

#[tokio::test]
async fn commentary_agent_message_delta_inherits_item_started_phase() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    let (_, assistant_message_id, _, _) = start_test_run(&service, &conversation, &runtime).await;

    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "item/started",
            json!({
                "threadId": "thread-1",
                "turnId": "provider-turn-1",
                "item": {
                    "id": "commentary-1",
                    "type": "agentMessage",
                    "phase": "commentary"
                }
            }),
        )
        .await
        .unwrap();
    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "item/agentMessage/delta",
            json!({
                "threadId": "thread-1",
                "turnId": "provider-turn-1",
                "itemId": "commentary-1",
                "delta": "Inspecting first."
            }),
        )
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    let message = detail
        .messages
        .iter()
        .find(|message| message.id == assistant_message_id)
        .unwrap();
    assert_eq!(message.content_text, "");
    assert_eq!(message.reasoning_text, "Inspecting first.");
    assert_eq!(detail.items.len(), 1);
    assert_eq!(detail.items[0].kind, ChatItemKind::Reasoning);
    assert_eq!(
        detail.items[0].summary.as_deref(),
        Some("Inspecting first.")
    );
    let activity = service
        .get_activity_detail(&conversation.id, &detail.items[0].id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(activity.outputs.len(), 1);
    assert_eq!(activity.outputs[0].content_text, "Inspecting first.");
}

#[tokio::test]
async fn multiple_commentary_agent_messages_accumulate_reasoning() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    let (_, assistant_message_id, _, _) = start_test_run(&service, &conversation, &runtime).await;

    for (item_id, text) in [
        ("commentary-1", "Inspecting first."),
        ("commentary-2", "Checking config next."),
    ] {
        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/started",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "item": {
                        "id": item_id,
                        "type": "agentMessage",
                        "phase": "commentary"
                    }
                }),
            )
            .await
            .unwrap();
        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/agentMessage/delta",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "itemId": item_id,
                    "delta": text
                }),
            )
            .await
            .unwrap();
        service
            .handle_provider_notification(
                &conversation.id,
                &runtime,
                "item/completed",
                json!({
                    "threadId": "thread-1",
                    "turnId": "provider-turn-1",
                    "item": {
                        "id": item_id,
                        "type": "agentMessage",
                        "phase": "commentary",
                        "text": text
                    }
                }),
            )
            .await
            .unwrap();
    }
    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "item/started",
            json!({
                "threadId": "thread-1",
                "turnId": "provider-turn-1",
                "item": {
                    "id": "final-1",
                    "type": "agentMessage",
                    "phase": "final_answer"
                }
            }),
        )
        .await
        .unwrap();
    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "item/agentMessage/delta",
            json!({
                "threadId": "thread-1",
                "turnId": "provider-turn-1",
                "itemId": "final-1",
                "delta": "Final answer."
            }),
        )
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    let message = detail
        .messages
        .iter()
        .find(|message| message.id == assistant_message_id)
        .unwrap();
    assert_eq!(message.content_text, "Final answer.");
    assert_eq!(
        message.reasoning_text,
        "Inspecting first.\n\nChecking config next."
    );
    assert_eq!(
        detail
            .items
            .iter()
            .filter(|item| item.kind == ChatItemKind::Reasoning)
            .count(),
        2
    );
    let reasoning_summaries = detail
        .items
        .iter()
        .filter(|item| item.kind == ChatItemKind::Reasoning)
        .map(|item| item.summary.as_deref())
        .collect::<Vec<_>>();
    assert_eq!(
        reasoning_summaries,
        vec![Some("Inspecting first."), Some("Checking config next.")]
    );
}

#[tokio::test]
async fn reasoning_delta_creates_reasoning_item_without_response_text() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    let (_, assistant_message_id, _, _) = start_test_run(&service, &conversation, &runtime).await;

    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "item/reasoning/summaryTextDelta",
            json!({
                "threadId": "thread-1",
                "turnId": "provider-turn-1",
                "itemId": "reasoning-1",
                "delta": "Thinking"
            }),
        )
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    let message = detail
        .messages
        .iter()
        .find(|message| message.id == assistant_message_id)
        .unwrap();
    assert_eq!(message.content_text, "");
    assert_eq!(message.reasoning_text, "Thinking");
    assert_eq!(message.provider_item_id, None);
    assert_eq!(detail.items[0].kind, ChatItemKind::Reasoning);
    assert_eq!(detail.items[0].summary.as_deref(), Some("Thinking"));
}

#[tokio::test]
async fn command_output_delta_creates_activity_item_and_output() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    let (_, assistant_message_id, _, _) = start_test_run(&service, &conversation, &runtime).await;

    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "item/commandExecution/outputDelta",
            json!({
                "threadId": "thread-1",
                "turnId": "provider-turn-1",
                "itemId": "command-1",
                "item": {
                    "id": "command-1",
                    "type": "commandExecution",
                    "command": "cargo test"
                },
                "stream": "stdout",
                "delta": "running 1 test\n"
            }),
        )
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    let message = detail
        .messages
        .iter()
        .find(|message| message.id == assistant_message_id)
        .unwrap();
    assert_eq!(message.content_text, "");
    assert_eq!(detail.items.len(), 1);
    assert_eq!(detail.items[0].kind, ChatItemKind::CommandExecution);
    assert_eq!(detail.items[0].title.as_deref(), Some("Run `cargo test`"));
    assert_eq!(
        detail.items[0].provider_item_id.as_deref(),
        Some("command-1")
    );

    let activity = service
        .get_activity_detail(&conversation.id, &detail.items[0].id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(activity.outputs.len(), 1);
    assert_eq!(activity.outputs[0].stream_kind, "stdout");
    assert_eq!(activity.outputs[0].content_text, "running 1 test\n");
}

#[tokio::test]
async fn file_change_completion_synthesizes_activity_item() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    start_test_run(&service, &conversation, &runtime).await;

    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "provider-turn-1",
                "item": {
                    "id": "file-1",
                    "type": "fileChange",
                    "path": "src/lib.rs"
                }
            }),
        )
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detail.items.len(), 1);
    assert_eq!(detail.items[0].kind, ChatItemKind::FileChange);
    assert_eq!(detail.items[0].status, ChatItemStatus::Completed);
    assert_eq!(detail.items[0].title.as_deref(), Some("Edit src/lib.rs"));
}

#[tokio::test]
async fn item_completed_before_started_is_idempotent() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    start_test_run(&service, &conversation, &runtime).await;
    let params = json!({
        "threadId": "thread-1",
        "turnId": "provider-turn-1",
        "item": {
            "id": "item-1",
            "type": "agentMessage",
            "text": "Final"
        }
    });

    service
        .handle_provider_notification(&conversation.id, &runtime, "item/completed", params.clone())
        .await
        .unwrap();
    service
        .handle_provider_notification(&conversation.id, &runtime, "item/completed", params)
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detail.items.len(), 1);
    assert_eq!(detail.items[0].status, ChatItemStatus::Completed);
    assert_eq!(detail.messages[1].content_text, "Final");
}

#[tokio::test]
async fn turn_completed_finalizes_turn_run_and_message() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    start_test_run(&service, &conversation, &runtime).await;

    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "provider-turn-1",
                    "status": "completed",
                    "items": [
                        {
                            "id": "item-1",
                            "type": "agentMessage",
                            "text": "Done"
                        }
                    ]
                }
            }),
        )
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detail.turns[0].status, ChatTurnStatus::Completed);
    assert_eq!(detail.latest_run.unwrap().status, ChatRunStatus::Completed);
    assert_eq!(detail.messages[1].status, ChatMessageStatus::Completed);
    assert_eq!(detail.messages[1].content_text, "Done");
}

#[tokio::test]
async fn plan_notifications_create_active_and_proposed_plans() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    start_test_run(&service, &conversation, &runtime).await;

    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "turn/plan/updated",
            json!({
                "threadId": "thread-1",
                "turnId": "provider-turn-1",
                "steps": [
                    { "text": "Inspect state", "status": "completed" },
                    { "text": "Patch code", "status": "in_progress" }
                ]
            }),
        )
        .await
        .unwrap();
    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "item/plan/delta",
            json!({
                "threadId": "thread-1",
                "turnId": "provider-turn-1",
                "itemId": "plan-item-1",
                "delta": "1. Inspect\n"
            }),
        )
        .await
        .unwrap();
    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "item/plan/delta",
            json!({
                "threadId": "thread-1",
                "turnId": "provider-turn-1",
                "itemId": "plan-item-1",
                "delta": "2. Patch\n"
            }),
        )
        .await
        .unwrap();
    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "provider-turn-1",
                "item": {
                    "id": "plan-item-1",
                    "type": "plan",
                    "text": "Final plan"
                }
            }),
        )
        .await
        .unwrap();
    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "provider-turn-1",
                    "status": "completed",
                    "items": []
                }
            }),
        )
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detail.plans.len(), 2);
    let active_plan = detail
        .plans
        .iter()
        .find(|plan| plan.kind == ChatPlanKind::ActiveTask)
        .unwrap();
    assert_eq!(active_plan.status, ChatPlanStatus::Completed);
    assert!(active_plan.steps_json.contains("Inspect state"));
    let proposed_plan = detail
        .plans
        .iter()
        .find(|plan| plan.kind == ChatPlanKind::ProposedPlan)
        .unwrap();
    assert_eq!(proposed_plan.status, ChatPlanStatus::Completed);
    assert_eq!(proposed_plan.content_text, "Final plan");
}

#[tokio::test]
async fn diff_and_context_notifications_do_not_mutate_transcript() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    start_test_run(&service, &conversation, &runtime).await;

    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "turn/diff/updated",
            json!({
                "threadId": "thread-1",
                "turnId": "provider-turn-1",
                "changedFileCount": 1,
                "additions": 8,
                "deletions": 2,
                "files": [
                    {
                        "path": "src/lib.rs",
                        "changeType": "modified",
                        "additions": 8,
                        "deletions": 2
                    }
                ]
            }),
        )
        .await
        .unwrap();
    service
        .handle_provider_notification(
            &conversation.id,
            &runtime,
            "thread/tokenUsage/updated",
            json!({
                "threadId": "thread-1",
                "usedTokens": 1200,
                "maxTokens": 12000,
                "totalProcessedTokens": 3000
            }),
        )
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detail.diff_summaries.len(), 1);
    assert_eq!(detail.diff_summaries[0].changed_file_count, 1);
    assert_eq!(detail.diff_summaries[0].files[0].path, "src/lib.rs");
    assert_eq!(
        detail.context_usage.as_ref().unwrap().percent_used,
        Some(10.0)
    );
    assert_eq!(detail.messages[1].content_text, "");
}

#[tokio::test]
async fn process_loss_preserves_partial_turn_and_marks_reconciliation_pending() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    let (_, assistant_message_id, _, _) = start_test_run(&service, &conversation, &runtime).await;
    service
        .append_message_delta(&conversation.id, &assistant_message_id, "partial")
        .await
        .unwrap();

    service
        .handle_provider_closed("transport closed".to_string())
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    let message = detail
        .messages
        .iter()
        .find(|message| message.id == assistant_message_id)
        .unwrap();
    assert_eq!(message.status, ChatMessageStatus::Streaming);
    assert_eq!(message.content_text, "partial");
    assert_eq!(detail.latest_run.unwrap().status, ChatRunStatus::Starting);
    assert_eq!(
        detail.latest_reconciliation.unwrap().status,
        ChatReconciliationStatus::Pending
    );
}

#[tokio::test]
async fn thread_read_replay_finalizes_transcript_idempotently() {
    let service = test_service().await;
    let conversation = create_persisted_conversation(&service).await;
    let runtime = insert_test_runtime(&service, &conversation.id, "thread-1", true, 1).await;
    let (_, assistant_message_id, _, _) = start_test_run(&service, &conversation, &runtime).await;

    let replay = json!({
        "thread": {
            "turns": [
                {
                    "id": "provider-turn-1",
                    "status": "completed",
                    "items": [
                        {
                            "id": "provider-item-1",
                            "type": "agentMessage",
                            "status": "completed",
                            "text": "Final answer"
                        }
                    ]
                }
            ]
        }
    });
    service
        .apply_thread_read_replay(&conversation.id, &runtime, &replay)
        .await
        .unwrap();
    service
        .apply_thread_read_replay(&conversation.id, &runtime, &replay)
        .await
        .unwrap();

    let detail = service
        .get_conversation_detail(&conversation.id)
        .await
        .unwrap()
        .unwrap();
    let message = detail
        .messages
        .iter()
        .find(|message| message.id == assistant_message_id)
        .unwrap();
    assert_eq!(message.status, ChatMessageStatus::Completed);
    assert_eq!(message.content_text, "Final answer");
    assert_eq!(detail.latest_run.unwrap().status, ChatRunStatus::Completed);
    assert_eq!(
        detail.turns[0].provider_turn_id.as_deref(),
        Some("provider-turn-1")
    );
    assert_eq!(detail.items.len(), 1);
    assert_eq!(
        detail.items[0].provider_item_id.as_deref(),
        Some("provider-item-1")
    );
}
