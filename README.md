# Zen Zephyr community API

Express/MongoDB API deployed through Netlify Functions at
https://zen-zephyr-api.netlify.app/api. `netlify.toml` wraps the Express application
with `serverless-http`; it opens no persistent listener in Functions.

## Secure runtime configuration

Set `MONGODB_URI`, `CLOUDINARY_URL`, `CLOUDINARY_UPLOAD_PRESET` and
`FIREBASE_WEB_API_KEY` in the backend's environment settings. `.env.example`
contains placeholders. Never commit `.env`, real credentials or deployment tokens.
The Firebase project must match the client. Cloudinary's signed image preset
must restrict JPG/PNG/WebP images to 5 MB. See `CLOUDINARY.md`.

```sh
npm ci
npm test
```

`npm start` is available for development. The deployed `/api/health` endpoint
checks database readiness. `/api/` alone is only liveness.

## Behavior

`/community` provides feeds, profiles, connections, posts, comments, saved posts,
activity notifications and moderation. Firebase ID tokens are verified server-side;
identities and privileged fields are never trusted from the request body. Only
post authors can edit/delete their own content, only request recipients can accept
connections, and friends-only visibility is checked before reads and interactions.
The legacy `/jwt` identity-exchange endpoint is retired.

MongoDB collections retain existing user/post/comment records. New data uses
`friendship`, `saved` and `notification` collections. Email/UID uniqueness and
query indexes are initialized on connection. If importing a legacy database with
duplicate identities, resolve them explicitly before adding these unique indexes;
do not silently delete user records. Tests use injected dependencies and isolated
fixtures, without touching a live database.

Repository images have been copied to Cloudinary; `scripts/site-image-map.json`
retains original-to-Cloudinary mappings for migration/recovery. New image URLs
must use this environment's Cloudinary account. Google-provider avatars are
copied to Cloudinary when a profile is first created. No original image is deleted
by the migration helper. Moderation is restricted to profiles with an existing
`admin` role; public registration never grants administrative access.


## Community expansion

The deployed system includes public/private groups with membership approval,
public pages with owner updates, direct messages with photos and read receipts,
24-hour stories, events with RSVPs, marketplace listings and account blocking.
Messaging refreshes every three seconds while a conversation is open; inboxes
refresh every ten seconds. These are authenticated conversations, without
end-to-end encryption. Marketplace payments and video calls are not implemented.

Twelve fictional demo profiles, ten posts and thirty comments are clearly labeled.
Demo accounts cannot receive connection requests or messages. Photos are served
from Cloudinary; the demo helper is idempotent and is not exposed as a deployed
HTTP endpoint. Stories are hidden immediately at expiry and MongoDB TTL indexes
remove their records later; Cloudinary assets are not automatically erased.

The frontend permits framing only by `https://sakib-studio.netlify.app` through
its response CSP. Keep `public/_headers` in the published frontend build and do
not add a conflicting `X-Frame-Options` header.
