# Reel Rescue

**Fix a video that won't play because your phone or camera died mid-recording. In your browser, nothing uploaded.**

When a recording is cut off, the picture is still in the file, but the index that players use to find it (the `moov` box) was never written. Reel Rescue finds every frame again and writes a new index.

Live site: https://gfxroy.github.io/reel-rescue/

## How it works

1. Scans the damaged file in small slices (never loads it whole) and finds every video frame, re-syncing across interleaved sound data.
2. Takes the video settings (resolution, codec details) from the file itself, or, if your phone doesn't store them there, from a short good clip you recorded with the same phone and settings.
3. Works out frame order (B-frames) and timing, and writes a new MP4 that re-uses your original bytes.

## Honest limits

- **Most phones need a reference clip.** iPhones, Android phones and most cameras keep the video settings only in the index, so they are lost with it. Add any short good video from the same device and settings. Files that keep the settings inside the video data work without one.
- **Sound is not recovered yet.** The repaired video has the full picture and no audio (it tells you when sound was found but dropped).
- H.264 and HEVC (H.265) video in MP4/MOV. Other codecs are not supported.
- If the frame rate isn't stored anywhere, 30 fps is assumed and you get a warning.

## Tested

- H.264 and HEVC files with B-frames, cut off mid-recording (made with ffmpeg, moov lost, sound interleaved frame by frame): rebuilt frames are bit-exact with the original and ffmpeg decodes them with zero errors (`npm test`).
- Honest failure when settings are missing and no reference is given.

## Not tested yet

- Real files from iPhone, GoPro, DJI, Sony and other cameras, files over 4 GB, Safari/Firefox, and recordings whose sound chunks are very large.

## CLI

```
npm i && npm run build
node dist/cli.js broken.mp4 -r good-clip.mp4 -o fixed.mp4
```

## Related tools

[untrunc](https://github.com/ponchio/untrunc) (needs a build and command line), [recover_mp4](https://github.com/ponchio/untrunc/issues/294) discussions, paid upload-based repair sites. Reel Rescue's difference: it runs in a browser tab and your video never leaves the device.

MIT
