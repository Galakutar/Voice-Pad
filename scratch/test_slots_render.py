import urllib.request
import subprocess
import time

def test():
    print("Testing Voice Pad with wait...")
    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    command = [edge_path, "--headless", "--disable-gpu", "--run-all-compositor-stages-before-draw", "--virtual-time-budget=2000", "--dump-dom", "http://127.0.0.1:8080/index.html"]
    res = subprocess.run(command, capture_output=True, encoding='utf-8', errors='replace', timeout=10)
    dom = res.stdout
    print("Rendered DOM length:", len(dom))
    print("Slot cards count:", dom.count('class="pad-card'))
    assert dom.count('class="pad-card') >= 8
    print("SLOT CARDS VERIFIED!")

if __name__ == "__main__":
    test()
