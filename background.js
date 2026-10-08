// Fallback inactivity limit (ms) until one is saved from the options page.
// One minute is also Chrome's minimum reliable alarm delay, so the options
// page won't accept less.
const DEFAULT_INACTIVE_LIMIT_MS = 60000;

// Live settings, seeded from storage below and kept current by the
// storage.onChanged listener.
let inactiveLimitMs = DEFAULT_INACTIVE_LIMIT_MS;

// Master switch. Always starts OFF; nothing closes until the user turns it
// on.
let isEnabled = false;

// Never close a tab if it would leave the window with fewer than this many
// tabs.
const DEFAULT_MINIMUM_TAB_COUNT = 5;
let minimumTabCount = DEFAULT_MINIMUM_TAB_COUNT;

// tabId -> when the tab was last active.
const lastActiveTime = new Map();

// tabId -> windowId.
const tabWindowId = new Map();

// tabId -> hostname, so evaluateWindow can check protection without an async
// tabs.get().
const tabHostname = new Map();

// Domains the user protected. An entry also covers its subdomains ("zoom.us"
// protects "us05web.zoom.us").
let protectedHostnames = [];

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return "";
  }
}

function isProtectedHostname(hostname) {
  if (!hostname) return false;
  return protectedHostnames.some(
    (protected_) => hostname === protected_ || hostname.endsWith(`.${protected_}`)
  );
}

// Most-active-domain tracking. Built but switched off: TRACK_ACTIVE_TIME
// gates every entry point, so nothing is tracked or stored until it's flipped
// on.
//
// Time is credited per domain, not per tab, so a tab that moves from Gmail to
// Zoom credits each site correctly. Totals are bucketed by calendar month, so
// rollover needs no alarm.
const TRACK_ACTIVE_TIME = false;
const ACTIVE_TIME_KEY = "activeTimeByMonth";

// Domain currently being looked at and when that segment began. Flushed to
// storage whenever the active tab, its domain, or Chrome's focus changes. A
// segment in progress is lost if the service worker restarts.
let activeSegmentHostname = "";
let activeSegmentStartedAt = 0;

// Whether Chrome has OS focus at all. Needed because regaining focus on the
// same window doesn't change focusedWindowId.
let chromeIsFocused = true;

