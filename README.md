# Orchestrator for ArcGIS

Configure ArcGIS map viewers without code.

The Orchestrator is a browser app that turns an ArcGIS web map into a configured map viewer — widgets,
tools, Details panels, dashboards, editing, 3D — and publishes it as a self-contained static site. No
build step, no bundler, no backend: a published viewer is plain HTML, CSS and ES modules that any web
server can host.

**[Open the demo viewers](viewer/)** · **[Read the user guide](docs/user-guide.htm)**

## The demo viewers

Three published viewers, each a folder of static files with its own `manifest.json` beside the page.
All three read public ArcGIS Online web maps, so none of them asks you to sign in, and none of them can
change any data. They are the three ways a viewer starts: imported from a Web AppBuilder app, imported
from an Experience Builder app, or built on a web map from scratch.

| Viewer | Where it came from | What it shows | Content |
|---|---|---|---|
| **[Saldanha GIS Viewer](viewer/saldanha/)** | Imported from a Web AppBuilder app | Layers, Legend, Search, Bookmarks, Details and Dashboards, with measure, draw, swipe, print and pointer coordinates; external pages on the rail. | *Public content reused with permission from Saldanha Bay Municipality.* |
| **[Citymaps GIS Viewer](viewer/citymaps/)** | Imported from an Experience Builder app | Add data and four search sources alongside Details and Dashboards, with elevation profile, dimensions, address audit, basemap gallery, share link and screenshot. | *Public content reused with permission from Stellenbosch Municipality.* |
| **[Overstrand GIS Viewer](viewer/overstrand/)** | Built on a public ArcGIS Online web map | The widest set: Details through related records, Dashboards, Layer information, Downloads, Streaming video and Attribute trace, with vegetation health, label orientation and go to coordinates. | *Public content reused with permission from Overstrand Municipality.* |

Each one keeps the colours and logo of the app or web map it came from — that branding is read from the
source, not typed in again, and each municipality has given permission for its public content to be
reused here. Editing is switched off in all three: the web maps are public, so an edit tool on this
site would be an edit tool for anybody.

## What it does

- Reads a web map's layers and builds a viewer from them: Layers, Legend, Layer information, Search,
  Bookmarks, Details, Dashboards, Add data, Editing, 3D scene, Streaming video, External pages,
  Downloads, Attribute trace.
- Details panels that follow a click through related records and other services, with results tables
  that export to Excel (.xlsx) and CSV.
- Tools: measure distance and area, select, draw, swipe, elevation profile, label orientation,
  dimensions, vegetation health, go to coordinates, address audit, basemap gallery, print, share link,
  screenshot, pointer coordinates.
- Draft preview runs the same runtime as the published viewer, so what you preview is what ships.
- Publishes to IIS, a Node.js Windows service or a Windows container, each with its own install script
  and an install page for the server.

## A look at it

| | |
|---|---|
| ![The Orchestrator's projects list](images/guide/projects.png) | **Projects.** Each viewer is a project: its web map, its settings and its published versions. |
| ![The widgets and tools settings page](images/guide/s-widgets.png) | **Settings, not code.** Switch widgets and tools on, set their options, preview, publish. |
| ![A published viewer showing its layer list](images/guide/v-layers.png) | **The published viewer.** A side rail, a header bar or a floating panel — the same runtime either way. |
| ![The Details panel](images/guide/v-details.png) | **Details.** One click gathers the feature, its related records and anything else you point at. |
| ![A dashboard of indicators and charts](images/guide/v-dashboards.png) | **Dashboards.** Indicators, charts and tables counted live from the map's own layers. |
| ![Attribute trace results](images/guide/v-trace-results.png) | **Attribute trace.** Follow a network from feature to feature, with the results listed and drawn. |

## Requirements

A published viewer needs only a web server that serves static files, and a current browser. The 3D
scene needs WebGL (a graphics card the browser can use). Services the viewer reads must allow requests
from the address it is hosted at (CORS).

## Third-party code

- [ArcGIS Maps SDK for JavaScript](https://developers.arcgis.com/javascript/latest/) 4.30, loaded from
  Esri's CDN, under Esri's terms.
- [Chart.js](https://www.chartjs.org/) 4 — MIT — dashboard charts.
- [hls.js](https://github.com/video-dev/hls.js) 1.5 — Apache-2.0 — camera and drone video.

Nothing else: no framework, no package manager, no build tooling.

## About this site

This site publishes the user guide and three demo viewers. The Orchestrator's own source is not published.
The demos' viewer runtime is here because a static viewer is served as readable source by nature —
there is no bundler or minifier in the project.

© Ashley Gahl. All rights reserved. Published as a demo and documentation, not an open-source release.

Site built 2026-11-16.
