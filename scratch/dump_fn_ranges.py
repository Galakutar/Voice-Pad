import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('app.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

funcs = [
    'initVoiceEngineUIEvents()',
    'initVoicemodCategoryTabs()',
    'renderVoicemodPresetCards(',
    'applyVoicemodPresetToUI(',
    'bindFxSliders(',
    'setFxParamsToUI(',
    'getFxParamsFromUI(',
    'openSlotVoiceModal(',
    'saveSlotVoiceModal()',
    'previewQuickVoiceEffect()',
    'openScrollModal(',
    'saveScrollModal()'
]

for fn in funcs:
    for i, line in enumerate(lines):
        if line.strip().startswith(fn) or line.strip().startswith('async ' + fn):
            print(f"=== {fn} at line {i+1} ===")
            for j in range(i, min(i+35, len(lines))):
                print(f"{j+1:4d}: {lines[j].rstrip()}")
            print()
            break
