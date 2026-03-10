.PHONY: build test check clean circuits anchor sdk relayer indexer fmt lint app app-dev

# ---------- Defaults ----------
CARGO      ?= cargo
ANCHOR     ?= anchor
NODE       ?= node
NPM        ?= npm

# ---------- All ----------
all: build

build: check anchor sdk

# ---------- Rust ----------
check:
	$(CARGO) check --workspace

test:
	$(CARGO) test --workspace

fmt:
	$(CARGO) fmt --all

lint:
	$(CARGO) clippy --workspace -- -D warnings

# ---------- Anchor programs ----------
anchor:
	$(ANCHOR) build

anchor-test:
	$(ANCHOR) test

# ---------- Circuits ----------
circuits:
	chmod +x scripts/setup-circuits.sh
	./scripts/setup-circuits.sh

# ---------- TypeScript SDK ----------
sdk:
	cd sdk/typescript && $(NPM) install && $(NPM) run build

# ---------- Relayer ----------
relayer:
	cd relayer && $(NPM) install && $(NPM) run build

relayer-dev:
	cd relayer && $(NPM) run dev

# ---------- Indexer ----------
indexer:
	cd indexer && $(NPM) install && $(NPM) run build

indexer-dev:
	cd indexer && $(NPM) run dev

# ---------- Frontend App ----------
app:
	cd app && $(NPM) install && $(NPM) run build

app-dev:
	cd app && $(NPM) run dev

# ---------- Docker ----------
docker-up:
	docker compose -f deploy/docker-compose.yml up -d

docker-down:
	docker compose -f deploy/docker-compose.yml down

# ---------- Full setup ----------
setup:
	chmod +x scripts/dev-setup.sh
	./scripts/dev-setup.sh

# ---------- Clean ----------
clean:
	$(CARGO) clean
	rm -rf sdk/typescript/dist
	rm -rf relayer/dist
	rm -rf indexer/dist
	rm -rf circuits/build
	rm -rf app/.next app/node_modules
