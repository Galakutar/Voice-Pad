import json
import time
import subprocess
import urllib.request
import websocket
import sys

sys.stdout.reconfigure(encoding='utf-8')

# Launch Edge in headless mode with debugging port
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
    # Get WebSocket Debugger URL
    with urllib.request.urlopen("http://localhost:9222/json") as res:
        tabs = json.loads(res.read().decode('utf-8'))
    ws_url = tabs[0]["webSocketDebuggerUrl"]
    print("[OK] Connected to Edge CDP:", ws_url)

    ws = websocket.create_connection(ws_url)

    def send_cmd(method, params=None):
        msg_id = int(time.time() * 1000) % 1000000
        req = {"id": msg_id, "method": method, "params": params or {}}
        ws.send(json.dumps(req))
        while True:
            resp = json.loads(ws.recv())
            if resp.get("id") == msg_id:
                return resp

    send_cmd("Runtime.enable")
    send_cmd("Page.enable")

    # Evaluate JS tests
    test_script = """
    (() => {
        const results = [];
        // Test 1: App version
        results.push({ test: 'APP_VERSION', val: APP_VERSION });

        // Test 2: VoiceEngine presets
        const presets = VoiceEngine.getVoicemodPresets();
        results.push({ test: 'presetsCount', val: presets.length });
        results.push({ test: 'presetSample', val: presets.slice(0, 3).map(p => ({ id: p.id, name: p.name, icon: p.icon })) });

        // Test 3: DSP methods exist
        results.push({ test: 'has3BandEQ', val: typeof VoiceEngine.apply3BandEQ === 'function' });
        results.push({ test: 'hasChorus', val: typeof VoiceEngine.applyChorus === 'function' });
        results.push({ test: 'hasRadioNoise', val: typeof VoiceEngine.applyRadioNoise === 'function' });
        results.push({ test: 'hasTrashMic', val: typeof VoiceEngine.applyTrashMic === 'function' });
        results.push({ test: 'hasProcessFull', val: typeof VoiceEngine.processFull === 'function' });

        // Test 4: Check if app instance is initialized
        results.push({ test: 'hasAppInstance', val: !!window.voicePadApp });

        // Test 5: Check Voicemod cards in slot modal
        if (window.voicePadApp) {
            window.voicePadApp.renderVoicemodPresetCards('slot-voicemod-grid', 'all', 'slot');
            const slotCards = document.querySelectorAll('#slot-voicemod-grid .vm-card');
            results.push({ test: 'slotPresetCardsRendered', val: slotCards.length });

            // Test 6: Quick Voice modal cards
            window.voicePadApp.renderVoicemodPresetCards('quick-voice-voicemod-grid', 'all', 'quick-voice');
            const qvCards = document.querySelectorAll('#quick-voice-voicemod-grid .vm-card');
            results.push({ test: 'qvPresetCardsRendered', val: qvCards.length });

            // Test 7: Scroll modal cards
            window.voicePadApp.renderVoicemodPresetCards('scroll-voicemod-grid', 'all', 'scroll');
            const scrollCards = document.querySelectorAll('#scroll-voicemod-grid .vm-card');
            results.push({ test: 'scrollPresetCardsRendered', val: scrollCards.length });

            // Test 8: Sliders check
            const sliders = [
                'quick-voice-eq-bass-slider', 'quick-voice-eq-mid-slider', 'quick-voice-eq-treble-slider',
                'quick-voice-special-chorus-slider', 'quick-voice-special-radio-slider', 'quick-voice-special-trash-slider',
                'slot-eq-bass-slider', 'slot-special-chorus-slider', 'scroll-eq-bass-slider', 'scroll-special-chorus-slider'
            ];
            const foundSliders = sliders.filter(id => !!document.getElementById(id));
            results.push({ test: 'slidersFound', val: `${foundSliders.length}/${sliders.length}` });

            // Test 9: Preset application simulation
            const walkiePreset = presets.find(p => p.id === 'walkie_talkie');
            if (walkiePreset) {
                window.voicePadApp.applyVoicemodPresetToUI(walkiePreset, 'quick-voice');
                const radioVal = document.getElementById('quick-voice-special-radio-slider')?.value;
                const eqBassVal = document.getElementById('quick-voice-eq-bass-slider')?.value;
                results.push({ test: 'walkieTalkiePresetApplied', val: { radioVal, eqBassVal } });
            }
        }

        return results;
    })()
    """

    eval_res = send_cmd("Runtime.evaluate", {"expression": test_script, "returnByValue": True})
    print("\n--- Test Results in Real Edge Browser ---")
    if "result" in eval_res and "value" in eval_res["result"]:
        for item in eval_res["result"]["value"]:
            print(f"[{item['test']}]: {item['val']}")
    else:
        print("Eval error:", eval_res)

    ws.close()
finally:
    edge_proc.terminate()
