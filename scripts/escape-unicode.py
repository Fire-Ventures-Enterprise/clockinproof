#!/usr/bin/env python3
import sys, os
worker_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'dist', '_worker.js')
if not os.path.exists(worker_path):
    sys.exit(0)
with open(worker_path, 'r', encoding='utf-8') as f:
    content = f.read()
def escape_char(ch):
    code = ord(ch)
    if code < 0x10000:
        return f'\\u{code:04X}'
    code -= 0x10000
    return f'\\u{0xD800+(code>>10):04X}\\u{0xDC00+(code&0x3FF):04X}'
fixed = ''.join(escape_char(c) if ord(c) > 127 else c for c in content)
count = sum(1 for c in content if ord(c) > 127)
with open(worker_path, 'w', encoding='utf-8') as f:
    f.write(fixed)
print(f"escape-unicode: escaped {count} non-ASCII chars")
