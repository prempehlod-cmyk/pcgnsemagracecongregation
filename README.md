# Grace Congregation, Nsema-Aburaso: Netlify site

Folder layout
- `public/index.html`  the website (same design as before)
- `public/sw.js`, `public/_headers`  offline page cache and headers
- `netlify/functions/api.mjs`  online storage and logins (data kept in Netlify Blobs)
- `netlify.toml`, `package.json`  Netlify settings

## Publish (the function needs Git or the CLI; plain drag-and-drop uploads only the static page)
Option A, GitHub: put this folder in a GitHub repository, then in Netlify choose
Add new site > Import an existing project, pick the repository, and deploy. No build command is needed.

Option B, Netlify CLI: `npm i -g netlify-cli`, then in this folder run `netlify deploy --prod`.

## First login
Admin name `admin`, passcode `grace2026`. Log in, open Administration, and use
"Change administrator login" straight away. To start with different details, set the
environment variables ADMIN_USER and ADMIN_PASS in Netlify (Site configuration > Environment variables)
before the first login. Once you change the login inside the site, the new one is used.

## What is on the site
Home (main photo, extra picture holders, birthdays, Admin Login at the bottom right), History, Membership, Administration, Attendance, Statistics, Announcements, Sermons & Devotions, Upcoming Events, Gallery, Contact & SMS. All menus open from the Home ▾ button.

Birthdays use the Date of Birth saved on each member. Visitors only see name, day/month, group and photo for birthdays in the next 7 days; never the year.

## Moving the data from the old site
On the old site: Administration > Download backup file.
On the new site (logged in as admin): Administration > Upload backup file (restore).
Photos, members, attendance and text pages are included.
