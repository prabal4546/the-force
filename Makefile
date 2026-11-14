PYTHON ?= python3
MAC_ROOT := services/mac-runtime
VENV_PYTHON := .venv/bin/python

.PHONY: check mac-setup mac-move-setup mac-sim move-left move-right api api-sim

check:
	$(PYTHON) scripts/check_repo.py
	PYTHONPATH=$(MAC_ROOT)/src $(PYTHON) -m unittest discover -s $(MAC_ROOT)/tests -v

mac-setup:
	$(PYTHON) -m venv .venv
	$(VENV_PYTHON) -m pip install --upgrade pip
	$(VENV_PYTHON) -m pip install '$(MAC_ROOT)[dev]'

# Installs the pyobjc 'mac' extra needed for real window moving (Demo 1 step 1).
mac-move-setup:
	$(PYTHON) -m venv .venv
	$(VENV_PYTHON) -m pip install --upgrade pip
	$(VENV_PYTHON) -m pip install '$(MAC_ROOT)[dev,mac]'

mac-sim:
	PYTHONPATH=$(MAC_ROOT)/src $(VENV_PYTHON) -m bodyos_mac.main --simulate

# Standalone real window move (needs mac-move-setup + Accessibility permission).
move-left:
	PYTHONPATH=$(MAC_ROOT)/src $(VENV_PYTHON) -m bodyos_mac.move_window --direction left

move-right:
	PYTHONPATH=$(MAC_ROOT)/src $(VENV_PYTHON) -m bodyos_mac.move_window --direction right

# Device API on :8000. A band `step` here moves the real focused window
# (needs mac-move-setup + Accessibility permission).
api:
	PYTHONPATH=$(MAC_ROOT)/src $(VENV_PYTHON) -m bodyos_mac.api

# Same API, but swipes drive an in-memory two-display model (no permission).
api-sim:
	PYTHONPATH=$(MAC_ROOT)/src $(VENV_PYTHON) -m bodyos_mac.api --simulate
