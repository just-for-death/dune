# Third-party notices

Dune's own source code is licensed under the MIT licence (see `package.json`).
That licence is unchanged by the material below, which keeps its own terms.

## Ludusavi Manifest / PCGamingWiki data

- What: save and config locations for PC games, used by the save-path manifest
  lookup (`@dune/providers` manifest provider, server route
  `GET /api/manifest/:gameId`). Off by default (`Settings.manifestEnabled`).
- Source: the Ludusavi Manifest, https://github.com/mtkennerly/ludusavi-manifest
  (`data/manifest.yaml`, downloaded at runtime and cached locally, e.g. under
  the server's `DATA_DIR/manifest-cache/`). Dune does not bundle the data.
- Original data: PCGamingWiki, https://www.pcgamingwiki.com/
- Data licence: the manifest data is derived from PCGamingWiki content and is
  available under the Creative Commons Attribution-NonCommercial-ShareAlike 3.0
  licence (CC BY-NC-SA 3.0),
  https://creativecommons.org/licenses/by-nc-sa/3.0/. Any copy or display of the
  data (including the cached copy) must keep this attribution, must not be used
  commercially, and adaptations must be shared under the same licence.
- Code licence: the ludusavi-manifest repository's code is MIT licensed
  (Copyright (c) mtkennerly); Dune does not include that code.
- Attribution shown to users: "Save and config locations from the Ludusavi
  Manifest, compiled from PCGamingWiki. PCGamingWiki content is available under
  CC BY-NC-SA 3.0." with links to PCGamingWiki, the licence and the manifest
  repository (returned as `attribution` with every manifest result).
