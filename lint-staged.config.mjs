export default {
  "*": () => "git diff --cached --check",
  "*.{sh,bash}": "bash -n",
  "{.husky/pre-commit,.mise/tasks/*}": "bash -n",
  "{*.rs,Cargo.toml,Cargo.lock,rustfmt.toml,.sqlx/**,apps/server/**}": () =>
    "mise run check:server",
  "{package.json,bun.lock,apps/web/**}": () => "mise run check:web",
  "{package.json,bun.lock,apps/desktop/**}": () => "mise run check:desktop",
  "*.md": () => "mise run check:markdown",
};
