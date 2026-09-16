import json
import time
import subprocess
import urllib.request
import websocket
import sys

sys.stdout.reconfigure(encoding='utf-8')

edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
edge_proc = subprocess.Popen([
    edge_path,
    "--headless=new",
    "--remote-debugging-port=9222",
    "--remote-allow-origins=*",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
])

time.sleep(2)

try:
    with urllib.request.urlopen("http://127.0.0.1:9222/json") as res:
        tabs = json.loads(res.read().decode('utf-8'))
    ws_url = tabs[0]["webSocketDebuggerUrl"]

    ws = websocket.create_connection(ws_url)

    msg_id = 1
    def send_cmd(method, params=None):
        global msg_id
        mid = msg_id
        msg_id += 1
        req = {"id": mid, "method": method, "params": params or {}}
        ws.send(json.dumps(req))
        while True:
            resp = json.loads(ws.recv())
            if "method" in resp:
                if resp["method"] == "Runtime.exceptionThrown":
                    print("[PAGE EXCEPTION]", json.dumps(resp["params"], ensure_ascii=False))
                elif resp["method"] == "Runtime.consoleAPICalled":
                    print("[PAGE CONSOLE]", resp["params"].get("type"), [a.get("value") for a in resp["params"].get("args", [])])
            if resp.get("id") == mid:
                return resp

    send_cmd("Runtime.enable")
    send_cmd("Page.enable")
    send_cmd("Log.enable")

    print("Navigating to http://127.0.0.1:8080/index.html...")
    nav_res = send_cmd("Page.navigate", {"url": "http://127.0.0.1:8080/index.html"})
    print("Nav response:", nav_res)

    # Listen for 3 seconds
    start_t = time.time()
    while time.time() - start_t < 3:
        try:
            ws.settimeout(1.0)
            msg = ws.recv()
            resp = json.loads(msg)
            if "method" in resp:
                if resp["method"] == "Runtime.exceptionThrown":
                    print("[PAGE EXCEPTION]", json.dumps(resp["params"], ensure_ascii=False))
                elif resp["method"] == "Runtime.consoleAPICalled":
                    print("[PAGE CONSOLE]", resp["params"].get("type"), [a.get("value") for a in resp["params"].get("args", [])])
        except Exception:
            break

finally:
    try:
        ws.close()
    except:
        pass
    edge_proc.terminate()
