#!/usr/bin/env python3
"""Local, synthetic phone screenshots. Never contacts the configured API host.

Run a production `next start` with API_URL=http://127.0.0.1:3109, then run
`python3 capture.py before|after`. Browser API traffic is intercepted in CDP
and fulfilled by this local fixture server. No third-party Python modules.
"""
import base64
import hashlib
import http.server
import json
import os
import socket
import struct
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import urllib.error

ROOT = "/Users/westbridgeinc/swift-coordination/screenshots/web-mobile"
CHROME = "/Users/westbridgeinc/.cache/puppeteer/chrome-headless-shell/mac_arm-144.0.7559.96/chrome-headless-shell-mac-arm64/chrome-headless-shell"
WEB = "http://127.0.0.1:3108"
MOCK = "http://127.0.0.1:3109"
ROUTES = ["/dashboard", "/dashboard/orders", "/dashboard/inventory",
          "/dashboard/inventory/import", "/dashboard/settings", "/portal",
          "/portal/history", "/portal/documents", "/portal/account",
          "/", "/store/phone-fixture", "/how-it-works"]

STORE = {"id": "store-phone", "name": "Phone Fixture Market", "slug": "phone-fixture",
         "vendorType": "STORE", "city": "Georgetown", "region": "Demerara-Mahaica",
         "description": "Fresh goods for a local layout check.", "logoUrl": None,
         "coverImageUrl": None, "cuisineTypes": [], "tags": [], "displayRating": 4.8,
         "ratingBucket": "4.5+", "ratingCount": 18, "topRated": True,
         "isCurrentlyOpen": True, "acceptingOrders": True, "estimatedPrepTime": 20,
         "minOrderAmount": 0, "isFeatured": True, "addressLine1": "Fixture Street",
         "operatingHours": [], "categories": [{"id": "cat-1", "name": "Essentials", "items": [
             {"id": "item-1", "name": "Rice", "description": "Local rice", "basePrice": 1200,
              "imageUrl": None, "unit": "bag", "isPopular": True, "fulfillment": "DELIVERY"}]}]}
ITEM = {"id": "item-1", "name": "Rice", "basePrice": "1200.00", "stockQuantity": 7,
        "lowStockThreshold": 10, "sku": "RICE-1", "isAvailable": True,
        "category": {"id": "cat-1", "name": "Essentials"}}
ORDER = {"id": "order-1", "orderNumber": "SW-1001", "status": "PENDING",
         "orderType": "STORE", "fulfillment": "DELIVERY", "placedAt": "2026-09-29T18:00:00Z",
         "totalAmount": "4200.00", "subtotalCustomer": "3600.00", "deliveryFee": "600.00",
         "items": [{"id": "line-1", "itemId": "item-1", "name": "Rice", "quantity": 3,
                    "totalCustomer": "3600.00"}],
         "customer": {"id": "customer-1", "firstName": "Pat", "lastName": "Fixture"},
         "vendor": {"id": "store-phone", "name": "Phone Fixture Market"}}

