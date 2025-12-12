# Changelog

All notable changes to Node Guardian will be documented in this file.

# [2.0.0](https://github.com/abbasspark/async-guardian/compare/v1.2.0...v2.0.0) (2025-12-12)


* refactor!: rename package from node-guardian to async-guardian ([dddf178](https://github.com/abbasspark/async-guardian/commit/dddf178fdeba114da0cb4f146fefb880f5e0e134))


### BREAKING CHANGES

* Package renamed from node-guardian to async-guardian.
Users must update their imports from 'node-guardian' to 'async-guardian'.

Files removed:
- test-self-tracking.js
- test-app.js
- optimized-dashboard.js
- replace-script.py
- apply-perf-fixes.sh
- .gitmessage

Files updated:
- README.md (all package references)
- All source files with imports and path checks
- Example files

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

# [1.2.0](https://github.com/abbasspark/async-guardian/compare/v1.1.0...v1.2.0) (2025-12-12)


### Features

* rename package to async-guardian ([d8a24e1](https://github.com/abbasspark/async-guardian/commit/d8a24e1a858d7002c754c69e58e93a0b29151a3e))

# [1.1.0](https://github.com/abbasspark/node_guardian/compare/v1.0.0...v1.1.0) (2025-12-12)


### Features

* rename package to async-guardian ([0408a0b](https://github.com/abbasspark/node_guardian/commit/0408a0b44ed3a2419c218222acc64a2ba3639365))

# 1.0.0 (2025-12-12)


### Bug Fixes

* add semantic-release plugins and correct repository URL ([370ace0](https://github.com/abbasspark/node_guardian/commit/370ace072eca17b6d9a915e5926a926e19fe329d))
* **semantic-release:** add semantic-release plugins to devDependencies ([0cf7ed1](https://github.com/abbasspark/node_guardian/commit/0cf7ed15f9fc470ead90b6cc7e548beb58d1537e))
* **core:** fix test errors ([7ce5557](https://github.com/abbasspark/node_guardian/commit/7ce55579bbe24c19bbcf7c08d9e89b870d15f242))


### Features

* add Prometheus metrics export ([f6c3900](https://github.com/abbasspark/node_guardian/commit/f6c3900e3591acfc46ff493d8e17b60f6fa34197))
