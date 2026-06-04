# Run middle as a system service

`mm start` runs the dispatcher as a background process you start by hand and stop with `mm stop`. To have middle come up automatically on boot, restart if it crashes, and log somewhere durable, run it under your platform's service manager — **systemd** on Linux, **launchd** on macOS. Both drive the same command:

```bash
mm start --foreground
```

`--foreground` runs the dispatcher **in-process**: it does not fork and writes **no** `~/.middle/dispatcher.pid` file. That's deliberate — the service manager owns the lifecycle (start, stop, restart), so middle must not daemonize behind its back. The process runs until it receives `SIGTERM`, which it handles by draining cleanly and exiting 0. Don't mix `mm stop` with a service-managed daemon; stop it through the service manager instead.

Run `mm doctor` first and make sure it passes — the service will inherit the same toolchain, so a missing `tmux` or unauthenticated `gh` fails the same way under systemd/launchd, just less visibly.

## Linux — systemd

A **user service** is the simplest setup and matches the commands below. Write `~/.config/systemd/user/middle.service`:

```ini
[Unit]
Description=middle — autonomous GitHub issue dispatcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# `mm` has a `#!/usr/bin/env bun` shebang, so bun must be on PATH. `%h` is your home.
Environment=PATH=%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.bun/bin/mm start --foreground
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

systemd captures the process's stdout and stderr into the journal automatically, so no log paths are needed. Adjust `%h/.bun/bin/mm` if your `mm` lives elsewhere (`command -v mm` tells you).

Install and enable it — `enable --now` starts it immediately and on every boot:

```bash
systemctl --user daemon-reload
systemctl --user enable --now middle.service
# Let the user service run without an active login session (survives logout/reboot):
loginctl enable-linger "$USER"
```

Verify it's up, and tail its logs:

```bash
systemctl --user status middle      # Active: active (running)
journalctl --user -u middle -f      # follow the daemon's output
```

Stop or restart through systemd, never `mm stop`:

```bash
systemctl --user restart middle
systemctl --user stop middle
```

### System-wide alternative

To run middle as a system service independent of any login (e.g. on a server), put the unit at `/etc/systemd/system/middle.service`, add a `User=` (and usually a `Group=`), and target the multi-user boot:

```ini
[Service]
Type=simple
User=middle
Environment=PATH=/home/middle/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/middle/.bun/bin/mm start --foreground
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl daemon-reload && sudo systemctl enable --now middle`, check with `systemctl status middle`, and read logs with `sudo journalctl -u middle -f`.

## macOS — launchd

launchd does **not** expand `~`, so use absolute paths. Replace `YOUR_USERNAME` with your account (run `whoami`). Write `~/Library/LaunchAgents/io.middle.dispatcher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.middle.dispatcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOUR_USERNAME/.bun/bin/mm</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/YOUR_USERNAME/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USERNAME/Library/Logs/middle.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USERNAME/Library/Logs/middle.log</string>
</dict>
</plist>
```

`RunAtLoad` starts middle when the agent loads (and at login); `KeepAlive` restarts it if it crashes. Both stdout and stderr go to `~/Library/Logs/middle.log`.

Load it (the `-w` flag persists it across reboots):

```bash
launchctl load -w ~/Library/LaunchAgents/io.middle.dispatcher.plist
```

Verify it's registered, and tail its log:

```bash
launchctl list | grep middle       # shows the PID and the io.middle.dispatcher label
tail -f ~/Library/Logs/middle.log  # follow the daemon's output
```

Unload it (the launchd equivalent of stopping) with:

```bash
launchctl unload -w ~/Library/LaunchAgents/io.middle.dispatcher.plist
```

> On recent macOS the modern equivalents are `launchctl bootstrap gui/$(id -u) <plist>` and `launchctl bootout gui/$(id -u)/io.middle.dispatcher`. The `load -w` / `unload -w` forms above still work and are simpler.

## What you get

- **Survives a reboot.** systemd (with linger) and launchd (`RunAtLoad`) bring middle back automatically.
- **Restarts on crash.** `Restart=on-failure` / `KeepAlive` relaunch the daemon if it exits unexpectedly.
- **Durable logs.** The journal (Linux) or `~/Library/Logs/middle.log` (macOS) keeps the output the foreground process emits.

Nothing else about middle changes: it serves the same dashboard on `global.dispatcher_port`, dispatches the same way, and GitHub is still the source of truth for the work. You've only changed *who* starts and stops the daemon — see the [operator guide](operator.md) for the day-to-day `mm` commands.

## Not covered

- **Windows services** and **Docker / containerized** deployment are separate workstreams — file an issue if you need them.
