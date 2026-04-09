# hubris

## Docker

Run the default Linux test pass with:

```sh
mise run docker:test
```

The test image defaults to `mise run test`, so custom Linux commands are just
raw `docker run` overrides:

```sh
docker run --rm \
  -v "$PWD:/work" \
  -v hubris-docker-test-cargo:/cargo \
  -v hubris-docker-test-target:/cargo-target \
  -v hubris-docker-test-sccache:/sccache \
  -v hubris-docker-test-bun-cache:/bun-cache \
  -v hubris-docker-test-node-modules:/work/frontend/node_modules \
  -e CARGO_HOME=/cargo \
  -e CARGO_TARGET_DIR=/cargo-target \
  -e HOST_UID="$(id -u)" \
  -e HOST_GID="$(id -g)" \
  -w /work \
  hubris-test \
  cargo test -p hubris-server linux_parent_death_signal -- --nocapture
```

The image trusts `/work` via global `mise` settings. The entrypoint only does
cache ownership bootstrap and runs `bun install --frozen-lockfile` for the
default `mise run test` command so a fresh `frontend/node_modules` volume is
usable.
