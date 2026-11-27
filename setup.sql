-- One-time setup in TeslaMate's database, as its superuser, e.g.:
--   docker exec -i teslamate-db psql -U teslamate -d teslamate < setup.sql
-- Replace the password first; put the same value in CAR_DASH_DB_PASSWORD.
--
-- car_dash can read TeslaMate's public schema (never `private`, where the Tesla
-- tokens live), write only what the app edits, and owns its own `car_dash` schema.

CREATE ROLE car_dash LOGIN PASSWORD 'change-me';

GRANT CONNECT ON DATABASE teslamate TO car_dash;
GRANT USAGE ON SCHEMA public TO car_dash;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO car_dash;
-- tables added by future TeslaMate upgrades stay readable
ALTER DEFAULT PRIVILEGES FOR ROLE teslamate IN SCHEMA public GRANT SELECT ON TABLES TO car_dash;

-- Charge costs you type in, and re-linking charges/drives to places
GRANT UPDATE (cost, geofence_id) ON charging_processes TO car_dash;
GRANT UPDATE (start_geofence_id, end_geofence_id) ON drives TO car_dash;
-- The Places screen (TeslaMate geofences)
GRANT INSERT, UPDATE, DELETE ON geofences TO car_dash;
GRANT USAGE ON SEQUENCE geofences_id_seq TO car_dash;

-- The app's own tables (created at startup)
CREATE SCHEMA car_dash AUTHORIZATION car_dash;
