# MLPR User Guide

A tour of every screen and setting in My Local Plane Radar. If you haven't
installed MLPR yet, see the [README](../README.md) first — this guide
assumes it's already running and open in your browser.

## Contents

- [The map](#the-map)
- [Aircraft details](#aircraft-details)
- [List](#list)
- [Stats](#stats)
- [Settings](#settings)
  - [General](#general-tab)
  - [Map](#map-tab)
  - [Aircraft](#aircraft-tab)
  - [Notifications](#notifications-tab)
  - [Server](#server-tab)
- [Setting up push notifications (ntfy)](#setting-up-push-notifications-ntfy)
- [Building a watch list](#building-a-watch-list)

## The map

The map is the whole screen — there's no separate "home" page. Aircraft
appear as small plane-shaped icons that rotate to match their heading. A
bottom bar with three pill-shaped buttons (List, Stats, Settings) floats
over the map and stays reachable everywhere.

- **Click an aircraft** to select it: the icon gets a soft glow ring so you
  can keep track of it among many others, and its trail (recent flight
  path) is drawn.
- **Hover an aircraft** (or a row in the List panel) to cross-highlight it
  between the map and the list — a different visual effect from selection,
  so the two states are never confused.
- Icons **fade toward red** if an aircraft stops sending updates, and are
  removed from the map after 5 minutes of silence. If it comes back, the
  gap in its trail is drawn grey.
- Right-click-drag (map rotate/tilt) is disabled on purpose — the map
  always stays north-up and flat, like a real radar display.

Trail color follows altitude by default: green under 10,000 ft, blue in the
climb through 17,500 ft, shading to red by 30,000 ft. See
[Aircraft → Aircraft color](#aircraft-tab) to switch the *aircraft icon*
color to the same altitude scheme, or to speed instead.

Small text labels can appear under each icon (callsign by default) — what's
shown is configurable per [Aircraft tab](#aircraft-tab), and labels
automatically hide when you zoom out far enough that they'd just clutter
the screen.

## Aircraft details

Clicking an aircraft opens a small info card with the essentials (callsign,
squawk, altitude, vertical rate, speed). A **"show more fields"** button
expands it into the full details panel: heading/attitude, autopilot/FMS
targets, military/interesting/PIA/LADD flags, weather data the receiver
computed, signal quality, and the raw ICAO hex — roughly ordered from most
to least interesting to a spotter. Fields with no data for that aircraft
are simply skipped, never shown as a blank dash.

If the aircraft has a known registration, MLPR also tries to fetch a photo
from [Planespotters'](https://www.planespotters.net/) public API, shown at
the top of the panel. No match (or no registration) just means no photo —
never an error.

### Icon shapes

MLPR currently draws four icon shapes, picked from the aircraft's reported
category and type: passenger/airliner, light GA (Cessna-class), helicopter,
and ground station (readsb's own antenna, if it reports one). More shapes
(glider, balloon, drone/UAS, and others) are planned as the ADS-B category
data is used more fully — see the project's `TODO.md`.

![Aircraft icon shapes](images/icon-gallery.png)

## List

![List panel](images/list-panel.png)

A sortable table of every aircraft currently on the map: flight/callsign,
type, altitude, speed. Click a column header to sort, click a row to select
that aircraft on the map (and center on it), or use the search box to
filter by callsign, registration, or type. The total aircraft count is
shown above the table.

## Stats

![Stats overview](images/stats-panel.png)

A full-screen view (not a side panel, since charts need the room) with
three live numbers at the top — current aircraft count, messages/sec, and
this session's max range — plus six charts and a searchable table of every
registration ever seen. A range selector (24h / 7d / 31d / 1y / all time,
your last choice is remembered) controls all charts and the table together:

- **Aircraft seen** — average and max simultaneous aircraft, over time.
- **With / without position** — how many aircraft had a reported position
  vs. Mode-S-only contacts with no lat/lon.
- **Antenna range** — the all-time max range record, plus a "top ~10%
  average" figure per period: the mean of that period's best few-percent of
  one-minute range samples. This is more representative of typical good
  reception than the single all-time max, which can be one lucky spike.
- **New registrations** — first-time-seen aircraft, bucketed over the
  selected range.
- **Most common aircraft type** / **Most common airline** — doughnut charts
  counting *distinct registrations*, not raw message volume, so one
  aircraft passing overhead every day doesn't dominate the chart. Airline
  identification is derived from the callsign against
  [OpenFlights](https://openflights.org/data.html) data (ODbL-licensed);
  military and general-aviation callsigns are correctly excluded rather
  than mismatched.

Below the charts, **"All registrations"** loads a full table of every
registration MLPR has ever tracked (lazy-loaded — it's not fetched until
you ask for it), sortable, paginated 20 rows at a time, with its own search
box:

![Registrations table, paginated](images/stats-pagination.png)

## Settings

Settings is organized into five tabs. A banner at the top of each tab tells
you its scope: most tabs apply **only to this browser** (stored locally,
so your phone and laptop can have different preferences), while
**Notifications** and **Server** are **shared by everyone** on the radar
(stored on the Pi, since they affect what gets sent and how the app is
reached).

### General tab

![General settings](images/settings-general.png)

Just one choice: **units** — imperial (nautical miles, feet) or metric
(kilometers, meters). Applies everywhere in the app (list, stats, aircraft
details, notification messages).

### Map tab

![Map settings](images/settings-map.png)

- **Basemap**: *Online* (detailed vector map, needs internet) or *Offline*
  (no internet needed, uses a bundled world map — coastlines, borders,
  rivers, major cities — coarser detail but works with no connection at
  all). If the online map can't be reached, MLPR falls back to offline
  automatically for the rest of that browser tab.
- **Map appearance**: Light, Dark, or **Automatic** (follows sunrise/sunset
  at the receiver's location). This is the *map's* color scheme only — the
  bottom bar and panels always stay dark, since this is meant to be
  readable on a wall-mounted screen at night regardless of the map
  underneath.
- **Trails**: draw a trail for *only the selected aircraft* (default) or
  *all aircraft at once*. The **"Use shorter trails"** checkbox is a
  performance option — it caps how much trail history is kept per
  aircraft on this device, useful on a slower phone/tablet if the map
  feels sluggish with lots of traffic. Hover the "i" next to it for
  details.
- **Receiver location marker**: toggles a pulsing dot at the receiver's
  home location on the map.

### Aircraft tab

![Aircraft settings](images/settings-aircraft.png)

- **Icon size**: a slider from 24 to 64 px.
- **Aircraft color**: what the plane icon's color represents — *red on
  signal loss* (default: green, fading to red as an aircraft's data goes
  stale), *depends on altitude*, or *depends on speed*.
- **Map labels**: choose which fields appear under each aircraft icon on
  the map — callsign/hex, aircraft type, altitude, speed. Leave everything
  unchecked to hide labels entirely and keep the map clean.
- **Altitude filter**: hide aircraft below and/or above a given altitude
  (feet), useful for filtering out distant airliners at cruise if you only
  care about local traffic, or vice versa.

### Notifications tab

![Notifications settings](images/settings-notifications.png)

Turns on push notifications for interesting events, delivered via
[ntfy](https://ntfy.sh) (see [setup below](#setting-up-push-notifications-ntfy)):

- **Squawk alerts** — an aircraft sets an emergency squawk code: 7500
  (hijack), 7600 (radio failure), 7700 (general emergency). Each code can
  be toggled independently.
- **First time seen aircraft** — notifies the first time MLPR ever
  observes a given aircraft. Note: on a brand new install, every aircraft
  currently in range will fire this notification once, since none of them
  have been "seen" before yet.
- **New range record** — a new all-time maximum reception distance.
- The **watched aircraft** list below is covered in its own section: see
  [Building a watch list](#building-a-watch-list).

### Server tab

![Server settings](images/settings-server.png)

- **Security** — off by default (this is meant for a home LAN). Turning it
  on requires a password to view or change *this tab* (server port,
  receiver location, the password itself) — everything else in Settings
  stays open, since there's no real security benefit to gating routine
  display preferences behind a login.
- **Server port** — which port the web interface is served on (default
  1090). Changing it needs an MLPR service restart, and you'll need to
  reach the app at the new port afterwards — MLPR shows you the exact new
  URL and asks you to confirm before saving, so you don't lock yourself out
  of a headless Pi by mistyping a number.
- **Home location** — MLPR auto-detects the receiver's coordinates from
  readsb's `receiver.json` at startup. You can override it manually here
  (e.g. if auto-detection picked up the wrong value, or your receiver
  doesn't report a location) — this feeds range calculations, the home
  marker, and the "automatic" map theme's sunrise/sunset calculation.

## Setting up push notifications (ntfy)

1. Open Settings → Notifications and turn on the events you want.
2. Install the free [ntfy](https://ntfy.sh) app on your phone (Android/iOS)
   or use it in a browser.
3. In ntfy, subscribe to the topic code shown in MLPR's Notifications tab
   (an 8-character code like the one in the screenshot above — yours will
   be different). Treat it like a password: anyone who knows it can read
   your notifications, since ntfy's public topics aren't private by
   default.
4. That's it — matching events now push a notification to your phone,
   including a tap-to-open link back into MLPR when possible.

You can regenerate the topic code at any time from the same tab (e.g. if
you think it's leaked) — you'll need to re-subscribe in ntfy afterwards.

## Building a watch list

The watch list lets you get notified about *specific* aircraft, independent
of the general rules above. Each entry matches on one of:

- **Aircraft type** (e.g. `B738`) — matches any aircraft of that type.
- **Registration** (e.g. `SP-LOT01`) — matches one specific airframe.
- **Flight / callsign** (e.g. `RYR4521`) — matches a specific flight number.

Matching is case-insensitive. Each entry can optionally add an altitude
condition (*below* / *above* a given feet value) — useful for something
like "notify me about this type, but only when it's low enough to actually
be worth looking up at." If the needed altitude data isn't available for a
given contact, the condition simply doesn't match — you'll never get a
false positive from missing data.

Add entries from Settings → Notifications → Watched aircraft; each has its
own **Remove** button once added.
