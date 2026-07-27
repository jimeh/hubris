//! Workspace package for release-please root version management.
//!
//! This crate is intentionally empty. It exists only so the workspace root
//! `Cargo.toml` is a real package manifest, which release-please's Rust
//! release strategy requires when it updates the root version. Real code
//! lives in `apps/server`, `crates/*`, and `tools/*`, which are listed in
//! `[workspace] default-members` so bare cargo commands still cover them.
