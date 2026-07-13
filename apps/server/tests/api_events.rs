use std::fmt::Debug;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::response::IntoResponse;
use futures_util::{Stream, StreamExt};
use hubris_server::api::events::{EventStreamParams, event_stream};
use hubris_server::events::EventKind;
use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

async fn start_test_server() -> (String, tempfile::TempDir) {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(tmp.path().to_path_buf()).await;
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{addr}"), tmp)
}

fn init_git_repo() -> tempfile::TempDir {
    let repo = tempfile::TempDir::new().unwrap();
    run_git(repo.path(), &["init", "-q"]);
    run_git(repo.path(), &["config", "user.email", "test@example.com"]);
    run_git(repo.path(), &["config", "user.name", "Hubris Test"]);
    std::fs::write(repo.path().join("README.md"), "hello\n").unwrap();
    run_git(repo.path(), &["add", "README.md"]);
    run_git(repo.path(), &["commit", "-q", "-m", "init"]);
    run_git(repo.path(), &["branch", "-M", "main"]);
    repo
}

fn run_git(repo_path: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .arg("-c")
        .arg("commit.gpgsign=false")
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git failed: {args:?}");
}

fn find_sse_separator(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .or_else(|| buffer.windows(4).position(|window| window == b"\r\n\r\n"))
}

fn take_sse_event(buffer: &mut Vec<u8>) -> Option<(String, Value)> {
    let separator = find_sse_separator(buffer)?;
    let separator_len = if buffer.get(separator..separator + 4) == Some(b"\r\n\r\n") {
        4
    } else {
        2
    };
    let raw = buffer
        .drain(..separator + separator_len)
        .collect::<Vec<_>>();
    let text = String::from_utf8(raw).unwrap();
    let mut event_name = None;
    let mut data = None;

    for line in text.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            event_name = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            data = Some(serde_json::from_str(value.trim()).unwrap());
        }
    }

    event_name.zip(data)
}

async fn next_http_sse_event(
    response: &mut reqwest::Response,
    buffer: &mut Vec<u8>,
) -> (String, Value) {
    loop {
        if let Some(event) = take_sse_event(buffer) {
            return event;
        }

        let chunk = tokio::time::timeout(Duration::from_secs(2), response.chunk())
            .await
            .unwrap()
            .unwrap()
            .expect("SSE stream ended before next event");
        buffer.extend_from_slice(&chunk);
    }
}

async fn next_body_sse_event<S, E>(stream: &mut S, buffer: &mut Vec<u8>) -> (String, Value)
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
    E: Debug,
{
    loop {
        if let Some(event) = take_sse_event(buffer) {
            return event;
        }

        let chunk = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .unwrap()
            .expect("SSE stream ended before next event")
            .unwrap();
        buffer.extend_from_slice(&chunk);
    }
}

#[tokio::test]
async fn snapshot_incremental_event_and_reconnect_snapshot() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();
    let repo = init_git_repo();
    let mut events = client
        .get(format!("{base}/api/events?sessionId=default"))
        .send()
        .await
        .unwrap();
    assert_eq!(events.status(), StatusCode::OK);
    let mut buffer = Vec::new();

    let (event_name, snapshot) = next_http_sse_event(&mut events, &mut buffer).await;
    assert_eq!(event_name, "snapshot");
    assert_eq!(snapshot["type"], "snapshot");
    assert!(snapshot["data"]["projects"].as_array().unwrap().is_empty());

    let response = client
        .post(format!("{base}/api/projects"))
        .json(&serde_json::json!({
            "path": repo.path().to_string_lossy(),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let project: Value = response.json().await.unwrap();
    let project_id = project["id"].as_str().unwrap();

    let (event_name, project_added) = next_http_sse_event(&mut events, &mut buffer).await;
    assert_eq!(event_name, "project_added");
    assert_eq!(project_added["type"], "project_added");
    assert_eq!(project_added["data"]["id"], project_id);

    let mut reconnected = client
        .get(format!("{base}/api/events?sessionId=default"))
        .send()
        .await
        .unwrap();
    assert_eq!(reconnected.status(), StatusCode::OK);
    let (event_name, snapshot) = next_http_sse_event(&mut reconnected, &mut Vec::new()).await;
    assert_eq!(event_name, "snapshot");
    let projects = snapshot["data"]["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0]["id"], project_id);
}

#[tokio::test]
async fn lagged_stream_recovers_with_fresh_snapshot() {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(tmp.path().to_path_buf()).await;
    let sse = event_stream(
        State(state.clone()),
        Query(EventStreamParams {
            session_id: "default".to_string(),
        }),
    )
    .await;

    for index in 0..257 {
        state.events.emit(EventKind::ProjectRemoved {
            project_id: format!("project-{index}"),
        });
    }

    let mut stream = sse.into_response().into_body().into_data_stream();
    let mut buffer = Vec::new();
    let (event_name, initial) = next_body_sse_event(&mut stream, &mut buffer).await;
    assert_eq!(event_name, "snapshot");
    assert_eq!(initial["type"], "snapshot");

    let (event_name, recovery) = next_body_sse_event(&mut stream, &mut buffer).await;
    assert_eq!(event_name, "snapshot");
    assert_eq!(recovery["type"], "snapshot");
    assert!(recovery["data"]["projects"].as_array().unwrap().is_empty());
}
