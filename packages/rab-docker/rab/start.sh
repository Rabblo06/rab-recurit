#!/bin/sh
set -e

# Migrations run against the direct (unpooled) connection — see
# render.yaml's comment. DATABASE_URL_UNPOOLED falls back to DATABASE_URL
# itself so this script also works unchanged in docker-compose, where
# there's no pooler and no separate unpooled URL.
DATABASE_URL="${DATABASE_URL_UNPOOLED:-$DATABASE_URL}" node packages/rab-server/dist/database/typeorm/scripts/setup-db.js

exec node packages/rab-server/dist/main.js
