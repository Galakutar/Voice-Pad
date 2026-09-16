with open(r'c:\Users\gyala\.antigravity-ide\voice-pad\app.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()
for idx, line in enumerate(lines):
    if 'openSettingsModal' in line or 'closeSettingsModal' in line:
        print(f"Line {idx+1}: {line.strip()}")
