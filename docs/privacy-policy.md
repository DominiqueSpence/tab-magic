# Tab Magic Privacy Policy

*Last updated: September 26, 2026*

Tab Magic does not transmit, sell, or share any user data. Everything the extension does happens entirely on your device. It stores a small amount of information about your tabs locally (the URL, title, and favicon of tabs it has closed, plus your settings), and it uses only the following Chrome permissions:

### `tabs` permission
Used to read each open tab's URL, title, and favicon. The URL lets Tab Magic recognize domains you've marked as protected; the title and favicon are shown in your Archived Tabs list inside the extension's settings page. Tab Magic also uses Chrome's standard tab-management features to close tabs that qualify and to reopen one you choose to restore, and it notes which tabs are pinned or playing audio so it can leave them alone.

### `alarms` permission
Used to schedule the inactivity timer for each tab, meaning "check this specific tab again once its inactivity limit is reached." No data is attached to or read from an alarm itself; it's purely a scheduling mechanism.

### `storage` permission
Used to save your settings (inactivity duration, minimum-tab-count safety rail, protected domains) and a short list of recently closed tabs, entirely on your device via Chrome's built-in local storage API. This is what lets your preferences persist between browser sessions and lets a closed tab be restored later. None of this information is ever sent anywhere else.

## What Tab Magic does not do

- Tab Magic runs entirely on your device: there are no servers, analytics, or third-party services of any kind, and your settings and history are never transmitted anywhere. The one network request involved is that the Archived Tabs list displays each site's favicon by loading it from the address the site itself provides, the same image your browser already showed when you visited.
- No account or sign-in is required or collected.
- No browsing history is retained beyond the short "recently closed" list, which you can clear at any time by removing the extension.

## Contact

Questions about this policy can be directed to <https://github.com/DominiqueSpence/tab-magic> or by email at <seeyou@dominiqueworks.com>.


