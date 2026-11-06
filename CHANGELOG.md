# Changelog

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-11-06

First published version. Needs Tetravox 0.8.1 or later, for `scene.tracts.scan`, `scene.tracts.attachFile`, `scene.openFile`, `files.chooseFolder` and panel tabs; 0.8.0 refuses it.

- **Every number covers the whole file**, whatever the display budget draws, and the panel says so: "48,300 of 200,000 drawn · numbers use all 200,000".
- **From → To** chooses a network with a search box on each side. The search and the list stay put while you take regions, and a ✓ marks what you took.
- **A matrix in the panel**, by streamline count, mean length, total weight or the mean of a value, in `tck2connectome`'s layout. Chosen cells have a red outline, and hovering bands the row and column. A click on a cell adds it to the choice, and a click on a name sets From.
- **A table of connections**, sortable and searchable, with the choice first, a tick per row, and Show all, Hide all and Invert.
- **Colours** colours each connection in the views, with a matching swatch on its row.
- **Values along streamlines:** a scalar image sampled along each streamline as `tcksample -stat_tck mean` does, an attached `.tsf`, or per-streamline weights such as `tcksift2`'s.
- **Region names:** a lookup table you load, else the names Tetravox gives the volume, including its built-in FreeSurfer names when the ids pass its safety test. The panel and `methods.txt` say which.
- **Saved tracts**, named by date, to apply, rename, delete and export.
- **Export to a folder**, suggested by date: `connectome_*.csv`, `edges.csv`, `nodes.csv`, `connectome.png` and `.svg`, a valid MRtrix `.tck` for each saved tract and the current choice, `streamlines.csv`, `methods.txt` and `recipe.json`. It asks before replacing anything.
- **Job operations** for the above that the job channel can carry, plus filter rules by region, sphere, ROI file and length. A job cannot write `.tck` or a large `streamlines.csv`. Rules are not in the panel; it says when a job or a scene has set them and can remove them.
