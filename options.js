// Live browser snapshot: total tabs and windows across all of Chrome. Kept
// current by tabs/windows events. It's current browser state, so it isn't
// stored or computed in background.js.
let totalTabCount = 0;
let totalWindowCount = 0;

const statTabCountEl = document.getElementById("stat-tab-count");
const statWindowCountEl = document.getElementById("stat-window-count");

function refreshBrowserSnapshot() {
  // windowType "normal" matches the window count below and leaves out tabs in
  // popup or app windows, so both numbers cover the same slice of the
  // browser.
  chrome.tabs.query({ windowType: "normal" }, (tabs) => {
    totalTabCount = tabs.length;
    statTabCountEl.textContent = String(totalTabCount);
  });
  // "normal" leaves out devtools, popup and app windows, so this only counts
  // real browser windows.
  chrome.windows.getAll({ windowTypes: ["normal"] }, (windows) => {
    totalWindowCount = windows.length;
    statWindowCountEl.textContent = String(totalWindowCount);
  });
}

refreshBrowserSnapshot();

chrome.tabs.onCreated.addListener(refreshBrowserSnapshot);
chrome.tabs.onRemoved.addListener(refreshBrowserSnapshot);
chrome.windows.onCreated.addListener(refreshBrowserSnapshot);
chrome.windows.onRemoved.addListener(refreshBrowserSnapshot);

// Duplicate Tabs tile: shows the live count and, on click, erases them.
//
// A duplicate group is 2 or more tabs in the current window with the exact
// same URL. The tile shows the number of groups, not the number of extra
// tabs, since erasing would collapse each group to one tab.
const duplicateCountEl = document.getElementById("duplicate-count");
const duplicateTileEl = document.getElementById("duplicate-tile");
const duplicateFlashEl = document.getElementById("duplicate-flash");
let duplicateFlashTimeout = null;

function refreshDuplicateCount() {
  chrome.tabs.query({ currentWindow: true, windowType: "normal" }, (tabs) => {
    const countByUrl = new Map();
    for (const tab of tabs) {
      countByUrl.set(tab.url, (countByUrl.get(tab.url) || 0) + 1);
    }
    let duplicateGroups = 0;
    for (const count of countByUrl.values()) {
      if (count >= 2) duplicateGroups++;
    }
    duplicateCountEl.textContent = String(duplicateGroups);
  });
}

refreshDuplicateCount();

chrome.tabs.onCreated.addListener(refreshDuplicateCount);
chrome.tabs.onRemoved.addListener(refreshDuplicateCount);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Only a URL change can create or remove duplicates, so skip the more
  // frequent title/favicon updates.
  if (changeInfo.url !== undefined) refreshDuplicateCount();
});

function showDuplicateFlash(message) {
  duplicateFlashEl.textContent = message;
  duplicateFlashEl.classList.add("is-visible");
  clearTimeout(duplicateFlashTimeout);
  duplicateFlashTimeout = setTimeout(() => {
    duplicateFlashEl.classList.remove("is-visible");
  }, 2600);
}

// Erase click: background.js owns the grouping and closing (it has each
// tab's creation time, which chrome.tabs.Tab doesn't expose, plus the
// pinned/audible/protected state), so this just hands off the options
// page's own window id and renders the result.
duplicateTileEl.addEventListener("click", () => {
  chrome.windows.getCurrent((win) => {
    chrome.runtime.sendMessage(
      { type: "eraseDuplicateTabs", windowId: win.id },
      (response) => {
        if (!response) return;

        const { erasedCount, shieldedCounts } = response;
        const shieldedTotal =
          shieldedCounts.pinned + shieldedCounts.protected + shieldedCounts.audible;

        if (erasedCount === 0 && shieldedTotal === 0) return; // nothing was a duplicate

        const reasons = [];
        if (shieldedCounts.pinned) reasons.push("pinned");
        if (shieldedCounts.protected) reasons.push("protected");
        if (shieldedCounts.audible) reasons.push("playing audio");

        if (erasedCount === 0) {
          showDuplicateFlash(`Can't erase — all duplicates are ${reasons.join("/")}`);
          return;
        }

        let message = `Erased ${erasedCount} duplicate${erasedCount === 1 ? "" : "s"}`;
        if (shieldedTotal > 0) {
          message += ` · ${shieldedTotal} kept (${reasons.join("/")})`;
        }
        showDuplicateFlash(message);
      }
    );
  });
});

