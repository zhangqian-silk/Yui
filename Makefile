NPM_INSTALL_STAMP := node_modules/.package-lock.json

.DEFAULT_GOAL := all

.PHONY: all help deps build lint test test-tier check install-local link unlink dev-reset

all: build

help:
	@printf '%s\n' 'Yui local targets:'
	@printf '%s\n' '  make               Build for local development (default)'
	@printf '%s\n' '  make all           Build for local development'
	@printf '%s\n' '  make deps          Install npm dependencies when needed'
	@printf '%s\n' '  make build         Build dist/cli.js'
	@printf '%s\n' '  make lint          Run TypeScript no-emit check'
	@printf '%s\n' '  make test          Run full deterministic test suite (no real model)'
	@printf '%s\n' '  make test-tier T=<tier>  Run one explicit test tier (see: node scripts/run-test-tier.mjs list)'
	@printf '%s\n' '  make check         Run full build, lint, and test verification'
	@printf '%s\n' '  make install-local Build and create only this checkout'\''s isolated yui launcher (no global change)'
	@printf '%s\n' '  make link          Reversibly point the user-level yui command at this checkout'
	@printf '%s\n' '  make unlink        Restore the previous user-level yui command'
	@printf '%s\n' '  make dev-reset     Move the isolated development home aside for a clean start'

deps: $(NPM_INSTALL_STAMP)

$(NPM_INSTALL_STAMP): package.json package-lock.json
	npm ci

build: deps
	npm run build

lint: deps
	npm run lint

test: deps
	npm test

# Run a single explicit tier: `make test-tier T=unit` (or isolated-integration,
# mock-agent-session, provider-e2e, release-e2e). Provider/Release tiers refuse
# to run without their opt-in env var and a passing isolation preflight.
test-tier: deps
	node scripts/run-test-tier.mjs $(T)

check: build lint test

install-local: build
	node scripts/manage-dev-launcher.mjs install-local

link: build
	node scripts/manage-dev-launcher.mjs link

unlink:
	node scripts/manage-dev-launcher.mjs unlink

dev-reset:
	node scripts/manage-dev-launcher.mjs reset-home
