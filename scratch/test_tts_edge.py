import json
import time
import subprocess
import urllib.request
import websocket
import sys

sys.stdout.reconfigure(encoding='utf-8')

# Launch Edge and test TtsEngine prototype
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
    with urllib.request.urlopen("http://localhost:9222/json") as res:
        tabs = json.loads(res.read().decode('utf-8'))
    target_tab = next((t for t in tabs if "8080" in t.get("url", "")), tabs[0])
    ws_url = target_tab["webSocketDebuggerUrl"]

    ws = websocket.create_connection(ws_url, timeout=5)

    prototype_js = """
    (() => {
        const sampleRate = 44100;
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        
        // Simple test of synthesis
        const dur = 1.0;
        const buffer = ctx.createBuffer(1, Math.floor(sampleRate * dur), sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.5;
        }
        
        // Test VoiceEngine.processFull on this buffer
        const voiceParams = { pitchSemitones: -5, formantRatio: 0.5, roughness: 40 };
        const envParams = { reverb: 50, filter: 30, modulation: 20 };
        const eqParams = { bass: 6, mid: 2, treble: -3 };
        const specialParams = { chorus: 60, radioNoise: 50, trash: 0 };
        
        const processed = VoiceEngine.processFull(buffer, ctx, voiceParams, envParams, 1.0, eqParams, specialParams);
        
        return {
            originalLen: buffer.length,
            processedLen: processed.length,
            sampleRate: processed.sampleRate,
            firstSamples: Array.from(processed.getChannelData(0).slice(1000, 1010))
        };
    })()
    """

    req = {"id": 1, "method": "Runtime.evaluate", "params": {"expression": prototype_js, "returnByValue": True}}
    ws.send(json.dumps(req))
    resp = json.loads(ws.recv())
    print("Prototype test result:", json.dumps(resp.get("result", {}).get("result", {}).get("value", resp), indent=2, ensure_ascii=False))

    ws.close()
finally:
    proc.terminate()
