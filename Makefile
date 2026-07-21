NPM_INSTALL_STAMP := node_modules/.package-lock.json

.DEFAULT_GOAL := all

.PHONY: all help deps build lint test check link unlink

all: build

help:
	@printf '%s\n' 'Yui local targets:'
	@printf '%s\n' '  make               Build for local development (default)'
	@printf '%s\n' '  make all           Build for local development'
	@printf '%s\n' '  make deps          Install npm dependencies when needed'
	@printf '%s\n' '  make build         Build dist/cli.js'
	@printf '%s\n' '  make lint          Run TypeScript no-emit check'
	@printf '%s\n' '  make test          Run full test suite'
	@printf '%s\n' '  make check         Run full build, lint, and test verification'
	@printf '%s\n' '  make link          Link yui and install the managed yui-dev launcher'
	@printf '%s\n' '  make unlink        Remove the global yui link and local yui-dev launcher'

deps: $(NPM_INSTALL_STAMP)

$(NPM_INSTALL_STAMP): package.json package-lock.json
	npm ci

build: deps
	npm run build

lint: deps
	npm run lint

test: deps
	npm test

check: build lint test

link: build
	npm link
	node scripts/manage-dev-launcher.mjs install

unlink:
	npm unlink -g @zq-silk/yui
	node scripts/manage-dev-launcher.mjs uninstall
