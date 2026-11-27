#!/usr/bin/env python3
"""End-to-end passkey test with a WebDriver virtual authenticator.
Run against the demo (dev/demo-db.sh starts it with RP_ID=localhost).
usage: PW=<password> python3 dev/passkey-test.py"""
import json, os, subprocess, time, urllib.error, urllib.request

BASE = "http://localhost:18000"
gd = subprocess.Popen([os.environ.get("GECKODRIVER", "geckodriver"), "--port", "4456"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)


def call(method, path, body=None):
    req = urllib.request.Request("http://127.0.0.1:4456" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)["value"]
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path}: {e.code} {e.read().decode()[:400]}")


def js(S, script, *args):
    return call("POST", S + "/execute/async", {"script": script, "args": list(args)})


try:
    sid = call("POST", "/session", {"capabilities": {"alwaysMatch": {
        "moz:firefoxOptions": {"args": ["-headless"], "prefs": {
            "security.webauth.webauthn_enable_softtoken": True,
            "security.webauthn.enable_softtoken": True,
            "security.webauth.webauthn_enable_usbtoken": False,
            "security.webauthn.enable_usbtoken": False}}, "webauthn:virtualAuthenticators": True}}})["sessionId"]
    S = f"/session/{sid}"
    call("POST", S + "/webauthn/authenticator", {"protocol": "ctap2", "transport": "internal",
         "hasResidentKey": True, "hasUserVerification": True, "isUserVerified": True})
    call("POST", S + "/url", {"url": BASE + "/"})
    time.sleep(2)
    done = "const done = arguments[arguments.length - 1];"
    print("password login:", js(S, done + """fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({password: arguments[0]})}).then(r => done(r.status));""", os.environ["PW"]))
    print("add passkey:", js(S, done + "passkeyAdd().then(r => done(r.passkeys.map(k => k.name))).catch(e => done('ERR ' + e.message));"))
    call("DELETE", S + "/cookie")
    print("signed out, status:", js(S, done + "fetch('/api/status').then(r => done(r.status));"))
    print("passkey sign-in:", js(S, done + "passkeySignIn().then(() => done('ok')).catch(e => done('ERR ' + e.message));"))
    print("status after passkey:", js(S, done + "fetch('/api/status').then(r => done(r.status));"))
    print("list:", js(S, done + "fetch('/api/passkeys').then(r => r.json()).then(d => done(d.passkeys));"))
    print("replay-protection (second sign-in reuses nothing):",
          js(S, done + "passkeySignIn().then(() => done('ok')).catch(e => done('ERR ' + e.message));"))
    call("DELETE", S)
finally:
    gd.terminate()
