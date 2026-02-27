.PHONY: build build-frontend build-server dev clean check

build: build-frontend build-server

build-frontend:
	cd frontend && pnpm install && pnpm build

build-server: build-frontend
	cargo build --release

dev:
	@echo "Run in separate terminals:"
	@echo "  cd crates/server && cargo run"
	@echo "  cd frontend && pnpm dev"

check:
	cargo check
	cd frontend && pnpm check

clean:
	cargo clean
	rm -rf frontend/dist frontend/node_modules
