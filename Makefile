PYTHON ?= python3
MAC_ROOT := services/mac-runtime

.PHONY: check mac-setup mac-sim

check:
	$(PYTHON) scripts/check_repo.py
	PYTHONPATH=$(MAC_ROOT)/src $(PYTHON) -m unittest discover -s $(MAC_ROOT)/tests -v

mac-setup:
	$(PYTHON) -m venv .venv
	.venv/bin/python -m pip install -e '$(MAC_ROOT)[dev]'

mac-sim:
	PYTHONPATH=$(MAC_ROOT)/src $(PYTHON) -m bodyos_mac.main --simulate