function monthKeyFromTimestamp(timestamp) {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}`;
}

// Adds elapsedMs to the hostname's total for the month the segment started
// in.
function recordActiveTime(hostname, elapsedMs, segmentStartedAt) {
  if (!TRACK_ACTIVE_TIME) return;
  if (!hostname || elapsedMs <= 0) return;

  const monthKey = monthKeyFromTimestamp(segmentStartedAt);
  chrome.storage.local.get({ [ACTIVE_TIME_KEY]: {} }, (result) => {
    const byMonth = result[ACTIVE_TIME_KEY];
    const monthBucket = byMonth[monthKey] || {};
    monthBucket[hostname] = (monthBucket[hostname] || 0) + elapsedMs;
    byMonth[monthKey] = monthBucket;
    chrome.storage.local.set({ [ACTIVE_TIME_KEY]: byMonth });
  });
}

// Credits the running segment up to `now` and clears it. No-op if nothing is
// running.
function flushActiveSegment(now) {
  if (!TRACK_ACTIVE_TIME) return;
  if (!activeSegmentHostname || !activeSegmentStartedAt) return;

  recordActiveTime(activeSegmentHostname, now - activeSegmentStartedAt, activeSegmentStartedAt);
  activeSegmentHostname = "";
  activeSegmentStartedAt = 0;
}

// Starts a segment for hostname. Flush the previous one first.
function startActiveSegment(hostname, now) {
  if (!TRACK_ACTIVE_TIME) return;
  activeSegmentHostname = hostname || "";
  activeSegmentStartedAt = activeSegmentHostname ? now : 0;
}

// Pinned tabs are never auto-closed.
const pinnedTabIds = new Set();

// Tabs playing audio get the same protection as pinned tabs.
const audibleTabIds = new Set();

// windowId -> active tabId.
const activeTabByWindow = new Map();

// windowId of the Chrome window with OS focus.
let focusedWindowId = chrome.windows.WINDOW_ID_NONE;

// One alarm per tab, named by tabId. Only non-active tabs in the focused
// window have one pending; other windows are frozen.
function alarmNameForTab(tabId) {
  return `close-tab-${tabId}`;
}

// Re-checks every tab in a window. The active tab is skipped; every other tab
// gets an alarm for when its inactivity limit runs out, or is closed now if
// that time already passed. Pinned, audible and protected-domain tabs and the
// minimum-tab-count rail are all applied here.
function evaluateWindow(windowId) {
  const now = Date.now();
  const activeTabId = activeTabByWindow.get(windowId);

  // Tabs in this window, pinned ones included. Decremented as tabs close so
  // the rail holds when several are stale in the same pass.
  let tabCountInWindow = 0;
  for (const ownerWindowId of tabWindowId.values()) {
    if (ownerWindowId === windowId) tabCountInWindow++;
  }

  for (const [tabId, ownerWindowId] of tabWindowId.entries()) {
    if (ownerWindowId !== windowId) continue;

    if (tabId === activeTabId) {
      chrome.alarms.clear(alarmNameForTab(tabId));
      continue;
    }

    if (pinnedTabIds.has(tabId)) {
      // Pinned: no timer.
      chrome.alarms.clear(alarmNameForTab(tabId));
      continue;
    }

    if (audibleTabIds.has(tabId)) {
      // Playing audio: no timer.
      chrome.alarms.clear(alarmNameForTab(tabId));
      continue;
    }

    if (isProtectedHostname(tabHostname.get(tabId))) {
      // Protected domain: no timer.
      chrome.alarms.clear(alarmNameForTab(tabId));
      continue;
    }

    if (tabCountInWindow <= minimumTabCount) {
      // At the minimum: closing this would drop the window below it. Reset
      // the clock rather than leave it overdue, so it gets a fresh countdown
      // if the count rises later.
      lastActiveTime.set(tabId, now);
      chrome.alarms.clear(alarmNameForTab(tabId));
      continue;
    }

    const dueAt = (lastActiveTime.get(tabId) ?? now) + inactiveLimitMs;
    if (dueAt <= now) {
      closeAndRecordTab(tabId);
      tabCountInWindow--; // this window just got one tab smaller
    } else {
      chrome.alarms.create(alarmNameForTab(tabId), { when: dueAt });
    }
  }
}

// Entries kept for the "up next to be archived" list: the next tab plus the 3
// behind it.
const UPCOMING_ARCHIVE_LIMIT = 4;
const UPCOMING_ARCHIVE_KEY = "upcomingArchive";

// Recomputes the "up next" list for the focused window and saves it to
// storage for the options page. Unfocused windows are frozen, so their due
// times wouldn't be real.
//
// Mirrors evaluateWindow's eligibility rules but does its own tabs.query,
// since evaluateWindow's maps don't carry title or favicon.
function refreshUpcomingArchiveList() {
  if (!isEnabled || focusedWindowId === chrome.windows.WINDOW_ID_NONE) {
    // Off, or no focused window: nothing is counting down, so show nothing.
    chrome.storage.local.set({ [UPCOMING_ARCHIVE_KEY]: [] });
    return;
  }

  const windowId = focusedWindowId;
  chrome.tabs.query({ windowId }, (tabs) => {
    const now = Date.now();
    const activeTabId = activeTabByWindow.get(windowId);
    const tabCountInWindow = tabs.length;

    const eligible = [];
    for (const tab of tabs) {
      if (tab.id === activeTabId) continue;
      if (pinnedTabIds.has(tab.id)) continue;
      if (audibleTabIds.has(tab.id)) continue;
      if (isProtectedHostname(tabHostname.get(tab.id))) continue;
      if (tabCountInWindow <= minimumTabCount) continue;

      eligible.push({
        tabId: tab.id,
        title: tab.title || tab.url,
        hostname: hostnameFromUrl(tab.url),
        favIconUrl: tab.favIconUrl || "",
        dueAt: (lastActiveTime.get(tab.id) ?? now) + inactiveLimitMs,
      });
    }

    eligible.sort((a, b) => a.dueAt - b.dueAt);
    chrome.storage.local.set({
      [UPCOMING_ARCHIVE_KEY]: eligible.slice(0, UPCOMING_ARCHIVE_LIMIT),
    });
  });
}

// Cancels a window's pending alarms when it loses focus, so its tabs freeze.
function freezeWindow(windowId) {
  for (const [tabId, ownerWindowId] of tabWindowId.entries()) {
    if (ownerWindowId === windowId) {
      chrome.alarms.clear(alarmNameForTab(tabId));
    }
  }
}

// Max closed-tab records kept. When full, the oldest is dropped.
const RECENTLY_CLOSED_LIMIT = 100;
const RECENTLY_CLOSED_KEY = "recentlyClosedTabs";

// Queue for every read-modify-write on RECENTLY_CLOSED_KEY. Without it, tabs
// closing in a burst (or a restore during a close) each read the same stale
// list and overwrite each other's entry. Each call waits for the previous
// write to finish. The .catch() keeps one failed write from blocking the
// rest.
let recentlyClosedQueue = Promise.resolve();

function withRecentlyClosedQueue(mutate) {
  recentlyClosedQueue = recentlyClosedQueue.catch(() => {}).then(
    () =>
      new Promise((resolve) => {
        chrome.storage.local.get({ [RECENTLY_CLOSED_KEY]: [] }, (result) => {
          const updated = mutate(result[RECENTLY_CLOSED_KEY]);
          chrome.storage.local.set({ [RECENTLY_CLOSED_KEY]: updated }, resolve);
        });
      })
  );
  return recentlyClosedQueue;
}

// Saves a closed tab's info to chrome.storage.local so the Archived Tabs list
// can restore it. Storage rather than a variable, because the service worker
// can be terminated at any time.
function recordClosedTab(tab) {
  withRecentlyClosedQueue((closedTabs) => {
    closedTabs.unshift({
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl,
      closedAt: Date.now(),
    });
    return closedTabs.slice(0, RECENTLY_CLOSED_LIMIT);
  });
}

// The options page asks for a restored tab's record to be removed here
// instead of writing to storage itself, so the removal goes through the same
// queue as new closures.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "removeRecentlyClosedTab") {
    withRecentlyClosedQueue((closedTabs) =>
      closedTabs.filter((entry) => entry.closedAt !== message.closedAt)
    );
    return;
  }

  // The options page's duplicate tile asks for its own window's duplicates
  // to be erased. This runs here, not in options.js, because the
  // pinned/audible/protected checks only live in this file.
  if (message?.type === "eraseDuplicateTabs") {
    chrome.tabs.query({ windowId: message.windowId, windowType: "normal" }, (tabs) => {
      const tabIdsByUrl = new Map();
      for (const tab of tabs) {
        if (!tabIdsByUrl.has(tab.url)) tabIdsByUrl.set(tab.url, []);
        tabIdsByUrl.get(tab.url).push(tab.id);
      }

      let erasedCount = 0;
      const shieldedCounts = { pinned: 0, protected: 0, audible: 0 };

      // Null means "fair game to close." A reason means this tab is never
      // touched here, no matter how old or new it is.
      function shieldReason(tabId) {
        if (pinnedTabIds.has(tabId)) return "pinned";
        if (audibleTabIds.has(tabId)) return "audible";
        if (isProtectedHostname(tabHostname.get(tabId))) return "protected";
        return null;
      }

      for (const tabIds of tabIdsByUrl.values()) {
        if (tabIds.length < 2) continue;

        const reasons = tabIds.map(shieldReason);

        if (reasons.some((reason) => reason !== null)) {
          // At least one copy in this group is untouchable, so it's already
          // the group's survivor regardless of age. Every other, unshielded
          // copy is still redundant next to it and gets closed -- recency
          // doesn't come into it.
          tabIds.forEach((tabId, index) => {
            const reason = reasons[index];
            if (reason) {
              shieldedCounts[reason]++;
            } else {
              closeDuplicateTab(tabId);
              erasedCount++;
            }
          });
          continue;
        }

        // Nothing in this group is shielded, so fall back to recency: the
        // newest tab (highest id -- ids are assigned by Chrome itself and
        // only ever increase, so this holds even across a service-worker
        // restart, unlike a timestamp we'd have to track ourselves)
        // survives, and every other tab in the group closes.
        const newestTabId = Math.max(...tabIds);
        for (const tabId of tabIds) {
          if (tabId === newestTabId) continue;
          closeDuplicateTab(tabId);
          erasedCount++;
        }
      }

      sendResponse({ erasedCount, shieldedCounts });
    });
    return true; // keep the message channel open for the async tabs.query above
  }
});

// Final live check before closing a tab. The decision evaluateWindow made can
// be stale by the time an alarm fires: several tabs can come due together,
// and Chrome may fire their alarms in one batch before the first closure's
// onRemoved re-check runs. This runs synchronously, so each alarm sees the
// tab count left by the one before it.
function canCloseTabNow(tabId) {
  if (pinnedTabIds.has(tabId)) return false;
  if (audibleTabIds.has(tabId)) return false;
  if (isProtectedHostname(tabHostname.get(tabId))) return false;

  const windowId = tabWindowId.get(tabId);
  if (windowId === undefined) return false; // already closed
  if (activeTabByWindow.get(windowId) === tabId) return false;

  let tabCountInWindow = 0;
  for (const ownerWindowId of tabWindowId.values()) {
    if (ownerWindowId === windowId) tabCountInWindow++;
  }
  if (tabCountInWindow <= minimumTabCount) return false;

  return true;
}

// The one place a tab gets closed for inactivity. Reads the tab's info first,
// while it still exists, so there's a record to restore from.
function closeAndRecordTab(tabId) {
  if (!canCloseTabNow(tabId)) {
    // No longer eligible: restart its countdown instead of leaving it
    // overdue.
    lastActiveTime.set(tabId, Date.now());
    chrome.alarms.clear(alarmNameForTab(tabId));
    return;
  }

  chrome.tabs.get(tabId, (tab) => {
    if (!chrome.runtime.lastError && tab) {
      recordClosedTab(tab);
    }
    chrome.tabs.remove(tabId);
  });
  lastActiveTime.delete(tabId);
  tabWindowId.delete(tabId);
}

// Closes one duplicate tab and records it to Archived Tabs, same as
// closeAndRecordTab. Eligibility (pinned/audible/protected) is decided by
// the caller, since "erase duplicates" has its own rules, not
// canCloseTabNow's (no active-tab or minimum-tab-count check: this is a
// direct user action, same tier as clicking the tab's own "x").
function closeDuplicateTab(tabId) {
  chrome.tabs.get(tabId, (tab) => {
    if (!chrome.runtime.lastError && tab) {
      recordClosedTab(tab);
    }
    chrome.tabs.remove(tabId);
  });
  lastActiveTime.delete(tabId);
  tabWindowId.delete(tabId);
}

// On startup, seed the maps from the open tabs, then evaluate the focused
// window. Settings load first so the first pass uses the saved limit, and
// it's skipped entirely if the extension is off.
chrome.storage.local.get(
  {
    inactiveLimitMs: DEFAULT_INACTIVE_LIMIT_MS,
    isEnabled: false,
    minimumTabCount: DEFAULT_MINIMUM_TAB_COUNT,
    protectedHostnames: [],
  },
  (settings) => {
    inactiveLimitMs = settings.inactiveLimitMs;
    isEnabled = settings.isEnabled;
    minimumTabCount = settings.minimumTabCount;
    protectedHostnames = settings.protectedHostnames;

    chrome.tabs.query({}, (tabs) => {
      const now = Date.now();
      for (const tab of tabs) {
        lastActiveTime.set(tab.id, now);
        tabWindowId.set(tab.id, tab.windowId);
        tabHostname.set(tab.id, hostnameFromUrl(tab.url));
        if (tab.pinned) {
          pinnedTabIds.add(tab.id);
        }
        if (tab.audible) {
          audibleTabIds.add(tab.id);
        }
        if (tab.active) {
          activeTabByWindow.set(tab.windowId, tab.id);
        }
      }

      chrome.windows.getLastFocused({}, (win) => {
        if (win && win.focused) {
          focusedWindowId = win.id;
          // Only schedule closes if the extension is on. Tabs are tracked
          // either way.
          if (isEnabled) {
            evaluateWindow(focusedWindowId);
          }
          refreshUpcomingArchiveList();
          if (TRACK_ACTIVE_TIME) {
            const activeTabId = activeTabByWindow.get(focusedWindowId);
            startActiveSegment(tabHostname.get(activeTabId), Date.now());
          }
        }
      });
    });
  }
);

// Reacts to settings saved from the options page. The two scripts can't call
// each other, so storage changes are how they communicate.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.inactiveLimitMs) {
    inactiveLimitMs = changes.inactiveLimitMs.newValue;
    // Re-check now so open tabs pick up the new limit right away.
    evaluateWindow(focusedWindowId);
    refreshUpcomingArchiveList();
  }

  if (changes.minimumTabCount) {
    minimumTabCount = changes.minimumTabCount.newValue;
    // Same: apply the new minimum right away.
    evaluateWindow(focusedWindowId);
    refreshUpcomingArchiveList();
  }

  if (changes.protectedHostnames) {
    protectedHostnames = changes.protectedHostnames.newValue || [];
    // Re-check now so an added or removed protected domain applies to tabs
    // that are already open.
    evaluateWindow(focusedWindowId);
    refreshUpcomingArchiveList();
  }

  if (changes.isEnabled) {
    isEnabled = changes.isEnabled.newValue;

    if (isEnabled) {
      // Turned ON: reset every tab's clock, so tabs that were idle before you
      // pressed Start get a full fresh countdown.
      const now = Date.now();
      const activeTabId = activeTabByWindow.get(focusedWindowId);
      for (const [tabId, ownerWindowId] of tabWindowId.entries()) {
        if (ownerWindowId === focusedWindowId && tabId !== activeTabId) {
          lastActiveTime.set(tabId, now);
        }
      }
      evaluateWindow(focusedWindowId);
    } else {
      // Turned OFF: cancel every pending alarm right away so nothing closes
      // after the toggle reads off.
      chrome.alarms.clearAll();
    }
    // Refresh the "up next" list either way (it clears itself when off).
    refreshUpcomingArchiveList();
  }
});

// Active tab changed in a window.
chrome.tabs.onActivated.addListener((activeInfo) => {
  // The tab being left starts its clock now.
  const previousActiveTabId = activeTabByWindow.get(activeInfo.windowId);
  if (previousActiveTabId !== undefined && previousActiveTabId !== activeInfo.tabId) {
    lastActiveTime.set(previousActiveTabId, Date.now());
  }

  activeTabByWindow.set(activeInfo.windowId, activeInfo.tabId);
  lastActiveTime.set(activeInfo.tabId, Date.now());
  tabWindowId.set(activeInfo.tabId, activeInfo.windowId);

  // Tracking always runs so state is current if the toggle flips mid-session.
  // Only scheduling closes is gated on isEnabled.
  if (isEnabled && activeInfo.windowId === focusedWindowId) {
    evaluateWindow(activeInfo.windowId);
    refreshUpcomingArchiveList();
  }

  // Active-time tracking is independent of isEnabled.
  if (TRACK_ACTIVE_TIME && activeInfo.windowId === focusedWindowId) {
    const now = Date.now();
    flushActiveSegment(now);
    startActiveSegment(tabHostname.get(activeInfo.tabId), now);
  }
});

// New tab opened.
chrome.tabs.onCreated.addListener((tab) => {
  lastActiveTime.set(tab.id, Date.now());
  tabWindowId.set(tab.id, tab.windowId);
  tabHostname.set(tab.id, hostnameFromUrl(tab.url));
  if (tab.pinned) {
    pinnedTabIds.add(tab.id);
  }
  if (tab.audible) {
    audibleTabIds.add(tab.id);
  }

  if (isEnabled && tab.windowId === focusedWindowId) {
    evaluateWindow(tab.windowId);
    refreshUpcomingArchiveList();
  }
});

// Tab closed: stop tracking it and clear its alarm. Re-check the window,
// since a manual close may bring it down to the minimum.
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  chrome.alarms.clear(alarmNameForTab(tabId));
  lastActiveTime.delete(tabId);
  tabWindowId.delete(tabId);
  tabHostname.delete(tabId);
  pinnedTabIds.delete(tabId);
  audibleTabIds.delete(tabId);

  if (isEnabled && removeInfo.windowId === focusedWindowId) {
    evaluateWindow(focusedWindowId);
    refreshUpcomingArchiveList();
  }
});

// Pinned or audible changed: update tracking and re-check the window. Gaining
// either cancels the tab's alarm; losing both makes it eligible again.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  let relevant = false;

  if (changeInfo.url !== undefined) {
    // Navigating can move a tab into or out of a protected domain, so
    // re-evaluate.
    relevant = true;
    const newHostname = hostnameFromUrl(changeInfo.url);
    tabHostname.set(tabId, newHostname);

    // Credits a tab that navigates across sites: a domain change on the
    // active tab ends the old domain's segment and starts the new one.
    if (TRACK_ACTIVE_TIME && tabId === activeTabByWindow.get(focusedWindowId)) {
      const now = Date.now();
      flushActiveSegment(now);
      startActiveSegment(newHostname, now);
    }
  }

  if (changeInfo.pinned !== undefined) {
    relevant = true;
    if (changeInfo.pinned) {
      pinnedTabIds.add(tabId);
    } else {
      pinnedTabIds.delete(tabId);
    }
  }

  if (changeInfo.audible !== undefined) {
    relevant = true;
    if (changeInfo.audible) {
      audibleTabIds.add(tabId);
    } else {
      audibleTabIds.delete(tabId);
    }
  }

  if (!relevant) return;

  if (isEnabled && tabWindowId.get(tabId) === focusedWindowId) {
    evaluateWindow(focusedWindowId);
    refreshUpcomingArchiveList();
  }
});

// OS focus moved to another Chrome window, or left Chrome (WINDOW_ID_NONE).
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Focus left Chrome: stop the active-time clock. Tab freezing below is
    // unchanged.
    if (TRACK_ACTIVE_TIME) {
      flushActiveSegment(Date.now());
      chromeIsFocused = false;
    }
    return;
  }

  // Regaining focus on the same window still needs a new segment.
  // focusedWindowId doesn't change, so this runs before the early return
  // below.
  if (TRACK_ACTIVE_TIME && !chromeIsFocused) {
    chromeIsFocused = true;
    if (windowId === focusedWindowId) {
      const activeTabId = activeTabByWindow.get(focusedWindowId);
      startActiveSegment(tabHostname.get(activeTabId), Date.now());
    }
  }

  if (windowId === focusedWindowId) return;

  if (TRACK_ACTIVE_TIME) {
    flushActiveSegment(Date.now());
  }

  // The tab being left starts its clock now.
  const departingTabId = activeTabByWindow.get(focusedWindowId);
  if (departingTabId !== undefined) {
    lastActiveTime.set(departingTabId, Date.now());
  }

  freezeWindow(focusedWindowId);
  focusedWindowId = windowId;
  if (isEnabled) {
    evaluateWindow(focusedWindowId);
  }
  refreshUpcomingArchiveList();

  if (TRACK_ACTIVE_TIME) {
    const newActiveTabId = activeTabByWindow.get(focusedWindowId);
    startActiveSegment(tabHostname.get(newActiveTabId), Date.now());
  }
});

// A close-alarm fired. Chrome wakes the service worker for this even if it
// was terminated after the alarm was scheduled.
chrome.alarms.onAlarm.addListener((alarm) => {
  // Turning the extension off already clears all alarms; check again anyway
  // so a tab never closes while the toggle reads OFF.
  if (!isEnabled) return;

  const tabId = Number(alarm.name.replace('close-tab-', ''));
  closeAndRecordTab(tabId);
});

// The toolbar icon opens the options page. There's no default_popup in the
// manifest, which is what makes this event fire.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// Quick-protect keyboard shortcut. Add-only and idempotent on purpose:
// pressing it always ensures the current domain is protected and never
// removes one, so a stray press can't unprotect anything. It doesn't depend
// on the page, so it also works on sites like Figma and Google Docs that
// replace the right-click menu.
//
// Confirmation is the toolbar icon flashing a shield. That's our own UI, so
// it works on every page, including chrome:// pages.
//
// Keep PROTECTED_HOSTNAMES_LIMIT in sync with options.js by hand; the files
// share no imports.
const PROTECTED_HOSTNAMES_LIMIT = 100;
const PROTECTED_ICON_FLASH_MS = 1500;
const DEFAULT_ICON_PATHS = {
  16: "icons/icon16.png",
  32: "icons/icon32.png",
  48: "icons/icon48.png",
  128: "icons/icon128.png",
};
const PROTECTED_ICON_PATHS = {
  16: "icons/icon16-protected.png",
  32: "icons/icon32-protected.png",
  48: "icons/icon48-protected.png",
  128: "icons/icon128-protected.png",
};

function flashProtectedIcon() {
  chrome.action.setIcon({ path: PROTECTED_ICON_PATHS });
  setTimeout(() => {
    chrome.action.setIcon({ path: DEFAULT_ICON_PATHS });
  }, PROTECTED_ICON_FLASH_MS);
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "protect-current-tab") return;
  if (!tab || !tab.url) return;

  const hostname = hostnameFromUrl(tab.url);
  if (!hostname) return;

  chrome.storage.local.get({ protectedHostnames: [] }, (result) => {
    const list = result.protectedHostnames;
    const alreadyProtected = list.some(
      (entry) => hostname === entry || hostname.endsWith(`.${entry}`)
    );

    if (alreadyProtected) {
      // Already protected (exact match or parent domain): flash to confirm,
      // write nothing.
      flashProtectedIcon();
      return;
    }

    if (list.length >= PROTECTED_HOSTNAMES_LIMIT) {
      // At the cap: do nothing rather than remove an entry. This shortcut
      // only adds.
      return;
    }

    chrome.storage.local.set({ protectedHostnames: [hostname, ...list] }, () => {
      flashProtectedIcon();
    });
  });
});