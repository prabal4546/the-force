PYTHON ?= python3
MAC_ROOT := services/mac-runtime
VENV_PYTHON := .venv/bin/python

.PHONY: check mac-setup mac-sim api

check:
	$(PYTHON) scripts/check_repo.py
	PYTHONPATH=$(MAC_ROOT)/src $(PYTHON) -m unittest discover -s $(MAC_ROOT)/tests -v

mac-setup:
	$(PYTHON) -m venv .venv
	$(VENV_PYTHON) -m pip install --upgrade pip
	$(VENV_PYTHON) -m pip install '$(MAC_ROOT)[dev]'

mac-sim:
	PYTHONPATH=$(MAC_ROOT)/src $(VENV_PYTHON) -m bodyos_mac.main --simulate

api:
	PYTHONPATH=$(MAC_ROOT)/src $(PYTHON) -m bodyos_mac.api
