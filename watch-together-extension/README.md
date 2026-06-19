# Watch Together Extension

A prototype Chrome extension for watching OTT videos together without screen-sharing. Each person logs into the streaming service with their own subscription, then the extension syncs play, pause, seek, and current time while a built-in WebRTC voice chat carries only microphone audio.

## What this does

- Syncs the main `<video>` element on the page.
- Supports two-person rooms through a tiny signaling server.
- Uses WebRTC for low-latency microphone chat.
- Does not bypass DRM, subscriptions, geoblocks, or platform restrictions.
- Does not transmit movie/video/audio content.

## Project Layout

- `extension/` - Chrome Manifest V3 extension.
- `server/signaling-server.js` - local WebSocket signaling server.

## Start The Signaling Server

From this folder:

```bash
node server/signaling-server.js
```

The server listens at:

```text
ws://localhost:8787
```

For two people on different networks, deploy this server somewhere reachable with HTTPS/WSS, then put that `wss://...` URL in the extension panel.

## Load The Extension In Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `extension/` folder.

## Use It

1. Both people open the same movie or episode on the same streaming service.
2. Open the extension popup and click `Open watch panel`.
3. Enter the same room code and server URL.
4. Click `Join`.
5. Allow microphone access.
6. One person presses play. The other page should follow.

## Notes For Real Product Development

OTT sites differ heavily. A production version should add provider adapters for Netflix, Prime Video, Disney+, YouTube, etc., because each site has different player structure, navigation, and SPA behavior.

You will also need a hosted signaling service, TURN servers for reliable WebRTC connection through restrictive networks, auth, moderation, room invites, reconnect logic, and careful testing against each provider's terms of service.
