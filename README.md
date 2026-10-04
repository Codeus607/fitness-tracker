# Fitness tracker

A small self-hosted workout log, installable on your phone as a web app (PWA).
Log workouts set by set, and track load, PRs, monthly stats and 1RM goals.
Runs on any PHP host with SQLite: no framework, no build step, no database server.

Live instance: https://fitness.simonsmind.com (private, password protected).

## Features

- **Workout logging** in the style of Strong/Hevy:
  - pick exercises by body part
  - one row per set (kg × reps), with a "previous" column showing last session's numbers
  - tick ✓ to save a set; empty fields reuse last time's numbers
  - warm-up sets, rest timer, notes, and backdating workouts
- **PR detection** 🏆 the moment a set beats your history.
- **Stats per month:**
  - workouts, active days, total load, working sets, exercises per day
  - a load-per-month chart and sets per muscle group
- **Best performance summary:**
  - best set, estimated 1RM, last set
  - days since last done, colour-coded (≤3d / ≤7d / older)
  - progress towards your goal
- **Exercise pages:** progress chart (est. 1RM / heaviest / load), rep records, goal progress, full history.
- **Plain-text backup:** after every save the server writes `Fitness.md` (a best-lifts table plus every workout), ready to sync into a notes app such as Obsidian.
- **Exercise list in markdown:** edit `exercises.md` to add exercises. No admin UI needed.

## How it computes things

- **Load** = reps × kg, summed over working sets. Warm-ups and timed exercises don't count.
- **Est. 1RM** uses the Brzycki formula: kg × 36 / (37 − reps).
- **`(bw)` bodyweight exercises:** kg is the *extra* weight only. Sets are ranked by extra weight, then reps, and goals are set in max reps.
- **`(sec)` timed exercises:** you log seconds instead of reps.

## Layout

| Path | What |
|---|---|
| `public/` | the app: upload this to your web folder |
| `public/api.php` | JSON API (PHP + SQLite), also writes the `Fitness.md` backup |
| `server/setpass.sh`, `setpass.php` | set the login password (run on the server) |
| `sync/` | optional laptop ↔ server sync: script + systemd user units |
| `deploy.sh` | rsync `public/` to the server over SSH |
| `exercises.example.md` | starter exercise list |

## Host it on your own website

**You need:** a web host with **PHP 8.1+** and the **pdo_sqlite** extension (most shared hosting has both), **HTTPS**, and SSH access (FTP works for uploading, but setting the password needs SSH).

1. **Upload the app.** Copy everything in `public/` to a web folder, e.g. a subdomain like `fitness.example.com`.
2. **Create a private data folder** *outside* the public web root, e.g. `~/fitness-data`, so nobody can download your database. Copy `server/setpass.php` and `server/setpass.sh` into it.
3. **Point the app at that folder.** Create `config.php` next to `api.php`:
   ```php
   <?php
   define("DATA_DIR", "/home/you/fitness-data");   // absolute path to the data folder
   define("TIMEZONE", "Europe/Brussels");          // your timezone
   ```
4. **Add your exercise list.** Copy `exercises.example.md` to the data folder as `exercises.md` and edit it. The format is `## Body part` headings with `- Exercise` items, and optional `(bw)` / `(sec)` / `(sec, bw)` tags.
5. **Set your password:** `ssh -t yourserver bash fitness-data/setpass.sh`. Running it again changes the password and logs out all devices. After 5 wrong logins, login is locked for 15 minutes.
6. **Install on your phone:** open the site, log in, then use "Add to Home Screen".

**Web server notes:**
- **Apache / LiteSpeed** hosts (Hostinger, most shared hosting) use the included `.htaccess`, which blocks `config.php` and forces HTTPS.
- **nginx** ignores `.htaccess`, so add `location = /config.php { deny all; }` yourself.

**Moving to a new host:** set it up as above, then copy `fitness.sqlite` into the new data folder. That one file holds your whole history.

## Deploying updates

Set `HOST` (an SSH alias from `~/.ssh/config`) and `WEB` (the web folder) in `deploy.sh`, then run `./deploy.sh`.
It uploads `public/` and bumps the service-worker cache so phones pick up the new version. On first run it also creates the data folder and `config.php`.

## Optional: sync with your notes + local backups

`sync/fitness-sync.sh` does three things:
- pushes `Fitness Exercises.md` from your notes folder to the server as `exercises.md`
- pulls `Fitness.md` back into your notes folder
- saves a consistent snapshot of the database to `~/.local/share/fitness-tracker/`: the latest copy plus one per day, kept for 30 days

You configure it with environment variables: `FITNESS_NOTES_DIR`, `FITNESS_BACKUP_DIR` and `FITNESS_HOST`.

To run it automatically on Linux with systemd:

```sh
cp sync/fitness-sync.{service,timer,path} ~/.config/systemd/user/
# point it at your notes folder (kept out of the repo, in drop-ins)
mkdir -p ~/.config/systemd/user/fitness-sync.{service,path}.d
printf '[Service]\nEnvironment="FITNESS_NOTES_DIR=%%h/Notes/Fitness"\n' > ~/.config/systemd/user/fitness-sync.service.d/local.conf
printf '[Path]\nPathChanged=\nPathChanged=%%h/Notes/Fitness/Fitness Exercises.md\n' > ~/.config/systemd/user/fitness-sync.path.d/local.conf
systemctl --user daemon-reload
systemctl --user enable --now fitness-sync.timer fitness-sync.path
```

Once enabled:
- The timer syncs every 10 minutes.
- The path unit pushes the exercise list as soon as you save it.
- To sync right away: `systemctl --user start fitness-sync`

**Restoring from a snapshot:** copy it to the server as `fitness-data/fitness.sqlite`.