const minutesInput = document.getElementById("minutesInput");
const hoursInput = document.getElementById("hoursInput");
const daysInput = document.getElementById("daysInput");
const minimumTabsInput = document.getElementById("minimumTabs");
const durationSentenceEl = document.getElementById("duration-sentence");
const saveFlashEl = document.getElementById("save-flash");
const toggleButton = document.getElementById("toggle");
const toggleLine1 = document.getElementById("toggle-line1");

// Nav: clicking a link shows its .view panel, hides the others, and marks the
// link active. This only switches views within the page.
const navLinks = document.querySelectorAll(".nav-link");
const views = document.querySelectorAll(".view");
const navIndicatorEl = document.getElementById("nav-indicator");

// Slides the shared indicator bar under whichever link is active.
// top/left/width are measured off the link itself, relative to .tm-nav (its
// offsetParent, now that .tm-nav has position: relative) -- real values on
// a real element, which is what lets the CSS transition in options.html
// actually animate between positions, unlike the old per-link ::after it
// replaced. top is computed from the link's own box (offsetTop +
// offsetHeight + a 6px gap) rather than a CSS bottom offset on .tm-nav
// itself, which would be anchored to the whole row's padding box instead of
// the button and land much lower than intended.
function moveNavIndicator(activeLink) {
  navIndicatorEl.style.top = `${activeLink.offsetTop + activeLink.offsetHeight + 6}px`;
  navIndicatorEl.style.left = `${activeLink.offsetLeft}px`;
  navIndicatorEl.style.width = `${activeLink.offsetWidth}px`;
}

// Positioned once, instantly (no "is-ready" yet, so no transition is
// defined), before the class that turns the transition on is added one
// frame later. Without this split, the bar would visibly slide in from
// wherever it defaults to the moment the page opens.
moveNavIndicator(document.querySelector(".nav-link.active"));
requestAnimationFrame(() => {
  navIndicatorEl.classList.add("is-ready");
});

// Inter is a web font (see fonts/ in the repo). If it's still loading at the
// moment moveNavIndicator first runs, offsetWidth reflects the fallback
// font's metrics, not Inter's -- re-measuring once it's confirmed loaded
// corrects any resulting mismatch.
if (document.fonts) {
  document.fonts.ready.then(() => {
    moveNavIndicator(document.querySelector(".nav-link.active"));
  });
}

navLinks.forEach((link) => {
  link.addEventListener("click", () => {
    navLinks.forEach((otherLink) => otherLink.classList.remove("active"));
    link.classList.add("active");
    moveNavIndicator(link);

    const targetId = `view-${link.dataset.view}`;
    views.forEach((view) => {
      const isTarget = view.id === targetId;
      view.classList.toggle("active", isTarget);
      // Both views stay in the grid stack (.tm-view-stack in options.html) so
      // the shell sizes to the taller one. `inert` keeps the hidden view's
      // buttons and inputs out of reach of the keyboard and screen readers.
      view.inert = !isTarget;
    });
  });
});

// Updates the tile headline and its CSS class for the on/off state. Only the
// first line changes; the crossfade itself is CSS, driven by is-on/is-off
// (see options.html).
function renderToggle(isEnabled) {
  toggleLine1.textContent = isEnabled ? "Stop" : "Start";
  toggleButton.classList.toggle("is-on", isEnabled);
  toggleButton.classList.toggle("is-off", !isEnabled);
}

// Show the saved state as soon as the page opens. Defaults to off, matching
// background.js.
chrome.storage.local.get({ isEnabled: false }, (result) => {
  renderToggle(result.isEnabled);
});

// Clicking flips the saved value. background.js watches storage.onChanged, so
// saving the new value is what turns the extension on or off. The two scripts
// only communicate through storage.
toggleButton.addEventListener("click", () => {
  chrome.storage.local.get({ isEnabled: false }, (result) => {
    const nextValue = !result.isEnabled;
    chrome.storage.local.set({ isEnabled: nextValue }, () => {
      renderToggle(nextValue);
    });
  });
});

