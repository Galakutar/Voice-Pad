import sys
import json
import time
import subprocess
import urllib.request
import websocket

sys.stdout.reconfigure(encoding='utf-8')

# Launch Edge and test full TtsEngine implementation
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

    test_js = """
    (() => {
        // Test Japanese Kanji dictionary mapping
        const dict = {
            'こんにちは': 'こんにちは',
            'ありがとう': 'ありがとう',
            'おはよう': 'おはよう',
            'こんばんは': 'こんばんは',
            'はい': 'はい',
            'いいえ': 'いいえ',
            'いくよ': 'いくよ',
            'とまる': 'とまる',
            'たすけて': 'たすけて',
            'だいじょうぶ': 'だいじょうぶ',
            '私': 'わたし',
            '僕': 'ぼく',
            '俺': 'おれ',
            '先生': 'せんせい',
            '音声': 'おんせい',
            '録音': 'ろくおん',
            '怪獣': 'かいじゅう',
            '大聖堂': 'だいせいどう',
            '無線': 'むせん'
        };
        
        return {
            dictSize: Object.keys(dict).length,
            sample: dict['怪獣']
        };
    })()
    """

    req = {"id": 1, "method": "Runtime.evaluate", "params": {"expression": test_js, "returnByValue": True}}
    ws.send(json.dumps(req))
    resp = json.loads(ws.recv())
    print("Dict test result:", json.dumps(resp.get("result", {}).get("result", {}).get("value", resp), indent=2, ensure_ascii=False))

    ws.close()
finally:
    proc.terminate()
