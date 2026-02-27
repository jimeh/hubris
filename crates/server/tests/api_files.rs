use hubris_server::{AppState, build_router};
use reqwest::StatusCode;
use serde_json::Value;

async fn start_test_server() -> (String, tempfile::TempDir) {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = AppState::new(tmp.path().to_path_buf());
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{}", addr), tmp)
}

#[tokio::test]
async fn test_list_files_default_path() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .get(format!("{}/api/files", base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body: Value = res.json().await.unwrap();
    assert!(body["path"].is_string());
    assert!(body["entries"].is_array());
    assert!(body["home_dir"].is_string());
}

#[tokio::test]
async fn test_list_files_explicit_path() {
    let (base, tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    // Create subdirectories
    std::fs::create_dir(tmp.path().join("mydir")).unwrap();
    let git_dir = tmp.path().join("myrepo");
    std::fs::create_dir(&git_dir).unwrap();
    std::fs::create_dir(git_dir.join(".git")).unwrap();
    // Hidden dir (should be excluded by default)
    std::fs::create_dir(tmp.path().join(".hidden")).unwrap();
    // Regular file (should be excluded)
    std::fs::write(tmp.path().join("file.txt"), "hi").unwrap();

    let res = client
        .get(format!("{}/api/files?path={}", base, tmp.path().display()))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body: Value = res.json().await.unwrap();
    let entries = body["entries"].as_array().unwrap();

    // Should have mydir and myrepo only
    assert_eq!(entries.len(), 2);

    let names: Vec<&str> = entries
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"mydir"));
    assert!(names.contains(&"myrepo"));

    // myrepo should be detected as git repo
    let myrepo = entries.iter().find(|e| e["name"] == "myrepo").unwrap();
    assert_eq!(myrepo["is_git_repo"], true);

    let mydir = entries.iter().find(|e| e["name"] == "mydir").unwrap();
    assert_eq!(mydir["is_git_repo"], false);
}

#[tokio::test]
async fn test_list_files_show_hidden() {
    let (base, tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    std::fs::create_dir(tmp.path().join(".hidden")).unwrap();
    std::fs::create_dir(tmp.path().join("visible")).unwrap();

    let res = client
        .get(format!(
            "{}/api/files?path={}&show_hidden=true",
            base,
            tmp.path().display()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body: Value = res.json().await.unwrap();
    let entries = body["entries"].as_array().unwrap();
    let names: Vec<&str> = entries
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&".hidden"));
    assert!(names.contains(&"visible"));
}

#[tokio::test]
async fn test_list_files_nonexistent_path() {
    let (base, _tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let res = client
        .get(format!("{}/api/files?path=/nonexistent_xyz_12345", base,))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_list_files_path_is_file() {
    let (base, tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    let file_path = tmp.path().join("notadir.txt");
    std::fs::write(&file_path, "content").unwrap();

    let res = client
        .get(format!("{}/api/files?path={}", base, file_path.display()))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_list_files_sorted_alphabetically() {
    let (base, tmp) = start_test_server().await;
    let client = reqwest::Client::new();

    std::fs::create_dir(tmp.path().join("Zebra")).unwrap();
    std::fs::create_dir(tmp.path().join("alpha")).unwrap();
    std::fs::create_dir(tmp.path().join("Beta")).unwrap();

    let res = client
        .get(format!("{}/api/files?path={}", base, tmp.path().display()))
        .send()
        .await
        .unwrap();
    let body: Value = res.json().await.unwrap();
    let names: Vec<&str> = body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["alpha", "Beta", "Zebra"]);
}
