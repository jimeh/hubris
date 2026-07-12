use hubris_server::task_manager::{
    TaskActionError, TaskFinalizeFuture, TaskInput, TaskMetadata, TaskStateInitFuture,
    TaskStateValue, TaskStepContext, TaskStepResult, TaskType, TaskTypeStep, TaskTypeStepRunFuture,
};
use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

const FIXTURE_TASK_NAME: &str = "integration.noop";

struct NoopTask;

static NOOP_STEPS: &[TaskTypeStep<()>] = &[TaskTypeStep::new(
    "complete",
    "Complete",
    100,
    complete_noop_step,
)];

fn complete_noop_step(_state: &mut (), _context: TaskStepContext) -> TaskTypeStepRunFuture<'_> {
    Box::pin(async { Ok(TaskStepResult::Completed) })
}

impl TaskType for NoopTask {
    type Input = ();
    type State = ();

    fn metadata(&self) -> TaskMetadata {
        TaskMetadata {
            name: FIXTURE_TASK_NAME.to_string(),
            title: "Integration No-op".to_string(),
            description: Some("Complete without external side effects.".to_string()),
            broadcast_updates: false,
            input_fields: vec![],
        }
    }

    fn parse_input(&self, _input: &TaskInput) -> Result<Self::Input, TaskActionError> {
        Ok(())
    }

    fn scope_key(&self, _input: &Self::Input) -> Result<Option<String>, TaskActionError> {
        Ok(None)
    }

    fn init<'a>(&'a self, _input: Self::Input) -> TaskStateInitFuture<'a, Self::State> {
        Box::pin(async { Ok(()) })
    }

    fn steps(&self) -> &'static [TaskTypeStep<Self::State>] {
        NOOP_STEPS
    }

    fn finalize<'a>(
        &'a self,
        _state: &'a mut Self::State,
        _final_status: TaskStateValue,
    ) -> TaskFinalizeFuture<'a> {
        Box::pin(async {})
    }
}

async fn start_test_server(register_noop: bool) -> (String, tempfile::TempDir) {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(tmp.path().to_path_buf()).await;
    if register_noop {
        state.tasks.register_typed_task(NoopTask);
    }
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{addr}"), tmp)
}

async fn wait_for_task(
    client: &reqwest::Client,
    base: &str,
    id: &str,
    expected_status: &str,
) -> Value {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let response = client
            .get(format!("{base}/api/tasks/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        if body["status"] == expected_status {
            return body;
        }

        assert!(
            tokio::time::Instant::now() < deadline,
            "task did not reach {expected_status}: {body}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn test_list_definitions_reports_real_app_state_registrations() {
    let (base, _tmp) = start_test_server(false).await;

    let response = reqwest::get(format!("{base}/api/tasks/definitions"))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let definitions: Vec<Value> = response.json().await.unwrap();
    let names = definitions
        .iter()
        .map(|definition| definition["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["vscode.check-update", "vscode.install-runtime"]);
    let install = definitions
        .iter()
        .find(|definition| definition["name"] == "vscode.install-runtime")
        .unwrap();
    assert_eq!(install["broadcastUpdates"], true);
    assert!(install["inputFields"].is_array());
    assert!(install["steps"].is_array());
}

#[tokio::test]
async fn test_list_tasks_starts_empty() {
    let (base, _tmp) = start_test_server(false).await;

    let response = reqwest::get(format!("{base}/api/tasks")).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let tasks: Vec<Value> = response.json().await.unwrap();
    assert!(tasks.is_empty());
}

#[tokio::test]
async fn test_start_get_and_list_task_use_contract_shape() {
    let (base, _tmp) = start_test_server(true).await;
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{base}/api/tasks"))
        .json(&serde_json::json!({
            "definitionName": FIXTURE_TASK_NAME,
            "input": {}
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let started: Value = response.json().await.unwrap();
    assert!(started["id"].is_string());
    assert_eq!(started["definitionName"], FIXTURE_TASK_NAME);
    assert_eq!(started["title"], "Integration No-op");
    assert!(started["createdAt"].is_string());
    assert!(started["progressPercent"].is_number());
    assert!(started["steps"].is_array());

    let id = started["id"].as_str().unwrap();
    let completed = wait_for_task(&client, &base, id, "succeeded").await;
    assert_eq!(completed["progressPercent"], 100);
    assert!(completed["finishedAt"].is_string());

    let response = client
        .get(format!("{base}/api/tasks"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let tasks: Vec<Value> = response.json().await.unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["id"], id);
}

#[tokio::test]
async fn test_get_task_returns_not_found_for_unknown_id() {
    let (base, _tmp) = start_test_server(false).await;

    let response = reqwest::get(format!("{base}/api/tasks/missing"))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["message"], "unknown task invocation: missing");
}

#[tokio::test]
async fn test_start_task_rejects_unknown_definition() {
    let (base, _tmp) = start_test_server(false).await;

    let response = reqwest::Client::new()
        .post(format!("{base}/api/tasks"))
        .json(&serde_json::json!({
            "definitionName": "missing",
            "input": {}
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["message"], "unknown task definition: missing");
}

#[tokio::test]
async fn test_start_task_rejects_non_object_input() {
    let (base, _tmp) = start_test_server(false).await;

    let response = reqwest::Client::new()
        .post(format!("{base}/api/tasks"))
        .json(&serde_json::json!({
            "definitionName": "vscode.install-runtime",
            "input": "invalid"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["message"], "task input must be a JSON object");
}
