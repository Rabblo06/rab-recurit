#!/bin/sh
set -e

# Deliberately does NOT run migrations or the admin-bootstrap command —
# `rab-server`'s own start.sh already does both, once, against the same
# database, before this service's queue processing matters. Running either
# from two services racing each other at deploy time is exactly the
# concurrent-migration hazard start.sh's own comment exists to avoid.
exec node packages/rab-server/dist/queue-worker/main.js
