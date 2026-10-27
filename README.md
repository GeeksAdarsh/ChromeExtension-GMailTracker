# Seenly — Gmail Tracker

A small Chrome extension that shows, right inside Gmail, whether the people you mailed have opened it.

| Mark | Meaning |
| --- | --- |
| <span>✓</span> gray | Sent. Seenly is watching for an open. It pulses gently for the first 30 minutes. |
| <span>✓✓</span> green | They opened it. Hover over it to see how many times and when. |

The ticks appear in the Gmail list, next to the recipient's name. Opens on a phone, a tablet, or another computer all count.

## Install

1. Download this repository, either with `git clone https://github.com/GeeksAdarsh/ChromeExtension-GMailTracker.git` or with **Code → Download ZIP**, which you then unzip.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** in the top-right corner.
4. Click **Load unpacked** and choose the downloaded folder, the one that contains `manifest.json`.
5. Pin Seenly to the toolbar, click its icon, and follow the three-step guide.

## Use

1. **Connect Gmail.** Click the Seenly icon, then **Connect Gmail**, and sign in to the account you send from.
2. **Send mail as usual.** Seenly adds an invisible 1×1 image to every new mail you write. When you send, you'll see "Tracking whether … saw this".
3. **Watch the ticks.** A gray ✓ turns into a green ✓✓ within about a minute of the recipient opening the mail. The popup shows when Seenly last checked.

Seenly ignores your own opens, so reading your Sent folder won't mark a mail as seen.

## Use it on more than one computer

Seenly shares your tracked mail between computers through Chrome's own sync, the same feature that syncs your bookmarks. On each computer:

1. Sign in to Chrome with the **same Google account** and make sure **Sync is on** (`chrome://settings/syncSetup`).
2. Install Seenly from this repository as described in [Install](#install). The extension has a fixed ID, so every copy shares the same data.
3. Click the Seenly icon and connect the **same Gmail account**.

Mail you send on one computer then shows its ticks on all of them, and an open recorded by any computer shows up everywhere within a minute or two.

If Chrome sync is off, Seenly still works on each computer by itself. Each computer then only shows ticks for the mail sent from it.

## How it works

- Every mail gets its own random tracking ID. The hidden image points to `https://ntfy.sh/snly<id>/publish`. Loading the image posts a tiny message to that ntfy topic.
- Seenly checks those topics every minute, and every few seconds while Gmail is open, and turns the messages into ticks.
- When you send, Seenly posts a "sent" marker to the same topic. Image loads before that, such as Gmail's own draft preview, are ignored. When you open your own mail, Seenly posts a "my own view" marker, and the image load right next to it is ignored too.
- Loads less than 2 minutes apart count as one viewing.
- No server of your own is needed, and your computer doesn't have to stay on. Opens are held on ntfy.sh for 12 hours, so **open Chrome on any of your computers at least once every 12 hours** so that no open is missed.

## Limits

- **No location or device.** Gmail, Outlook, and most other mail apps load images through their own servers. Seenly can tell *that* a mail was opened, and when, but not where or on what device. No image-based tracker can.
- **Images turned off.** If the recipient blocks images, their opens can't be seen.
- **Apple Mail Privacy Protection** loads images on its own, so recipients using Apple Mail may show ✓✓ even if they didn't open the mail.
- **Mail written before Seenly was installed**, or written outside Gmail in Chrome, has no tracking image.
- **The ntfy.sh topics are public but unguessable.** Each topic name is a random 128-bit ID. Don't use Seenly for anything that needs real secrecy.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Ticks don't show | Refresh the Gmail tab. Check that the popup shows your account as connected. |
| "Extension context invalidated" under **Errors** | It comes from Gmail tabs that were open when Seenly was reloaded. Click **Clear all**, then close and reopen Gmail. |
| Popup says it can't reach the tracking service | The network is blocking `ntfy.sh`. The ticks catch up once it can connect again. |
| Another computer shows no ticks | Check Chrome sign-in and Sync on both computers, and that both are connected to the same Gmail account. |

## Project layout

```
manifest.json          Chrome extension manifest (load this folder)
extension/
  background.js        Polls ntfy.sh, works out opens, syncs between computers
  content.js           Runs in Gmail: adds the tracking image and draws the ticks
  popup.html/.css/.js  Toolbar popup and guide
  icons/
```

## Privacy

Seenly only tracks mail that you send from the Gmail account you connect. It never reads your inbox or anyone else's mail. Everything it keeps stays in your Chrome profile, apart from the open and sent markers on ntfy.sh, which expire after 12 hours.
