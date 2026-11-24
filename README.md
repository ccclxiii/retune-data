# ReTune data

Station data for the ReTune radio app, read by the app at start-up:

- `stations-gr.json` — corrections for Greek stations from [Radio Browser](https://www.radio-browser.info)
  (names, cities, frequencies, duplicates folded into one) and stations Radio Browser doesn't list.
- `logos/` — station logos (256 px WebP).
- `podcasts/greek-shows.json` — Greek podcasts for the app's popular list, each by its own feed, and
  podcast companies whose shows carry each maker's own name.
- `podcasts/popular-gr.json` — that list as the app reads it, made every morning by
  `podcasts/build.mjs` (GitHub Actions) from each show's own feed: in each group the newest episode
  first; a show without an episode for 45 days at the end, after 180 days left out.

Station names and logos belong to their stations; they're here only to show which station is which.
Podcast names and covers belong to their makers; episodes are always played from the makers' own feeds.
