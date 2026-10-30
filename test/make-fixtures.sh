#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="${SCRIPT_DIR}/fixtures"

mkdir -p "${FIXTURES_DIR}"

echo "Generating test fixtures in ${FIXTURES_DIR}..."

# (a) iPhone-style HEVC+AAC mov (mdat first, moov at end)
echo "Generating (a) iPhone-style HEVC+AAC mov..."
ffmpeg -y -v error -f lavfi -i testsrc=duration=10:size=640x360:rate=30 \
       -f lavfi -i sine=frequency=1000:duration=10 \
       -c:v libx265 -tag:v hvc1 -c:a aac \
       -movflags 0 \
       "${FIXTURES_DIR}/iphone-hevc-aac-reference.mov"

python3 -c "
with open('${FIXTURES_DIR}/iphone-hevc-aac-reference.mov', 'rb') as f:
    data = f.read()
# Truncate at 85% to cut off moov atom at the end and some mdat tail
cut = int(len(data) * 0.85)
with open('${FIXTURES_DIR}/iphone-hevc-aac-truncated.mov', 'wb') as f:
    f.write(data[:cut])
"

# (b) Android-style H.264+AAC mp4 (mdat first, moov at end)
echo "Generating (b) Android-style H.264+AAC mp4..."
ffmpeg -y -v error -f lavfi -i testsrc=duration=10:size=640x360:rate=30 \
       -f lavfi -i sine=frequency=1000:duration=10 \
       -c:v libx264 -pix_fmt yuv420p -c:a aac \
       -movflags 0 \
       "${FIXTURES_DIR}/android-h264-aac-reference.mp4"

python3 -c "
with open('${FIXTURES_DIR}/android-h264-aac-reference.mp4', 'rb') as f:
    data = f.read()
cut = int(len(data) * 0.85)
with open('${FIXTURES_DIR}/android-h264-aac-truncated.mp4', 'wb') as f:
    f.write(data[:cut])
"

# (c) H.264 with zero-filled tail (last 20% bytes replaced with zeros, moov gone)
echo "Generating (c) H.264 with zero-filled tail..."
ffmpeg -y -v error -f lavfi -i testsrc=duration=10:size=640x360:rate=30 \
       -f lavfi -i sine=frequency=1000:duration=10 \
       -c:v libx264 -pix_fmt yuv420p -c:a aac \
       -movflags 0 \
       "${FIXTURES_DIR}/h264-zerofill-reference.mp4"

python3 -c "
with open('${FIXTURES_DIR}/h264-zerofill-reference.mp4', 'rb') as f:
    data = bytearray(f.read())
cut = int(len(data) * 0.80)
for i in range(cut, len(data)):
    data[i] = 0
with open('${FIXTURES_DIR}/h264-zerofill-truncated.mp4', 'wb') as f:
    f.write(data)
"

# (d) H.264 video only
echo "Generating (d) H.264 video only..."
ffmpeg -y -v error -f lavfi -i testsrc=duration=10:size=640x360:rate=30 \
       -c:v libx264 -pix_fmt yuv420p -an \
       -movflags 0 \
       "${FIXTURES_DIR}/h264-video-only-reference.mp4"

python3 -c "
with open('${FIXTURES_DIR}/h264-video-only-reference.mp4', 'rb') as f:
    data = f.read()
cut = int(len(data) * 0.85)
with open('${FIXTURES_DIR}/h264-video-only-truncated.mp4', 'wb') as f:
    f.write(data[:cut])
"

echo "All fixtures generated successfully in ${FIXTURES_DIR}."
