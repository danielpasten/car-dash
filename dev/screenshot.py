#!/usr/bin/env python3
"""Minimal WebDriver client (Firefox + geckodriver, no Selenium): sign in to the demo app and
screenshot routes, full length, at a phone's width.
usage: PW=<password> dev/screenshot.py <outdir> 390 844 name=#/route [name=#/route ...] [--dark] [--signed-out]
  BASE=http://127.0.0.1:18000   app to shoot
  GECKODRIVER=geckodriver       driver binary (Ubuntu's snap: /snap/bin/geckodriver)
  PREVIEW_FONT=/path/Inter.ttf  optional stand-in for SF Pro (the app uses the system font)
  DPR=2.0                       device pixel ratio of the PNGs"""
import base64, json, os, shutil, subprocess, sys, time, urllib.request

BASE = os.environ.get("BASE", "http://127.0.0.1:18000")
out, W, H = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
dark = "--dark" in sys.argv
shots = [a.split("=", 1) for a in sys.argv[4:] if "=" in a]
EXTRA = json.loads(os.environ.get("EXTRA", "{}"))   # name -> [js to run before the shot]
PASSWORD = os.environ.get("PW", "")
# Preview only: the app uses the system font (SF Pro on iPhone). Optionally stand in a font
# such as Inter, added from bytes so there's no fetch and no change to the app's CSS/CSP.
_font = os.environ.get("PREVIEW_FONT")
FONT = base64.b64encode(open(_font, "rb").read()).decode() if _font else ""
INJECT = """const done = arguments[arguments.length - 1];
// Firefox's minimum window is ~500px: zoom the page so its layout width is the phone's.
document.documentElement.style.scrollbarWidth = 'none';
document.documentElement.style.zoom = innerWidth / arguments[1];
if (!arguments[0] || [...document.fonts].some(f => f.family.includes('Inter Variable'))) { done(1); return; }
const b = Uint8Array.from(atob(arguments[0]), c => c.charCodeAt(0));
const f = new FontFace('Inter Variable', b.buffer, {weight: '100 900'});
document.fonts.add(f); f.load().then(() => done(2), e => done(String(e)));"""

GECKO = os.environ.get("GECKODRIVER") or shutil.which("geckodriver") or "/snap/bin/geckodriver"
gd = subprocess.Popen([GECKO, "--port", "4455"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(60):          # the snap takes a while to start; wait until it answers
    try:
        urllib.request.urlopen("http://127.0.0.1:4455/status", timeout=1)
        break
    except OSError:
        time.sleep(0.5)


def call(method, path, body=None):
    req = urllib.request.Request("http://127.0.0.1:4455" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["value"]


try:
    prefs = {"ui.systemUsesDarkTheme": 1 if dark else 0, "layout.css.prefers-color-scheme.content-override": 0 if dark else 1}
    # Firefox won't make a window narrower than ~500px, so render at 2x and size the window
    # in device pixels: an iPhone-width 390 CSS px viewport, crisp @2x screenshots.
    prefs["layout.css.devPixelsPerPx"] = os.environ.get("DPR", "2.0")
    sess = call("POST", "/session", {"capabilities": {"alwaysMatch": {"moz:firefoxOptions": {
        "args": ["-headless"], "prefs": prefs}}}})
    sid = sess["sessionId"]
    S = f"/session/{sid}"
    call("POST", S + "/window/rect", {"width": W, "height": H})
    call("POST", S + "/url", {"url": BASE + "/"})
    time.sleep(1.5)
    if "--signed-out" in sys.argv:
        call("POST", S + "/execute/async", {"script": INJECT, "args": [FONT, W]})
    if "--signed-out" not in sys.argv:
      call("POST", S + "/execute/async", {"script": """
      const done = arguments[arguments.length - 1];
      fetch('/api/login', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({password: arguments[0]})}).then(r => done(r.status));""", "args": [PASSWORD]})
    for name, route in shots:
        call("POST", S + "/url", {"url": BASE + "/" + route})
        time.sleep(2)
        call("POST", S + "/execute/async", {"script": INJECT, "args": [FONT, W]})
        time.sleep(1.2)
        if os.environ.get("PROBE"):
            print(call("POST", S + "/execute/sync", {"script": os.environ["PROBE"], "args": []}))
        for js in EXTRA.get(name, []):
            call("POST", S + "/execute/sync", {"script": js, "args": []}); time.sleep(0.8)
        # full-page: grow the window to the document height
        # viewport = the phone's height (in zoomed px) or the whole page, whichever is taller;
        # the window rect includes the browser frame, so add that back
        h = call("POST", S + "/execute/sync", {"script": "const z = parseFloat(document.documentElement.style.zoom) || 1;"
                 "return Math.ceil(Math.max(document.documentElement.scrollHeight, arguments[0] * z) + outerHeight - innerHeight)",
                 "args": [H]})
        call("POST", S + "/window/rect", {"width": W, "height": h})
        time.sleep(0.8)
        png = call("GET", S + "/screenshot")
        with open(os.path.join(out, name + ".png"), "wb") as f:
            f.write(base64.b64decode(png))
        call("POST", S + "/window/rect", {"width": W, "height": H})
        print(os.path.join(out, name + ".png"))
    call("DELETE", S)
finally:
    gd.terminate()
