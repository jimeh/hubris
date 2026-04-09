fn main() {
    ensure_placeholder_dist();
    tauri_build::build()
}

fn ensure_placeholder_dist() {
    let dist_dir = std::path::Path::new("../web/dist");
    let index = dist_dir.join("index.html");

    if index.exists() {
        return;
    }

    std::fs::create_dir_all(dist_dir).expect("failed to create placeholder dist directory");
    std::fs::write(
        index,
        "<!doctype html><html><body>Hubris desktop placeholder</body></html>",
    )
    .expect("failed to write placeholder dist entrypoint");
}
