# Changelog

## [Unreleased]

Nothing yet.

## [0.1.0]

- **Select streamlines live, as `tckedit` would.** Sphere and label-region rules, include or exclude, ends only, and length limits, with a count that follows as you edit. Your own filter still applies.
- **Browse a connectome in place.** Assign endpoints from a label volume, by end voxel or radial search, or take an attached `-out_assignments` pair; click a cell for an edge's streamlines, the left strip for a node's.
- **Per-streamline statistics.** Mean, median, min and max of any per-point field, as streamline fields you can colour and filter by.
- **Export** the matrix as `.csv` and the selection as a `.txt` that `tckedit -tck_weights_in` reads.

Needs a Tetravox with `scene.tracts`; the published 0.8.0 lacks it, and the panel says so.
