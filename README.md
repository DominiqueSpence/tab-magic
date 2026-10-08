# Tab Magic

Tab Magic seamlessly closes the tabs you've forgot to close, so you don't have to think twice.
If you have ever:

- Had so many tabs open most of their icons have turned into a greyed-out planet favicon
- Had to ask yourself "why is this tab still here?"
- Or been called out in a meeting for too many tabs this is what you've been missing.

**Tab Magic is for you.**

*Status: unlisted beta (v0.2.0). Feedback is very welcome.*

![Tab Magic home screen with the Start the Magic button, tab counts, and inactivity settings](images/01-home.png)

![Tab Magic active state with orange Stope the Magic button](images/02-running.png)

![Tab Magic's Tab Management section, where you can manage all Archived Tabs, and add or remove Protected Tabs that never get removed from your window](images/03-tab-management.png)




## Why I made Tab Magic

I'll admit it: I am a tab hoarder.

I would have so many tabs open that I couldn't tell which tab was which anymore and this is a problem not only my friends, but my colleagues had as well. There are other tab management applications out there but they were really bare bone and felt pretty unintuitive to use. So I designed a solve for this.  

## What it does

You choose how long a tab can sit untouched (minutes, hours, or days). Once Tab Magic is on, the magic starts and tabs you haven't been active on for that set amount of time are closed and moved to your Archived Tabs list.

- **Off until you turn it on.** Nothing closes until you press Start the Magic.
- **A minimum tab count.** Set a number of tabs to always keep open, and Tab Magic will never go below it.
- **Protected sites.** Add a site like `zoom.us` and it, along with its subdomains, is never closed.
- **Pinned tabs and tabs playing audio** are never closed.
- **Only the window you're using counts down.** Other windows are paused until you return to them.
- **Nothing is lost.** Closed tabs go to Archived Tabs (up to 100), and you can restore one from there.

## How to use it

1. Click the Tab Magic icon in your toolbar to open its page.
2. On **Home**, set how long a tab can be inactive and the minimum number of tabs to keep open.
3. Press **Start the Magic**. The button turns amber while it's running. Press it again to stop.
4. On **Tab Management**, you can see Archived Tabs (click one, then confirm, to restore it) and manage Protected Tabs.
5. To protect the site you're on right now, press `Cmd+Shift+P` on Mac or `Ctrl+Shift+P` on Windows and Linux.

![Tab Management screen listing archived tabs and protected sites, with Add and Remove buttons](docs/screenshots/03-tab-management.png)

## Install

**From source (for testers):**

1. Download this repository and unzip it.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder.

Chrome will show a "developer mode extensions" reminder when it starts. That's normal for extensions installed this way.

**From the Chrome Web Store:** TBA on Chrome Store approval

## Troubleshooting

**A tab didn't close when I expected it to.** Check these:

- Is Tab Magic on? The button should say **Stop the Magic and glow orange**.
- Is the window at or below your minimum tab count? Tab Magic never closes a tab if that would leave the window with fewer tabs than your minimum.
- Is the tab active, pinned, playing audio, or on a protected site? Those are never closed.
- Was that window in the background? Only the window you're using counts down, so a window you left will keep its timers paused.

## Good to know

- **Unsaved work:** Tab Magic doesn't (yet) have special handling for pages that warn you about unsaved changes. If you keep drafts on a site (documents, forms), add that site to Protected Tabs.
- **Duplicate tabs:** click the Home screen's duplicate tile to close them. The most recently opened tab in each duplicate group is kept; pinned, protected, or audio-playing duplicates are left open (and the tile tells you when that happens).

## Privacy

Everything stays on your computer. Tab Magic has no servers, no accounts, and no analytics. It only stores your settings and the list of tabs it has closed, locally in your browser. Full details: [Privacy Policy](https://dominiquespence.github.io/tab-magic/privacy-policy)

## Feedback and support

Found a bug or have an idea? [Open an issue](https://github.com/DominiqueSpence/tab-magic/issues) or email seeyou@dominiqueworks.com.

Maintained by [@DominiqueSpence](https://github.com/DominiqueSpence).

## What's coming

- A popup window that opens when you click the pinned "Tab Magic" icon which shows high level stats (such as # of opened tabs and Chrome windows)
- I list of predetermined protected tabs (such as Zoom, Google Meet, Gmail) that generally speaking users would rather not close automatically at any point. 

## Under the hood

For the curious: it's a Chrome Manifest V3 extension using a background service worker, per-tab alarms, and `chrome.storage`. There are no dependencies or build step. It's plain HTML, CSS, and JavaScript.
