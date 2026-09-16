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
    "--autoplay-policy=no-user-gesture-required",
    "http://127.0.0.1:8080/index.html"
])

time.sleep(2)

try:
    with urllib.request.urlopen("http://127.0.0.1:9222/json") as res:
        tabs = json.loads(res.read().decode('utf-8'))
    
    page_tab = next((t for t in tabs if t.get('type') == 'page'), tabs[0])
    ws_url = page_tab["webSocketDebuggerUrl"]
    print(f"[OK] Connected to Edge CDP page target ({page_tab.get('title')}):", ws_url)

    ws = websocket.create_connection(ws_url)

    msg_counter = 1
    def send_cmd(method, params=None):
        global msg_counter
        mid = msg_counter
        msg_counter += 1
        req = {"id": mid, "method": method, "params": params or {}}
        ws.send(json.dumps(req))
        while True:
            resp = json.loads(ws.recv())
            if resp.get("id") == mid:
                return resp

    send_cmd("Runtime.enable")
    send_cmd("Page.enable")

    # Poll until ready
    for _ in range(20):
        time.sleep(0.3)
        chk = send_cmd("Runtime.evaluate", {
            "expression": "document.readyState === 'complete' && typeof window.app !== 'undefined'",
            "returnByValue": True
        })
        if chk.get("result", {}).get("result", {}).get("value") is True:
            break

    test_script = """
    (async () => {
        const results = [];
        const app = window.app;
        const ctx = AudioUnlocker.getContext();
        await AudioUnlocker.unlock();

        // 1. Check VoiceEngine Full DSP on recorded WAV audio
        const sr = ctx.sampleRate || 44100;
        const rawBuf = ctx.createBuffer(1, sr * 2, sr); // 2 sec
        const rawData = rawBuf.getChannelData(0);
        for (let i = 0; i < rawData.length; i++) {
            rawData[i] = Math.sin(2 * Math.PI * 440 * (i / sr)) * 0.4;
        }

        // Apply Cathedral reverb + Underwater ambient + Pitch shift
        const vParams = { pitchSemitones: 4, formantRatio: 1.2, roughness: 0 };
        const eParams = { reverb: 70, filter: 30, modulation: 0, ambientSound: 'underwater', ambientVolume: 40 };
        const eqParams = { bass: 6, mid: 0, treble: -3 };
        const specialParams = { chorus: 20, radioNoise: 0, trashMic: 0 };

        const processedBuf = VoiceEngine.processFull(rawBuf, ctx, vParams, eParams, 1.0, eqParams, specialParams);

        results.push({ test: 'processedDuration', val: processedBuf.duration });
        results.push({ test: 'processedChannels', val: processedBuf.numberOfChannels });
        results.push({ test: 'hasTailReverb', val: processedBuf.duration > rawBuf.duration });

        // 2. Test playSlot on recorded WAV slot
        const wavBlob = AudioUtils.audioBufferToWav(rawBuf);
        const slot = app.slots[0];
        slot.audioBlob = wavBlob;
        slot.duration = 2.0;
        slot.envParams = eParams;
        slot.voiceParams = vParams;

        await app.playSlot(slot.id);
        const isPlaying = app.activeSources.has(slot.id);
        results.push({ test: 'isPlaying', val: isPlaying });

        // Stop slot
        app.stopSlot(slot.id);
        const isStopped = !app.activeSources.has(slot.id);
        results.push({ test: 'isStopped', val: isStopped });

        return results;
    })()
    """

    res = send_cmd("Runtime.evaluate", {
        "expression": test_script,
        "awaitPromise": True,
        "returnByValue": True
    })

    print("\n--- Playback & DSP Verification Results ---")
    print("Full response:", json.dumps(res, ensure_ascii=False, indent=2))
    vals = res.get("result", {}).get("result", {}).get("value", [])
    for v in vals:
        print(f"[{v['test']}] => {json.dumps(v['val'], ensure_ascii=False)}")

    dur = next(item for item in vals if item["test"] == "processedDuration")["val"]
    assert dur >= 2.0, f"Processed duration too short: {dur}"

    has_tail = next(item for item in vals if item["test"] == "hasTailReverb")["val"]
    assert has_tail is True, "Tail reverb should extend duration"

    is_playing = next(item for item in vals if item["test"] == "isPlaying")["val"]
    assert is_playing is True, "Slot should be playing"

    is_stopped = next(item for item in vals if item["test"] == "isStopped")["val"]
    assert is_stopped is True, "Slot should be stopped"

    print("\n🎉 ALL PLAYBACK & DSP FLOW TESTS PASSED SUCCESSFULLY!")

finally:
    try:
        ws.close()
    except:
        pass
    edge_proc.terminate()
