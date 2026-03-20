# Spicetify Jam Round Robin

A [Spicetify](https://spicetify.app/) extension that enforces fair, round-robin queue ordering in Spotify Jam sessions. Each participant gets a turn before anyone goes twice.

## How it works

- Detects active Jam sessions via Spotify's `SocialConnectAPI`
- Reads the queue DOM to identify which user queued each track (via avatar matching)
- Automatically reorders the queue so participants alternate fairly
- Tracks play counts per member — if someone misses a turn, they get catch-up priority when they queue next
- Polls every 3 seconds and reorders on queue changes or song changes

## Install

1. Install [Spicetify](https://spicetify.app/docs/getting-started)
2. Copy `jam-roundrobin.js` to your Spicetify extensions folder:
   ```bash
   cp jam-roundrobin.js ~/.config/spicetify/Extensions/
   ```
3. Register and apply:
   ```bash
   spicetify config extensions jam-roundrobin.js
   spicetify apply
   ```

## Usage

The extension auto-starts when Spotify loads. It activates when a Jam session with 2+ members is detected.

- **Toggle**: Profile menu → "Jam Round Robin"
- **Notifications**: Shows whose turn it is and when the queue is reordered

### Debug console

Open Spotify DevTools (`Cmd+Opt+I` / `Ctrl+Shift+I`) and use:

```js
__jamRR.getState()          // session members, play counts, currently playing
__jamRR.getQueue()          // annotated queue with ownership
__jamRR.enforceRoundRobin() // manually trigger reorder
```

## How fairness works

1. The currently playing track's owner is identified
2. Members are sorted by fewest tracks played (catch-up priority), then by rotation order after the current player
3. Queued tracks are interleaved following this priority
4. If a member has no tracks queued, their turn is skipped — but they get priority once they add something

## Requirements

- Spotify desktop app
- [Spicetify](https://spicetify.app/) v2.30+
- An active Spotify Jam session

## License

MIT
