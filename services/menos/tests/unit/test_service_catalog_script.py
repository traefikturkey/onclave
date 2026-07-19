"""Tests for the catalog-driven deployment command surface."""

import importlib.util
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[4] / "scripts" / "service-catalog.py"
SPEC = importlib.util.spec_from_file_location("service_catalog", SCRIPT_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_catalog_is_ordered_and_contains_both_apps() -> None:
    services = MODULE.load_catalog()

    assert [service["id"] for service in services] == ["onclave", "menos"]
    assert [service["order"] for service in services] == [10, 20]


def test_validate_apps_routes_through_compose(monkeypatch) -> None:
    commands = []

    def fake_run(command, **kwargs):
        commands.append(command)

    monkeypatch.setattr(MODULE.subprocess, "run", fake_run)
    MODULE.validate_apps(MODULE.load_catalog())

    assert len(commands) == 2
    assert all(command[:2] == ["docker", "compose"] for command in commands)
    assert all(command[-2:] == ["config", "--quiet"] for command in commands)


def test_external_service_cannot_use_temporary_deploy_path() -> None:
    menos = MODULE.select_services(MODULE.load_catalog(), "menos")[0]

    with pytest.raises(ValueError, match="deployment is external"):
        MODULE.deploy(menos)
