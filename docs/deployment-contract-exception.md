# Temporary Direct Deployment Exception

## Scope

The tracked Ansible harness can deploy the Onclave app definition directly to
a values-provided host. This bypasses the platform ownership boundary in which
homelab-infra owns host placement and the app platform owns workload rollout.

The path exists only to validate that the reusable app definition can be
consumed without duplicating application logic. It has not performed the first
production Onclave deployment.

## Constraints

- Inventory and provider settings come only from the ignored values repository.
- The app definition owns Compose behavior; the playbook only renders values,
  copies the app definition, and performs lifecycle checks.
- DNS is consumer-owned and absent from the app definition.
- Live use requires a reviewed plan and explicit approval.

## Removal condition

Retire the direct playbook, inventory, and catalog deployment mode when the
Phase A3 homelab-infra deployment gate passes. The app definitions remain as
the reusable source boundary.

The matching homelab-infra contract update is deferred to Phase A3; Phases
A0-A2 do not modify that repository.