// Three fields add up to one duration. background.js only reads the final
// inactiveLimitMs.
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function pluralize(value, unit) {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

// Leaves out any unit that's zero, and falls back to a prompt if all three
// are.
function buildDurationSentence(minutes, hours, days) {
  const parts = [];
  if (days > 0) parts.push(pluralize(days, "day"));
  if (hours > 0) parts.push(pluralize(hours, "hour"));
  if (minutes > 0) parts.push(pluralize(minutes, "minute"));

  if (parts.length === 0) {
    return "Enter how long a tab can sit inactive before it's archived.";
  }

  const joined =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")}${parts.length > 2 ? "," : ""} and ${parts[parts.length - 1]}`;

  return `Tabs will disappear after ${joined} of inactivity.`;
}

function renderDurationSentence() {
  const minutes = Math.max(0, Math.floor(Number(minutesInput.value)) || 0);
  const hours = Math.max(0, Math.floor(Number(hoursInput.value)) || 0);
  const days = Math.max(0, Math.floor(Number(daysInput.value)) || 0);
  durationSentenceEl.textContent = buildDurationSentence(minutes, hours, days);
}

// Load the saved values into the form. Defaults: 5 minutes, 1 hour, 0 days.
chrome.storage.local.get(
  {
    inactiveLimitMinutes: 5,
    inactiveLimitHours: 1,
    inactiveLimitDays: 0,
    minimumTabCount: 5,
  },
  (result) => {
    minutesInput.value = result.inactiveLimitMinutes;
    hoursInput.value = result.inactiveLimitHours;
    daysInput.value = result.inactiveLimitDays;
    minimumTabsInput.value = result.minimumTabCount;
    renderDurationSentence();
  }
);

// Auto-save: any change to the four fields saves right away, debounced so
// fast typing doesn't write on every keystroke. A quiet "Saved" flash
// confirms it.
let saveSettingsTimeout = null;
let saveFlashTimeout = null;

function saveSettings() {
  const minutes = Math.max(0, Math.floor(Number(minutesInput.value)) || 0);
  const hours = Math.max(0, Math.floor(Number(hoursInput.value)) || 0);
  const days = Math.max(0, Math.floor(Number(daysInput.value)) || 0);
  // 0 is valid (see minimumTabCount below). Only an empty or non-numeric
  // field falls back to 0.
  const minimumTabCount = Math.max(0, Math.floor(Number(minimumTabsInput.value)) || 0);

  // Chrome alarms don't reliably support delays under a minute, so the stored
  // value is floored at 1 minute even if every field is 0 or empty. The
  // fields themselves are left alone so typing isn't interrupted.
  const rawMs = minutes * MINUTE_MS + hours * HOUR_MS + days * DAY_MS;
  const inactiveLimitMs = Math.max(MINUTE_MS, rawMs);

  chrome.storage.local.set(
    {
      inactiveLimitMinutes: minutes,
      inactiveLimitHours: hours,
      inactiveLimitDays: days,
      inactiveLimitMs,
      minimumTabCount,
    },
    () => {
      saveFlashEl.classList.add("is-visible");
      clearTimeout(saveFlashTimeout);
      saveFlashTimeout = setTimeout(() => {
        saveFlashEl.classList.remove("is-visible");
      }, 1200);
    }
  );

  renderDurationSentence();
}

function scheduleSave() {
  clearTimeout(saveSettingsTimeout);
  saveSettingsTimeout = setTimeout(saveSettings, 400);
}

[minutesInput, hoursInput, daysInput, minimumTabsInput].forEach((input) => {
  input.addEventListener("input", scheduleSave);
});

// Archived Tabs. Must match RECENTLY_CLOSED_KEY in background.js; the files
// share no imports, so keep them in sync by hand.
const RECENTLY_CLOSED_KEY = "recentlyClosedTabs";

const archivedListEl = document.getElementById("archived-list");
const restoreConfirmEl = document.getElementById("restore-confirm");
const restoreConfirmBtn = document.getElementById("restore-confirm-btn");

// The tab a click asked to restore, held until the confirm button is clicked
// or the popup is dismissed.
let pendingRestoreTab = null;

// Turns a timestamp into "5s ago" / "3m ago" / "2h ago".
function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function renderArchivedTabs(closedTabs) {
  archivedListEl.innerHTML = "";

  if (closedTabs.length === 0) {
    const empty = document.createElement("li");
    empty.className = "tm-empty";
    empty.textContent =
      "No archived tabs just yet. You'll see them here once Tab Magic closes one for you.";
    archivedListEl.appendChild(empty);
    return;
  }

  for (const tab of closedTabs) {
    const row = document.createElement("li");
    row.className = "tm-row";

    const icon = document.createElement("img");
    icon.className = "tm-row-icon";
    icon.src = tab.favIconUrl || "";
    icon.addEventListener("error", () => {
      icon.style.visibility = "hidden";
    });

    const textWrap = document.createElement("div");
    textWrap.className = "tm-row-text";

    const title = document.createElement("span");
    title.className = "tm-row-title";
    title.textContent = tab.title || tab.url;

    const url = document.createElement("span");
    url.className = "tm-row-url";
    url.textContent = tab.url;

    textWrap.appendChild(title);
    textWrap.appendChild(url);

    const time = document.createElement("span");
    time.className = "tm-row-time";
    time.textContent = timeAgo(tab.closedAt);

    row.appendChild(icon);
    row.appendChild(textWrap);
    row.appendChild(time);

    // Stop propagation so the document-level "click outside closes the popup"
    // listener below doesn't immediately undo the popup this click opened.
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      showRestoreConfirm(event, tab);
    });

    archivedListEl.appendChild(row);
  }
}

