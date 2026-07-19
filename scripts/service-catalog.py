#!/usr/bin/env python3
"""Validate app definitions and route catalog deployment commands."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CATALOG_PATH = REPO_ROOT / "infra" / "services.json"
SERVICE_ID = re.compile(r"[a-z][a-z0-9-]*")


def load_catalog(path: Path = CATALOG_PATH) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("version") != 1 or not isinstance(payload.get("services"), list):
        raise ValueError("catalog must contain version 1 and a services array")
    services = payload["services"]
    validate_catalog(services)
    return sorted(services, key=lambda service: service["order"])


def validate_catalog(services: list[dict]) -> None:
    ids: set[str] = set()
    orders: set[int] = set()
    by_id: dict[str, dict] = {}

    for service in services:
        service_id = service.get("id")
        order = service.get("order")
        if not isinstance(service_id, str) or not SERVICE_ID.fullmatch(service_id):
            raise ValueError(f"invalid service id: {service_id!r}")
        if service_id in ids:
            raise ValueError(f"duplicate service id: {service_id}")
        if not isinstance(order, int) or order in orders:
            raise ValueError(f"invalid or duplicate order for {service_id}")
        ids.add(service_id)
        orders.add(order)
        by_id[service_id] = service

        for key in ("appDefinition", "sampleEnv"):
            relative_path = service.get(key)
            if not isinstance(relative_path, str) or not (REPO_ROOT / relative_path).is_file():
                raise ValueError(f"{service_id}: missing {key}")

        state_order = service.get("stateOrder")
        if (
            not isinstance(state_order, list)
            or not state_order
            or len(state_order) != len(set(state_order))
        ):
            raise ValueError(f"{service_id}: stateOrder must be a non-empty unique list")

        deployment = service.get("deployment")
        if not isinstance(deployment, dict) or deployment.get("mode") not in {
            "temporary-direct",
            "external",
        }:
            raise ValueError(f"{service_id}: unsupported deployment mode")
        if deployment["mode"] == "temporary-direct" and not deployment.get("playbook"):
            raise ValueError(f"{service_id}: temporary-direct mode requires a playbook")

    for service in services:
        for dependency in service.get("dependencies", []):
            if dependency not in by_id:
                raise ValueError(f"{service['id']}: unknown dependency {dependency}")
            if by_id[dependency]["order"] >= service["order"]:
                raise ValueError(
                    f"{service['id']}: dependency {dependency} must have a lower order"
                )


def select_services(services: list[dict], service_id: str | None) -> list[dict]:
    if not service_id:
        return services
    selected = [service for service in services if service["id"] == service_id]
    if not selected:
        raise ValueError(f"unknown service: {service_id}")
    return selected


def validate_apps(services: list[dict]) -> None:
    for service in services:
        command = [
            "docker",
            "compose",
            "--env-file",
            str(REPO_ROOT / service["sampleEnv"]),
            "-f",
            str(REPO_ROOT / service["appDefinition"]),
            "config",
            "--quiet",
        ]
        subprocess.run(command, cwd=REPO_ROOT, check=True)
        print(f"validated {service['id']}")


def deploy(service: dict) -> None:
    deployment = service["deployment"]
    if deployment["mode"] != "temporary-direct":
        raise ValueError(
            f"{service['id']} deployment is external; follow docs/infra-alignment-plan.md"
        )
    command = [
        "docker",
        "compose",
        "-f",
        "infra/ansible/docker-compose.yml",
        "run",
        "--rm",
        "ansible",
        "ansible-playbook",
        deployment["playbook"],
    ]
    subprocess.run(command, cwd=REPO_ROOT, check=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("list")
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("service", nargs="?")
    deploy_parser = subparsers.add_parser("deploy")
    deploy_parser.add_argument("service")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    services = load_catalog()
    if args.command == "list":
        for service in services:
            print(f"{service['order']:03d} {service['id']} {service['deployment']['mode']}")
        return 0
    if args.command == "validate":
        validate_apps(select_services(services, args.service))
        return 0
    service = select_services(services, args.service)[0]
    deploy(service)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, subprocess.CalledProcessError) as exc:
        print(f"ERROR {exc}")
        raise SystemExit(1) from None
