.PHONY: install test canary demo-fixture dev build clean-generated

install:
	npm run install:local

test:
	npm test

canary:
	npm run canary

demo-fixture:
	npm run demo-fixture

dev:
	npm run dev

build:
	npm run build

clean-generated:
	node --experimental-strip-types src/cli.ts clean-generated
