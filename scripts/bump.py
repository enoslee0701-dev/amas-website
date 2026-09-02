# Cache-busting: stamp ?v=<timestamp> on local css/js references so browsers fetch fresh assets after each deploy.
import re, time, pathlib
v = time.strftime("%Y%m%d%H%M")
root = pathlib.Path(__file__).resolve().parent.parent
pat = re.compile(r'((?:href|src)="(?:\.\./)*assets/(?:css|js)/[^"?]+)(?:\?v=\d+)?"')
for f in ["index.html", "giving.html", "login.html", "discover.html", "admin.html", "login/index.html", "register/index.html", "forgot-password/index.html", "help/index.html", "portal/index.html", "portal/applicant/index.html", "faculty/verify/index.html", "auth/callback/index.html"]:
    p = root / f
    if not p.exists(): continue
    s = p.read_text(encoding="utf-8")
    n = pat.sub(lambda m: m.group(1) + "?v=" + v + '"', s)
    if n != s:
        p.write_text(n, encoding="utf-8"); print("stamped", f)
