"""Car dashboard API — reads TeslaMate's Postgres, serves the PWA.

TeslaMate stores timestamps as naive UTC and distances in km; everything is
converted to local time and the user's unit (TeslaMate settings) here, so the
frontend only formats.
"""
import asyncio
import base64
import hashlib
import hmac
import html
import json
import logging
import math
import os
import secrets
import time
import urllib.parse
from collections import defaultdict, deque
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from cryptography.fernet import Fernet, InvalidToken
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pydantic import BaseModel
from webauthn import (generate_authentication_options, generate_registration_options, options_to_json,
                      verify_authentication_response, verify_registration_response)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor,
                                      ResidentKeyRequirement, UserVerificationRequirement)

TZ = ZoneInfo(os.environ.get("TZ", "UTC"))
PASSWORD = os.environ["CAR_DASH_PASSWORD"]
SECRET = os.environ["CAR_DASH_SECRET"].encode()
TESLAMATE_URL = os.environ.get("TESLAMATE_URL", "")     # optional: links to your TeslaMate web UI
COOKIE = "car_session"
RP_ID = os.environ.get("RP_ID", "")       # the app's hostname, e.g. car.example.com (passkeys are bound to it)
if not RP_ID:
    raise RuntimeError("Set RP_ID to the hostname the app is served on, e.g. RP_ID=car.example.com")
ORIGIN = os.environ.get("ORIGIN", f"https://{RP_ID}")
SESSION_DAYS = 400
STALE_HOURS = 36          # no new TeslaMate data for this long -> warn on the Car screen
KM_PER_MI = 1.609344
STATIC = os.path.join(os.path.dirname(__file__), "..", "static")
# Map tiles: OpenStreetMap's public servers are fine for one person's light use
# (https://operations.osmfoundation.org/policies/tiles/); point this at another
# provider or your own tile server otherwise. {z}/{x}/{y} are filled in by the app.
MAP_TILES = os.environ.get("MAP_TILES", "https://tile.openstreetmap.org/{z}/{x}/{y}.png")
MAP_CREDIT = os.environ.get("MAP_CREDIT", "© OpenStreetMap")
_tiles_origin = "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(MAP_TILES))

pool = ConnectionPool(
    conninfo=(f"host={os.environ.get('DB_HOST', 'teslamate-db')} dbname={os.environ.get('DB_NAME', 'teslamate')} "
              f"user=car_dash password={os.environ['CAR_DASH_DB_PASSWORD']}"),
    min_size=1, max_size=4, kwargs={"row_factory": dict_row}, open=False)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
log = logging.getLogger("uvicorn.error")

# The app's own tables live in the car_dash schema (owned by the car_dash
# role); TeslaMate's tables are never altered. Created here so a fresh
# database (e.g. the dev demo) matches production.
SCHEMA = """
create table if not exists car_dash.manual_costs (
  charging_process_id integer primary key, entered_at timestamptz not null default now());
create table if not exists car_dash.passkeys (
  id bytea primary key, public_key bytea not null, sign_count bigint not null default 0,
  name text not null, created_at timestamptz not null default now(), last_used_at timestamptz);
create table if not exists car_dash.drive_energy (
  drive_id integer primary key, kwh double precision, coverage double precision,
  computed_at timestamptz not null default now());
create table if not exists car_dash.app_state (
  key text primary key, value jsonb not null, updated_at timestamptz not null default now());
create table if not exists car_dash.push_subscriptions (
  endpoint text primary key, p256dh text not null, auth text not null, name text,
  created_at timestamptz not null default now(), last_ok_at timestamptz);
create table if not exists car_dash.tesla_bills (
  session_id text primary key, vin text, start_at timestamptz not null, site text,
  total numeric(10, 2), currency text, charging_process_id integer, raw jsonb not null,
  fetched_at timestamptz not null default now());
create index if not exists tesla_bills_cp on car_dash.tesla_bills (charging_process_id);
"""


@app.on_event("startup")
def _open_pool():
    pool.open()
    with pool.connection() as conn:
        conn.execute(SCHEMA)
    _load_not_before()
    _adopt_existing_install()


@app.on_event("startup")
async def _start_background():
    app.state.bg = asyncio.create_task(_background())


def q(sql, *args):
    with pool.connection() as c:
        return c.execute(sql, args).fetchall()


def q1(sql, *args):
    rows = q(sql, *args)
    return rows[0] if rows else None


def state_get(key, default=None):
    r = q1("select value from car_dash.app_state where key = %s", key)
    return r["value"] if r else default


def state_set(key, value):
    with pool.connection() as conn:
        conn.execute("insert into car_dash.app_state (key, value) values (%s, %s) on conflict (key) "
                     "do update set value = excluded.value, updated_at = now()", (key, Jsonb(value)))


# Secrets the app keeps in its own tables (Tesla tokens, push signing key)
# are encrypted with a key derived from CAR_DASH_SECRET.
_fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(b"car-dash-storage:" + os.environ["CAR_DASH_SECRET"].encode()).digest()))


def seal(text: str) -> str:
    return _fernet.encrypt(text.encode()).decode()


def unseal(token: str) -> str | None:
    try:
        return _fernet.decrypt(token.encode()).decode()
    except (InvalidToken, AttributeError):
        return None


@app.get("/healthz")
def healthz():
    """Docker health check: the app is up and can reach the database."""
    try:
        q1("select 1 as ok")
    except Exception:
        return JSONResponse({"ok": False}, status_code=503)
    return {"ok": True}


# ── Auth ──────────────────────────────────────────────────────────────
# One password (from .env) -> long-lived signed cookie, so the installed
# app stays signed in. Failed logins are rate-limited per client IP.

def _sign(payload: str) -> str:
    return hmac.new(SECRET, payload.encode(), hashlib.sha256).hexdigest()


def make_token() -> str:
    issued = str(int(time.time()))
    return f"{issued}.{_sign(issued)}"


# "Sign out everywhere" moves this line forward: older cookies stop working.
_not_before = 0


def _load_not_before():
    global _not_before
    _not_before = int(state_get("sessions_not_before", 0) or 0)


