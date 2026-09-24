# Ledgerly Trading Journal

A static personal trading-journal interface designed for GitHub Pages.

## Run

Open `index.html` directly in a browser. The UI uses Chart.js from a CDN, so an internet connection is required for the dashboard charts.

## Included

- Hash-routed Dashboard, Journal, and Settings views
- Responsive dark journal UI that starts empty and ready to use
- Chart.js cumulative P&L and strategy charts
- localStorage cache, JSON export/import, and optional passphrase-encrypted GitHub Gist synchronization

## GitHub Gist Setup

Ledgerly keeps the journal usable locally if GitHub is unavailable. GitHub synchronization is manual and stores one file named `trading-journal.json` in one secret/private Gist.

1. In GitHub, open **Settings** > **Developer settings** > **Personal access tokens** > **Tokens (classic)** > **Generate new token (classic)**.
2. Give the token a recognizable name, choose an expiry, and enable only the `gist` scope. Create and copy the token immediately; GitHub will not show it again.
3. Open [gist.github.com](https://gist.github.com), create a **secret** Gist, and add a file named exactly `trading-journal.json`. Its initial contents may be a JSON export from Ledgerly.
4. Copy the Gist ID from the Gist URL. It is the final URL segment.
5. In Ledgerly, open **Settings** > **GitHub storage**, paste the token and Gist ID, then select **Save connection**. The token is held only in `sessionStorage` for the current browser session and the field is cleared immediately.
6. Use **Load from GitHub** to intentionally replace the local cache with the remote journal, or **Save to GitHub** to intentionally replace the remote file with the local journal.
7. Use **Sync now** for version-aware synchronization. Every document includes `dataVersion`, `updatedAt`, and `deviceId`. Ledgerly reads the remote file before every save; if the remote version is equal to or newer than a different local copy, it opens a conflict screen instead of overwriting GitHub.
8. In a conflict, choose **Keep Local** to save a new version higher than both copies, **Keep Remote** to intentionally replace the local cache, or **Export Both** to download both JSON documents before deciding. No remote overwrite happens until you explicitly choose Keep Local.

The token is never included in source code, exported journal JSON, the Gist file, or application logs.

## Publish

Push this folder to a GitHub repository and configure GitHub Pages to deploy from the repository root.
