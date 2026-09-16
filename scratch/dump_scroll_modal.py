import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('index.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()

for i in range(860, min(1040, len(lines))):
    print(f"{i+1:4d}: {lines[i].rstrip()}")
