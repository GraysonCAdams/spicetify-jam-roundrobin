// NAME: Jam Round Robin
// AUTHOR: Grayson Adams
// DESCRIPTION: Round-robin queue contributions in Spotify Jam so each person gets a turn
// VERSION: 0.3.0

/// <reference path="../../.spicetify/globals.d.ts" />

(function JamRoundRobin() {
  const LOG_PREFIX = "[JamRR]";
  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  // Wait for Spicetify APIs
  if (
    !Spicetify?.Player ||
    !Spicetify?.showNotification ||
    !Spicetify?.Platform?.SocialConnectAPI ||
    !Spicetify?.Platform?.PlayerAPI
  ) {
    setTimeout(JamRoundRobin, 500);
    return;
  }

  log("Extension loaded!");

  const SocialConnect = Spicetify.Platform.SocialConnectAPI;
  const PlayerAPI = Spicetify.Platform.PlayerAPI;

  // ── State ──
  let sessionMembers = []; // { id, displayName, imageUrl } from session API
  let isActive = false;
  let roundRobinEnabled = true; // controlled by UI toggle
  let pollHandle = null;
  let lastQueueUids = ""; // stringified uid list for change detection
  let isReordering = false; // prevent re-entrancy
  // Track how many songs each member has had played (for fairness catch-up)
  const playedCount = {}; // memberId → number of tracks played
  let toggleInjected = false; // track whether the DOM toggle exists

  // ── UI Toggle ──
  // Inject a toggle next to the "Let others change what's playing" toggle
  function injectToggle() {
    // Don't duplicate
    if (document.getElementById("jamRoundRobinToggle")) {
      toggleInjected = true;
      return;
    }

    // Find the existing queueOnlyMode toggle's parent container
    const existingToggle = document.getElementById("queueOnlyMode");
    if (!existingToggle) {
      toggleInjected = false;
      return;
    }

    // Walk up to the wrapper div that contains the label+toggle pair
    const existingWrapper = existingToggle.closest(
      "div.hgZr0mFedRYZODXAt6gQ"
    )?.parentElement;
    if (!existingWrapper) {
      // Fallback: try parent of the label
      const label = existingToggle.closest("label.hgZr0mFedRYZODXAt6gQ");
      if (!label?.parentElement) return;
    }

    const container = existingToggle.closest(
      "label.hgZr0mFedRYZODXAt6gQ"
    )?.parentElement?.parentElement;
    if (!container) return;

    // Clone the structure of the existing toggle
    const wrapper = document.createElement("div");
    wrapper.id = "jamRoundRobinWrapper";
    wrapper.innerHTML = `
      <label for="jamRoundRobinToggle" class="hgZr0mFedRYZODXAt6gQ">
        <span class="e-91000-text encore-text-body-small encore-internal-color-text-subdued" data-encore-id="text">
          Auto-rotate queue (round robin)
        </span>
        <label class="x-toggle-wrapper">
          <input id="jamRoundRobinToggle" class="x-toggle-input" type="checkbox" ${roundRobinEnabled ? 'checked=""' : ""}>
          <span class="x-toggle-indicatorWrapper hHbxQzEOQZOm1TWz5Tqg">
            <span class="x-toggle-indicator hHbxQzEOQZOm1TWz5Tqg"></span>
          </span>
        </label>
      </label>
      <p id="jamRoundRobinOrder" style="
        margin: 4px 0 0 0;
        padding: 0;
        font-size: 11px;
        color: var(--text-subdued, #a7a7a7);
        line-height: 1.3;
        display: ${roundRobinEnabled ? "block" : "none"};
      "></p>
    `;

    container.appendChild(wrapper);

    const input = document.getElementById("jamRoundRobinToggle");
    if (input) {
      input.addEventListener("change", () => {
        roundRobinEnabled = input.checked;
        log("Round-robin toggled:", roundRobinEnabled ? "ON" : "OFF");
        Spicetify.showNotification(
          roundRobinEnabled
            ? "Queue auto-rotate: ON"
            : "Queue auto-rotate: OFF"
        );
        const orderEl = document.getElementById("jamRoundRobinOrder");
        if (orderEl) {
          orderEl.style.display = roundRobinEnabled ? "block" : "none";
          if (roundRobinEnabled) updateOrderText();
        }
      });
    }

    toggleInjected = true;
    log("UI toggle injected.");
  }

  // ── Update order text below toggle ──
  function initials(name) {
    if (!name) return "?";
    return name
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  }

  async function updateOrderText() {
    const el = document.getElementById("jamRoundRobinOrder");
    if (!el || !roundRobinEnabled) return;

    if (sessionMembers.length < 2) {
      el.textContent = "";
      return;
    }

    // Build the rotation order using the same priority logic as enforceRoundRobin
    const currentOwner = getCurrentlyPlayingOwner();
    const currentIdx = currentOwner
      ? sessionMembers.findIndex((m) => m.id === currentOwner.id)
      : -1;

    const ordered = sessionMembers
      .map((m, i) => ({
        member: m,
        played: playedCount[m.id] || 0,
        rotationOrder:
          currentIdx >= 0
            ? ((i - currentIdx - 1 + sessionMembers.length) %
                sessionMembers.length)
            : i,
      }))
      .sort((a, b) => {
        if (a.played !== b.played) return a.played - b.played;
        return a.rotationOrder - b.rotationOrder;
      })
      .map((p) => initials(p.member.displayName));

    el.textContent = ordered.join(" → ");
  }

  // ── Session Members (from API) ──
  async function fetchSessionMembers() {
    try {
      const session = await SocialConnect.getCurrentSession();
      if (!session?.sessionMembers?.length) return [];
      return session.sessionMembers.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        imageUrl: m.imageUrl,
      }));
    } catch (e) {
      return [];
    }
  }

  // ── Avatar URL matching ──
  function avatarSrcMatchesMember(domSrc, memberUrl) {
    if (!domSrc || !memberUrl) return false;
    // Spotify CDN: /image/ab67757000XXXXXX<24-char-unique-id>
    const spotifyAvatarId = (url) => {
      const m = url.match(/ab67757[0-9a-f]{9}([0-9a-f]{24})/);
      return m ? m[1] : null;
    };
    const h1 = spotifyAvatarId(domSrc);
    const h2 = spotifyAvatarId(memberUrl);
    if (h1 && h2) return h1 === h2;

    // Facebook CDN: stable photo ID across size variants
    const fbId = (url) => {
      const m = url.match(/(\d{10,}_\d{10,}_\d{10,})/);
      return m ? m[1] : null;
    };
    const f1 = fbId(domSrc);
    const f2 = fbId(memberUrl);
    if (f1 && f2) return f1 === f2;

    // Fallback: substring match on path
    const short = (url) =>
      url.replace(/[?#].*/, "").replace(/https?:\/\//, "");
    return (
      short(domSrc).includes(short(memberUrl)) ||
      short(memberUrl).includes(short(domSrc))
    );
  }

  // ── Extract queue ownership from DOM ──
  // DOM rows in "Next in queue" have avatar images we can match to members
  function extractDOMQueue() {
    const queueList = document.querySelector(
      "ul[aria-label='Next in queue']"
    );
    if (!queueList) return [];
    const items = queueList.querySelectorAll("[data-flip-id^='q']");
    const tracks = [];
    items.forEach((item) => {
      const flipId = item.getAttribute("data-flip-id");
      const titleEl = item.querySelector("[id^='listrow-title']");
      const avatarImg = item.querySelector("img.main-avatar-image");
      const trackName = titleEl?.textContent || "?";
      const avatarSrc = avatarImg?.src || "";

      let owner = null;
      for (const member of sessionMembers) {
        if (avatarSrcMatchesMember(avatarSrc, member.imageUrl)) {
          owner = member;
          break;
        }
      }

      tracks.push({
        flipId,
        trackName,
        avatarSrc,
        owner: owner ? owner.displayName : null,
        ownerId: owner ? owner.id : null,
      });
    });
    return tracks;
  }

  // ── Get annotated queue: merge DOM ownership with API data ──
  async function getAnnotatedQueue() {
    const domTracks = extractDOMQueue();
    let apiQueue;
    try {
      apiQueue = await PlayerAPI.getQueue();
    } catch (e) {
      warn("Failed to get API queue:", e.message);
      return domTracks;
    }

    // Queued tracks live in apiQueue.queued (not nextUp)
    const apiQueued = apiQueue.queued || [];

    // Match by position — DOM and API queued lists are in the same order
    for (let i = 0; i < domTracks.length && i < apiQueued.length; i++) {
      domTracks[i].uri = apiQueued[i].uri;
      domTracks[i].uid = apiQueued[i].uid;
      domTracks[i].apiName = apiQueued[i].name;
    }

    return domTracks;
  }

  // ── Determine who should be next based on who's currently playing ──
  // The currently playing track's owner tells us who just "used their turn".
  // The next track should belong to the next member in rotation.
  function getCurrentlyPlayingOwner() {
    // Check the "Now playing" section DOM for an avatar
    // The now-playing row also has an avatar image if it was queued by someone
    const nowPlayingSection = document.querySelector(
      "ul[aria-label='Now playing']"
    );
    if (!nowPlayingSection) return null;
    const avatarImg = nowPlayingSection.querySelector("img.main-avatar-image");
    if (!avatarImg) return null; // no avatar = from playlist, not a user queue

    const src = avatarImg.src || "";
    for (const member of sessionMembers) {
      if (avatarSrcMatchesMember(src, member.imageUrl)) {
        return member;
      }
    }
    return null;
  }

  // ── Reorder queue to enforce round-robin ──
  async function enforceRoundRobin() {
    if (isReordering) return;
    isReordering = true;

    try {
      const annotated = await getAnnotatedQueue();
      if (annotated.length < 2) {
        log(
          "Queue has",
          annotated.length,
          "track(s) — nothing to reorder."
        );
        return;
      }

      log(
        "Current queue:",
        annotated
          .map((t) => `${t.trackName} (${t.owner || "?"})`)
          .join(" → ")
      );

      // ── Fairness-based ordering ──
      // Members who have played fewer tracks get priority (catch-up).
      // Among equal counts, use natural rotation from who's currently playing.
      const currentOwner = getCurrentlyPlayingOwner();

      // Group queued tracks by owner
      const byOwner = {};
      for (const t of annotated) {
        const key = t.ownerId || "__unknown__";
        if (!byOwner[key]) byOwner[key] = [];
        byOwner[key].push(t);
      }

      // Sort members by who is most "behind" (fewest played), ties broken
      // by rotation order after the currently playing member
      const currentIdx = currentOwner
        ? sessionMembers.findIndex((m) => m.id === currentOwner.id)
        : -1;

      const memberPriority = sessionMembers
        .map((m, i) => ({
          member: m,
          played: playedCount[m.id] || 0,
          // Rotation distance from current player (next in line = 1)
          rotationOrder:
            currentIdx >= 0
              ? ((i - currentIdx - 1 + sessionMembers.length) %
                  sessionMembers.length)
              : i,
        }))
        .sort((a, b) => {
          // Fewest plays first (catch-up priority)
          if (a.played !== b.played) return a.played - b.played;
          // Then by rotation order
          return a.rotationOrder - b.rotationOrder;
        });

      log(
        "Priority order:",
        memberPriority.map(
          (p) =>
            `${p.member.displayName} (played: ${p.played}, rot: ${p.rotationOrder})`
        )
      );

      // Interleave tracks: cycle through members in priority order,
      // picking one track at a time from each
      const reordered = [];
      let safety = annotated.length + sessionMembers.length * 2;
      while (reordered.length < annotated.length && safety-- > 0) {
        let added = false;
        for (const p of memberPriority) {
          const tracks = byOwner[p.member.id];
          if (tracks && tracks.length > 0) {
            reordered.push(tracks.shift());
            added = true;
          }
        }
        if (!added) break;
      }

      // Append any unknown-owner tracks
      if (byOwner.__unknown__?.length) {
        reordered.push(...byOwner.__unknown__);
      }

      // Check if order actually changed
      const currentOrder = annotated.map((t) => t.uid).join(",");
      const newOrder = reordered.map((t) => t.uid).join(",");
      if (currentOrder === newOrder) {
        log("Queue already in correct round-robin order.");
        return;
      }

      log(
        "Reordering to:",
        reordered
          .map((t) => `${t.trackName} (${t.owner || "?"})`)
          .join(" → ")
      );

      // Reorder using PlayerAPI.reorderQueue([{uid}], {before: {uid}})
      // Move each track into place from back to front
      const withUids = reordered.filter((t) => t.uid);
      if (withUids.length >= 2) {
        try {
          // Move tracks into position: place each track before the one
          // that should follow it, working from the end backwards
          for (let i = withUids.length - 2; i >= 0; i--) {
            await PlayerAPI.reorderQueue(
              [{ uid: withUids[i].uid }],
              { before: { uid: withUids[i + 1].uid } }
            );
          }
          log("Queue reordered successfully!");
          Spicetify.showNotification("Queue reordered for fair turns!");
        } catch (e) {
          warn("reorderQueue failed:", e.message);
        }
      }
    } finally {
      isReordering = false;
    }
  }

  // ── Polling ──
  async function poll() {
    // Update session members
    const members = await fetchSessionMembers();
    const changed =
      members.length !== sessionMembers.length ||
      members.some((m, i) => m.id !== sessionMembers[i]?.id);

    if (changed) {
      sessionMembers = members;
      log(
        "Session members:",
        sessionMembers.map((m) => m.displayName)
      );

      if (sessionMembers.length > 1 && !isActive) {
        isActive = true;
        log("Jam detected! Round-robin activated.");
        Spicetify.showNotification(
          `Jam Round Robin active! ${sessionMembers.length} members.`
        );
      } else if (sessionMembers.length <= 1 && isActive) {
        isActive = false;
        log("Not enough members — deactivated.");
      }
    }

    // Inject toggle if the Jam panel is open but our toggle is missing
    if (!document.getElementById("jamRoundRobinToggle")) {
      toggleInjected = false;
      injectToggle();
    }

    // Check for queue changes and enforce round-robin
    if (isActive && roundRobinEnabled) {
      let apiQueue;
      try {
        apiQueue = await PlayerAPI.getQueue();
      } catch (e) {
        return;
      }
      const queuedUids = (apiQueue.queued || [])
        .map((t) => t.uid)
        .join(",");

      if (queuedUids !== lastQueueUids) {
        log("Queue changed, checking round-robin order...");
        lastQueueUids = queuedUids;
        await enforceRoundRobin();
        // Update snapshot after potential reorder
        try {
          const q = await PlayerAPI.getQueue();
          lastQueueUids = (q.queued || []).map((t) => t.uid).join(",");
        } catch (e) {}
      }

      // Keep the order text fresh
      updateOrderText();
    }
  }

  // ── Song Change Handler ──
  function onSongChange() {
    if (!isActive || !roundRobinEnabled) return;
    const data = Spicetify.Player.data;
    if (!data?.item) return;
    const track = data.item.metadata;
    log(`Now playing: "${track.title}" by ${track.artist_name}`);

    // Track who just played — check "Now playing" DOM for avatar
    // (runs after song change, so "now playing" is the new track)
    setTimeout(() => {
      const owner = getCurrentlyPlayingOwner();
      if (owner) {
        playedCount[owner.id] = (playedCount[owner.id] || 0) + 1;
        log(
          `Credited ${owner.displayName} (total: ${playedCount[owner.id]})`,
          "Counts:",
          sessionMembers.map(
            (m) => `${m.displayName}: ${playedCount[m.id] || 0}`
          )
        );
      }
      poll();
    }, 1000);
  }

  // ── Start/Stop ──
  function start() {
    log("Starting Jam Round Robin...");
    poll();
    pollHandle = setInterval(poll, 3000);
    Spicetify.Player.addEventListener("songchange", onSongChange);
    log("Listening for song changes, polling every 3s.");
  }

  function stop() {
    log("Stopping Jam Round Robin.");
    if (pollHandle) clearInterval(pollHandle);
    Spicetify.Player.removeEventListener("songchange", onSongChange);
    isActive = false;
    sessionMembers = [];
    lastQueueUids = "";
  }

  // ── Menu Toggle ──
  const menuItem = new Spicetify.Menu.Item(
    "Jam Round Robin",
    false,
    (self) => {
      self.isEnabled = !self.isEnabled;
      if (self.isEnabled) {
        start();
        Spicetify.showNotification("Jam Round Robin: ON");
      } else {
        stop();
        Spicetify.showNotification("Jam Round Robin: OFF");
      }
    }
  );
  menuItem.register();

  // ── Debug ──
  window.__jamRR = {
    getState: () => ({
      sessionMembers,
      isActive,
      roundRobinEnabled,
      toggleInjected,
      lastQueueUids,
      currentlyPlaying: getCurrentlyPlayingOwner()?.displayName || "playlist",
      playedCount: sessionMembers.reduce((acc, m) => {
        acc[m.displayName] = playedCount[m.id] || 0;
        return acc;
      }, {}),
    }),
    getQueue: () => getAnnotatedQueue(),
    enforceRoundRobin,
    poll,
    start,
    stop,
  };

  log("Debug API at window.__jamRR");
  start();
})();
