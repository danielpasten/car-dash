#!/bin/bash
# Throwaway demo: copies your TeslaMate database *schema* (no data) into a new
# `teslamate_demo` database, fills it with ~6 months of made-up driving and charging
# (dev/demo-seed.py, ending "now"), and runs a demo app container on
# http://localhost:18000 with RP_ID=localhost so passkeys work too.
# Your real database and app container are never touched.
#
#   dev/demo-db.sh                          # create + seed + start
#   IMAGE=car-dash:next dev/demo-db.sh      # same, with an image built from this tree
#   dev/demo-db.sh --down                   # remove the demo database and container
#
# Settings (environment, all optional):
#   DB_CONTAINER   TeslaMate's Postgres container         (default: teslamate-db)
#   DB_SUPERUSER   its superuser                          (default: teslamate)
#   DB_SOURCE      the database whose schema is copied    (default: teslamate)
#   ENV_FILE       .env with CAR_DASH_PASSWORD, CAR_DASH_SECRET, CAR_DASH_DB_PASSWORD
#                  (default: ./.env; variables already set in the environment win)
#   NETWORK        Docker network to reach the database   (default: the DB container's first network)
#   IMAGE          app image to run                        (default: car-dash:local)
#   PORT           host port                               (default: 18000)
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB_CONTAINER="${DB_CONTAINER:-teslamate-db}"
DB_SUPERUSER="${DB_SUPERUSER:-teslamate}"
DB_SOURCE="${DB_SOURCE:-teslamate}"
ENV_FILE="${ENV_FILE:-.env}"
PORT="${PORT:-18000}"
setting() {   # value from the environment, else from ENV_FILE
  local v="${!1:-}"
  if [ -z "$v" ] && [ -f "$ENV_FILE" ]; then v="$(grep "^$1=" "$ENV_FILE" | cut -d= -f2- || true)"; fi
  [ -n "$v" ] || { echo "Set $1 (environment or $ENV_FILE)" >&2; exit 1; }
  printf '%s' "$v"
}
PSQL="docker exec -i $DB_CONTAINER psql -q -v ON_ERROR_STOP=1 -U $DB_SUPERUSER -d teslamate_demo"

docker rm -f car-dash-demo >/dev/null 2>&1 || true
docker exec "$DB_CONTAINER" dropdb -U "$DB_SUPERUSER" --if-exists teslamate_demo
[ "${1:-}" = "--down" ] && { echo "demo removed"; exit 0; }

PASSWORD="$(setting CAR_DASH_PASSWORD)"; SECRET="$(setting CAR_DASH_SECRET)"; DB_PASSWORD="$(setting CAR_DASH_DB_PASSWORD)"
NETWORK="${NETWORK:-$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$DB_CONTAINER" | awk '{print $1}')}"

docker exec "$DB_CONTAINER" createdb -U "$DB_SUPERUSER" teslamate_demo
docker exec "$DB_CONTAINER" sh -c "pg_dump -U $DB_SUPERUSER -s -n public $DB_SOURCE | psql -q -U $DB_SUPERUSER -d teslamate_demo" >/dev/null 2>&1
$PSQL <<'EOF'
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;
GRANT CONNECT ON DATABASE teslamate_demo TO car_dash;
GRANT USAGE ON SCHEMA public TO car_dash;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO car_dash;
GRANT UPDATE (cost, geofence_id) ON charging_processes TO car_dash;
GRANT INSERT, UPDATE, DELETE ON geofences TO car_dash;
GRANT USAGE ON SEQUENCE geofences_id_seq TO car_dash;
GRANT UPDATE (start_geofence_id, end_geofence_id) ON drives TO car_dash;
CREATE SCHEMA car_dash AUTHORIZATION car_dash;
-- the app creates its own tables in car_dash at startup (see SCHEMA in app/main.py)
EOF
python3 "$APP_DIR/dev/demo-seed.py" \
  | sed '1s/^begin;$/begin;\nset session_replication_role = replica;/' \
  | sed "s/'drives_id_seq'/'trips_id_seq'/" | $PSQL >/dev/null
$PSQL -c "set session_replication_role=replica;
  delete from positions where date > now() at time zone 'utc';
  delete from drives where start_date > now() at time zone 'utc';
  update charging_processes set cost = null
   where id = (select id from charging_processes where geofence_id is null order by start_date desc limit 1);"

# start on the default network (an internal DB network can't publish ports), then join the DB's
docker run -d --name car-dash-demo -p "127.0.0.1:$PORT:8000" \
  -v "$APP_DIR/static:/srv/static:ro" -v "$APP_DIR/app:/srv/app:ro" \
  -e TZ=America/New_York -e DB_HOST="$DB_CONTAINER" -e DB_NAME=teslamate_demo \
  -e RP_ID=localhost -e ORIGIN="http://localhost:$PORT" \
  -e CAR_DASH_PASSWORD="$PASSWORD" -e CAR_DASH_SECRET="$SECRET" -e CAR_DASH_DB_PASSWORD="$DB_PASSWORD" \
  "${IMAGE:-car-dash:local}" >/dev/null
docker network connect "$NETWORK" car-dash-demo
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 1; done
echo "demo up: http://localhost:$PORT ($(docker exec "$DB_CONTAINER" psql -U "$DB_SUPERUSER" -d teslamate_demo -Atc 'select count(*) from drives') drives)"
