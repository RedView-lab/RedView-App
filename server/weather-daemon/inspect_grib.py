#!/usr/bin/env python3
import struct
import sys

with open("/tmp/sample.grib2", "rb") as f:
    data = f.read()

print("File size:", len(data), "Header:", data[:4])
total_len = struct.unpack(">Q", data[8:16])[0]
print("Total GRIB len:", total_len)

pos = 16
while pos < total_len - 4:
    sec_len = struct.unpack(">I", data[pos:pos+4])[0]
    sec_id = data[pos+4]
    print(f"Section {sec_id} at {pos}: len {sec_len}")
    if sec_id == 3:
        # Grid definition
        template = struct.unpack(">H", data[pos+12:pos+14])[0]
        nx = struct.unpack(">I", data[pos+30:pos+34])[0]
        ny = struct.unpack(">I", data[pos+34:pos+38])[0]
        print(f"  Grid template {template}, nx={nx}, ny={ny}")
    elif sec_id == 5:
        # Data representation
        num_points = struct.unpack(">I", data[pos+5:pos+9])[0]
        template = struct.unpack(">H", data[pos+9:pos+11])[0]
        print(f"  DRS template {template}, num points {num_points}")
    elif sec_id == 7:
        print(f"  Section 7 data bytes: {sec_len - 5}")
    pos += sec_len
