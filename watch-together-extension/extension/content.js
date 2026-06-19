(() => {
  if (window.__watchTogetherLoaded) return;
  window.__watchTogetherLoaded = true;

  const state = {
    socket: null,
    peer: null,
    localStream: null,
    remoteAudio: null,
    clientId: null,
    connected: false,
    applyingRemoteSync: false,
    lastSyncAt: 0,
    settings: {
      serverUrl: "ws://localhost:8787",
      room: "movie-night",
      name: "Friend",
    },
  };

  let root;
  let panel;
  let statusEl;
  let muteButton;
  let syncButton;
  let disconnectButton;

  function findVideo() {
    const videos = [...document.querySelectorAll("video")];
    return videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0] || null;
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function send(message) {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify(message));
    }
  }

  function broadcastSync(reason) {
    const video = findVideo();
    if (!video || state.applyingRemoteSync) return;

    const now = Date.now();
    if (reason === "timeupdate" && now - state.lastSyncAt < 2500) return;
    state.lastSyncAt = now;

    send({
      type: "sync",
      reason,
      paused: video.paused,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      pageUrl: location.href,
      sentAt: now,
    });
  }

  async function applySync(message) {
    const video = findVideo();
    if (!video) {
      setStatus("No video found on this page.");
      return;
    }

    state.applyingRemoteSync = true;
    const transitSeconds = Math.max(0, (Date.now() - Number(message.sentAt || Date.now())) / 1000);
    const targetTime = message.paused ? message.currentTime : message.currentTime + transitSeconds;

    if (Math.abs(video.currentTime - targetTime) > 0.75) {
      video.currentTime = targetTime;
    }

    if (video.playbackRate !== message.playbackRate) {
      video.playbackRate = message.playbackRate || 1;
    }

    try {
      if (message.paused && !video.paused) video.pause();
      if (!message.paused && video.paused) await video.play();
    } catch {
      setStatus("Click the page once, then sync again.");
    } finally {
      setTimeout(() => {
        state.applyingRemoteSync = false;
      }, 300);
    }
  }

  function attachVideoListeners() {
    const video = findVideo();
    if (!video || video.dataset.watchTogetherAttached) return;
    video.dataset.watchTogetherAttached = "true";
    ["play", "pause", "seeked", "ratechange"].forEach((eventName) => {
      video.addEventListener(eventName, () => broadcastSync(eventName), true);
    });
    video.addEventListener("timeupdate", () => broadcastSync("timeupdate"), true);
    setStatus("Video detected. Join a room when ready.");
  }

  async function ensureMedia() {
    if (state.localStream) return state.localStream;
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    return state.localStream;
  }

  async function createPeer(isInitiator) {
    if (state.peer) state.peer.close();

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    state.peer = peer;

    const stream = await ensureMedia();
    for (const track of stream.getTracks()) peer.addTrack(track, stream);

    peer.onicecandidate = (event) => {
      if (event.candidate) send({ type: "signal", signal: { candidate: event.candidate } });
    };

    peer.ontrack = (event) => {
      if (!state.remoteAudio) {
        state.remoteAudio = document.createElement("audio");
        state.remoteAudio.autoplay = true;
        state.remoteAudio.style.display = "none";
        document.documentElement.appendChild(state.remoteAudio);
      }
      state.remoteAudio.srcObject = event.streams[0];
      setStatus("Voice connected. Playback sync is active.");
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") setStatus("Connected.");
      if (peer.connectionState === "failed") setStatus("Voice connection failed. Rejoin the room.");
    };

    if (isInitiator) {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      send({ type: "signal", signal: peer.localDescription });
    }
  }

  async function handleSignal(signal) {
    if (!state.peer) await createPeer(false);

    if (signal.type === "offer") {
      await state.peer.setRemoteDescription(signal);
      const answer = await state.peer.createAnswer();
      await state.peer.setLocalDescription(answer);
      send({ type: "signal", signal: state.peer.localDescription });
      return;
    }

    if (signal.type === "answer") {
      await state.peer.setRemoteDescription(signal);
      return;
    }

    if (signal.candidate) {
      await state.peer.addIceCandidate(signal.candidate);
    }
  }

  async function joinRoom() {
    const serverUrl = panel.querySelector("#wt-server").value.trim();
    const room = panel.querySelector("#wt-room").value.trim();
    const name = panel.querySelector("#wt-name").value.trim();

    state.settings = { serverUrl, room, name };
    chrome.storage.local.set({ watchTogetherSettings: state.settings });

    if (state.socket) state.socket.close();
    setStatus("Requesting microphone...");
    await ensureMedia();

    const url = new URL(serverUrl);
    url.searchParams.set("room", room);
    url.searchParams.set("name", name);

    state.socket = new WebSocket(url.toString());
    state.socket.addEventListener("open", () => setStatus("Joined room. Waiting for peer..."));
    state.socket.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "joined") {
        state.clientId = message.id;
        state.connected = true;
        if (message.initiator) await createPeer(true);
      }
      if (message.type === "peer-joined") {
        setStatus("Peer joined. Connecting voice...");
      }
      if (message.type === "peer-left") {
        setStatus("Peer left the room.");
      }
      if (message.type === "signal") {
        await handleSignal(message.signal);
      }
      if (message.type === "sync") {
        await applySync(message);
      }
      if (message.type === "error") {
        setStatus(message.message);
      }
    });
    state.socket.addEventListener("close", () => setStatus("Disconnected."));
    state.socket.addEventListener("error", () => setStatus("Cannot reach signaling server."));
  }

  function disconnectSession(message = "Disconnected.") {
    state.connected = false;
    state.clientId = null;

    if (state.socket) {
      state.socket.close();
      state.socket = null;
    }

    if (state.peer) {
      state.peer.close();
      state.peer = null;
    }

    if (state.remoteAudio) {
      state.remoteAudio.srcObject = null;
      state.remoteAudio.remove();
      state.remoteAudio = null;
    }

    if (state.localStream) {
      for (const track of state.localStream.getTracks()) track.stop();
      state.localStream = null;
    }

    if (muteButton) muteButton.textContent = "Mute mic";
    setStatus(message);
  }

  function toggleMute() {
    if (!state.localStream) return;
    const muted = state.localStream.getAudioTracks().some((track) => track.enabled);
    for (const track of state.localStream.getAudioTracks()) track.enabled = !muted;
    muteButton.textContent = muted ? "Unmute mic" : "Mute mic";
  }

  function injectPanel() {
    if (root) {
      panel.hidden = false;
      return;
    }

    root = document.createElement("div");
    root.id = "watch-together-root";
    document.documentElement.appendChild(root);
    const shadow = root.attachShadow({ mode: "open" });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: fixed;
          z-index: 2147483647;
          right: 18px;
          bottom: 18px;
          width: min(340px, calc(100vw - 28px));
          border: 1px solid #d6dde5;
          border-radius: 8px;
          color: #101820;
          background: #ffffff;
          box-shadow: 0 18px 45px rgba(0, 0, 0, .22);
          font: 14px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 12px 14px;
          border-bottom: 1px solid #edf0f3;
        }
        h2 {
          margin: 0;
          font-size: 15px;
          line-height: 1.2;
        }
        .close {
          width: 28px;
          height: 28px;
          border: 0;
          border-radius: 6px;
          color: #344054;
          background: #eef2f6;
          cursor: pointer;
        }
        .body {
          display: grid;
          gap: 10px;
          padding: 12px 14px 14px;
        }
        label {
          display: grid;
          gap: 4px;
          color: #344054;
          font-size: 12px;
          font-weight: 700;
        }
        input {
          width: 100%;
          min-height: 34px;
          border: 1px solid #ccd5df;
          border-radius: 6px;
          padding: 6px 8px;
          color: #101820;
          background: #fff;
          font: 13px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .actions {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 8px;
        }
        .disconnect {
          grid-column: 1 / -1;
          background: #b42318;
        }
        .disconnect:hover {
          background: #912018;
        }
        button {
          min-height: 34px;
          border: 0;
          border-radius: 6px;
          padding: 6px 8px;
          color: #fff;
          background: #0f766e;
          font: 700 13px/1.1 system-ui, sans-serif;
          cursor: pointer;
        }
        button.secondary {
          color: #17212b;
          background: #e8edf2;
        }
        .status {
          min-height: 18px;
          color: #4b5b6b;
          font-size: 12px;
        }
      </style>
      <section class="panel" aria-label="Watch Together panel">
        <header>
          <h2>Watch Together</h2>
          <button class="close" title="Close" type="button">x</button>
        </header>
        <div class="body">
          <label>Server URL<input id="wt-server" autocomplete="off"></label>
          <label>Room code<input id="wt-room" autocomplete="off"></label>
          <label>Your name<input id="wt-name" autocomplete="off"></label>
          <div class="actions">
            <button id="wt-join" type="button">Join</button>
            <button id="wt-sync" class="secondary" type="button">Sync now</button>
            <button id="wt-mute" class="secondary" type="button">Mute mic</button>
            <button id="wt-disconnect" class="disconnect" type="button">Disconnect</button>
          </div>
          <div class="status" id="wt-status">Looking for video...</div>
        </div>
      </section>
    `;

    panel = shadow.querySelector(".panel");
    statusEl = shadow.querySelector("#wt-status");
    muteButton = shadow.querySelector("#wt-mute");
    syncButton = shadow.querySelector("#wt-sync");
    disconnectButton = shadow.querySelector("#wt-disconnect");

    shadow.querySelector("#wt-server").value = state.settings.serverUrl;
    shadow.querySelector("#wt-room").value = state.settings.room;
    shadow.querySelector("#wt-name").value = state.settings.name;
    shadow.querySelector(".close").addEventListener("click", () => {
      panel.hidden = true;
    });
    shadow.querySelector("#wt-join").addEventListener("click", () => {
      joinRoom().catch((error) => setStatus(error.message));
    });
    muteButton.addEventListener("click", toggleMute);
    syncButton.addEventListener("click", () => broadcastSync("manual"));
    disconnectButton.addEventListener("click", () => disconnectSession());

    attachVideoListeners();
  }

  chrome.storage.local.get("watchTogetherSettings", (result) => {
    if (result.watchTogetherSettings) state.settings = result.watchTogetherSettings;
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "watch-together:open-panel") injectPanel();
  });

  const observer = new MutationObserver(attachVideoListeners);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  attachVideoListeners();
})();
