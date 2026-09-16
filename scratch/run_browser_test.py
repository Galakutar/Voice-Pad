import sys
import json
import time
import subprocess
import urllib.request
import websocket
sys.stdout.reconfigure(encoding='utf-8')

print("1. Starting Edge...", flush=True)
edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
proc = subprocess.Popen([
    edge_path,
    "--headless=new",
    "--remote-debugging-port=9222",
    "--remote-allow-origins=*",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "http://127.0.0.1:8080/index.html"
])

time.sleep(3)

try:
    print("2. Listing CDP tabs...", flush=True)
    with urllib.request.urlopen("http://localhost:9222/json") as res:
        tabs = json.loads(res.read().decode('utf-8'))
    print("Tabs found:", json.dumps(tabs, indent=2), flush=True)
    
    # Pick the tab with url containing 8080
    target_tab = next((t for t in tabs if "8080" in t.get("url", "")), tabs[0])
    ws_url = target_tab["webSocketDebuggerUrl"]
    print("3. Connecting to WebSocket URL:", ws_url, flush=True)

    ws = websocket.create_connection(ws_url, timeout=5)
    
    # Navigate explicitly and wait
    ws.send(json.dumps({"id": 1, "method": "Page.enable"}))
    ws.send(json.dumps({"id": 2, "method": "Page.navigate", "params": {"url": "http://127.0.0.1:8080/index.html"}}))
    time.sleep(2)
    
    # Request DOM & JS state
    req = {
        "id": 3,
        "method": "Runtime.evaluate",
        "params": {
            "expression": """
            (() => {
                const presets = VoiceEngine.getVoicemodPresets();
                const app = window.app;
                
                // Trigger quick voice modal preset rendering
                if (app) {
                    app.renderVoicemodPresetCards('quick-voice-voicemod-grid', 'all', 'quick-voice');
                    app.renderVoicemodPresetCards('slot-voicemod-grid', 'all', 'slot');
                    app.renderVoicemodPresetCards('scroll-voicemod-grid', 'all', 'scroll');
                }
                
                const qvCards = document.querySelectorAll('#quick-voice-voicemod-grid .vm-card');
                const slotCards = document.querySelectorAll('#slot-voicemod-grid .vm-card');
                const scrollCards = document.querySelectorAll('#scroll-voicemod-grid .vm-card');
                
                return {
                    currentUrl: window.location.href,
                    title: document.title,
                    version: APP_VERSION,
                    presetsCount: presets.length,
                    firstPreset: presets[0].name,
                    firstPresetIcon: presets[0].icon,
                    firstPresetCategory: presets[0].category,
                    qvCardsCount: qvCards.length,
                    slotCardsCount: slotCards.length,
                    scrollCardsCount: scrollCards.length,
                    eqBassSlider: !!document.getElementById('quick-voice-eq-bass-slider'),
                    chorusSlider: !!document.getElementById('quick-voice-special-chorus-slider'),
                    radioSlider: !!document.getElementById('quick-voice-special-radio-slider'),
                    trashSlider: !!document.getElementById('quick-voice-special-trash-slider'),
                    scrollPreviewBtn: !!document.getElementById('btn-scroll-fx-preview')
                };
            })()
            """,
            "returnByValue": True
        }
    }
    ws.send(json.dumps(req))
    
    while True:
        resp = json.loads(ws.recv())
        if resp.get("id") == 3:
            print("4. Result:", json.dumps(resp.get("result", {}).get("result", {}).get("value", resp), indent=2, ensure_ascii=False), flush=True)
            break
            
    ws.close()
finally:
    proc.terminate()
    print("5. Done.", flush=True)
