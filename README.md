# Kay SKU Scanner

A mobile-first PWA that requests rear-camera access, OCRs the center scan region, detects exactly one 9-digit SKU, confirms the same SKU across two OCR passes, and then opens a Kay.com search for that SKU.

## Features

- Rear camera (`facingMode: environment`)
- On-device camera frame processing
- Tesseract.js OCR with a reusable worker for faster repeated scans
- Exactly 9-digit SKU detection
- Two-read confirmation before redirect
- Manual SKU entry fallback
- Local scan history
- Installable PWA
- No backend required

## Run locally

Camera access requires a secure context. Desktop `localhost` is treated as secure by browsers, but for a phone you should deploy the folder to an HTTPS host.

For a desktop test:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Deploy

This is a static site. Upload the contents of this folder to any HTTPS static host such as Netlify, Vercel, Cloudflare Pages, GitHub Pages, or a normal HTTPS web server.

## Kay search behavior

The search URL is centralized near the top of `app.js`:

```js
kaySearchUrl: (sku) => `https://www.kay.com/search?text=${encodeURIComponent(sku)}`
```

If Kay changes its site-search path later, only that line needs to be updated.

## OCR note

Tesseract.js is loaded from jsDelivr, so the scanner needs internet access on first load. Kay lookup itself also requires internet access.
