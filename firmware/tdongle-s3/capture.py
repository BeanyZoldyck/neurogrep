#!/usr/bin/env python3
"""Reset the dongle into normal boot, ask for one frame ('d'), save the dump."""
import sys
import time

import serial

port, out = sys.argv[1], sys.argv[2]

s = serial.Serial()
s.port = port
s.baudrate = 115200
s.timeout = 0.5
s.open()

if len(sys.argv) > 3 and sys.argv[3] == "noreset":
    time.sleep(0.2)
else:
    # USB-Serial/JTAG maps RTS->EN, DTR->GPIO0. Both asserted = download mode,
    # so force a clean reset into the application.
    s.dtr = False
    s.rts = True
    time.sleep(0.15)
    s.rts = False
    time.sleep(0.3)
s.reset_input_buffer()

buf = b""
s.write(b"d")

deadline = time.time() + 30
while time.time() < deadline:
    chunk = s.read(8192)
    if chunk:
        buf += chunk
        if b"FEND" in buf:
            break

open(out, "wb").write(buf)
print(f"captured {len(buf)} bytes, FEND={b"FEND" in buf}")
s.close()
