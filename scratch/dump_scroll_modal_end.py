import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('index.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()

for i in range(1039, min(1100, len(lines))):
    print(f"{i+1:4d}: {lines[i].rstrip()}")
