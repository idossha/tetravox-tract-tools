# Changelog

## [Unreleased]

Nothing yet.

## [0.2.0]

### Changed

- **Every number now covers the whole file, whatever the display budget draws.** The panel shows it plainly: "48,300 of 200,000 drawn · numbers use all 200,000". The old "results cover the displayed ones only" limit and the refusal to export a selection are gone. Needs a Tetravox with `scene.tracts.scan`, `files.chooseFolder`, `scene.openFile`, `scene.tracts.attachFile` and panel tabs.
- **Two tabs, Network and Export.** Rules still run from a job or a scene; the panel says when they apply and can remove them.
- **A sphere now uses `tckedit`'s point test by default**, so its count equals `tckedit`'s. The segment test is under Advanced. Rules saved in an existing scene keep the test they had.
- **Matrices keep `tck2connectome`'s layout**: the upper triangle by default, both triangles under Advanced.

### Added

- **Filter by an ROI file, from a job.** A binary mask becomes a rule named after the file; an atlas asks which label.
- **Saved tracts.** Name a filter or a matrix cell, apply it, rename it, delete it, export it.
- **Length histogram** of every streamline, with the kept range highlighted, and a median length for what is kept.
- **From → To** chooses a network with a search box on each side. A click on a row or a matrix cell adds to it, and the matrix outlines the choice in red and bands the row and column you hover.
- **Saved networks and export folders are named by date.**
- **A summary of the chosen connection or region**, a sortable, searchable table of connections with a tick per row and Show all, Hide all and Invert, a colour bar, hover readout, and keyboard reach on the matrix.
- **Values along streamlines:** a scalar image sampled along each streamline as `tcksample -stat_tck mean` does, an attached `.tsf`, or per-streamline weights loaded from the panel.
- **Region names:** a lookup table you load, else the names Tetravox gives the volume, including its built-in FreeSurfer names when the ids pass its safety test. The panel and `methods.txt` say which.
- **Export to a folder:** `connectome_*.csv`, `edges.csv`, `nodes.csv`, `connectome.png` and `.svg`, a valid MRtrix `.tck` for each saved tract and the current filter, `streamlines.csv`, `methods.txt` and `recipe.json`. It asks before replacing anything, and a failure removes what was open and says what finished.
- **Job operations** for all of the above that the job channel can carry: `open-roi`, `attach`, `set-weights`, `set-value`, `save-tract`, `add-connection`, `apply-tract`, `rename-tract`, `delete-tract`, `export-file`. A job cannot write `.tck` (the channel takes text and figures); it says so and points at `export-selection` and `tckedit -tck_weights_in`.

Existing scenes open as before: a block written by 0.1.0 restores, and recomputes over the whole file.

### Removed

- The Statistics section of the panel. The `stats` job operation stays, and now covers the whole file.

## [0.1.0]

- **Select streamlines live, as `tckedit` would.** Sphere and label-region rules, include or exclude, ends only, and length limits, with a count that follows as you edit. Your own filter still applies.
- **Browse a connectome in place.** Assign endpoints from a label volume, by end voxel or radial search, or take an attached `-out_assignments` pair; click a cell for an edge's streamlines, the left strip for a node's.
- **Per-streamline statistics.** Mean, median, min and max of any per-point field, as streamline fields you can colour and filter by.
- **Export** the matrix as `.csv` and the selection as a `.txt` that `tckedit -tck_weights_in` reads.

Needs a Tetravox with `scene.tracts`; the published 0.8.0 lacks it, and the panel says so.
