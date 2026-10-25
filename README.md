# Melissa API

Minimal Node.js HTTP API that uses the public TikWM endpoint to resolve a TikTok video and streams the returned media to the caller.

## Hostless

- Runtime: Node.js 20+
- Start command: `npm start` (or `node server.js`)
- Port: uses `PORT` from the environment, falling back to `3000`
- Health check: `GET /health`
- Download: `POST /download` with JSON `{"url":"https://www.tiktok.com/@user/video/123"}`

No npm dependencies are required.

## Test

Health check:

```sh
curl https://YOUR-HOSTLESS-DOMAIN/health
```

Download to a local file:

```sh
curl -X POST https://YOUR-HOSTLESS-DOMAIN/download \
  -H 'Content-Type: application/json' \
  -d '{"url":"YOUR_PUBLIC_TIKTOK_URL"}' \
  --output video.mp4
```

The API streams the media instead of saving it to disk. The 500 MB limit is a basic safeguard for this initial test. The public TikWM endpoint may change, rate-limit requests, or fail for some videos. Keep this prototype for personal testing and add authentication/rate limiting before exposing it broadly.
