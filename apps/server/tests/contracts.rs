use std::collections::BTreeSet;

use hubris_server::API_ROUTES;
use hubris_server::api::terminal::ServerControlMessage;
use hubris_server::events::EventKind;
use hubris_server::openapi_spec;

#[test]
fn sse_event_uses_type_and_data_envelope() {
    let json = serde_json::to_value(EventKind::TabClosed {
        session_id: "default".to_string(),
        tab_id: "tab-1".to_string(),
    })
    .unwrap();

    assert_eq!(json["type"], "tab_closed");
    assert_eq!(json["data"]["session_id"], "default");
    assert_eq!(json["data"]["tab_id"], "tab-1");
}

#[test]
fn ws_server_message_uses_stable_keys() {
    let attached = serde_json::to_value(ServerControlMessage::Attached {
        byte_offset: 42,
        snapshot: true,
        data_lost: true,
        cols: 80,
        rows: 24,
    })
    .unwrap();

    assert_eq!(attached["type"], "attached");
    assert_eq!(attached["byte_offset"], 42);
    assert_eq!(attached["snapshot"], true);
    assert_eq!(attached["data_lost"], true);
    assert_eq!(attached["cols"], 80);
    assert_eq!(attached["rows"], 24);

    let resized = serde_json::to_value(ServerControlMessage::PtyResized {
        cols: 100,
        rows: 40,
    })
    .unwrap();
    assert_eq!(resized["type"], "pty_resized");
    assert_eq!(resized["cols"], 100);
    assert_eq!(resized["rows"], 40);

    let closed = serde_json::to_value(ServerControlMessage::TabClosed).unwrap();
    assert_eq!(closed["type"], "tab_closed");
    assert!(closed.get("byte_offset").is_none());
}

#[test]
fn openapi_contains_core_paths_and_schemas() {
    let spec = serde_json::to_value(openapi_spec()).unwrap();

    assert!(spec["paths"]["/api/projects"].is_object());
    assert!(spec["paths"]["/api/tabs"].is_object());
    assert!(spec["paths"]["/api/settings"]["get"].is_object());
    assert!(spec["paths"]["/api/settings"]["put"].is_object());
    assert!(spec["paths"]["/api/settings"]["patch"].is_object());
    assert!(spec["paths"]["/api/openapi.json"].is_object());
    assert!(spec["paths"]["/api/themes"].is_null());
    assert!(spec["paths"]["/api/themes/{id}"].is_null());
    assert_eq!(
        spec["components"]["schemas"]["ClientControlMessage"]["oneOf"][0]["properties"]["visible"]
            ["type"],
        "boolean"
    );
    assert!(
        spec["components"]["schemas"]["ServerControlMessage"]["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .any(|variant| variant["properties"]["type"]["enum"][0] == "pty_resized")
    );

    assert!(spec["components"]["schemas"]["Project"].is_object());
    assert!(spec["components"]["schemas"]["Worktree"].is_object());
    assert!(spec["components"]["schemas"]["TabInfo"].is_object());
    assert!(spec["components"]["schemas"]["Settings"].is_object());
    assert!(spec["components"]["schemas"]["SettingsPatch"].is_object());
    assert!(spec["components"]["schemas"]["SettingsState"].is_object());
    assert!(spec["components"]["schemas"]["ThemeMeta"].is_null());
    assert!(spec["components"]["schemas"]["ThemeFile"].is_null());
}

/// Replace every `{param}` path segment with `{}` so router and spec
/// paths compare equal even when the two sides name a parameter
/// differently (for example `{id}` vs `{project_id}`). Wildcard
/// segments (`{*path}`) normalize to the distinct token `{*}` so a
/// wildcard on one side never matches a single-segment parameter on
/// the other.
fn normalize_route_path(path: &str) -> String {
    path.split('/')
        .map(|segment| {
            if segment.starts_with("{*") && segment.ends_with('}') {
                "{*}"
            } else if segment.starts_with('{') && segment.ends_with('}') {
                "{}"
            } else {
                segment
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Normalize raw `(method, path)` pairs into a set, asserting that
/// normalization does not collapse two distinct routes. A collapse
/// would mean either a duplicate registration or two routes that
/// differ only by parameter name, and would let the parity check
/// silently miss real drift.
fn normalized_route_set(label: &str, raw: &[(String, String)]) -> BTreeSet<(String, String)> {
    let set: BTreeSet<(String, String)> = raw
        .iter()
        .map(|(method, path)| (method.clone(), normalize_route_path(path)))
        .collect();
    assert_eq!(
        set.len(),
        raw.len(),
        "{label} routes collapsed under parameter-name \
         normalization; two routes are duplicates or differ only by \
         parameter name: {raw:?}"
    );
    set
}

/// Collect raw `(method, path)` pairs from the OpenAPI spec.
fn spec_raw_routes(spec: &serde_json::Value) -> Vec<(String, String)> {
    const HTTP_METHODS: [&str; 8] = [
        "get", "post", "put", "delete", "patch", "head", "options", "trace",
    ];

    let mut routes = Vec::new();
    let paths = spec["paths"]
        .as_object()
        .expect("OpenAPI document must contain a `paths` object");
    for (path, item) in paths {
        // Every documented endpoint lives under /api. The router
        // manifest only covers the nested /api sub-router, so
        // non-API surfaces (static frontend fallback, the /code
        // proxy, desktop bootstrap/WS upgrade plumbing) stay out of
        // scope on both sides of this comparison.
        assert!(
            path.starts_with("/api/"),
            "OpenAPI path {path} is outside /api; extend the router \
             parity test if the spec grows non-/api surfaces"
        );
        let operations = item
            .as_object()
            .expect("every OpenAPI path item must be a JSON object");
        for method in operations.keys() {
            if HTTP_METHODS.contains(&method.as_str()) {
                routes.push((method.clone(), path.clone()));
            }
        }
    }
    routes
}

#[test]
fn router_routes_match_openapi_paths() {
    let spec = serde_json::to_value(openapi_spec()).unwrap();
    let spec_routes = normalized_route_set("OpenAPI spec", &spec_raw_routes(&spec));

    let router_raw: Vec<(String, String)> = API_ROUTES
        .iter()
        .map(|(method, path)| ((*method).to_string(), format!("/api{path}")))
        .collect();
    let router_routes = normalized_route_set("router", &router_raw);

    let missing_in_spec: Vec<_> = router_routes.difference(&spec_routes).collect();
    let missing_in_router: Vec<_> = spec_routes.difference(&router_routes).collect();

    assert!(
        missing_in_spec.is_empty() && missing_in_router.is_empty(),
        "router and OpenAPI spec drifted.\n\
         In router but missing from spec (add a #[utoipa::path] \
         annotation to the handler and list it in paths(...) in \
         api/openapi.rs, then run `mise run generate`): \
         {missing_in_spec:?}\n\
         In spec but missing from router (register the route in the \
         api_routes! table in lib.rs): {missing_in_router:?}"
    );
}
