#!/usr/bin/env python3
"""Click-through UI test against the demo (dev/demo-db.sh): sign-in, passkeys (WebAuthn virtual
authenticator), charge costs, places, settings, drives. Changes demo data only.
usage: PW=<password> dev/ui-test.py        (BASE=http://localhost:18000, GECKODRIVER=geckodriver)"""
import json, os, shutil, subprocess, sys, time, urllib.error, urllib.request

BASE = os.environ.get("BASE", "http://localhost:18000")
PORT = 4457
subprocess.run(["pkill", "-u", os.environ.get("USER", ""), "-f", f"geckodriver --port {PORT}"])
GECKO = os.environ.get("GECKODRIVER") or shutil.which("geckodriver") or "/snap/bin/geckodriver"
gd = subprocess.Popen([GECKO, "--port", str(PORT)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(80):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/status", timeout=1); break
    except OSError:
        time.sleep(0.5)

results = []


def call(method, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)["value"]
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path}: {e.code} {e.read().decode()[:400]}")


def run(js_body, *args):
    """Run an async snippet; it gets helpers wait(fn), sleep(ms), q(sel), click(sel) and must `return` a value."""
    script = """const done = arguments[arguments.length - 1];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const q = (s) => document.querySelector(s);
const qa = (s) => [...document.querySelectorAll(s)];
async function wait(fn, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(100); } return null; }
const text = () => q('#view').innerText;
const byText = (sel, t) => qa(sel).find(e => e.textContent.trim().includes(t));
const toastText = () => (q('.toast') || {}).textContent || '';
(async () => {""" + js_body + """})().then(done, e => done('JS ERROR: ' + e));"""
    return call("POST", S + "/execute/async", {"script": script, "args": list(args)})


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))


def go(route):
    call("POST", S + "/url", {"url": BASE + "/" + route})
    time.sleep(1.5)


