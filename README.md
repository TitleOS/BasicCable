# StreamTube

Virtual live TV channels for Stremio, built from any show or movie Stremio can find and played through your debrid service.

You build channels in a web UI that runs in a container on your network. Each channel has a guide that runs on the real clock. When you open a channel in Stremio, StreamTube finds a cached debrid stream for whatever is on and joins it at the current point. If *Modern Family* started 10 minutes ago, you start 10 minutes in.

- **Auto-fill pools.** Add shows, movies or wildcards to a channel. Any hour without a time slot gets filled from the pool. Shows play their episodes in order and remember where they stopped.
- **Time slots.** Weekly blocks such as "Weeknights 8:00 PM: Modern Family" or "Weekends 10 PM–1 AM: `Batman*` movies".
- **Wildcards.** `Star Trek*` adds The Next Generation, Voyager, Deep Space Nine, Discovery and the rest. You can untick any match. New titles that match are picked up each day.
- **English subtitles.** StreamTube looks for an English SDH track in the file, then the first English or unlabelled one. Text subtitles become a selectable caption track. Image subtitles (Blu-ray PGS) are burned into the picture. See [Subtitles](#subtitles).
- **Target resolution per channel.** The picker uses the exact resolution when it can. Otherwise it takes the next best: by default the nearest lower one, or optionally the nearest higher one. It only uses cached, direct debrid links, and it skips CAM/TS releases, Dolby Vision-only files (optional) and any keywords you list.
- **Preferred releases.** Releases whose names contain a preferred word win over everything else, resolution included. The default is `Superfan`, so The Office plays its extended Superfan episodes when an addon has them.
- **Streams prepared ahead.** About 10 minutes before each program airs, StreamTube asks your addons, picks the file and checks it. Tuning in then only has to start the video. See [Fast tune-in](#fast-tune-in).
- **Backup and restore.** Export your channels, pools, wildcards, slots and each show's progress as one JSON file, and import it into another install. See [Backup and restore](#backup-and-restore).
- **One stream per device.** Each viewer IP watches one channel at a time, so channel surfing doesn't leave old channels running. See [Stream cap](#stream-cap).
- **Manage it by asking.** A built-in MCP server lets Claude (or any MCP client) create and edit channels from plain requests like "make a Saturday-morning cartoons channel". See [MCP server](#mcp-server).
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

The live playlist is built to ride out a flaky debrid connection without errors:

- **Cushion.** Segments are 6 seconds long, and players start about 3 segments behind live, which gives roughly 18 seconds of buffer. The playlist lists about 90 seconds, so a player that stalls carries on from where it was instead of being pushed out of the window (an error followed by a jump ahead).
- **Hand-overs.** If the next program's stream isn't ready when one ends, short "Up next" filler segments keep the playlist moving, so players don't give up and drop back to their menus.
- **Continuous timestamps.** Each program's timestamps continue from the last one, so players that ignore discontinuity markers (mpv, which Stremio desktop uses) never see time run backwards at an episode change.
- **Drop-outs.** If a link drops part-way through an episode, playback resumes from the last second delivered. Nothing is skipped; the end of the episode is trimmed instead. ffmpeg sometimes exits "normally" when a link dies, so StreamTube only counts an episode as finished if it reached the end of the file or its slot.
- **Bad files.** A file that fails as soon as it starts gets one retry with the video re-encoded. If that fails too, the next release is tried, and if every release fails, another episode takes its place. If nothing works at all, a "couldn't play" slate is shown and StreamTube keeps retrying.

Failed segment and playlist requests are logged as warnings, so if a player hits a problem, it shows up in the logs.

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
| `TRUST_PROXY` | *(off)* | Set to `1` when StreamTube sits behind your own reverse proxy, so viewer IPs are read from `X-Forwarded-For`. Without it, every viewer looks like the proxy. |
| `SUBTITLE_BURN_PRESET` | `veryfast` | x264 preset used when burning in image subtitles. Faster presets use less CPU but give lower quality. |

## Scheduling details

- **Runtimes** come from Cinemeta, which gives a single per-series value such as "21 min". Real files differ by a minute or two, so each channel rounds runtimes up (5 minutes by default). If a file ends early, the next program starts early and catches back up to the guide. If a file runs long, it's cut at its scheduled end. Pick a larger rounding if you see endings get clipped. With stream prefetching on, files that run longer, such as Superfan cuts, are caught before they air and given their full length.
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

## Backup and restore

**Settings → Backup & restore** downloads a `streamtube-backup-<date>.json` file. It holds:

- Every channel and its options.
- The auto-fill pool, including wildcards and any matches you unticked.
- Time slots.
- Where each show has got to.

Settings are left out unless you tick **Include settings**, because they contain your debrid addon URLs and keys.

To restore, choose the file on another install (or the same one) and click **Import**:

- **Imported channels are added** next to existing ones. If a channel number is already in use, the channel gets the next free number.
- **Replace existing channels** deletes the current channels first.
- **Also restore settings from the file** applies the settings, if the backup has them.

Guides are rebuilt in the background after an import. A bad file is rejected before anything changes, with a message naming the channel at fault.

The same thing is available from the API: `GET /api/backup` (add `?settings=1` to include settings) and `POST /api/restore` with `{"backup": <file contents>, "replace": false, "includeSettings": false}`.

## Fast tune-in

Without help, opening a channel waits for every stream addon to answer, then checks the chosen file. With slow addons that adds several seconds. So once a minute StreamTube prepares, on every enabled channel, whatever is on now and whatever starts in the next **Prepare streams ahead** minutes (Settings, default 10):

1. It asks the addons for streams and ranks them.
2. It checks the top file is reachable and real (not a debrid "downloading" placeholder).
3. It keeps that choice for up to 2 hours.

Opening a channel then starts ffmpeg straight away. The log line for the program says `stream was prepared ahead`. In testing with addons that took 5 seconds to answer, tune-in dropped from 6.2s to 1.0s.

Preparing also reveals the file's real length. If it's more than a minute longer than its guide slot, the slot is stretched to fit (rounded up per channel), and the rest of the guide moves back. A Superfan episode in a 25-minute slot gets 30 or 35 minutes instead of being cut off. Only programs that haven't started yet are changed. If a stretched program runs into a time slot, that slot starts late by the same amount.

### Episodes with nothing playable

Sometimes no addon has a usable copy: every result is uncached, torrent-only or filtered out. When that happens, StreamTube puts something else in that spot, chosen by the channel's usual rules:

- **In-order channels** play the next episode, and the show continues from there.
- **Random channels** pick another random episode.
- **Pools with several titles** may move on to a different show.

An upcoming program is swapped before it airs. One already on air is cut off and the replacement starts straight away. The replacement is checked immediately too, so a run of missing episodes is skipped in one go. Tuning in does the same, even with prefetching off, so you get the next playable episode instead of a "couldn't play" screen.

A skipped episode isn't scheduled again for 6 hours, after which it gets another chance, since debrid caches change. If no addon answers at all (an outage rather than a missing episode), nothing is skipped and StreamTube retries later.

Lookups are spaced 3–30 seconds apart at random, so a batch of channels never hits your addons all at once and trips their rate limits. Tuning in never waits for this spacing. If a program isn't prepared yet, opening it looks it up immediately.

The cost is one addon lookup and one file check per program, made even when nobody is watching. Set **Prepare streams ahead** to 0 to turn it off.

## Stream cap

With **One stream per viewer IP** on (Settings, on by default), each device watches one channel at a time:

- Opening a channel releases the one that device was watching before.
- If nobody else is on that old channel, it stops straight away, along with its ffmpeg process and debrid connection. Otherwise it would keep running for a minute after you leave.
- If an old player keeps asking for the channel you left, it gets an error instead of restarting it.
- Other devices are unaffected. Two TVs can watch two channels, or the same one.

The cap covers the live channel streams. **Start over** links go straight to your debrid service, so StreamTube doesn't see them.

If StreamTube is behind a reverse proxy, set `TRUST_PROXY=1`. Otherwise every viewer shares the proxy's IP and counts as one device.

## MCP server

StreamTube includes an [MCP](https://modelcontextprotocol.io) server at `/mcp` (Streamable HTTP). With it, an assistant such as Claude Code can manage everything from plain-language requests:

> Make a channel called Saturday Cartoons with Animaniacs, Pinky and the Brain and Batman: The Animated Series, 720p, and put Pokémon on Saturdays 8 to 10am.
>
> Set every channel to skip REMUX releases.
>
> What's on channel 4, and why is it only 480p?
>
> Skip whatever's on Adult Swim.

**Connect Claude Code:**

```bash
claude mcp add --transport http streamtube http://<server>:7000/mcp
```

If you set `ADMIN_PASSWORD`, add `--header "Authorization: Bearer <password>"` (Basic auth works too). This repo's `.mcp.json` registers the server for Claude Code sessions opened here. It reads the address from `STREAMTUBE_MCP_URL` and the password from `STREAMTUBE_TOKEN` if they're set.

| Area | Tools |
|---|---|
| Look around | `streamtube_list_channels`, `streamtube_get_channel`, `streamtube_get_guide`, `streamtube_whats_on`, `streamtube_server_status` |
| Channels | `streamtube_create_channel` (settings, pool and slots in one call), `streamtube_update_channel`, `streamtube_bulk_update_channels`, `streamtube_delete_channel` |
| Pool & slots | `streamtube_add_to_pool`, `streamtube_remove_from_pool`, `streamtube_set_wildcard_exclusions`, `streamtube_add_slots`, `streamtube_remove_slots` |
| Titles | `streamtube_search_titles`, `streamtube_preview_wildcard` |
| Playback | `streamtube_skip_current`, `streamtube_check_streams`, `streamtube_rebuild_guide` |
| Addons & settings | `streamtube_get_settings` (addon keys hidden unless asked), `streamtube_add_stream_addon`, `streamtube_remove_stream_addon`, `streamtube_test_stream_addons`, `streamtube_update_settings` |
| Backups | `streamtube_export_backup`, `streamtube_import_backup` |

The tools take things the way people say them:

- **Channels:** a number or a name ("4", "adult swim").
- **Titles:** a name, optionally with `movie:` / `show:` or a year ("Heat (1995)"), an IMDb id, or a wildcard ("Star Trek*").
- **Days:** "weeknights", "mon-fri", "sat, sun".
- **Times and lengths:** "8pm", "20:00", "1h30m".

Every change reports exactly what each title matched, along with the runner-up matches. A name with no close match is refused with suggestions instead of being guessed. Browser requests from other websites are rejected.

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
SAMPLE_FILE=/path/to/video.mkv node test/mock-addon.js   # MOCK_DELAY_MS=5000 makes it answer slowly, like a real addon
```

Then add `http://localhost:7099/manifest.json` as a stream addon.

`test/mcp-smoke.js` drives every MCP tool against a running server. It creates a test channel and deletes it again, and needs internet access for Cinemeta:

```bash
MCP_URL=http://localhost:7000/mcp ADDON_URL=http://localhost:7099/manifest.json node test/mcp-smoke.js
```

Requires Node 22.13 or newer (it uses the built-in `node:sqlite`) and ffmpeg 6.1 or newer on the PATH (older versions work but take longer to tune in). Use ffmpeg 7.x if you want subtitles; see [Subtitles](#subtitles).