function showRestoreConfirm(event, tab) {
  pendingRestoreTab = tab;
  restoreConfirmEl.hidden = false;
  restoreConfirmEl.style.left = `${event.clientX}px`;
  restoreConfirmEl.style.top = `${event.clientY}px`;
}

function hideRestoreConfirm() {
  restoreConfirmEl.hidden = true;
  pendingRestoreTab = null;
}

restoreConfirmBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!pendingRestoreTab) return;

  const tabToRestore = pendingRestoreTab;
  chrome.tabs.create({ url: tabToRestore.url });

  // Sent to background.js instead of writing storage here, so the removal
  // goes through the same queue as new closures and can't race them.
  chrome.runtime.sendMessage({
    type: "removeRecentlyClosedTab",
    closedAt: tabToRestore.closedAt,
  });

  hideRestoreConfirm();
});

// Any click outside a row or the confirm button dismisses the popup without
// restoring.
document.addEventListener("click", (event) => {
  if (!restoreConfirmEl.hidden && !restoreConfirmEl.contains(event.target)) {
    hideRestoreConfirm();
  }
});

chrome.storage.local.get({ [RECENTLY_CLOSED_KEY]: [] }, (result) => {
  renderArchivedTabs(result[RECENTLY_CLOSED_KEY]);
});

// The options page can stay open while background.js closes tabs, so
// re-render the list whenever storage changes.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[RECENTLY_CLOSED_KEY]) {
    renderArchivedTabs(changes[RECENTLY_CLOSED_KEY].newValue || []);
  }
  if (changes[PROTECTED_HOSTNAMES_KEY]) {
    renderProtectedHostnames(changes[PROTECTED_HOSTNAMES_KEY].newValue || []);
  }
});

// Protected Tabs. Must match the protectedHostnames key used in
// background.js.
const PROTECTED_HOSTNAMES_KEY = "protectedHostnames";
const PROTECTED_HOSTNAMES_LIMIT = 100;

const protectedListEl = document.getElementById("protected-list");
const protectedAddBtn = document.getElementById("protected-add-btn");
const protectedRemoveBtn = document.getElementById("protected-remove-btn");
const protectedErrorEl = document.getElementById("protected-error");

// The input in the live Add row, kept so addProtectedHostname() and the Enter
// handler can read its value. The row is rebuilt on every render.
let activeAddInputEl = null;

// Builds the shield icon for real rows and the empty-state row. A function,
// since each row needs its own node.
function createShieldIcon() {
  const icon = document.createElement("img");
  icon.className = "tm-shield-icon";
  icon.src = "icons/shield.png";
  icon.alt = "";
  return icon;
}

// Current mode: "idle" (list plus Add/Remove buttons), "add" (inline input,
// Enter saves) or "remove" (an x on every row; one click deletes it and
// returns to idle). Only one is active at a time, and the controls and list
// both render from this value.
let protectedMode = "idle";
let currentProtectedHostnames = [];
let protectedErrorTimeout = null;

function showProtectedError(message) {
  protectedErrorEl.textContent = message;
  protectedErrorEl.hidden = false;
  clearTimeout(protectedErrorTimeout);
  protectedErrorTimeout = setTimeout(() => {
    protectedErrorEl.hidden = true;
  }, 2500);
}

function setProtectedMode(mode) {
  protectedMode = mode;
  protectedAddBtn.classList.toggle("is-active", mode === "add");
  protectedRemoveBtn.classList.toggle("is-active", mode === "remove");
  renderProtectedHostnames(currentProtectedHostnames);
}

