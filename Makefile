# Mentra glasses tool (tools/mentra-glasses-tool): its tests and the viewer's run in `make check`.
# Plain Node, no npm install needed; the tests that need ffmpeg skip themselves without it.
check: glasses-check
.PHONY: glasses-check
glasses-check:
	cd tools/mentra-glasses-tool && npm test
	cd tools/mentra-glasses-tool/viewer && npm test

PYTHON ?= python3
MAC_ROOT := services/mac-runtime
VENV_PYTHON := .venv/bin/python

.PHONY: check mac-setup mac-sim mac-demo govee-demo band api

check:
	$(PYTHON) scripts/check_repo.py
	PYTHONPATH=$(MAC_ROOT)/src $(PYTHON) -m unittest discover -s $(MAC_ROOT)/tests -v
	cd apps/band && npm test

mac-setup:
	$(PYTHON) -m venv .venv
	$(VENV_PYTHON) -m pip install --upgrade pip
	$(VENV_PYTHON) -m pip install '$(MAC_ROOT)[dev,mac]'

mac-sim:
	PYTHONPATH=$(MAC_ROOT)/src $(VENV_PYTHON) -m bodyos_mac.main --simulate

mac-demo:
	PYTHONPATH=$(MAC_ROOT)/src $(VENV_PYTHON) -m bodyos_mac.main --simulate --real-windows

govee-demo:
	GOVEE_LAN=1 PYTHONPATH=$(MAC_ROOT)/src $(VENV_PYTHON) -m bodyos_mac.main --simulate

band:
	cd apps/band && $(PYTHON) serve.py

api:
	PYTHONPATH=$(MAC_ROOT)/src $(PYTHON) -m bodyos_mac.api
