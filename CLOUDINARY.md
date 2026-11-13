# Cloudinary community uploads

The community composer and profile editor use Firebase authentication and calls `POST /uploads/signature`
with a Firebase ID token. The server verifies that token with Firebase's Identity
Toolkit, signs a restricted upload, and never returns the Cloudinary API secret.
The browser uploads directly to Cloudinary and saves its HTTPS URL in the profile.
This route is registered independently of the MongoDB connection.

Backend environment settings:

- `CLOUDINARY_URL`: securely store the rotated Cloudinary URL. Never commit it or
  add a `VITE_` prefix. URL-encode credential components containing special characters.
- `CLOUDINARY_UPLOAD_PRESET`: create a **signed** preset in Cloudinary's upload
  settings. Restrict allowed formats to jpg/jpeg, png and webp, maximum file size
  to 5 MB, and prevent overwriting. Configure these restrictions at Cloudinary,
  since browser checks can be bypassed. Set an account quota/usage alert too.
- `FIREBASE_WEB_API_KEY`: the web API key for the same Firebase project as the
  frontend. The backend also accepts `VITE_apiKey` for existing environments.

Frontend: set `VITE_API_URL` to the deployed backend origin. The existing hosted
backend is used as a fallback. Set this before building the frontend.

Allow outbound HTTPS to identitytoolkit.googleapis.com from the backend and
api.cloudinary.com for browser uploads; images are delivered by res.cloudinary.com.

Run `node --test cloudinary-upload.test.js`. Tests use fake credentials and mocked
Firebase responses; they do not upload files or change any remote account.
For deployment validation, sign up with a test account and a small image, confirm
the resulting profile URL uses Cloudinary, and check that anonymous signature
requests return 401. Do not reuse the Cloudinary secret previously shared in chat.

All 11 former ImgBB repository image URLs and the local image asset have been copied to Cloudinary. API uploads and VITE_IMAGEBB_KEY are no longer used. A scan of the connected database found no pre-existing image records to migrate.
The broader backend authorization issues in the system audit remain separate.
New accounts can exist in Firebase if a subsequent upload or profile save fails;
the signup UI reports this and directs the user to sign in rather than retry blindly.