// Builds the "type a domain" row used in Add mode: styled like a real row,
// with an editable input instead of a saved hostname.
function createAddInputRow() {
  const row = document.createElement("li");
  row.className = "tm-row tm-add-row";

  const icon = createShieldIcon();

  const input = document.createElement("input");
  input.type = "text";
  input.className = "tm-add-row-input";
  input.placeholder = "Enter URL";
  input.autocomplete = "off";
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addProtectedHostname();
    }
  });

  row.appendChild(icon);
  row.appendChild(input);

  activeAddInputEl = input;
  return row;
}

function renderProtectedHostnames(hostnames) {
  currentProtectedHostnames = hostnames;
  protectedListEl.innerHTML = "";
  activeAddInputEl = null;

  if (protectedMode === "add") {
    const addRow = createAddInputRow();
    protectedListEl.appendChild(addRow);
    activeAddInputEl.focus();
  } else if (hostnames.length === 0) {
    const empty = document.createElement("li");
    empty.className = "tm-protected-empty";

    const icon = createShieldIcon();

    const text = document.createElement("span");
    text.className = "tm-protected-empty-text";
    text.textContent = "Your Protected Tabs will show up here. Go ahead and add some.";

    empty.appendChild(icon);
    empty.appendChild(text);
    protectedListEl.appendChild(empty);
    return;
  }

  for (const hostname of hostnames) {
    const row = document.createElement("li");
    row.className = "tm-row";

    const icon = createShieldIcon();

    const textWrap = document.createElement("div");
    textWrap.className = "tm-row-text";
    const title = document.createElement("span");
    title.className = "tm-row-title";
    title.textContent = hostname;
    textWrap.appendChild(title);

    row.appendChild(icon);
    row.appendChild(textWrap);

    if (protectedMode === "remove") {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "tm-remove-x";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        removeProtectedHostname(hostname);
      });
      row.appendChild(removeBtn);
    }

    protectedListEl.appendChild(row);
  }
}

// Reduces a bare domain, a full URL, or a domain with a path to just the
// hostname, so pasting "https://zoom.us/j/123" works the same as typing
// "zoom.us".
function normalizeHostname(raw) {
  let value = raw.trim().toLowerCase();
  if (!value) return "";
  if (!value.includes("://")) {
    value = `http://${value}`;
  }
  try {
    return new URL(value).hostname;
  } catch (error) {
    return "";
  }
}

function addProtectedHostname() {
  const hostname = normalizeHostname(activeAddInputEl ? activeAddInputEl.value : "");
  if (!hostname) {
    showProtectedError("Enter a valid domain, like zoom.us.");
    return;
  }

  chrome.storage.local.get({ [PROTECTED_HOSTNAMES_KEY]: [] }, (result) => {
    const existing = result[PROTECTED_HOSTNAMES_KEY];

    if (existing.includes(hostname)) {
      showProtectedError("That domain is already protected.");
      return;
    }
    if (existing.length >= PROTECTED_HOSTNAMES_LIMIT) {
      showProtectedError(`You've reached the ${PROTECTED_HOSTNAMES_LIMIT} domain limit.`);
      return;
    }

    const updated = [hostname, ...existing];
    chrome.storage.local.set({ [PROTECTED_HOSTNAMES_KEY]: updated }, () => {
      setProtectedMode("idle");
    });
  });
}

function removeProtectedHostname(hostname) {
  chrome.storage.local.get({ [PROTECTED_HOSTNAMES_KEY]: [] }, (result) => {
    const updated = result[PROTECTED_HOSTNAMES_KEY].filter((h) => h !== hostname);
    chrome.storage.local.set({ [PROTECTED_HOSTNAMES_KEY]: updated }, () => {
      setProtectedMode("idle");
    });
  });
}

// Clicking a button switches to its mode; clicking the active mode's button
// cancels back to idle, so the highlighted button doubles as a cancel.
protectedAddBtn.addEventListener("click", () => {
  setProtectedMode(protectedMode === "add" ? "idle" : "add");
});
protectedRemoveBtn.addEventListener("click", () => {
  setProtectedMode(protectedMode === "remove" ? "idle" : "remove");
});

// Escape backs out of Add or Remove without saving or deleting anything.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && protectedMode !== "idle") {
    setProtectedMode("idle");
  }
});

chrome.storage.local.get({ [PROTECTED_HOSTNAMES_KEY]: [] }, (result) => {
  renderProtectedHostnames(result[PROTECTED_HOSTNAMES_KEY]);
});