try:
    sid = call("POST", "/session", {"capabilities": {"alwaysMatch": {
        "moz:firefoxOptions": {"args": ["-headless"], "prefs": {
            "security.webauth.webauthn_enable_softtoken": True, "security.webauthn.enable_softtoken": True,
            "security.webauth.webauthn_enable_usbtoken": False, "security.webauthn.enable_usbtoken": False}},
        "webauthn:virtualAuthenticators": True}}})["sessionId"]
    S = f"/session/{sid}"
    call("POST", S + "/window/rect", {"width": 500, "height": 1000})
    call("POST", S + "/webauthn/authenticator", {"protocol": "ctap2", "transport": "internal",
         "hasResidentKey": True, "hasUserVerification": True, "isUserVerified": True})
    go("#/car")
    run("await fetch('/api/logout', {method: 'POST'}); location.reload(); return 1;")
    time.sleep(2)

    # 1. Password sign-in through the form (wrong, then right)
    r = run("""await wait(() => q('#pw'));
      q('#pw').value = 'definitely-wrong'; q('.signin form').requestSubmit();
      const err = await wait(() => q('.signin .error').textContent);
      q('#pw').value = arguments[0]; q('.signin form').requestSubmit();
      const ok = await wait(() => q('.car-hero'));
      return JSON.stringify({err, ok: !!ok, tabs: !q('#tabs').hidden});""", os.environ["PW"])
    d = json.loads(r); check("sign-in: wrong password shows error", d["err"], r); check("sign-in: password opens Car with tabs", d["ok"] and d["tabs"], r)

    # reset demo state from earlier runs: no passkeys, banner not dismissed
    run("""const {passkeys} = await (await fetch('/api/passkeys')).json();
      for (const k of passkeys) await fetch('/api/passkeys/' + k.id, {method: 'DELETE'});
      localStorage.removeItem('passkey-nudge'); location.reload(); return passkeys.length;""")
    time.sleep(2.5)
    # 2. Car home pieces
    r = run("""await wait(() => q('.tiles'));
      return JSON.stringify({tiles: qa('.tile').length, links: qa('a.tile').map(a => a.getAttribute('href')),
        nudge: !!byText('.banner-title', 'Face ID'), settings: !!q('.lt a[href=\"#/account\"]'), sign: !!q('.sign')});""")
    d = json.loads(r)
    check("car: 4 tiles, linked tiles go to charging/drive/battery", d["tiles"] == 4 and "#/charging" in d["links"] and "#/battery" in d["links"], r)
    check("car: passkey banner + Settings button, no highway sign", d["nudge"] and d["settings"] and not d["sign"], r)

    # 3. Passkey: add from the Car banner, then it disappears; sign out; sign in with passkey
    r = run("""byText('.banner button', 'Add').click();
      const t = await wait(() => toastText()); await sleep(300);
      return JSON.stringify({toast: t, banner: !!byText('.banner-title', 'Face ID')});""")
    d = json.loads(r); check("passkey: add from banner", d["toast"] == "Passkey added" and not d["banner"], r)
    go("#/account")
    r = run("""await wait(() => byText('.grp-head', 'Passkeys'));
      const rows = qa('.grp')[0].querySelectorAll('.cell-title'); return [...rows].map(e => e.textContent).join('|');""")
    check("settings: passkey listed", "No passkeys" not in r and len(r) > 0, r)
    r = run("""qa('.cell').find(e => e.textContent.trim() === 'Sign out').click(); const ok = await wait(() => q('.signin .passkey'));
      q('.signin .passkey').click(); const home = await wait(() => !q('.signin') && q('.lt') && !q('#tabs').hidden, 15000);
      return JSON.stringify({signinShown: !!ok, home: !!home, err: (q('.signin .error') || {}).textContent, hash: location.hash, view: text().slice(0, 80)});""")
    d = json.loads(r) if r.startswith('{') else {"signinShown": False, "home": False}; check("sign out → sign-in screen", d["signinShown"], r); check("passkey sign-in", d["home"], r)

    # 4. Charge cost: enter, then clear back to the place price
    go("#/charge/106")
    r = run("""await wait(() => q('#cost'));
      const before = q('.card .stat-value').textContent;
      q('#cost').value = '4.25'; q('.cost-form').requestSubmit();
      const t1 = await wait(() => toastText().includes('Cost saved') && toastText());
      const after = await wait(() => q('.card .stat-value').textContent === '$4.25' && '$4.25');
      const how = q('.card .caption').textContent;
      q('#cost').value = ''; q('.cost-form').requestSubmit();
      await wait(() => toastText().includes('Back to'));
      const back = await wait(() => q('.card .stat-value').textContent === before && before);
      return JSON.stringify({before, after, how, back});""")
    d = json.loads(r); check("charge: save manual cost", d["after"] == "$4.25" and "Entered by you" in d["how"], r)
    check("charge: clearing restores place price", d["back"] == d["before"], r)

    # 5. Edit place: rename + radius + per-minute, then restore
    go("#/place/1")
    r = run("""await wait(() => q('#pname'));
      const orig = q('#pname').value; const origRate = q('#prate').value;
      q('#pname').value = orig + ' X'; const rg = q('#radius'); rg.value = 120; rg.dispatchEvent(new Event('input'));
      const out = q('output').textContent;
      byText('.segmented button', 'Per minute').click(); const unit = q('.cell.field .unit').textContent;
      byText('.segmented button', 'Per kWh').click();
      const sw = q('#reprice'); const swOn = sw && sw.checked;
      q('.place-form').requestSubmit();
      await wait(() => location.hash === '#/places');
      const listed = await wait(() => byText('.cell-title', orig + ' X'));
      return JSON.stringify({orig, origRate, out, unit, swOn, listed: !!listed});""")
    d = json.loads(r)
    check("place: radius slider updates readout", d["out"] == "120 m", r)
    check("place: segmented switches unit", d["unit"] == "/min", r)
    check("place: save renames, back to Places", d["listed"] and d["swOn"], r)
    go("#/place/1")
    r = run("""await wait(() => q('#pname')); q('#pname').value = arguments[0];
      const rg = q('#radius'); rg.value = arguments[1]; rg.dispatchEvent(new Event('input'));
      q('.place-form').requestSubmit(); return !!(await wait(() => byText('.cell-title', arguments[0])));""", d["orig"], 60)
    check("place: restore name", r is True, str(r))

    # 6. New place from a suggestion, then delete (two taps)
    go("#/places")
    r = run("""const a = await wait(() => q('.grp:nth-of-type(2) a.cell') || qa('a.cell').find(x => x.querySelector('.tag')));
      if (!a) return 'no suggestion'; a.click();
      await wait(() => q('#pname')); q('#pname').value = 'Flow Test';
      q('#prate').value = '0.31'; q('.place-form').requestSubmit();
      const ok = await wait(() => byText('.cell-title', 'Flow Test'));
      byText('a.cell', 'Flow Test').click();
      await wait(() => byText('.cell', 'Delete place'));
      const del = byText('button.cell', 'Delete place'); del.click(); const armed = del.classList.contains('armed') && del.textContent;
      del.click(); const gone = await wait(() => location.hash === '#/places' && !byText('.cell-title', 'Flow Test') && 1);
      return JSON.stringify({created: !!ok, armed, gone: !!gone});""")
    try:
        d = json.loads(r)
    except Exception:
        d = {}
    check("place: create from suggestion", d.get("created"), r)
    check("place: delete needs second tap, then removes", d.get("armed") == "Tap again to delete" and d.get("gone"), r)

    # 7. Gas settings save on change, charging shows Gas savings
    go("#/account")
    r = run("""await wait(() => q('#gprice'));
      q('#gprice').value = q('#gprice').value === '3.29' ? '3.49' : '3.29'; q('#gprice').dispatchEvent(new Event('change'));
      const t1 = await wait(() => toastText().includes('Saved'));
      q('#gecon').value = '28'; q('#gecon').dispatchEvent(new Event('change'));
      await sleep(800); return JSON.stringify({saved: !!t1, w: q('#gprice').style.width});""")
    d = json.loads(r); check("settings: gas price saves on change", d["saved"], r)
    go("#/charging")
    r = run("""const s = await wait(() => byText('.sec-title', 'Gas savings')); return !!s;""")
    check("charging: gas savings card appears", r is True, str(r))

    # 8. Notifications toggle (headless can't grant permission: must fail gracefully)
    go("#/account")
    r = run("""const sw = await wait(() => q('#push-toggle')); await sleep(800);
      const foot = sw.closest('.grp').querySelector('.grp-foot').textContent;
      if (sw.disabled) return JSON.stringify({foot, disabled: true});
      sw.click(); const t = await wait(() => toastText(), 6000); await sleep(500);
      return JSON.stringify({foot, toast: t, checked: q('#push-toggle').checked, view: !!q('.lt')});""")
    d = json.loads(r); check("settings: notification toggle renders and handles outcome", d.get("view", True) and d.get("foot"), r)
    print("   notifications:", r)

    # 9. Remove passkey (armed)
    r = run("""const b = await wait(() => byText('.list button', 'Remove')); b.click(); const armed = b.textContent;
      b.click(); const t = await wait(() => toastText().includes('removed'));
      const none = await wait(() => byText('.cell-title', 'No passkeys'));
      return JSON.stringify({armed, removed: !!t, none: !!none});""")
    d = json.loads(r); check("settings: remove passkey (two taps)", d["armed"] == "Remove?" and d["removed"] and d["none"], r)

    # 10. Sessions armed row
    r = run("""const b = byText('button.cell', 'Sign out all other'); b.click(); const armed = b.textContent;
      b.click(); const t = await wait(() => toastText().includes('Other devices')); await sleep(300);
      return JSON.stringify({armed, toast: !!t, still: !!q('.lt')});""")
    d = json.loads(r); check("settings: sign out others (two taps), stays signed in", d["armed"].startswith("Tap again") and d["toast"] and d["still"], r)

    # 11. Drives: older drives load + month totals fill in; month stepper on Charging
    go("#/drives")
    r = run("""const b = await wait(() => byText('button', 'Show older'));
      const m0 = qa('.grp-head.month').length; b.click();
      await wait(() => qa('.grp-head.month').length > m0, 8000);
      const ends = qa('.grp-head.month .end').map(e => e.textContent);
      return JSON.stringify({m0, months: qa('.grp-head.month').length, firstEnd: ends[0]});""")
    d = json.loads(r); check("drives: older drives load, finished month shows totals", d["months"] > d["m0"] and "drives" in (d["firstEnd"] or ""), r)
    r = run("""const a = q('#tabs a[href=\"#/charging\"]'); a.click(); await wait(() => q('.stepper'));
      const m = q('.stepper-label').textContent; q('.stepper .step').click();
      await wait(() => q('.stepper-label').textContent !== m); return q('.stepper-label').textContent + ' <- ' + m;""")
    check("charging: previous-month stepper", "<-" in r and r.split(" <- ")[0] != r.split(" <- ")[1], r)

    # 12. Drive detail: floating back works
    go("#/drive/386")
    r = run("""const b = await wait(() => q('.float-back')); b.click(); return !!(await wait(() => location.hash === '#/drives'));""")
    check("drive: floating back button", r is True, str(r))

    # 13. Every main route renders without the error card
    bad = []
    for rt in ["#/car", "#/charging", "#/charge/106", "#/drives", "#/drive/386", "#/places", "#/place/1", "#/place/new", "#/battery", "#/account"]:
        go(rt)
        if run("await sleep(500); return text().includes('Couldn’t load');"):
            bad.append(rt)
    check("all routes render", not bad, ",".join(bad))
    call("DELETE", S)
finally:
    gd.terminate()
fails = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
