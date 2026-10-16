# StreamTube

Virtual live TV channels for Stremio, built from any show or movie Stremio can find and played through your debrid service.

You build channels in a web UI that runs in a container on your network. Each channel has a guide that runs on the real clock. When you open a channel in Stremio, StreamTube finds a cached debrid stream for whatever is on and joins it at the current point. If *Modern Family* started 10 minutes ago, you start 10 minutes in.

- **Auto-fill pools.** Add shows, movies or wildcards to a channel. Any hour without a time slot gets filled from the pool. Shows play their episodes in order and remember where they stopped.
- **Time slots.** Weekly blocks such as "Weeknights 8:00 PM: Modern Family" or "Weekends 10 PM–1 AM: `Batman*` movies".
- **Wildcards.** `Star Trek*` adds The Next Generation, Voyager, Deep Space Nine, Discovery and the rest. You can untick any match. New titles that match are picked up each day.
- **English subtitles.** StreamTube looks for an English SDH track in the file, then the first English or unlabelled one. Text subtitles become a selectable caption track. Image subtitles (Blu-ray PGS) are burned into the picture. See [Subtitles](#subtitles).
- **Target resolution per channel.** The picker uses the exact resolution when it can. Otherwise it takes the next best: by default the nearest lower one, or optionally the nearest higher one. It only uses cached, direct debrid links, and it skips CAM/TS releases, Dolby Vision-only files (optional) and any keywords you list.
- **Live guide.** The web UI shows a ticking clock, a now-playing strip with progress bars and an EPG grid. Click any program to see which stream it would pick.
- **Other players.** Besides the Stremio addon you get an M3U playlist and an XMLTV guide for VLC, Kodi, TiviMate, Jellyfin, Plex and similar apps.

## How it works

```
Stremio ──/stream/tv/streamtube:3──▶ StreamTube ──▶ live HLS URL for channel 3
Stremio ──/live/3/index.m3u8───────▶ StreamTube
                                       │ guide says: Modern Family S01E05, 10:00 in
                                       │ ask your debrid addons (Torrentio/Comet/…)
                                       │ rank: cached + direct link + target resolution
                                       ▼
                         ffmpeg -ss 600 -readrate 1 -i <debrid link> -c:v copy → HLS
```

The Stremio stream protocol has no "start at" field, so StreamTube does the playout itself. A single ffmpeg process per channel reads the debrid file in real time from the scheduled offset. It remuxes the video without re-encoding and, by default, converts the audio to stereo AAC. The output is a rolling HLS playlist. When a program ends, the next one is joined to the same playlist with a discontinuity marker, so playback continues like a real channel. Everyone watching a channel shares that one ffmpeg process, so a channel uses one debrid connection no matter how many people watch. ffmpeg stops a minute after the last viewer leaves.

If a stream can't be played, the channel shows a "couldn't play" slate and retries instead of dropping out.

## Quick start

```bash
docker compose up -d --build
```

Open `http://<server-ip>:7000` from any device on your network.

1. **Settings → Debrid stream addons.** Paste the manifest URL of each stream addon you've set up with your debrid service, one per line. For example, Torrentio configured for Real-Debrid gives a URL like `https://torrentio.strem.fun/realdebrid=YOURKEY/manifest.json`. Comet, MediaFusion, AIOStreams, Jackettio and the TorBox addon also work. Your debrid key is already inside that URL. Click **Test addons** to confirm it returns cached links.
2. **Channels → New channel.** Name it, pick a target resolution, then add shows or movies to the auto-fill pool, or add a wildcard. Add time slots if you want fixed programming.
3. **Connect.** Copy the manifest URL, then in Stremio go to **Addons**, paste it into the search box and click **Install**. The one-click install button only appears for https addresses, because Stremio treats `stremio://` links as https. The channels show up under **Discover → TV → StreamTube**.

> Open the web UI through the server's LAN address, not `localhost`, before you copy the install link. Stremio on your TV needs an address it can reach. If you use a reverse proxy, set **Public URL** in Settings or `BASE_URL` in compose.

### Stremio clients and https

The desktop, Android and Android TV apps accept plain `http://` LAN addresses. **Stremio Web** (web.stremio.com) only loads `https` addons. To use StreamTube there, put it behind a reverse proxy with a certificate, such as Caddy, Nginx Proxy Manager or Tailscale Serve, and set the public URL.

## Configuration

| Variable | Default | |
|---|---|---|
| `TZ` | system | Timezone for the guide and time slots. You can also change it in Settings. |
| `PORT` | `7000` | |
| `BASE_URL` | *(from request)* | Public address used in stream and playlist URLs. |
| `ADMIN_PASSWORD` | *(none)* | Protects the web UI and API with HTTP basic auth (any user name). The addon, live and playlist endpoints stay open because Stremio and IPTV apps can't log in. |
| `DATA_DIR` | `/data` | SQLite database. |
| `HLS_DIR` | `/tmp/streamtube-hls` | Live segments, about 30 per active channel. tmpfs works well here. |
| `GUIDE_HOURS` | `48` | How far ahead the guide is planned. |
| `IDLE_SECONDS` | `60` | How long a channel keeps running after its last viewer leaves. |
| `SUBTITLE_BURN_PRESET` | `veryfast` | x264 preset used when burning in image subtitles. Faster presets use less CPU but give lower quality. |

## Scheduling details

- **Runtimes** come from Cinemeta, which gives a single per-series value such as "21 min". Real files differ by a minute or two, so each channel rounds runtimes up (5 minutes by default). If a file ends early, the next program starts early and catches back up to the guide. If a file runs long, it's cut at its scheduled end. Pick a larger rounding if you see endings get clipped.
- **Slots win.** Auto-fill items never run into a slot. Leftover time at the end of a block goes to the previous item if it's under 10 minutes. Otherwise a fitting item from the pool fills it. An episode that has to be cut short airs again next time instead of being skipped.
- **Episode memory** is per channel and per show, and is shared between the pool and slots. Specials (season 0) and unreleased episodes are skipped.
- Editing a channel replans everything after the program that's on now. What's airing keeps playing.

## Subtitles

When the file has embedded subtitles, StreamTube picks one track per program:

1. An English SDH track (flagged hearing-impaired, or titled SDH/CC), if there is one.
2. Otherwise, the first English or unlabelled track.

Forced-only tracks, which carry just the foreign-language lines, are skipped.

How the track reaches the player depends on its format and the channel's **English subtitles** setting:

| | Selectable track, or burned in for image subs *(default)* | Selectable track only | Off |
|---|---|---|---|
| Text (SRT, ASS, WebVTT) | Caption track, on by default | Caption track, on by default | None |
| Image (Blu-ray PGS, DVD) | Burned into the video | Skipped; a text track is used if there is one | None |

- **Caption tracks** cost almost nothing: ffmpeg turns them into WebVTT alongside the video. The channel's `index.m3u8` becomes an HLS master playlist with an "English" track marked default, and players can turn it off.
- **Burning in** means re-encoding the video with x264. Expect real 1080p content to keep a few CPU cores busy per channel. 4K sources are scaled to 1080p first. Lower `SUBTITLE_BURN_PRESET` (for example `superfast` or `ultrafast`) if a channel can't keep up. Set the channel to **Selectable track only** to never re-encode.
- Subtitle files that sit next to the video in a torrent can't be used. Debrid links point at the video file alone.
- Subtitles need ffmpeg 7.x. ffmpeg 8.0's real-time pacing slows to about half speed when a subtitle stream is included, so on 8.x StreamTube plays without subtitles and logs a warning. The Docker image ships 7.1.

## Outputs

| URL | |
|---|---|
| `/manifest.json` | Stremio addon |
| `/playlist.m3u` | M3U playlist for IPTV players |
| `/epg.xml` | XMLTV guide |
| `/live/<channel>/index.m3u8` | A channel's live stream |

The Stremio stream list also offers **Start over**, which redirects straight to the debrid link for the current program from the beginning. Use it if a player struggles with the live HLS stream.

## Limits worth knowing

- Video is copied as-is to keep CPU use near zero (except when burning in image subtitles). The device you watch on has to decode whatever the release uses, such as HEVC or 10-bit. To avoid a codec, add it to the channel's skip list, for example `HEVC, x265`.
- Joining mid-program starts at the nearest keyframe before the offset, usually within a couple of seconds.
- Uncached torrents are ignored, because live TV can't wait for a download. Keep a few addons configured to get the best cache coverage.

## Development

```bash
npm install
npm start          # http://localhost:7000, data in ./data
npm test
```

`test/mock-addon.js` is a fake debrid stream addon that serves one local video file with HTTP Range support, for testing playback without a debrid account:

```bash
SAMPLE_FILE=/path/to/video.mkv node test/mock-addon.js
```

Then add `http://localhost:7099/manifest.json` as a stream addon.

Requires Node 22.13 or newer (it uses the built-in `node:sqlite`) and ffmpeg 6.1 or newer on the PATH (older versions work but take longer to tune in). Use ffmpeg 7.x if you want subtitles; see [Subtitles](#subtitles).