def fixture(path, cookie):
    p = urllib.parse.urlparse(path).path
    if p == "/api/v1/auth/me":
        if "swift_at=fixture-" not in cookie:
            return 401, {"error": "Synthetic session cookie required"}
        role = "mover" if "swift_at=fixture-mover" in cookie else "owner"
        return 200, {"data": {"user": {"id": role + "-fixture", "firstName": "Pat"}}}
    if p == "/api/v1/vendor/stores":
        return 200, {"data": {"stores": [STORE], "selectedId": "store-phone", "myRole": "OWNER"}}
    if p == "/api/v1/vendor/analytics/overview":
        return 200, {"data": {"vendor": {**STORE, "averageRating": 4.8, "totalRatings": 18,
                  "totalOrders": 120}, "pendingOrders": 1, "queueValue": 4200,
                  "today": {"orders": 4, "revenue": 16800},
                  "week": {"orders": 21, "revenue": 88200},
                  "month": {"orders": 90, "revenue": 378000}, "activeMenuItems": 17}}
    if p == "/api/v1/vendor/orders/order-1": return 200, {"data": ORDER}
    if p == "/api/v1/vendor/orders": return 200, {"data": [ORDER], "meta": {"total": 1, "page": 1, "totalPages": 1}}
    if p == "/api/v1/vendor/items/low-stock": return 200, {"data": [ITEM]}
    if p == "/api/v1/vendor/items": return 200, {"data": [ITEM]}
    if p == "/api/v1/vendor/categories": return 200, {"data": [{"id": "cat-1", "name": "Essentials"}]}
    if p == "/api/v1/vendor/hours": return 200, {"data": [{"dayOfWeek": d, "openTime": "08:00", "closeTime": "20:00", "isClosed": False} for d in range(7)]}
    if p == "/api/v1/vendor/profile": return 200, {"data": STORE}
    if p == "/api/v1/vendor/subscription": return 200, {"data": {"status": "ACTIVE", "weeklyRate": "4500.00"}}
    if p == "/api/v1/vendor/cash-settlements": return 200, {"data": {"summary": {"owed": 0, "count": 0}, "unsettled": [], "settled": []}}
    if p == "/api/v1/rider/profile": return 200, {"data": {"id": "rider-1", "firstName": "Pat"}}
    if p == "/api/v1/driver/profile": return 200, {"data": {"id": "driver-1", "firstName": "Pat", "mmgPayUrl": "https://pay.mmg.gy/fixture"}}
    if p == "/api/v1/rider/earnings/summary": return 200, {"data": {"today": {"total": 3500, "count": 2}, "thisWeek": {"total": 12500, "count": 7}, "thisMonth": {"total": 42000, "count": 21}, "allTime": {"total": 180000, "count": 83}}}
    if p == "/api/v1/driver/earnings": return 200, {"data": [], "totalEarnings": 20000, "meta": {"totalPages": 1}}
    if p == "/api/v1/rider/subscription" or p == "/api/v1/driver/subscription": return 200, {"data": {"status": "ACTIVE", "weeklyRate": "4500.00"}}
    if p == "/api/v1/rider/cash-settlements": return 200, {"data": {"summary": {"owed": 800, "count": 1}, "unsettled": [{"id": "settle-1", "amount": "800.00", "status": "PENDING", "vendor": {"name": "Phone Fixture Market"}, "order": {"orderNumber": "SW-1001"}}], "settled": []}}
    if p == "/api/v1/rider/orders": return 200, {"data": [{**ORDER, "deliveryFee": "800.00"}], "meta": {"totalPages": 1}}
    if p == "/api/v1/driver/rides": return 200, {"data": [{"id": "ride-1", "orderNumber": "SW-2001", "status": "COMPLETED", "taxiPickupAddress": "Market Street", "taxiDropoffAddress": "Camp Street", "taxiFareTotal": "2500.00", "tipAmount": "200.00"}], "meta": {"totalPages": 1}}
    if p == "/api/v1/verification/status": return 200, {"data": {"checklist": [], "documents": [], "missing": [], "roleVerified": True}}
    if p == "/api/v1/public/storefronts/phone-fixture": return 200, {"data": STORE}
    if p == "/api/v1/public/storefronts": return 200, {"data": [STORE]}
    if p == "/api/v1/customer/home": return 200, {"data": {"vendors": [STORE], "featuredVendors": [STORE], "categories": []}}
    if p == "/api/v1/customer/cart": return 200, {"data": None}
    if p == "/api/v1/market/depth": return 200, {"data": {"totalItems": 1, "totalVendors": 1}}
    if p == "/api/v1/market/items": return 200, {"data": {"items": [], "nextCursor": None}}
    if p == "/api/v1/discovery/categories": return 200, {"data": {"enabled": False, "categories": []}}
    if p == "/api/v1/auth/pricing": return 200, {"data": None}
    return 404, {"error": "No synthetic fixture for " + p}

class Mock(http.server.BaseHTTPRequestHandler):
    def do_GET(self): self.respond()
    def do_OPTIONS(self): self.respond()
    def respond(self):
        if self.command == "OPTIONS": status, body = 204, None
        else: status, body = fixture(self.path, self.headers.get("Cookie", ""))
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", WEB)
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Headers", "content-type,x-swift-client,x-vendor-id")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        if self.path.startswith("/api/v1/auth/me"):
            role = "mover" if "swift_at=fixture-mover" in self.headers.get("Cookie", "") else "owner"
            self.send_header("Set-Cookie", f"swift_at=fixture-{role}; HttpOnly; Secure; SameSite=None; Path=/")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)
    def log_message(self, *_): pass

