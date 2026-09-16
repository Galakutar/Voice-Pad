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
    "http://localhost:8080/index.html"
])

time.sleep(2)

try:
    with urllib.request.urlopen("http://localhost:9222/json") as res:
        tabs = json.loads(res.read().decode('utf-8'))
    ws_url = tabs[0]["webSocketDebuggerUrl"]

    ws = websocket.create_connection(ws_url)

    msg_counter = 1
    def send_cmd(method, params=None):
        global msg_counter
        msg_id = msg_counter
        msg_counter += 1
        req = {"id": msg_id, "method": method, "params": params or {}}
        ws.send(json.dumps(req))
        while True:
            resp = json.loads(ws.recv())
            if "method" in resp:
                if resp["method"] == "Runtime.exceptionThrown":
                    print("[CDP EXCEPTION]", resp["params"])
                elif resp["method"] == "Runtime.consoleAPICalled":
                    print("[CDP CONSOLE]", resp["params"]["type"], [a.get("value") for a in resp["params"]["args"]])
            if resp.get("id") == msg_id:
                return resp

    send_cmd("Runtime.enable")
    send_cmd("Page.enable")
    send_cmd("Page.navigate", {"url": "http://localhost:8080/index.html"})

    # Wait for load
    loaded = False
    start_t = time.time()
    while time.time() - start_t < 5:
        resp = json.loads(ws.recv())
        if "method" in resp:
            if resp["method"] == "Runtime.exceptionThrown":
                print("[CDP EXCEPTION]", resp["params"])
            elif resp["method"] == "Runtime.consoleAPICalled":
                print("[CDP CONSOLE]", resp["params"]["type"], [a.get("value") for a in resp["params"]["args"]])
            elif resp["method"] == "Page.loadEventFired":
                loaded = True
                break

    time.sleep(1)

    eval_res = send_cmd("Runtime.evaluate", {
        "expression": """
        (() => {
            const presets = VoiceEngine.getVoicemodPresets();
            const cards = document.querySelectorAll('.vm-card');
            return {
                title: document.title,
                version: APP_VERSION,
                presetsCount: presets.length,
                firstPreset: presets[0].name,
                hasEQ: typeof VoiceEngine.apply3BandEQ === 'function',
                hasChorus: typeof VoiceEngine.applyChorus === 'function',
                hasRadio: typeof VoiceEngine.applyRadioNoise === 'function',
                hasTrash: typeof VoiceEngine.applyTrashMic === 'function'
            };
        })()
        """,
        "returnByValue": True
    })
    print("\n--- FINAL TEST EVALUATION ---")
    print(json.dumps(eval_res, indent=2, ensure_ascii=False))

    ws.close()
finally:
    edge_proc.terminate()
