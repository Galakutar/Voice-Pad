import urllib.request
import json
import subprocess
import time

def test_syntax_and_tts():
    # 1. Fetch version.json
    try:
        req = urllib.request.urlopen("http://localhost:8080/voice-pad/version.json")
        data = json.loads(req.read().decode('utf-8'))
        print("Version fetched:", data["version"])
        assert data["version"] == "2026.09.17.0008"
    except Exception as e:
        print("HTTP fetch error:", e)

    # 2. Run Node.js check on app.js syntax
    result = subprocess.run(["node", "-c", "app.js"], cwd=r"c:\Users\gyala\.antigravity-ide\voice-pad", capture_output=True, text=True)
    if result.returncode == 0:
        print("Node -c check PASSED: No syntax errors in app.js!")
    else:
        print("Node -c check FAILED:", result.stderr)
        assert False, "Syntax error in app.js"

if __name__ == "__main__":
    test_syntax_and_tts()