class WS:
    def __init__(self, url):
        u = urllib.parse.urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=20)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: {WEB}\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head: head += self.sock.recv(4096)
        if b"HTTP/1.1 101" not in head: raise RuntimeError(head.decode(errors="replace"))
        self.pending = head.split(b"\r\n\r\n", 1)[1]
        self.serial = 0
        self.events = []
    def readn(self, n):
        while len(self.pending) < n: self.pending += self.sock.recv(max(4096, n-len(self.pending)))
        data, self.pending = self.pending[:n], self.pending[n:]
        return data
    def recv(self):
        while True:
            a, b = self.readn(2)
            size = b & 127
            if size == 126: size = struct.unpack('!H', self.readn(2))[0]
            if size == 127: size = struct.unpack('!Q', self.readn(8))[0]
            if b & 128: mask = self.readn(4)
            else: mask = None
            data = self.readn(size)
            if mask: data = bytes(v ^ mask[i % 4] for i, v in enumerate(data))
            if a & 15 == 9: self.send(data, opcode=10); continue
            if a & 15 == 1: return json.loads(data)
    def send(self, data, opcode=1):
        if not isinstance(data, bytes): data = json.dumps(data).encode()
        mask = os.urandom(4); n = len(data)
        header = bytes([128 | opcode, 128 | n]) if n < 126 else (bytes([128 | opcode, 128 | 126]) + struct.pack('!H', n) if n < 65536 else bytes([128 | opcode, 128 | 127]) + struct.pack('!Q', n))
        self.sock.sendall(header + mask + bytes(v ^ mask[i % 4] for i, v in enumerate(data)))
    def command(self, method, params=None):
        self.serial += 1; ident = self.serial
        self.send({"id": ident, "method": method, "params": params or {}})
        while True:
            message = self.recv()
            if message.get("method") == "Fetch.requestPaused": self.fulfill(message["params"])
            elif message.get("id") == ident:
                if "error" in message: raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})
            else: self.events.append(message)
    def fulfill(self, params):
        req = params["request"]
        url = urllib.parse.urlparse(req["url"])
        cookie = f"swift_at=fixture-{self.role}"
        request = urllib.request.Request(MOCK + url.path + ("?" + url.query if url.query else ""), headers={"Cookie": cookie}, method=req.get("method", "GET"))
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                status, data = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, data = error.code, error.read()
        self.serial += 1
        self.send({"id": self.serial, "method": "Fetch.fulfillRequest", "params": {
            "requestId": params["requestId"], "responseCode": status,
            "responseHeaders": [{"name": "Content-Type", "value": "application/json"},
                                {"name": "Set-Cookie", "value": f"swift_at=fixture-{self.role}; HttpOnly; Secure; SameSite=None; Path=/"},
                                {"name": "Access-Control-Allow-Origin", "value": WEB},
                                {"name": "Access-Control-Allow-Credentials", "value": "true"},
                                {"name": "Access-Control-Allow-Headers", "value": "content-type,x-swift-client,x-vendor-id"},
                                {"name": "Access-Control-Allow-Methods", "value": "GET,POST,PUT,DELETE,OPTIONS"}],
            "body": base64.b64encode(data).decode()}})

