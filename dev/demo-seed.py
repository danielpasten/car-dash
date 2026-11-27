#!/usr/bin/env python3
"""Emit SQL that fills teslamate_demo with ~6 months of plausible data."""
import math
import random
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

random.seed(7)
TZ = ZoneInfo("America/New_York")
out = []
emit = out.append


def utc(dt):
    return dt.astimezone(timezone.utc).replace(tzinfo=None).isoformat(sep=" ")


def lit(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(round(v, 4)) if isinstance(v, float) else str(v)
    return "'" + str(v).replace("'", "''") + "'"


def ins(table, **cols):
    emit(f"insert into {table} ({', '.join(cols)}) values ({', '.join(lit(v) for v in cols.values())});")


HOME = (40.73570, -74.17240)
WORK = (40.74400, -74.03240)
SC = [("Tesla Supercharger Paramus", 40.9170, -74.0710), ("Tesla Supercharger Woodbridge", 40.5580, -74.2900)]
MALL = ("Garden State Plaza, Paramus", 40.9185, -74.0770)

emit("begin;")
ins("car_settings", id=1, suspend_min=21, suspend_after_idle_min=15, req_not_unlocked=False,
    free_supercharging=False, use_streaming_api=True, enabled=True, lfp_battery=False)
ins("cars", id=1, eid=1, vid=1, model="Y", efficiency=0.153, vin="7SAYGDEE0PA000000", name=None,
    trim_badging="74D", settings_id=1, marketing_name="Model Y Long Range", display_priority=1,
    inserted_at="2026-03-01 00:00:00", updated_at="2026-03-01 00:00:00")
ins("geofences", id=1, name="Home", latitude=HOME[0], longitude=HOME[1], radius=60, cost_per_unit=0.17,
    session_fee=None, billing_type="per_kwh", inserted_at="2026-03-01 00:00:00", updated_at="2026-03-01 00:00:00")
ins("geofences", id=2, name="Work", latitude=WORK[0], longitude=WORK[1], radius=80, cost_per_unit=0.0,
    session_fee=None, billing_type="per_kwh", inserted_at="2026-03-01 00:00:00", updated_at="2026-03-01 00:00:00")

addr_id = [0]


def address(name, road, city, lat, lon):
    addr_id[0] += 1
    ins("addresses", id=addr_id[0], display_name=f"{road}, {city}", latitude=lat, longitude=lon, name=name,
        road=road, city=city, inserted_at="2026-03-01 00:00:00", updated_at="2026-03-01 00:00:00")
    return addr_id[0]


A_HOME = address(None, "Park Avenue", "Newark", *HOME)
A_WORK = address(None, "Hudson Street", "Jersey City", *WORK)
A_SC = [address(n, "Route 17", "Paramus" if "Paramus" in n else "Woodbridge", la, lo) for n, la, lo in SC]
A_MALL = address(None, "Garden State Plaza Blvd", "Paramus", MALL[1], MALL[2])
A_ERR = [address(None, r, c, la, lo) for r, c, la, lo in
         [("Bloomfield Avenue", "Montclair", 40.8130, -74.2110), ("Main Street", "Hoboken", 40.7440, -74.0290),
          ("Ferry Street", "Newark", 40.7270, -74.1600)]]

pos_id = [0]
odo = [18420.0]   # km
rng = [390.0]     # rated km
batt = [78]


def season_temp(when):
    """Rough NJ monthly average in °C, so efficiency varies with the weather."""
    return {1: -1, 2: 1, 3: 6, 4: 12, 5: 17, 6: 23, 7: 27, 8: 26, 9: 21, 10: 14, 11: 8, 12: 2}[when.month] + random.uniform(-4, 4)


def position(when, lat, lon, drive_id=None, speed=None, power=None, elevation=None):
    pos_id[0] += 1
    ins("positions", id=pos_id[0], date=utc(when), latitude=lat, longitude=lon, speed=speed, power=power,
        elevation=elevation, odometer=odo[0],
        battery_level=batt[0], usable_battery_level=batt[0] - 1, rated_battery_range_km=rng[0],
        ideal_battery_range_km=rng[0], outside_temp=18.0, inside_temp=21.5, car_id=1, drive_id=drive_id)
    return pos_id[0]


drive_id = [0]


def drive(start, km, frm, to, fence_from=None, fence_to=None):
    """A drive traced every 10 s along a bendy path, with stops, regen and hills."""
    drive_id[0] += 1
    did = drive_id[0]
    mins = max(6, int(km / 0.75))
    t_c = season_temp(start)
    cold = max(0.0, (15 - t_c) / 15)                # 0 in summer, up to ~0.6 in March
    r0 = rng[0]
    used = km * random.uniform(1.0, 1.2) * (1 + 0.35 * cold)
    (la0, lo0), (la1, lo1) = frm[1:], to[1:]
    # two bends offset perpendicular to the straight line
    dx, dy = lo1 - lo0, la1 - la0
    bends = [(la0 + dy * f - dx * off, lo0 + dx * f + dy * off)
             for f, off in ((0.33, random.uniform(-0.18, 0.18)), (0.66, random.uniform(-0.18, 0.18)))]
    way = [(la0, lo0), *bends, (la1, lo1)]
    n = mins * 6
    elev0 = random.uniform(10, 60)
    stops = sorted(random.sample(range(12, max(13, n - 12)), k=min(4, max(1, n // 40))))
    speed_prev = 0.0
    top = 0
    p0 = None
    for i in range(n + 1):
        f = i / n
        seg = min(int(f * (len(way) - 1)), len(way) - 2)
        g = f * (len(way) - 1) - seg
        lat = way[seg][0] + (way[seg + 1][0] - way[seg][0]) * g + random.uniform(-0.00004, 0.00004)
        lon = way[seg][1] + (way[seg + 1][1] - way[seg][1]) * g + random.uniform(-0.00004, 0.00004)
        near_stop = min((abs(i - st) for st in stops), default=99)
        cruise = 55 + 45 * math.sin(math.pi * f) + random.uniform(-6, 6)       # km/h, faster mid-trip
        speed = 0.0 if i in (0, n) else max(0.0, cruise * min(1.0, near_stop / 4))
        dv = speed - speed_prev
        power = 0.1 * speed + 0.0011 * speed ** 2 + dv * 1.6 + (3.5 * cold if speed > 1 else 0.8 * cold) + 0.8
        if dv < -4:
            power = max(-60.0, dv * 2.4)                                         # regen on slowing down
        elev = elev0 + 18 * math.sin(f * math.pi * 3) + 8 * math.sin(f * math.pi * 7)
        rng[0] = r0 - used * f
        batt[0] = max(10, int(rng[0] / 5.0))
        odo[0] += km / n if i else 0
        pid = position(start + timedelta(seconds=10 * i), lat, lon, did, int(round(speed)), int(round(power)), int(elev))
        p0 = p0 or pid
        top = max(top, speed)
        speed_prev = speed
    end = start + timedelta(minutes=mins)
    rng[0] = max(40.0, r0 - used)
    batt[0] = max(10, int(rng[0] / 5.0))
    ins("drives", id=did, start_date=utc(start), end_date=utc(end), outside_temp_avg=round(t_c, 1),
        speed_max=int(top), distance=km, duration_min=mins, car_id=1,
        start_km=odo[0] - km, end_km=odo[0], start_rated_range_km=r0, end_rated_range_km=rng[0],
        start_ideal_range_km=r0, end_ideal_range_km=rng[0], start_address_id=frm[0], end_address_id=to[0],
        start_position_id=p0, end_position_id=pos_id[0], start_geofence_id=fence_from, end_geofence_id=fence_to,
        inside_temp_avg=21.0, ascent=int(40 + random.uniform(0, 30)), descent=int(38 + random.uniform(0, 30)))
    return end


cp_id, ch_id = [0], [0]


def charge(start, where, lat, lon, addr, fence, kind, target, cost=None):
    cp_id[0] += 1
    start_pct = batt[0]
    target = max(target, start_pct + 5)
    kwh = (target - start_pct) / 100 * 75
    if kind == "dc":
        peak = random.choice([150, 170, 190, 250])
        mins = int(kwh / (peak * 0.55) * 60) + 4
        used = kwh * 1.03
    else:
        peak = 11 if kind == "home" else 7
        mins = int(kwh / (peak * 0.95) * 60) + 3
        used = kwh * random.uniform(1.08, 1.14)
    p = position(start, lat, lon)
    end = start + timedelta(minutes=mins)
    r0 = rng[0]
    ins("charging_processes", id=cp_id[0], start_date=utc(start), end_date=utc(end), charge_energy_added=kwh,
        charge_energy_used=used, start_battery_level=start_pct, end_battery_level=target, duration_min=mins,
        car_id=1, position_id=p, address_id=addr, geofence_id=fence, cost=cost, outside_temp_avg=17.0,
        start_rated_range_km=r0, end_rated_range_km=target * 5.0, start_ideal_range_km=r0,
        end_ideal_range_km=target * 5.0)
    step = 2 if kind != "dc" else 1
    # rated km per % slowly fades (~2.5%/year) with a little noise, so Battery health has a trend
    per_pct = 5.0 * (1 - 0.025 * (start - SEED_START).days / 365) + random.uniform(-0.03, 0.03)
    for i in range(0, mins + 1, step):
        f = i / max(1, mins)
        pct = int(start_pct + (target - start_pct) * f)
        if kind == "dc":
            kw = int(peak * (1.0 if pct < 45 else max(0.18, 1 - (pct - 45) / 55)) * random.uniform(0.96, 1.02))
        else:
            kw = peak if i else 0
        ch_id[0] += 1
        ins("charges", id=ch_id[0], date=utc(start + timedelta(minutes=i)), battery_level=pct,
            usable_battery_level=pct, charge_energy_added=kwh * f, charger_power=kw,
            charger_voltage=400 if kind == "dc" else 240, charger_actual_current=kw * 1000 // (400 if kind == "dc" else 240),
            charger_phases=None if kind == "dc" else 1, fast_charger_present=kind == "dc",
            fast_charger_brand="Tesla" if kind == "dc" else "<invalid>", fast_charger_type="Supercharger" if kind == "dc" else "<invalid>",
            ideal_battery_range_km=pct * per_pct, rated_battery_range_km=pct * per_pct, outside_temp=17.0,
            charging_process_id=cp_id[0], conn_charge_cable="IEC" if kind != "dc" else "GB_DC")
    batt[0] = target
    rng[0] = target * 5.0
    return end


home = (A_HOME, *HOME)
work = (A_WORK, *WORK)
# six months ending an hour ago, so "this month" and "last 30 days" always have data
last = datetime.now(TZ).replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
day = (last - timedelta(days=183)).replace(hour=0)
SEED_START = day
sc_count = 0
while day < last:
    wd = day.weekday() < 5
    t = day.replace(hour=8, minute=random.randint(0, 40))
    if wd:
        t = drive(t, random.uniform(16, 21), home, work, 1, 2)
        if random.random() < 0.55 and batt[0] < 75:
            t = charge(t + timedelta(minutes=3), "Work", *WORK, A_WORK, 2, "work", random.choice([70, 80]))
        t = day.replace(hour=17, minute=random.randint(20, 59))
        t = drive(t, random.uniform(16, 22), work, home, 2, 1)
    else:
        e = random.choice(A_ERR)
        t = day.replace(hour=11, minute=random.randint(0, 59))
        t = drive(t, random.uniform(8, 30), home, (e, 40.80, -74.15), 1, None)
        t = drive(t + timedelta(hours=2), random.uniform(8, 30), (e, 40.80, -74.15), home, None, 1)
        if random.random() < 0.18:
            sc = random.randrange(2)
            t = drive(t + timedelta(hours=1), random.uniform(40, 90), home, (A_SC[sc], SC[sc][1], SC[sc][2]), 1, None)
            batt[0] = min(batt[0], random.randint(18, 35))
            added_rate = random.choice([0.41, 0.44, 0.48, 0.52])
            sc_count += 1
            skip_bill = day > last - timedelta(days=14) and sc_count % 2 == 0
            start_pct = batt[0]
            est_cost = None if skip_bill else round((80 - start_pct) / 100 * 75 * 1.03 * added_rate, 2)
            t = charge(t + timedelta(minutes=2), SC[sc][0], SC[sc][1], SC[sc][2], A_SC[sc], None, "dc", 80, est_cost)
            t = drive(t + timedelta(minutes=5), random.uniform(40, 90), (A_SC[sc], SC[sc][1], SC[sc][2]), home, None, 1)
        if day.day in (6, 19) and day.month >= 8:
            t = drive(t + timedelta(hours=1), 24, home, (A_MALL, MALL[1], MALL[2]), 1, None)
            t = charge(t + timedelta(minutes=4), "Mall", MALL[1], MALL[2], A_MALL, None, "mall", batt[0] + 18)
            t = drive(t + timedelta(minutes=30), 24, (A_MALL, MALL[1], MALL[2]), home, None, 1)
    if batt[0] < 55 or (not wd and random.random() < 0.3):
        t = charge(day.replace(hour=22, minute=random.randint(0, 30)), "Home", *HOME, A_HOME, 1, "home", 80)
    day += timedelta(days=1)

position(last, *HOME)
ins("states", id=1, state="asleep", start_date=utc(last - timedelta(hours=3)), end_date=None, car_id=1)
for seq, tbl in [("positions_id_seq", "positions"), ("drives_id_seq", "drives"), ("charges_id_seq", "charges"),
                 ("charging_processes_id_seq", "charging_processes"), ("addresses_id_seq", "addresses"),
                 ("geofences_id_seq", "geofences"), ("states_id_seq", "states")]:
    emit(f"select setval('{seq}', (select max(id) from {tbl}));")
emit("commit;")
print("\n".join(out))
