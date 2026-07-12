TASKMUX_HOME ?= $(CURDIR)/output/taskmux-local-test
TASKMUX ?= node dist/cli.js
WORKSPACE ?= $(CURDIR)

.DEFAULT_GOAL := all

.PHONY: all help build lint test check link unlink local-clean local-setup local-smoke local-board local-roles local-detail

all: check

help:
	@printf '%s\n' 'TaskMux local targets:'
	@printf '%s\n' '  make               Run all: check'
	@printf '%s\n' '  make all           Run check'
	@printf '%s\n' '  make build         Build dist/cli.js'
	@printf '%s\n' '  make lint          Run TypeScript no-emit check'
	@printf '%s\n' '  make test          Run full test suite'
	@printf '%s\n' '  make check         Run build, lint, and tests'
	@printf '%s\n' '  make link          Link taskmux and install isolated taskmux-dev locally'
	@printf '%s\n' '  make unlink        Remove the global taskmux link and local taskmux-dev launcher'
	@printf '%s\n' '  make local-smoke   Reset output sandbox and exercise agent/role/task flow'
	@printf '%s\n' '  make local-board   Show the sandbox Task board'
	@printf '%s\n' '  make local-roles   Show task-1 roles in sandbox'
	@printf '%s\n' '  make local-detail  Show task-1 reviewer detail in sandbox'
	@printf '%s\n' ''
	@printf '%s\n' 'Variables:'
	@printf '%s\n' '  TASKMUX_HOME=$(CURDIR)/output/taskmux-local-test'
	@printf '%s\n' '  WORKSPACE=$(CURDIR)'

build:
	npm run build

lint:
	npm run lint

test:
	npm test

check: build lint test

link: build
	npm link
	node scripts/manage-dev-launcher.mjs install

unlink:
	npm unlink -g @zq-silk/taskmux
	node scripts/manage-dev-launcher.mjs uninstall

local-clean:
	rm -rf "$(TASKMUX_HOME)"

local-setup: build local-clean
	TASKMUX_HOME="$(TASKMUX_HOME)" node --input-type=module -e 'import { ensureStorageSchema } from "./dist/storage/storageSchema.js"; ensureStorageSchema(process.env.TASKMUX_HOME);'
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) agent add codex --command codex
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) agent add claude --command claude
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) config set default-agent codex
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) config set default-workspace "$(WORKSPACE)"
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) role add reviewer --agent claude --workspace "$(WORKSPACE)"

local-smoke: local-setup
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) task board
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) task create "Local test task"
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) task bind task-1 reviewer
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) task roles task-1
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) role update reviewer --agent codex --workspace /tmp/global-reviewer
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) task role update task-1 reviewer --workspace /tmp/task-reviewer
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) role show reviewer
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) role show operator
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) task detail task-1 reviewer

local-board:
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) task board

local-roles:
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) task roles task-1

local-detail:
	TASKMUX_HOME="$(TASKMUX_HOME)" $(TASKMUX) task detail task-1 reviewer