def token_ok(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    issued, sig = token.split(".", 1)
    if not hmac.compare_digest(sig, _sign(issued)):
        return False
    return issued.isdigit() and int(issued) >= _not_before and time.time() - int(issued) < SESSION_DAYS * 86400


_failures: dict[str, deque] = defaultdict(deque)
# Password failures from everyone together. The per-IP limit relies on the
# X-Real-IP header the proxy sets; this cap holds even if that header could be
# forged. Passkey sign-in isn't subject to it, so the owner can't be locked out.
_all_failures: deque = deque()
GLOBAL_LIMIT = 20


def client_ip(req: Request) -> str:
    return req.headers.get("x-real-ip") or (req.client.host if req.client else "?")


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
    public = (path == "/api/login" or path.startswith("/api/passkeys/login"))
    if path.startswith("/api/") and not public and not token_ok(request.cookies.get(COOKIE)):
        return JSONResponse({"error": "signed_out"}, status_code=401)
    # Changes only from the app's own pages. SameSite=Lax cookies still go along with
    # requests from sibling subdomains (same "site"), so check what the browser reports.
    if (request.method not in ("GET", "HEAD", "OPTIONS") and path.startswith("/api/")
            and request.headers.get("sec-fetch-site", "same-origin") not in ("same-origin", "none")):
        return JSONResponse({"error": "cross_site"}, status_code=403)
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["Content-Security-Policy"] = (
        f"default-src 'self'; img-src 'self' data: {_tiles_origin}; style-src 'self'; script-src 'self'; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    if path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    elif path in ("/", "/index.html", "/manifest.webmanifest"):
        # the page names the versioned CSS/JS; it must never be reused unchecked,
        # or phones keep running an old app.js for days after a deploy
        resp.headers["Cache-Control"] = "no-cache"
    return resp


class Login(BaseModel):
    password: str


def _prune(fails: deque):
    while fails and time.time() - fails[0] > 600:
        fails.popleft()


def _throttle(request: Request):
    fails = _failures[client_ip(request)]
    _prune(fails)
    if len(fails) >= 5:
        raise HTTPException(429, "Too many attempts. Wait 10 minutes and try again.")
    return fails


def _start_session(response: Response):
    response.set_cookie(COOKIE, make_token(), max_age=SESSION_DAYS * 86400,
                        httponly=True, secure=True, samesite="lax", path="/")


@app.post("/api/login")
def login(body: Login, request: Request, response: Response):
    fails = _throttle(request)
    _prune(_all_failures)
    if len(_all_failures) >= GLOBAL_LIMIT:
        log.warning("password sign-in paused: %d failed attempts in 10 minutes", len(_all_failures))
        raise HTTPException(429, "Password sign-in is paused for a few minutes after many wrong tries. "
                                 "Use your passkey, or wait and try again.")
    if not hmac.compare_digest(body.password.encode(), PASSWORD.encode()):
        fails.append(time.time())
        _all_failures.append(time.time())
        raise HTTPException(401, "That password isn't right.")
    fails.clear()
    _start_session(response)
    return {"ok": True}


@app.post("/api/sessions/revoke")
def revoke_sessions(response: Response):
    """Sign out every device, then sign this one back in."""
    global _not_before
    now = int(time.time())
    state_set("sessions_not_before", now)
    _not_before = now
    _start_session(response)
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


# ── Passkeys (WebAuthn) ───────────────────────────────────────────────
# Discoverable credentials for a single owner. Challenges live in memory for
# 5 minutes, keyed by a short-lived cookie, and are single-use.

USER_HANDLE = b"car-dash-owner"
CHAL_COOKIE = "car_chal"
_challenges: dict[str, tuple[bytes, float, str]] = {}


def _new_challenge(response: Response, kind: str, challenge: bytes):
    now = time.time()
    for k in [k for k, v in _challenges.items() if v[1] < now]:
        del _challenges[k]
    while len(_challenges) >= 1000:          # unauthenticated callers can request these; keep memory bounded
        del _challenges[next(iter(_challenges))]
    cid = secrets.token_urlsafe(24)
    _challenges[cid] = (challenge, now + 300, kind)
    response.set_cookie(CHAL_COOKIE, cid, max_age=300, httponly=True, secure=True, samesite="strict",
                        path="/api/passkeys")


def _take_challenge(request: Request, response: Response, kind: str) -> bytes:
    got = _challenges.pop(request.cookies.get(CHAL_COOKIE, ""), None)
    response.delete_cookie(CHAL_COOKIE, path="/api/passkeys")
    if not got or got[1] < time.time() or got[2] != kind:
        raise HTTPException(400, "That took too long. Try again.")
    return got[0]


@app.post("/api/passkeys/register/options")
def passkey_register_options(response: Response):
    existing = q("select id from car_dash.passkeys")
    opts = generate_registration_options(
        rp_id=RP_ID, rp_name="Car", user_id=USER_HANDLE, user_name="owner", user_display_name="Car",
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED),
        exclude_credentials=[PublicKeyCredentialDescriptor(id=bytes(r["id"])) for r in existing])
    _new_challenge(response, "register", opts.challenge)
    return json.loads(options_to_json(opts))


class PasskeyIn(BaseModel):
    credential: dict
    name: str | None = None


@app.post("/api/passkeys/register")
def passkey_register(body: PasskeyIn, request: Request, response: Response):
    challenge = _take_challenge(request, response, "register")
    try:
        v = verify_registration_response(credential=body.credential, expected_challenge=challenge,
                                         expected_rp_id=RP_ID, expected_origin=ORIGIN,
                                         require_user_verification=True)
    except Exception as e:
        raise HTTPException(400, f"Couldn't add that passkey: {e}")
    name = (body.name or "Passkey").strip()[:60] or "Passkey"
    with pool.connection() as conn:
        conn.execute("insert into car_dash.passkeys (id, public_key, sign_count, name) values (%s, %s, %s, %s) "
                     "on conflict (id) do nothing", (v.credential_id, v.credential_public_key, v.sign_count, name))
    return passkey_list()


@app.get("/api/passkeys")
def passkey_list():
    rows = q("select id, name, created_at, last_used_at from car_dash.passkeys order by created_at")
    return {"passkeys": [{"id": bytes_to_base64url(bytes(r["id"])), "name": r["name"],
                          "created": r["created_at"].astimezone(TZ).isoformat(),
                          "last_used": r["last_used_at"] and r["last_used_at"].astimezone(TZ).isoformat()}
                         for r in rows]}


@app.delete("/api/passkeys/{pid}")
def passkey_delete(pid: str):
    with pool.connection() as conn:
        n = conn.execute("delete from car_dash.passkeys where id = %s", (base64url_to_bytes(pid),)).rowcount
    if not n:
        raise HTTPException(404, "That passkey is already gone.")
    return passkey_list()


@app.post("/api/passkeys/login/options")
def passkey_login_options(request: Request, response: Response):
    _throttle(request)
    opts = generate_authentication_options(rp_id=RP_ID, user_verification=UserVerificationRequirement.REQUIRED)
    _new_challenge(response, "login", opts.challenge)
    return json.loads(options_to_json(opts))


@app.post("/api/passkeys/login")
def passkey_login(body: PasskeyIn, request: Request, response: Response):
    fails = _throttle(request)
    challenge = _take_challenge(request, response, "login")
    try:
        cred_id = base64url_to_bytes(body.credential["rawId"])
    except Exception:
        raise HTTPException(400, "That passkey response was malformed.")
    row = q1("select public_key, sign_count from car_dash.passkeys where id = %s", cred_id)
    if not row:
        fails.append(time.time())
        raise HTTPException(401, "This passkey isn't registered here. Sign in with the password, then add it again.")
    try:
        v = verify_authentication_response(credential=body.credential, expected_challenge=challenge,
                                           expected_rp_id=RP_ID, expected_origin=ORIGIN,
                                           credential_public_key=bytes(row["public_key"]),
                                           credential_current_sign_count=row["sign_count"],
                                           require_user_verification=True)
    except Exception:
        fails.append(time.time())
        raise HTTPException(401, "That passkey didn't check out. Try again or use the password.")
    with pool.connection() as conn:
        conn.execute("update car_dash.passkeys set sign_count = %s, last_used_at = now() where id = %s",
                     (v.new_sign_count, cred_id))
    fails.clear()
    _start_session(response)
    return {"ok": True}


# ── Helpers ───────────────────────────────────────────────────────────

def units():
    s = q1("select unit_of_length::text as length, unit_of_temperature::text as temp from settings limit 1")
    return {"length": (s or {}).get("length") or "mi", "temp": (s or {}).get("temp") or "F"}


def dist(km, u):
    if km is None:
        return None
    km = float(km)
    return round(km / KM_PER_MI, 1) if u["length"] == "mi" else round(km, 1)


def temp(c, u):
    if c is None:
        return None
    c = float(c)
    return round(c * 9 / 5 + 32) if u["temp"] == "F" else round(c)


def local(dt: datetime | None):
    """TeslaMate timestamps are naive UTC."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).astimezone(TZ).isoformat()


def month_bounds(month: str):
    """'2026-09' -> (utc_start, utc_end) as naive UTC datetimes."""
    y, m = (int(x) for x in month.split("-"))
    start = datetime(y, m, 1, tzinfo=TZ)
    end = datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=TZ)
    to_utc = lambda d: d.astimezone(timezone.utc).replace(tzinfo=None)
    return to_utc(start), to_utc(end)


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def geofences():
    return q("select id, name, latitude::float as lat, longitude::float as lon, radius, "
             "cost_per_unit::float as rate, session_fee::float as fee, billing_type::text as billing "
             "from geofences order by id")


def geofence_at(lat, lon, fences):
    for g in fences:
        if haversine_m(lat, lon, g["lat"], g["lon"]) <= g["radius"]:
            return g
    return None


def address_label(a):
    if not a:
        return None
    if a.get("name"):
        return a["name"]
    road = " ".join(x for x in (a.get("house_number"), a.get("road")) if x)
    parts = [p for p in (road, a.get("city") or a.get("neighbourhood")) if p]
    return ", ".join(parts) or a.get("display_name")


TYPICAL_EFFICIENCY = {"3": 0.137, "Y": 0.150, "S": 0.176, "X": 0.203}


def pick_car(car_id):
    cars = q("select c.id, c.name, c.model, c.marketing_name, c.trim_badging, c.efficiency, "
             "s.free_supercharging from cars c left join car_settings s on s.id = c.settings_id "
             "order by c.display_priority nulls last, c.id")
    if not cars:
        return None, []
    car = next((c for c in cars if car_id and c["id"] == car_id), cars[0])
    # TeslaMate learns cars.efficiency (kWh per km of rated range) from a few
    # charges; until then use a typical figure for the model and say so.
    car["efficiency_estimated"] = not car["efficiency"]
    if not car["efficiency"]:
        car["efficiency"] = TYPICAL_EFFICIENCY.get((car["model"] or "").upper(), 0.155)
    return car, cars


# ── Charge classification & cost ──────────────────────────────────────
# A charge belongs to a "place": its TeslaMate geofence if it has one, else
# "Supercharger" when Tesla's fast charger was used, else "Untagged".
# Cost: a cost typed into the app ("manual") wins, then the stored cost
# (TeslaMate prices a charge when it ends), otherwise it's computed from the
# place's current price — so tagging a place later prices its history too.

CHARGE_SQL = """
select cp.id, cp.car_id, cp.start_date, cp.end_date, cp.duration_min,
       cp.charge_energy_added::float as added, cp.charge_energy_used::float as used,
       cp.start_battery_level as start_pct, cp.end_battery_level as end_pct,
       cp.cost::float as cost, cp.geofence_id, cp.outside_temp_avg::float as temp_c,
       a.name, a.display_name, a.house_number, a.road, a.city, a.neighbourhood,
       p.latitude::float as lat, p.longitude::float as lon,
       x.fast, x.brand, x.max_kw,
       (mc.charging_process_id is not null) as manual,
       tb.total::float as bill, tb.site as bill_site
from charging_processes cp
left join car_dash.manual_costs mc on mc.charging_process_id = cp.id
left join lateral (select total, site from car_dash.tesla_bills b where b.charging_process_id = cp.id
                   order by b.start_at limit 1) tb on true
left join addresses a on a.id = cp.address_id
left join positions p on p.id = cp.position_id
left join lateral (
  select bool_or(ch.fast_charger_present) as fast,
         max(ch.fast_charger_brand) as brand,
         max(ch.charger_power) as max_kw
  from charges ch where ch.charging_process_id = cp.id
) x on true
where cp.car_id = %s
"""


def classify(row, fences_by_id, free_sc):
    g = fences_by_id.get(row["geofence_id"])
    if g is None and row["lat"] is not None:
        # a place tagged after the charge: match it by location so the
        # new price applies to history too
        g = geofence_at(row["lat"], row["lon"], fences_by_id.values())
    supercharger = bool(row["fast"]) and (row["brand"] or "").lower().startswith("tesla")
    if g:
        place, kind = g["name"], "geofence"
    elif supercharger:
        place, kind = "Supercharger", "supercharger"
    else:
        place, kind = "Untagged", "untagged"

    energy = row["used"] if row["used"] and row["used"] > (row["added"] or 0) else row["added"]
    cost, source = None, "missing"
    if row["cost"] is not None and row.get("manual"):
        cost, source = row["cost"], "manual"
    elif row.get("bill") is not None:
        cost, source = row["bill"], "tesla"          # Tesla's own bill for this Supercharger session
    elif row["cost"] is not None:
        cost, source = row["cost"], "stored"
    elif supercharger and free_sc:
        cost, source = 0.0, "free"
    elif g and g["rate"] is not None:
        if g["billing"] == "per_minute":
            cost = g["rate"] * (row["duration_min"] or 0)
        else:
            cost = g["rate"] * (energy or 0)
        cost += g["fee"] or 0
        source = "rate"
    return {
        "id": row["id"],
        "start": local(row["start_date"]),
        "end": local(row["end_date"]),
        "ongoing": row["end_date"] is None,
        "minutes": row["duration_min"],
        "added_kwh": round(row["added"] or 0, 2),
        "used_kwh": round(row["used"], 2) if row["used"] else None,
        "start_pct": row["start_pct"],
        "end_pct": row["end_pct"],
        "place": place,
        "place_kind": kind,
        "geofence_id": g["id"] if g else None,
        "address": address_label(row),
        "lat": row["lat"],
        "lon": row["lon"],
        "fast": bool(row["fast"]),
        "max_kw": row["max_kw"],
        "cost": round(cost, 2) if cost is not None else None,
        "cost_source": source,
        "bill_site": row.get("bill_site") if source == "tesla" else None,
    }


def charges_between(car, start, end):
    fences = {g["id"]: g for g in geofences()}
    rows = q(CHARGE_SQL + " and cp.start_date >= %s and cp.start_date < %s order by cp.start_date desc",
             car["id"], start, end)
    return [classify(r, fences, car["free_supercharging"]) for r in rows]


def place_order():
    """Stable color slot per place: geofences by id, Supercharger fixed."""
    return [g["name"] for g in geofences()]


def summarize(charges):
    by_place = {}
    for c in charges:
        if c["ongoing"]:
            continue
        p = by_place.setdefault(c["place"], {"place": c["place"], "kind": c["place_kind"],
                                             "kwh": 0.0, "cost": 0.0, "count": 0, "missing": 0})
        p["kwh"] += c["added_kwh"]
        p["count"] += 1
        if c["cost"] is None:
            p["missing"] += 1
        else:
            p["cost"] += c["cost"]
    places = sorted(by_place.values(), key=lambda p: -p["kwh"])
    for p in places:
        p["kwh"], p["cost"] = round(p["kwh"], 1), round(p["cost"], 2)
    total_kwh = round(sum(p["kwh"] for p in places), 1)
    total_cost = round(sum(p["cost"] for p in places), 2)
    return {
        "places": places,
        "kwh": total_kwh,
        "cost": total_cost,
        "count": sum(p["count"] for p in places),
        "missing": sum(p["missing"] for p in places),
        "per_kwh": round(total_cost / total_kwh, 3) if total_kwh else None,
    }


def miles_between(car, start, end, u):
    r = q1("select coalesce(sum(distance), 0)::float as km from drives "
           "where car_id = %s and start_date >= %s and start_date < %s", car["id"], start, end)
    return dist(r["km"], u)


# ── Onboarding ────────────────────────────────────────────────────────
# A first-run guide (static/app.js, #/welcome) runs until it's finished once.

def onboarded() -> bool:
    return state_get("onboarded") is not None


def _adopt_existing_install():
    """Installs from before the guide existed skip it: anything the owner already set up counts."""
    if onboarded():
        return
    used = q1("select (select count(*) from car_dash.passkeys) + (select count(*) from car_dash.push_subscriptions)"
              " + (select count(*) from car_dash.manual_costs)"
              " + (select count(*) from car_dash.app_state where key in ('gas', 'tesla')) as n")
    if used and used["n"]:
        state_set("onboarded", {"at": time.time(), "adopted": True})


@app.get("/api/setup")
def setup_check():
    """What the guide's connection check shows: is TeslaMate's data there, and can we use it?"""
    u = units()
    c, cars = pick_car(None)
    perms = q1("select has_table_privilege('geofences', 'INSERT') and has_table_privilege('geofences', 'UPDATE')"
               "       and has_sequence_privilege('geofences_id_seq', 'USAGE') as places,"
               " has_column_privilege('charging_processes', 'cost', 'UPDATE') as costs,"
               " has_column_privilege('drives', 'start_geofence_id', 'UPDATE') as drives")
    counts = q1("select (select count(*) from drives) as drives, (select count(*) from charging_processes) as charges")
    last, odo = None, None
    if c:
        pos = q1("select date, odometer from positions where car_id = %s order by date desc limit 1", c["id"])
        last_cp = q1("select max(coalesce(end_date, start_date)) as t from charging_processes where car_id = %s", c["id"])
        seen = [t for t in ((pos or {}).get("date"), (last_cp or {}).get("t")) if t]
        last = max(seen) if seen else None
        odo = pos and dist(pos["odometer"], u)
    return {
        "car": c and {"name": c["name"] or (f"Model {c['model']}" if c["model"] else c["marketing_name"] or "Car"),
                      "odometer": odo},
        "cars": len(cars),
        "last_seen": local(last),
        "stale": bool(last) and (datetime.now(timezone.utc).replace(tzinfo=None) - last).total_seconds() > STALE_HOURS * 3600,
        "counts": counts,
        "permissions": perms,
        "units": u,
        "rp_id": RP_ID,
        "teslamate_url": TESLAMATE_URL,
        "onboarded": onboarded(),
    }


class OnboardingIn(BaseModel):
    done: bool


@app.post("/api/onboarding")
def onboarding_set(body: OnboardingIn):
    if body.done:
        state_set("onboarded", {"at": time.time()})
    else:
        with pool.connection() as conn:
            conn.execute("delete from car_dash.app_state where key = 'onboarded'")
    return {"onboarded": body.done}


# ── Endpoints ─────────────────────────────────────────────────────────

@app.get("/api/status")
def status(car: int | None = None):
    u = units()
    c, cars = pick_car(car)
    base = {"teslamate_url": TESLAMATE_URL, "units": u, "onboarded": onboarded()}
    if not c:
        return {**base, "car": None, "cars": []}

    pos = q1("select date, latitude::float as lat, longitude::float as lon, battery_level, "
             "usable_battery_level, rated_battery_range_km, est_battery_range_km, odometer, "
             "outside_temp, inside_temp, speed from positions where car_id = %s "
             "order by date desc limit 1", c["id"])
    state = q1("select state::text as state, start_date from states where car_id = %s "
               "order by start_date desc limit 1", c["id"])
    drive = q1("select id, start_date from drives where car_id = %s and end_date is null "
               "order by start_date desc limit 1", c["id"])
    charging = None
    open_cp = q1(CHARGE_SQL + " and cp.end_date is null order by cp.start_date desc limit 1", c["id"])
    if open_cp:
        fences = {g["id"]: g for g in geofences()}
        charging = classify(open_cp, fences, c["free_supercharging"])
        last = q1("select date, battery_level, charger_power, charge_energy_added::float as added, "
                  "rated_battery_range_km from charges where charging_process_id = %s "
                  "order by date desc limit 1", open_cp["id"])
        if last:
            charging.update(now_pct=last["battery_level"], now_kw=last["charger_power"],
                            added_kwh=round(last["added"] or 0, 2))
            # while plugged in TeslaMate logs battery to `charges`, not `positions`
            if pos and last["date"] > pos["date"]:
                pos = {**pos, "battery_level": last["battery_level"], "date": last["date"],
                       "usable_battery_level": last["battery_level"],
                       "rated_battery_range_km": last["rated_battery_range_km"]}

    place, place_id = None, None
    if pos:
        g = geofence_at(pos["lat"], pos["lon"], geofences())
        place_id = g and g["id"]
        if g:
            place = g["name"]
        else:
            a = q1("select a.* from drives d join addresses a on a.id = d.end_address_id "
                   "where d.car_id = %s and d.end_date is not null order by d.end_date desc limit 1", c["id"])
            place = address_label(a)

    if drive:
        activity = "driving"
    elif charging:
        activity = "charging"
    else:
        activity = (state or {}).get("state") or "unknown"   # online / asleep / offline

    recent = drives_page(c, u, None, 1) if not drive else []
    last_drive = recent[0] if recent else None
    if last_drive:
        rated = rated_wh(c, u)
        last_drive["ratio"] = round(last_drive["wh_per"] / rated, 3) if last_drive["wh_per"] and rated else None
    month = datetime.now(TZ).strftime("%Y-%m")
    ms, me = month_bounds(month)
    month_sum = summarize(charges_between(c, ms, me))

    # When did TeslaMate last record anything for this car? If Tesla signs
    # TeslaMate out, data just stops; say so instead of showing old figures quietly.
    last_cp = q1("select max(coalesce(end_date, start_date)) as t from charging_processes where car_id = %s", c["id"])
    seen = [t for t in ((pos or {}).get("date"), (state or {}).get("start_date"), (last_cp or {}).get("t")) if t]
    last_seen = max(seen) if seen else None
    stale_hours = (datetime.now(timezone.utc).replace(tzinfo=None) - last_seen).total_seconds() / 3600 if last_seen else None

    return {
        **base,
        "car": {
            "id": c["id"],
            # Tesla's marketing_name can be a bare trim code like "SR"
            "name": c["name"] or (f"Model {c['model']}" if c["model"] else c["marketing_name"] or "Car"),
            # only as a subtitle when the car has its own name
            "model": (c["marketing_name"] or (f"Model {c['model']}" if c["model"] else None)) if c["name"] else None,
        },
        "cars": [{"id": x["id"], "name": x["name"]} for x in cars],
        "activity": activity,
        "since": local((state or {}).get("start_date")),
        "place": place,
        "place_id": place_id,
        "position": pos and {"lat": pos["lat"], "lon": pos["lon"]},
        "battery": pos and pos["battery_level"],
        "usable_battery": pos and pos["usable_battery_level"],
        "range": pos and dist(pos["rated_battery_range_km"], u),
        "odometer": pos and dist(pos["odometer"], u),
        "outside_temp": pos and temp(pos["outside_temp"], u),
        "inside_temp": pos and temp(pos["inside_temp"], u),
        "updated": pos and local(pos["date"]),
        "last_seen": local(last_seen),
        "stale": stale_hours is not None and stale_hours > STALE_HOURS and not drive and not charging,
        "charging": charging,
        "last_drive": last_drive,
        "month": {"month": month, "cost": month_sum["cost"], "kwh": month_sum["kwh"],
                  "missing": month_sum["missing"]},
    }


@app.get("/api/charging")
def charging(month: str | None = None, car: int | None = None):
    u = units()
    c, _ = pick_car(car)
    month = month or datetime.now(TZ).strftime("%Y-%m")
    try:
        start, end = month_bounds(month)
    except ValueError:
        raise HTTPException(400, "month must look like 2026-09")
    if not c:
        return {"month": month, "car": None}

    charges = charges_between(c, start, end)
    summary = summarize(charges)
    miles = miles_between(c, start, end, u)

    # 12-month spend history ending at the selected month: one query, bucketed
    # by local month (a charge's "start" is already local time).
    y, m = (int(x) for x in month.split("-"))
    keys = []
    for i in range(11, -1, -1):
        mm = (y * 12 + m - 1) - i
        keys.append(f"{mm // 12}-{mm % 12 + 1:02d}")
    by_month = defaultdict(list)
    for ch in charges_between(c, month_bounds(keys[0])[0], start):
        by_month[ch["start"][:7]].append(ch)
    history = []
    for key in keys:
        s = summary if key == month else summarize(by_month.get(key, []))
        history.append({"month": key, "cost": s["cost"], "kwh": s["kwh"], "missing": s["missing"]})

    first = q1("select min(start_date) as d from charging_processes where car_id = %s", c["id"])
    return {
        "month": month,
        "first_month": first["d"] and first["d"].replace(tzinfo=timezone.utc).astimezone(TZ).strftime("%Y-%m"),
        "units": u,
        "summary": summary,
        "distance": miles,
        "per_distance": round(summary["cost"] / miles, 3) if miles else None,
        "gas": gas_compare(miles, summary, u),
        "place_order": place_order(),
        "history": history,
        "charges": charges,
        "teslamate_url": TESLAMATE_URL,
    }


# ── Gas comparison ────────────────────────────────────────────────────
# What the same distance would have cost in a gas car. The price and mileage
# are the owner's own figures (Account screen); nothing is assumed.

def gas_settings():
    g = state_get("gas") or {}
    return {"price": g.get("price"), "economy": g.get("economy")}


def gas_compare(distance, summary, u):
    g = gas_settings()
    if not g["price"] or not g["economy"] or not distance:
        return {"set": bool(g["price"] and g["economy"]), **g}
    if u["length"] == "mi":
        fuel = distance / g["economy"]                  # gallons at N mpg
    else:
        fuel = distance * g["economy"] / 100            # litres at N L/100 km
    cost = round(fuel * g["price"], 2)
    return {"set": True, **g, "fuel": round(fuel, 1), "cost": cost,
            "saved": round(cost - summary["cost"], 2), "partial": summary["missing"] > 0}


class GasIn(BaseModel):
    price: float | None = None
    economy: float | None = None


@app.get("/api/settings/gas")
def get_gas():
    return {**gas_settings(), "units": units()}


@app.put("/api/settings/gas")
def put_gas(b: GasIn):
    if b.price is not None and not 0 < b.price < 50:
        raise HTTPException(400, "Enter a fuel price like 3.29.")
    if b.economy is not None and not 1 <= b.economy <= 200:
        raise HTTPException(400, "Enter the gas car's mileage, like 28.")
    state_set("gas", {"price": b.price, "economy": b.economy})
    return get_gas()


@app.get("/api/charges/{charge_id}")
def charge_detail(charge_id: int):
    row = q1(CHARGE_SQL.replace("where cp.car_id = %s", "where cp.id = %s"), charge_id)
    if not row:
        raise HTTPException(404, "No charge with that id.")
    car = q1("select c.id, s.free_supercharging from charging_processes cp join cars c on c.id = cp.car_id "
             "left join car_settings s on s.id = c.settings_id where cp.id = %s", charge_id)
    fences = {g["id"]: g for g in geofences()}
    detail = classify(row, fences, car["free_supercharging"])
    curve = q("select date, battery_level, charger_power, charger_voltage, charger_actual_current, "
              "charge_energy_added::float as added from charges where charging_process_id = %s "
              "order by date", charge_id)
    detail["curve"] = [{"t": local(p["date"]), "kw": p["charger_power"], "pct": p["battery_level"],
                        "kwh": round(p["added"] or 0, 2)} for p in curve]
    g = fences.get(detail["geofence_id"])
    detail["rate"] = g and {"per": g["billing"], "rate": g["rate"], "fee": g["fee"]}
    if detail["used_kwh"] and detail["added_kwh"]:
        detail["loss_pct"] = round(100 * (1 - detail["added_kwh"] / detail["used_kwh"]), 1)
    detail["teslamate_url"] = TESLAMATE_URL
    detail["place_order"] = [g["name"] for g in fences.values()]
    return detail


class CostIn(BaseModel):
    cost: float | None


@app.patch("/api/charges/{charge_id}")
def set_cost(charge_id: int, body: CostIn):
    if body.cost is not None and not (0 <= body.cost < 10000):
        raise HTTPException(400, "Cost must be between $0 and $9,999.")
    with pool.connection() as conn:
        n = conn.execute("update charging_processes set cost = %s where id = %s",
                         (body.cost, charge_id)).rowcount
        if not n:
            raise HTTPException(404, "No charge with that id.")
        if body.cost is None:
            # back to the place's price
            conn.execute("delete from car_dash.manual_costs where charging_process_id = %s", (charge_id,))
        else:
            conn.execute("insert into car_dash.manual_costs (charging_process_id) values (%s) "
                         "on conflict (charging_process_id) do update set entered_at = now()", (charge_id,))
    return charge_detail(charge_id)


def drive_energy(ids):
    """Battery energy per finished drive, integrated from positions.power (kW at
    ~4 Hz), gaps capped at 30 s. Computed once per drive and kept in car_dash."""
    ids = list(ids)
    if not ids:
        return {}
    have = {r["drive_id"]: r for r in q("select drive_id, kwh, coverage from car_dash.drive_energy "
                                         "where drive_id = any(%s)", ids)}
    missing = [i for i in ids if i not in have]
    if missing:
        rows = q("""
          select x.drive_id, (sum(x.power * least(x.dt, 30)) / 3600)::float as kwh,
                 avg((x.power is not null)::int)::float as coverage
          from (select p.drive_id, p.power,
                       extract(epoch from lead(p.date) over (partition by p.drive_id order by p.date) - p.date) as dt
                from positions p join drives d on d.id = p.drive_id
                where p.drive_id = any(%s) and d.end_date is not null) x
          group by x.drive_id""", missing)
        with pool.connection() as conn:
            for r in rows:
                kwh = r["kwh"] if r["coverage"] and r["coverage"] >= 0.8 and r["kwh"] and r["kwh"] > 0 else None
                conn.execute("insert into car_dash.drive_energy (drive_id, kwh, coverage) values (%s, %s, %s) "
                             "on conflict (drive_id) do nothing", (r["drive_id"], kwh, r["coverage"]))
                have[r["drive_id"]] = {"drive_id": r["drive_id"], "kwh": kwh, "coverage": r["coverage"]}
    return {k: v["kwh"] for k, v in have.items()}


def drives_page(c, u, before: str | None, limit: int, ids=None, since=None):
    """Finished drives, newest first. `ids` limits to those drives, `since` (naive UTC) to recent ones."""
    args = [c["id"]]
    cond = ""
    if before:
        cond += " and d.start_date < %s"
        args.append(datetime.fromisoformat(before).astimezone(timezone.utc).replace(tzinfo=None))
    if ids is not None:
        cond += " and d.id = any(%s)"
        args.append(list(ids))
    if since is not None:
        cond += " and d.start_date >= %s"
        args.append(since)
    rows = q(f"""
      select d.id, d.start_date, d.end_date, d.distance, d.duration_min, d.speed_max,
             d.start_rated_range_km::float as r0, d.end_rated_range_km::float as r1,
             d.outside_temp_avg::float as temp_c,
             sa.name as s_name, sa.display_name as s_display_name, sa.house_number as s_house_number,
             sa.road as s_road, sa.city as s_city, sa.neighbourhood as s_neighbourhood,
             ea.name as e_name, ea.display_name as e_display_name, ea.house_number as e_house_number,
             ea.road as e_road, ea.city as e_city, ea.neighbourhood as e_neighbourhood,
             sg.name as s_fence, eg.name as e_fence
      from drives d
      left join addresses sa on sa.id = d.start_address_id
      left join addresses ea on ea.id = d.end_address_id
      left join geofences sg on sg.id = d.start_geofence_id
      left join geofences eg on eg.id = d.end_geofence_id
      where d.car_id = %s and d.end_date is not null {cond}
      order by d.start_date desc limit {int(limit)}""", *args)
    eff = c["efficiency"]
    measured = drive_energy(r["id"] for r in rows)
    out = []
    for r in rows:
        pick = lambda pre: {k[2:]: v for k, v in r.items() if k.startswith(pre)}
        kwh = measured.get(r["id"])
        if kwh is None:   # no power readings: fall back to the drop in rated range
            kwh = (r["r0"] - r["r1"]) * eff if eff and r["r0"] is not None and r["r1"] is not None else None
        d = dist(r["distance"], u)
        per = None
        if kwh and d and d >= 0.5:        # shorter hops give meaningless per-mile figures
            per = round(kwh * 1000 / d)   # Wh per mile (or km)
        out.append({
            "id": r["id"],
            "start": local(r["start_date"]),
            "end": local(r["end_date"]),
            "from": r["s_fence"] or address_label(pick("s_")),
            "to": r["e_fence"] or address_label(pick("e_")),
            "distance": d,
            "minutes": r["duration_min"],
            "kwh": round(kwh, 2) if kwh else None,
            "wh_per": per if per and per > 0 else None,
            "temp": temp(r["temp_c"], u),
        })
    return out


@app.get("/api/drives")
def drives(before: str | None = None, car: int | None = None):
    u = units()
    c, _ = pick_car(car)
    if not c:
        return {"drives": [], "units": u}
    page = drives_page(c, u, before, 40)
    rated = rated_wh(c, u)
    for d in page:
        d["ratio"] = round(d["wh_per"] / rated, 3) if d["wh_per"] and rated else None
    return {"drives": page, "units": u, "more": len(page) == 40, "rated_wh": rated,
            "rated_estimated": c["efficiency_estimated"]}


# ── Efficiency ────────────────────────────────────────────────────────
# "Rated" is the car's own consumption figure (TeslaMate's cars.efficiency,
# kWh per km of rated range). Efficiency classes compare against it:
#   -2 regen / <70%   -1 70-90%   0 90-110%   1 110-130%   2 >130%

def rated_wh(c, u):
    if not c or not c["efficiency"]:
        return None
    per_km = c["efficiency"] * 1000
    return round(per_km * KM_PER_MI) if u["length"] == "mi" else round(per_km)


def eff_class(ratio):
    if ratio is None:
        return None
    if ratio < 0.7:
        return -2
    if ratio < 0.9:
        return -1
    if ratio <= 1.1:
        return 0
    if ratio <= 1.3:
        return 1
    return 2


def avg_price(c):
    """What a kWh actually cost over the last 90 days of priced charges."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    ch = [x for x in charges_between(c, now - timedelta(days=90), now) if x["cost"] is not None and not x["ongoing"]]
    kwh = sum(x["added_kwh"] for x in ch)
    return (sum(x["cost"] for x in ch) / kwh) if kwh else None


def _thin(rows, target):
    """Keep ~target points: average speed/power per bucket, keep the bucket's last position."""
    if len(rows) <= target:
        return rows
    step = math.ceil(len(rows) / target)
    out = []
    for i in range(0, len(rows), step):
        b = rows[i:i + step]
        last = b[-1]
        sp = [r["speed"] for r in b if r["speed"] is not None]
        pw = [r["power"] for r in b if r["power"] is not None]
        out.append({**last, "speed": sum(sp) / len(sp) if sp else None,
                    "power": sum(pw) / len(pw) if pw else None})
    if out[0] is not rows[0]:
        out.insert(0, rows[0])
    return out


@app.get("/api/drives/{drive_id}")
def drive_detail(drive_id: int):
    u = units()
    d = q1("select d.*, d.start_rated_range_km::float as r0, d.end_rated_range_km::float as r1, "
           "d.outside_temp_avg::float as temp_c, d.inside_temp_avg::float as itemp_c from drives d where d.id = %s", drive_id)
    if not d:
        raise HTTPException(404, "No drive with that id.")
    c, _ = pick_car(d["car_id"])
    summary = next(iter(drives_page(c, u, None, 1, ids=[drive_id])), None) if d["end_date"] else None
    rows = q("select date, latitude::float as lat, longitude::float as lon, speed, power, elevation, "
             "battery_level, odometer from positions where drive_id = %s order by date", drive_id)
    pts = _thin(rows, 500)
    mi = u["length"] == "mi"
    rated = rated_wh(c, u)

    # efficiency along the route, smoothed over +-30 s so stop-and-go doesn't
    # turn the line into stripes: energy (W*s) / distance (unit*s/h) in the window
    speeds = [(p["speed"] or 0) / (KM_PER_MI if mi else 1) for p in pts]   # per hour, in user units
    powers = [p["power"] or 0 for p in pts]
    ts = [p["date"].timestamp() for p in pts]
    dts = [min(ts[i + 1] - ts[i], 30) if i + 1 < len(ts) else 0 for i in range(len(ts))]
    classes, lo, hi = [], 0, 0
    for i in range(len(pts)):
        while ts[i] - ts[lo] > 30:
            lo += 1
        while hi < len(pts) and ts[hi] - ts[i] <= 30:
            hi += 1
        e = sum(powers[k] * 1000 * dts[k] for k in range(lo, hi))
        dd = sum(speeds[k] * dts[k] for k in range(lo, hi))
        classes.append(eff_class((e / dd) / rated) if dd > 3 * 20 and rated else None)

    out_pts = [{"t": local(p["date"]), "lat": p["lat"], "lon": p["lon"],
                "speed": round(sp) if p["speed"] is not None else None,
                "kw": p["power"] if p["power"] is None else round(p["power"]),
                "elev": None if p["elevation"] is None else round(p["elevation"] * (3.28084 if mi else 1)),
                "pct": p["battery_level"], "e": cl} for p, sp, cl in zip(pts, speeds, classes)]

    km = (rows[-1]["odometer"] - rows[0]["odometer"]) if len(rows) > 1 and rows[0]["odometer"] else None
    distance = (summary or {}).get("distance") or dist(km, u)
    minutes = d["duration_min"] or (round((rows[-1]["date"] - rows[0]["date"]).total_seconds() / 60) if len(rows) > 1 else None)
    kwh = (summary or {}).get("kwh")
    price = avg_price(c)
    speeds_moving = [x for x in speeds if x > 2]
    return {
        "id": drive_id,
        "ongoing": d["end_date"] is None,
        "start": local(d["start_date"]),
        "end": local(d["end_date"]),
        "from": (summary or {}).get("from"),
        "to": (summary or {}).get("to"),
        "distance": distance,
        "minutes": minutes,
        "kwh": kwh,
        "wh_per": (summary or {}).get("wh_per"),
        "rated_wh": rated,
        "rated_estimated": c["efficiency_estimated"],
        "ratio": round(summary["wh_per"] / rated, 3) if summary and summary.get("wh_per") and rated else None,
        "cost": round(kwh * price, 2) if kwh and price else None,
        "price_per_kwh": round(price, 3) if price else None,
        "avg_speed": round(distance / (minutes / 60)) if distance and minutes else None,
        "max_speed": dist(d["speed_max"], u) if d["speed_max"] else (round(max(speeds)) if speeds else None),
        "moving_speed": round(sum(speeds_moving) / len(speeds_moving)) if speeds_moving else None,
        "ascent": None if d["ascent"] is None else round(d["ascent"] * (3.28084 if mi else 1)),
        "descent": None if d["descent"] is None else round(d["descent"] * (3.28084 if mi else 1)),
        "temp": temp(d["temp_c"], u),
        "inside_temp": temp(d["itemp_c"], u),
        "start_pct": rows[0]["battery_level"] if rows else None,
        "end_pct": rows[-1]["battery_level"] if rows else None,
        "max_regen_kw": -min(powers) if powers and min(powers) < 0 else None,
        "max_kw": max(powers) if powers else None,
        "points": out_pts,
        "units": u,
    }


@app.get("/api/routes")
def routes(days: int = 30):
    """Every finished drive in the last N days, thinned to ~80 points each, for the overview map."""
    u = units()
    c, _ = pick_car(None)
    if not c:
        return {"routes": [], "units": u}
    days = max(1, min(days, 365))
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
    rows = q("""
      with p as (
        select p.drive_id, p.date, p.latitude::float as lat, p.longitude::float as lon,
               row_number() over (partition by p.drive_id order by p.date) as rn,
               count(*) over (partition by p.drive_id) as n
        from positions p join drives d on d.id = p.drive_id
        where d.car_id = %s and d.start_date >= %s and d.end_date is not null)
      select drive_id, lat, lon from p
      where rn = 1 or rn = n or rn %% greatest(1, n / 80) = 0
      order by drive_id, date""", c["id"], since)
    by = {}
    for r in rows:
        by.setdefault(r["drive_id"], []).append([round(r["lat"], 5), round(r["lon"], 5)])
    rated = rated_wh(c, u)
    info = {x["id"]: x for x in drives_page(c, u, None, max(1, len(by)), ids=list(by))}
    out = []
    for did, pts in by.items():
        dd = info.get(did, {})
        ratio = dd.get("wh_per") / rated if dd.get("wh_per") and rated else None
        out.append({"id": did, "points": pts, "e": eff_class(ratio), "wh_per": dd.get("wh_per"),
                    "distance": dd.get("distance"), "start": dd.get("start"),
                    "from": dd.get("from"), "to": dd.get("to")})
    return {"routes": out, "units": u, "days": days, "rated_wh": rated}


@app.get("/api/efficiency")
def efficiency(weeks: int = 12):
    """Weekly distance-weighted consumption vs the car's rated figure, plus a 30-day summary."""
    u = units()
    c, _ = pick_car(None)
    if not c:
        return {"weeks": [], "units": u}
    weeks = max(4, min(weeks, 52))
    today = datetime.now(TZ).date()
    monday = today - timedelta(days=today.weekday())
    first = monday - timedelta(weeks=weeks - 1)
    since = datetime.combine(first - timedelta(days=1), datetime.min.time())   # a day early covers the UTC offset
    all_d = [x for x in drives_page(c, u, None, 5000, since=since) if x["start"][:10] >= first.isoformat()]
    buckets = {}
    for i in range(weeks):
        wk = first + timedelta(weeks=i)
        buckets[wk.isoformat()] = {"week": wk.isoformat(), "distance": 0.0, "kwh": 0.0, "drives": 0}
    thirty = (today - timedelta(days=30)).isoformat()
    last30 = {"distance": 0.0, "kwh": 0.0, "drives": 0}
    temps = []
    for x in all_d:
        dday = datetime.fromisoformat(x["start"]).date()
        wk = (dday - timedelta(days=dday.weekday())).isoformat()
        if x["kwh"] and x["distance"]:
            if wk in buckets:
                b = buckets[wk]
                b["distance"] += x["distance"]; b["kwh"] += x["kwh"]; b["drives"] += 1
            if x["start"][:10] >= thirty:
                last30["distance"] += x["distance"]; last30["kwh"] += x["kwh"]; last30["drives"] += 1
            if x["temp"] is not None and x["distance"] >= 1 and x["wh_per"]:
                temps.append({"temp": x["temp"], "wh_per": x["wh_per"], "distance": x["distance"]})
    rated = rated_wh(c, u)
    wk_out = []
    for b in buckets.values():
        wh = round(b["kwh"] * 1000 / b["distance"]) if b["distance"] else None
        wk_out.append({**b, "distance": round(b["distance"], 1), "kwh": round(b["kwh"], 1), "wh_per": wh})
    l30 = round(last30["kwh"] * 1000 / last30["distance"]) if last30["distance"] else None
    price = avg_price(c)
    return {
        "weeks": wk_out,
        "rated_wh": rated,
        "last30": {"distance": round(last30["distance"], 1), "kwh": round(last30["kwh"], 1),
                   "drives": last30["drives"], "wh_per": l30,
                   "ratio": round(l30 / rated, 3) if l30 and rated else None,
                   "cost_per_distance": round(price * l30 / 1000, 3) if price and l30 else None},
        "by_temp": temps[-300:],
        "rated_estimated": c["efficiency_estimated"],
        "units": u,
    }


# ── Places (TeslaMate geofences) ──────────────────────────────────────
# Mirrors TeslaMate's Locations.create/update/delete_geofence: save the row,
# then re-link every drive start/end and charge whose position falls inside
# the circle. TeslaMate keeps no geofence cache, so it sees changes at once.

def _relink(conn, lat, lon, radius, except_id=-1):
    """Point everything inside (lat, lon, radius) at the nearest remaining place."""
    for table, fence_col, pos_col in (("drives", "start_geofence_id", "start_position_id"),
                                      ("drives", "end_geofence_id", "end_position_id"),
                                      ("charging_processes", "geofence_id", "position_id")):
        conn.execute(f"""
            update {table} m set {fence_col} = (
              select g.id from geofences g
              where earth_box(ll_to_earth(g.latitude, g.longitude), g.radius) @> ll_to_earth(p.latitude, p.longitude)
                and earth_distance(ll_to_earth(g.latitude, g.longitude), ll_to_earth(p.latitude, p.longitude)) < g.radius
                and g.id != %(except)s
              order by earth_distance(ll_to_earth(g.latitude, g.longitude), ll_to_earth(p.latitude, p.longitude))
              limit 1)
            from positions p
            where m.{pos_col} = p.id
              and earth_box(ll_to_earth(%(lat)s::numeric, %(lon)s::numeric), %(r)s) @> ll_to_earth(p.latitude, p.longitude)
              and earth_distance(ll_to_earth(%(lat)s::numeric, %(lon)s::numeric), ll_to_earth(p.latitude, p.longitude)) < %(r)s
        """, {"lat": lat, "lon": lon, "r": radius, "except": except_id})


class PlaceIn(BaseModel):
    name: str
    lat: float
    lon: float
    radius: int = 75
    billing: str = "per_kwh"          # per_kwh | per_minute
    rate: float | None = None         # None or 0 -> free
    fee: float | None = None
    reprice: bool = False             # re-price earlier charges here at the new price


def _check_place(b: PlaceIn):
    b.name = b.name.strip()
    if not 1 <= len(b.name) <= 60:
        raise HTTPException(400, "Give the place a name (up to 60 characters).")
    if not (-90 <= b.lat <= 90 and -180 <= b.lon <= 180):
        raise HTTPException(400, "That location isn't valid.")
    if not 20 <= b.radius <= 1000:
        raise HTTPException(400, "The circle has to be between 20 and 1,000 meters.")
    if b.billing not in ("per_kwh", "per_minute"):
        raise HTTPException(400, "Price has to be per kWh or per minute.")
    for v, label in ((b.rate, "price"), (b.fee, "session fee")):
        if v is not None and not 0 <= v <= 100:
            raise HTTPException(400, f"The {label} has to be between $0 and $100.")


def _reprice(conn, place_id):
    """Forget stored (not hand-entered) costs here so the current price applies."""
    conn.execute("update charging_processes cp set cost = null where cp.geofence_id = %s "
                 "and not exists (select 1 from car_dash.manual_costs mc where mc.charging_process_id = cp.id)",
                 (place_id,))


@app.get("/api/places")
def places():
    u = units()
    c, _ = pick_car(None)
    fences = geofences()
    stats = {g["id"]: {"count": 0, "kwh": 0.0, "cost": 0.0, "last": None} for g in fences}
    untagged = {}
    if c:
        rows = q(CHARGE_SQL + " and cp.end_date is not null order by cp.start_date", c["id"])
        by_id = {g["id"]: g for g in fences}
        for r in rows:
            ch = classify(r, by_id, c["free_supercharging"])
            if ch["geofence_id"] in stats:
                st = stats[ch["geofence_id"]]
                st["count"] += 1
                st["kwh"] += ch["added_kwh"]
                st["cost"] += ch["cost"] or 0
                st["last"] = ch["start"]
            elif ch["place_kind"] == "untagged" and ch["lat"] is not None:
                # cluster untagged charges ~100 m apart into suggestions
                key = (round(ch["lat"] * 1000), round(ch["lon"] * 1000))
                sg = untagged.setdefault(key, {"lat": ch["lat"], "lon": ch["lon"], "address": ch["address"],
                                               "count": 0, "kwh": 0.0, "last": None})
                sg["count"] += 1
                sg["kwh"] += ch["added_kwh"]
                sg["last"] = ch["start"]
    status_pos = c and q1("select latitude::float as lat, longitude::float as lon from positions "
                          "where car_id = %s order by date desc limit 1", c["id"])
    return {
        "places": [{**g, **{k: (round(v, 2) if isinstance(v, float) else v) for k, v in stats[g["id"]].items()}}
                   for g in fences],
        "suggestions": sorted(({**v, "kwh": round(v["kwh"], 1)} for v in untagged.values()),
                              key=lambda v: -v["count"])[:5],
        "car_position": status_pos,
        "units": u,
        "teslamate_url": TESLAMATE_URL,
    }


@app.post("/api/places")
def create_place(b: PlaceIn):
    _check_place(b)
    with pool.connection() as conn, conn.transaction():
        row = conn.execute(
            "insert into geofences (name, latitude, longitude, radius, cost_per_unit, session_fee, billing_type, "
            "inserted_at, updated_at) values (%s, %s, %s, %s, %s, %s, %s::billing_type, "
            "now() at time zone 'utc', now() at time zone 'utc') returning id",
            (b.name, b.lat, b.lon, b.radius, b.rate or 0, b.fee, b.billing)).fetchone()
        _relink(conn, b.lat, b.lon, b.radius)
        _reprice(conn, row["id"])
    return {"id": row["id"]}


@app.put("/api/places/{place_id}")
def update_place(place_id: int, b: PlaceIn):
    _check_place(b)
    with pool.connection() as conn, conn.transaction():
        old = conn.execute("select latitude::float as lat, longitude::float as lon, radius from geofences "
                           "where id = %s for update", (place_id,)).fetchone()
        if not old:
            raise HTTPException(404, "That place doesn't exist anymore.")
        _relink(conn, old["lat"], old["lon"], old["radius"], except_id=place_id)   # release the old circle
        conn.execute("update geofences set name = %s, latitude = %s, longitude = %s, radius = %s, "
                     "cost_per_unit = %s, session_fee = %s, billing_type = %s::billing_type, "
                     "updated_at = now() at time zone 'utc' where id = %s",
                     (b.name, b.lat, b.lon, b.radius, b.rate or 0, b.fee, b.billing, place_id))
        _relink(conn, b.lat, b.lon, b.radius)
        if b.reprice:
            _reprice(conn, place_id)
    return {"id": place_id}


@app.delete("/api/places/{place_id}")
def delete_place(place_id: int):
    with pool.connection() as conn, conn.transaction():
        old = conn.execute("select latitude::float as lat, longitude::float as lon, radius from geofences "
                           "where id = %s for update", (place_id,)).fetchone()
        if not old:
            raise HTTPException(404, "That place doesn't exist anymore.")
        _relink(conn, old["lat"], old["lon"], old["radius"], except_id=place_id)
        conn.execute("delete from geofences where id = %s", (place_id,))
    return {"ok": True}


# ── Battery health ────────────────────────────────────────────────────
# Range at 100%, read from the end of each charge: rated range / usable % × 100.
# Only charges that end at 50% or more count (1% steps make low ends noisy).
# Capacity = that range × the car's consumption figure.

@app.get("/api/battery")
def battery():
    u = units()
    c, _ = pick_car(None)
    if not c:
        return {"points": [], "units": u}
    rows = q("""
      select cp.id, cp.end_date, x.usable_battery_level as pct, x.rated_battery_range_km::float as rkm
      from charging_processes cp
      join lateral (select usable_battery_level, rated_battery_range_km from charges
                    where charging_process_id = cp.id order by date desc limit 1) x on true
      where cp.car_id = %s and cp.end_date is not null
        and x.usable_battery_level >= 50 and x.rated_battery_range_km > 0
      order by cp.end_date""", c["id"])
    pts = []
    for r in rows:
        km100 = r["rkm"] / r["pct"] * 100
        pts.append({"t": local(r["end_date"]), "id": r["id"], "range": dist(km100, u),
                    "kwh": round(km100 * c["efficiency"], 1)})

    def median(xs):
        xs = sorted(xs)
        return xs[len(xs) // 2] if xs else None
    first = median([p["range"] for p in pts[:5]])
    now = median([p["range"] for p in pts[-5:]])
    return {
        "points": pts[-400:],
        "first": first, "now": now,
        "kwh_now": median([p["kwh"] for p in pts[-5:]]),
        "change_pct": round(100 * (now - first) / first, 1) if first and now and len(pts) >= 10 else None,
        "since": pts[0]["t"] if pts else None,
        "rated_estimated": c["efficiency_estimated"],
        "units": u,
    }


# ── Push notifications (Web Push) ─────────────────────────────────────
# One notification so far: a charge finished somewhere that isn't a saved
# place. The text names no address; the push service only relays it.

def vapid_keys():
    """(private PEM, public key for the browser), made once and kept sealed."""
    v = state_get("vapid")
    pem = v and unseal(v.get("private", ""))
    if pem:
        return pem, v["public"]
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode()
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    with pool.connection() as conn:
        conn.execute("insert into car_dash.app_state (key, value) values ('vapid', %s) on conflict (key) do nothing",
                     (Jsonb({"private": seal(pem), "public": base64.urlsafe_b64encode(pub).rstrip(b"=").decode()}),))
    v = state_get("vapid")
    return unseal(v["private"]), v["public"]


def send_push(sub, payload) -> bool:
    """Send one notification. Returns False (and forgets the device) when the
    browser says the subscription is gone."""
    from py_vapid import Vapid
    from pywebpush import WebPushException, webpush
    pem, _ = vapid_keys()
    try:
        webpush({"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                json.dumps(payload), vapid_private_key=Vapid.from_pem(pem.encode()),
                vapid_claims={"sub": ORIGIN if ORIGIN.startswith("https://") else f"https://{RP_ID}"},
                ttl=24 * 3600, timeout=10)
    except WebPushException as e:
        code = getattr(e.response, "status_code", None)
        if code in (404, 410):
            with pool.connection() as conn:
                conn.execute("delete from car_dash.push_subscriptions where endpoint = %s", (sub["endpoint"],))
            return False
        raise
    with pool.connection() as conn:
        conn.execute("update car_dash.push_subscriptions set last_ok_at = now() where endpoint = %s", (sub["endpoint"],))
    return True


class PushSub(BaseModel):
    endpoint: str
    keys: dict | None = None
    name: str | None = None


def _check_endpoint(ep: str):
    if not ep.startswith("https://") or len(ep) > 1000:
        raise HTTPException(400, "That doesn't look like a push subscription.")


@app.get("/api/push")
def push_status():
    _, public = vapid_keys()
    n = q1("select count(*) as n from car_dash.push_subscriptions")["n"]
    return {"public_key": public, "devices": n}


@app.post("/api/push/subscribe")
def push_subscribe(b: PushSub):
    _check_endpoint(b.endpoint)
    keys = b.keys or {}
    if not keys.get("p256dh") or not keys.get("auth"):
        raise HTTPException(400, "That push subscription is missing its keys.")
    with pool.connection() as conn:
        conn.execute("insert into car_dash.push_subscriptions (endpoint, p256dh, auth, name) values (%s, %s, %s, %s) "
                     "on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, "
                     "name = excluded.name", (b.endpoint, keys["p256dh"], keys["auth"], (b.name or "Device")[:60]))
    return push_status()


@app.post("/api/push/unsubscribe")
def push_unsubscribe(b: PushSub):
    with pool.connection() as conn:
        conn.execute("delete from car_dash.push_subscriptions where endpoint = %s", (b.endpoint,))
    return push_status()


@app.post("/api/push/test")
def push_test(b: PushSub):
    sub = q1("select endpoint, p256dh, auth from car_dash.push_subscriptions where endpoint = %s", b.endpoint)
    if not sub:
        raise HTTPException(404, "Notifications aren't on for this device.")
    try:
        ok = send_push(sub, {"title": "Car", "body": "Notifications work. You'll hear from Car when a charge "
                                                    "finishes somewhere you haven't saved.", "url": "/#/account"})
    except Exception as e:
        raise HTTPException(502, f"The push service didn't take it: {e}")
    if not ok:
        raise HTTPException(410, "This device's notification subscription expired. Turn notifications on again.")
    return {"ok": True}


def notify_finished_charges():
    """Called every minute: tell subscribed devices about charges that just
    ended at an untagged place. Only looks back 6 hours, so a restart after
    downtime doesn't replay old charges."""
    cursor = state_get("push_cursor")
    newest = q1("select max(end_date) as t from charging_processes")["t"]
    if cursor is None or newest is None:
        if newest is not None:
            state_set("push_cursor", newest.isoformat())
        return
    since = max(datetime.fromisoformat(cursor), datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=6))
    rows = q(CHARGE_SQL.replace("where cp.car_id = %s", "where cp.end_date > %s") + " order by cp.end_date", since)
    if not rows:
        return
    state_set("push_cursor", max(r["end_date"] for r in rows).isoformat())
    subs = q("select endpoint, p256dh, auth from car_dash.push_subscriptions")
    if not subs:
        return
    fences = {g["id"]: g for g in geofences()}
    free = {r["id"]: r["free_supercharging"] for r in
            q("select c.id, s.free_supercharging from cars c left join car_settings s on s.id = c.settings_id")}
    for r in rows:
        ch = classify(r, fences, free.get(r["car_id"]))
        if ch["place_kind"] != "untagged":
            continue
        msg = {"title": "Charge finished",
               "body": f"{ch['added_kwh']:.1f} kWh at a place you haven't saved. Tap to name it and set what it costs.",
               "url": f"/#/charge/{ch['id']}", "tag": f"charge-{ch['id']}"}
        for s in subs:
            try:
                send_push(s, msg)
            except Exception:
                log.exception("push to one device failed")


# ── Tesla Supercharger bills (Fleet API, read-only) ───────────────────
# Owner connects their Tesla account once (OAuth). Every 6 hours the app reads
# GET /api/1/dx/charging/history and keeps each session's bill in
# car_dash.tesla_bills, matched to TeslaMate's charge by start time. Nothing
# is written to TeslaMate's tables, and no vehicle command is ever sent.

TESLA_CLIENT_ID = os.environ.get("TESLA_CLIENT_ID", "")
TESLA_CLIENT_SECRET = os.environ.get("TESLA_CLIENT_SECRET", "")
TESLA_API = os.environ.get("TESLA_API", "https://fleet-api.prd.na.vn.cloud.tesla.com").rstrip("/")
TESLA_AUTHORIZE = os.environ.get("TESLA_AUTHORIZE", "https://auth.tesla.com/oauth2/v3/authorize")
TESLA_TOKEN = os.environ.get("TESLA_TOKEN", "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token")
# vehicle_charging_cmds is the only scope that covers charging history (it
# would also allow charging commands; this app never sends any).
TESLA_SCOPES = "openid offline_access vehicle_charging_cmds"
TESLA_REDIRECT = f"{ORIGIN}/api/tesla/callback"
TESLA_STATE_COOKIE = "car_tesla_state"
TESLA_SYNC_HOURS = 6


def _http(method, url, *, form=None, body=None, token=None, timeout=20):
    import urllib.error
    import urllib.parse
    import urllib.request
    headers = {"Accept": "application/json", "User-Agent": "car-dash"}
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    try:
        return status, json.loads(raw or b"{}")
    except ValueError:
        return status, {"error": raw[:200].decode(errors="replace")}


def _tesla_err(status, j):
    return f"Tesla said {status}: {j.get('error_description') or j.get('error') or j.get('message') or 'no details'}"


def tesla_state():
    return state_get("tesla") or {}


def tesla_public_key():
    k = state_get("tesla_key")
    if k:
        return k["public_pem"]
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    key = ec.generate_private_key(ec.SECP256R1())
    pub = key.public_key().public_bytes(serialization.Encoding.PEM,
                                        serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    priv = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption()).decode()
    with pool.connection() as conn:
        conn.execute("insert into car_dash.app_state (key, value) values ('tesla_key', %s) on conflict (key) do nothing",
                     (Jsonb({"public_pem": pub, "private": seal(priv)}),))
    return state_get("tesla_key")["public_pem"]


@app.get("/.well-known/appspecific/com.tesla.3p.public-key.pem")
def tesla_key_file():
    """Tesla requires every Fleet API app to publish a public key on its domain.
    It's only used for vehicle commands, which this app doesn't send."""
    if not TESLA_CLIENT_ID:
        raise HTTPException(404)
    return PlainTextResponse(tesla_public_key(), media_type="application/x-pem-file")


def tesla_access_token():
    st = tesla_state()
    access = unseal(st.get("access", ""))
    if access and st.get("expires", 0) > time.time() + 120:
        return access
    refresh = unseal(st.get("refresh", ""))
    if not refresh:
        raise RuntimeError("Not connected to Tesla.")
    status, j = _http("POST", TESLA_TOKEN, form={"grant_type": "refresh_token", "client_id": TESLA_CLIENT_ID,
                                                 "refresh_token": refresh})
    if status != 200 or not j.get("access_token"):
        st["error"] = _tesla_err(status, j) + (" Connect again on the Account screen." if status in (400, 401) else "")
        state_set("tesla", st)
        raise RuntimeError(st["error"])
    # refresh tokens are single-use: save the new one before anything else
    st.update(access=seal(j["access_token"]), refresh=seal(j.get("refresh_token") or refresh),
              expires=time.time() + int(j.get("expires_in", 3600)), error=None)
    state_set("tesla", st)
    return j["access_token"]


def _records(j):
    """Charging history comes back as {data: [...]} (possibly inside {response: ...})."""
    for v in (j, j.get("response") if isinstance(j, dict) else None):
        if isinstance(v, list):
            return v
        if isinstance(v, dict):
            for k in ("data", "results", "records"):
                if isinstance(v.get(k), list):
                    return v[k]
    return []


def _parse_time(s):
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def tesla_sync():
    """Fetch charging history pages and store each session's bill."""
    token = tesla_access_token()
    vins = [r["vin"] for r in q("select vin from cars where vin is not null")] or [None]
    seen = 0
    for vin in vins:
        for page in range(1, 21):
            params = f"pageNo={page}&pageSize=50" + (f"&vin={vin}" if vin else "")
            status, j = _http("GET", f"{TESLA_API}/api/1/dx/charging/history?{params}", token=token)
            if status != 200:
                raise RuntimeError(_tesla_err(status, j))
            recs = _records(j)
            with pool.connection() as conn:
                for rec in recs:
                    sid = rec.get("sessionId") or rec.get("id")
                    start = _parse_time(rec.get("chargeStartDateTime") or rec.get("startDateTime"))
                    if sid is None or start is None:
                        continue
                    fees = rec.get("fees") or []
                    total = sum(float(f.get("totalDue") or 0) for f in fees if isinstance(f, dict))
                    currency = next((f.get("currencyCode") for f in fees if isinstance(f, dict) and f.get("currencyCode")), None)
                    conn.execute(
                        "insert into car_dash.tesla_bills (session_id, vin, start_at, site, total, currency, raw) "
                        "values (%s, %s, %s, %s, %s, %s, %s) on conflict (session_id) do update set "
                        "total = excluded.total, currency = excluded.currency, site = excluded.site, "
                        "raw = excluded.raw, fetched_at = now()",
                        (str(sid), rec.get("vin") or vin, start, rec.get("siteLocationName"), round(total, 2),
                         currency, Jsonb(rec)))
                    seen += 1
            if len(recs) < 50:
                break
    # match each bill to the TeslaMate charge that started closest to it (within 20 min)
    with pool.connection() as conn:
        conn.execute("""
          update car_dash.tesla_bills b set charging_process_id = (
            select cp.id from charging_processes cp join cars c on c.id = cp.car_id
            where (b.vin is null or c.vin = b.vin)
              and cp.start_date between (b.start_at at time zone 'utc') - interval '20 minutes'
                                    and (b.start_at at time zone 'utc') + interval '20 minutes'
            order by abs(extract(epoch from cp.start_date - (b.start_at at time zone 'utc'))) limit 1)
          where b.charging_process_id is null""")
    st = tesla_state()
    st.update(last_sync=time.time(), error=None)
    state_set("tesla", st)
    return seen


def tesla_sync_safely():
    try:
        return tesla_sync()
    except Exception as e:
        st = tesla_state()
        st.update(last_try=time.time(), error=str(e)[:300])
        state_set("tesla", st)
        log.warning("tesla sync failed: %s", e)
        return None


@app.get("/api/tesla")
def tesla_status():
    st = tesla_state()
    counts = q1("select count(*) as bills, count(charging_process_id) as matched, "
                "coalesce(sum(total) filter (where charging_process_id is not null), 0)::float as total "
                "from car_dash.tesla_bills")
    return {
        "configured": bool(TESLA_CLIENT_ID and TESLA_CLIENT_SECRET),
        "registered": bool(st.get("registered")),
        "connected": bool(st.get("refresh")),
        "last_sync": st.get("last_sync") and datetime.fromtimestamp(st["last_sync"], TZ).isoformat(),
        "error": st.get("error"),
        "bills": counts["bills"], "matched": counts["matched"], "total": round(counts["total"], 2),
        "redirect_uri": TESLA_REDIRECT, "domain": RP_ID,
    }


@app.post("/api/tesla/register")
def tesla_register():
    """One-time: register this domain with Tesla (needs the public key above to be reachable)."""
    if not TESLA_CLIENT_ID:
        raise HTTPException(400, "Add TESLA_CLIENT_ID and TESLA_CLIENT_SECRET first (see the README).")
    tesla_public_key()
    status, j = _http("POST", TESLA_TOKEN, form={"grant_type": "client_credentials", "client_id": TESLA_CLIENT_ID,
                                                 "client_secret": TESLA_CLIENT_SECRET, "audience": TESLA_API,
                                                 "scope": "openid vehicle_charging_cmds"})
    if status != 200 or not j.get("access_token"):
        raise HTTPException(502, _tesla_err(status, j))
    status, r = _http("POST", f"{TESLA_API}/api/1/partner_accounts", body={"domain": RP_ID}, token=j["access_token"])
    if status not in (200, 201):
        raise HTTPException(502, _tesla_err(status, r))
    st = tesla_state()
    st["registered"] = True
    state_set("tesla", st)
    return tesla_status()


@app.get("/api/tesla/connect")
def tesla_connect(response: Response):
    import urllib.parse
    if not TESLA_CLIENT_ID:
        raise HTTPException(400, "Add TESLA_CLIENT_ID and TESLA_CLIENT_SECRET first (see the README).")
    nonce = secrets.token_urlsafe(24)
    response.set_cookie(TESLA_STATE_COOKIE, nonce, max_age=900, httponly=True, secure=True,
                        samesite="lax", path="/api/tesla")
    q_ = urllib.parse.urlencode({"response_type": "code", "client_id": TESLA_CLIENT_ID, "redirect_uri": TESLA_REDIRECT,
                                 "scope": TESLA_SCOPES, "state": nonce, "prompt_missing_scopes": "true"})
    return {"url": f"{TESLA_AUTHORIZE}?{q_}"}


@app.get("/api/tesla/callback")
def tesla_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
    def back(result):
        r = RedirectResponse(f"/#/account?tesla={result}", status_code=303)
        r.delete_cookie(TESLA_STATE_COOKIE, path="/api/tesla")
        return r
    expected = request.cookies.get(TESLA_STATE_COOKIE)
    if error or not code or not state or not expected or not hmac.compare_digest(state, expected):
        return back("cancelled" if error else "error")
    status, j = _http("POST", TESLA_TOKEN, form={"grant_type": "authorization_code", "client_id": TESLA_CLIENT_ID,
                                                 "client_secret": TESLA_CLIENT_SECRET, "code": code,
                                                 "audience": TESLA_API, "redirect_uri": TESLA_REDIRECT})
    if status != 200 or not j.get("refresh_token"):
        st = tesla_state()
        st["error"] = _tesla_err(status, j)
        state_set("tesla", st)
        return back("error")
    st = tesla_state()
    st.update(access=seal(j["access_token"]), refresh=seal(j["refresh_token"]),
              expires=time.time() + int(j.get("expires_in", 3600)), error=None, connected_at=time.time())
    state_set("tesla", st)
    tesla_sync_safely()
    return back("connected")


@app.post("/api/tesla/sync")
def tesla_sync_now():
    if not tesla_state().get("refresh"):
        raise HTTPException(400, "Connect your Tesla account first.")
    if tesla_sync_safely() is None:
        raise HTTPException(502, tesla_state().get("error") or "Sync failed.")
    return tesla_status()


@app.post("/api/tesla/disconnect")
def tesla_disconnect():
    st = tesla_state()
    for k in ("access", "refresh", "expires", "error", "connected_at"):
        st.pop(k, None)
    state_set("tesla", st)
    return tesla_status()


# ── Background jobs ───────────────────────────────────────────────────

async def _background():
    await asyncio.sleep(20)
    last_tesla = 0.0
    while True:
        try:
            await run_in_threadpool(notify_finished_charges)
        except Exception:
            log.exception("charge notification check failed")
        try:
            if TESLA_CLIENT_ID and time.time() - last_tesla > TESLA_SYNC_HOURS * 3600:
                last_tesla = time.time()
                if (await run_in_threadpool(tesla_state)).get("refresh"):
                    await run_in_threadpool(tesla_sync_safely)
        except Exception:
            log.exception("tesla sync check failed")
        await asyncio.sleep(60)


# ── Static app shell ──────────────────────────────────────────────────



@app.get("/sw.js")
def service_worker():
    return FileResponse(os.path.join(STATIC, "sw.js"), media_type="text/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(os.path.join(STATIC, "manifest.webmanifest"),
                        media_type="application/manifest+json")


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def index():
    with open(os.path.join(STATIC, "index.html"), encoding="utf-8") as f:
        page = f.read()
    page = (page.replace('name="map-tiles" content=""', f'name="map-tiles" content="{html.escape(MAP_TILES)}"')
                .replace('name="map-credit" content=""', f'name="map-credit" content="{html.escape(MAP_CREDIT)}"'))
    return HTMLResponse(page)


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