def main():
    import sys
    phase = sys.argv[1]
    assert phase in ("before", "after")
    os.makedirs(ROOT, exist_ok=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 3109), Mock)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    chrome = subprocess.Popen([CHROME, "--no-sandbox", "--single-process", "--no-zygote", "--disable-gpu", "--remote-allow-origins=*",
                               "--remote-debugging-port=3110", "--user-data-dir=/tmp/swift-phone-chrome-"+phase,
                               "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen("http://127.0.0.1:3110/json/version", timeout=1); break
            except Exception: time.sleep(.2)
        passed = 0; failures = []
        for route in ROUTES:
            for width, height, dpr in ((390, 844, 3), (360, 800, 2)):
                # Start blank so interception is installed before any app code runs.
                tab = json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:3110/json/new?about:blank", method="PUT")))
                ws = WS(tab["webSocketDebuggerUrl"])
                ws.role = "mover" if route.startswith("/portal") else "owner"
                ws.command("Page.enable"); ws.command("Network.enable")
                ws.command("Fetch.enable", {"patterns": [{"urlPattern": "https://api.swiftgy.com/*", "requestStage": "Request"}]})
                cookie_set = ws.command("Network.setCookie", {"name": "swift_at", "value": f"fixture-{ws.role}", "domain": "api.swiftgy.com", "path": "/", "secure": True, "httpOnly": True, "sameSite": "None"})
                assert cookie_set.get("success"), "Synthetic session cookie was not set"
                ws.command("Emulation.setDeviceMetricsOverride", {"width": width, "height": height, "deviceScaleFactor": dpr, "mobile": True})
                ws.command("Page.navigate", {"url": WEB+route})
                end = time.time()+12
                while time.time() < end:
                    result = ws.command("Runtime.evaluate", {"expression": "({ready:document.readyState, text:document.body?.innerText?.slice(0,200), scroll:document.documentElement.scrollWidth, width:innerWidth})", "returnByValue": True}).get("result", {}).get("value")
                    if not result: time.sleep(.2); continue
                    expected = "Swift Business" if route.startswith("/dashboard") else "Swift Earner" if route.startswith("/portal") else "Swift"
                    if result["ready"] == "complete" and expected in result["text"] and "Loading…" not in result["text"]: break
                    time.sleep(.2)
                time.sleep(.5)
                state = ws.command("Runtime.evaluate", {"expression": "({scroll:document.documentElement.scrollWidth,width:innerWidth,text:document.body.innerText.slice(0,180)})", "returnByValue": True})["result"]["value"]
                slug = route.strip("/").replace("/", "-") or "home"
                filename = f"{phase}-{slug}-{width}x{height}.png"
                image = ws.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})["data"]
                with open(os.path.join(ROOT, filename), "wb") as out: out.write(base64.b64decode(image))
                ok = state["scroll"] <= state["width"] and state["scroll"] <= width
                passed += ok
                if not ok: failures.append(filename)
                print(f"{filename}: scroll={state['scroll']} innerWidth={state['width']} deviceWidth={width} {'PASS' if ok else 'OVERFLOW'} {state['text'][:60]!r}", flush=True)
                if phase == "after":
                    extra = None
                    if route in ("/dashboard", "/how-it-works"):
                        ws.command("Runtime.evaluate", {"expression": "document.querySelector('button[aria-label=\"Open menu\"]')?.click()"})
                        extra = "dashboard-menu" if route == "/dashboard" else "how-it-works-menu"
                    elif route == "/dashboard/orders":
                        ws.command("Runtime.evaluate", {"expression": "Array.from(document.querySelectorAll('button')).find(b=>b.textContent?.includes('View later'))?.click()"})
                        for _ in range(20):
                            takeover = ws.command("Runtime.evaluate", {"expression": "Array.from(document.querySelectorAll('button')).some(b=>b.textContent?.includes('View later'))", "returnByValue": True})["result"].get("value")
                            if not takeover: break
                            time.sleep(.1)
                        ws.command("Runtime.evaluate", {"expression": "Array.from(document.querySelectorAll('button.w-full')).find(b=>b.textContent?.includes('#SW-1001'))?.click()"})
                        extra = "dashboard-orders-detail"
                    elif route == "/dashboard/settings":
                        ws.command("Runtime.evaluate", {"expression": "Array.from(document.querySelectorAll('h2')).find(h=>h.textContent?.includes('Operating hours'))?.scrollIntoView()"})
                        extra = "dashboard-settings-hours"
                    elif route == "/portal/history":
                        ws.command("Runtime.evaluate", {"expression": "Array.from(document.querySelectorAll('button')).find(b=>b.textContent?.trim().toLowerCase()==='rides')?.click()"})
                        for _ in range(30):
                            loaded = ws.command("Runtime.evaluate", {"expression": "document.body.innerText.includes('SW-2001')", "returnByValue": True})["result"].get("value")
                            if loaded: break
                            time.sleep(.1)
                        assert loaded, "Rides table did not load"
                        extra = "portal-history-rides"
                    if extra:
                        for _ in range(30):
                            detail = ws.command("Runtime.evaluate", {"expression": "({scroll:document.documentElement.scrollWidth,width:innerWidth,menu:!!document.querySelector('[role=dialog]'),detail:!!document.querySelector('button[aria-label=\"Close order detail\"]')})", "returnByValue": True})["result"]["value"]
                            if detail["menu"] if extra.endswith("menu") else detail["detail"]: break
                            time.sleep(.1)
                        time.sleep(.3)
                        assert detail["scroll"] <= detail["width"] and detail["scroll"] <= width, f"Overflow in {extra}"
                        visible = detail["menu"] if extra.endswith("menu") else detail["detail"] if extra.endswith("detail") else True
                        assert visible, f"Interactive view missing: {extra}"
                        name = f"after-{extra}-{width}x{height}.png"
                        shot = ws.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})["data"]
                        with open(os.path.join(ROOT, name), "wb") as out: out.write(base64.b64decode(shot))
                        print(f"{name}: interaction PASS", flush=True)
                ws.command("Page.close"); ws.sock.close()
        print(f"NO OVERFLOW: {passed}/{len(ROUTES)*2}; failures={failures}")
        if phase == "after" and failures: sys.exit(1)
    finally:
        chrome.terminate(); server.shutdown()

if __name__ == "__main__": main()
