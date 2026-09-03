.PHONY: install typecheck test canary demo-fixture grafana-setup agent-live dev build clean-generated

install:
	npm run install:local

typecheck:
	npm run typecheck

test:
	npm test

canary:
	npm run canary

demo-fixture:
	npm run demo-fixture

grafana-setup:
	npm run grafana:setup

agent-live:
	npm run agent:live

dev:
	npm run dev

build:
	npm run build

clean-generated:
	node --experimental-strip-types src/cli.ts clean-generated
