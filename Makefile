PY := .venv/bin/python
PYTHON311 ?= python3.11

.PHONY: setup dev test test-agent test-server test-web

# Create the Python env (shared by agent and server) and install web deps.
setup:
	test -x $(PY) || $(PYTHON311) -m venv .venv
	$(PY) -m pip install --upgrade pip
	$(PY) -m pip install -r server/requirements.txt
	@if [ -f agent/pyproject.toml ]; then \
		$(PY) -m pip install -e agent; \
	else \
		echo "Skipping agent install: agent/pyproject.toml not found yet."; \
	fi
	npm --prefix web install

# Run server (:8000) and web (:5173) together. Ctrl-C stops both.
dev:
	@trap 'kill 0' INT TERM EXIT; \
	$(PY) -m uvicorn app.main:app --reload --app-dir server --port 8000 & \
	npm --prefix web run dev & \
	wait

# Runs all three suites even if one fails, then exits non-zero if any did.
test:
	@$(MAKE) --no-print-directory -k test-agent test-server test-web

test-agent:
	@if [ ! -d agent/tests ]; then \
		echo "agent/ is empty: copy the ember-agent folder into agent/"; \
		exit 1; \
	fi
	$(PY) -m unittest discover -s agent/tests

test-server:
	cd server && ../$(PY) -m pytest

test-web:
	npm --prefix web test
