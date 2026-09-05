#!/usr/bin/env bash
set -euo pipefail

# Resource ownership and lifecycle durations live in scripts/lib/production-resources.ts.
exec vp exec tsx scripts/provision-production-resources.ts
