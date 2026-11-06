# Tract tools: a Tetravox extension

`tetravox.tract-tools` does one plain thing with a tractogram you have open: it lets you **choose, show and export a network**: matrices, lengths, statistics and tables. Inputs are the usual ones (`.tck`, `.trk`, `.trx`, a NIfTI atlas or mask, a lookup table, a weights `.txt`, a `.tsf`). Outputs are plain files. Every number uses every streamline in the file, whatever the display budget draws, and agrees with MRtrix 3.0.8 (below).

It needs a Tetravox with `scene.tracts.scan`, `scene.tracts.attachFile`, `scene.openFile`, `files.chooseFolder` and panel tabs. Without them the panel says so and does nothing else.

## Install

Through **File ▸ Extensions…**, in Tetravox 0.8.1 or later. From a checkout: `pnpm install && pnpm run sideload`, restart Tetravox, and consent in File ▸ Extensions….

## Using it

**Network.** Choose an atlas and **Build**. **From** and **To** are search boxes: type part of a region's name, or its id, then press Enter or click it. The search and the list stay put with a ✓ on what you took, so you can take several and click one again to drop it. With no To, you get everything the From regions reach. The chosen connections are what the views draw and the tracts export. You can also click: a row or a cell starts a choice of that one and then toggles it; clicking a region's name in the matrix sets From. The table lists the chosen connections first. The ◉ on a row shows or hides it, and **Show all**, **Hide all** and **Invert** act on whatever the table's search found. *Min streamlines* applies to From → To. In the matrix, chosen cells have a red outline and hovering bands the row and column; exports always cover all of it. **Colours** colours each connection in the views, matching its swatch in the table. **Save** keeps the choice as one tract named by date, such as `network_20261106_1130`, and the export folder is suggested the same way. *Show* picks streamline count, mean length, total weight, or the mean of a value. Under **Measures**, *Weights* is any per-streamline field, or **Load…** a `tcksift2` file, and *Value* is an open scalar image, sampled along each streamline, or a per-point or per-streamline field, or **Load…** a `.tsf`. The matrix is in the panel and fills its width; drag the panel's edge to make it bigger. Hover for numbers. A selected connection is drawn alone, combined with any filter rules, and can be added to the saved tracts. **Advanced** holds the assignment: nearest region within a radius (default 4 mm, as `tck2connectome`), the voxel under the end, or an attached `-out_assignments` pair (`name[0]`, `name[1]`).

Region names come from a table you load (**Load region names…**: FreeSurfer `id name r g b a` or MRtrix `id short long r g b a`, up to 1 MiB), else from the volume itself: its lookup table, or Tetravox's built-in FreeSurfer names, which it assumes only when the ids pass its safety test and says so in the Regions section. *Names:* in the panel and `methods.txt` say which.

**Export.** Tick what you want and **Export to folder…**. `streamlines.csv` holds the saved tracts' and current filter's streamlines, or every streamline if there are none. `methods.txt` records parameters, inputs with fingerprints, versions and the matching MRtrix commands. Existing files are replaced only after you say so. A `.tck` is written as the file is read, so its size is not limited by memory or by the display budget.

**Scenes.** A saved scene holds the recipe (rules, volumes by file name, saved tracts, region names) and recomputes when opened, once the files are open. A block from 0.1.0 restores.

**Jobs.** Each panel action that needs no dialog is an operation:

```json
{ "type": "module", "module": "tetravox.tract-tools", "op": "add-region", "args": { "volume": "aseg.nii.gz", "labels": "10", "mode": "ends" } }
```

`add-sphere`, `add-region`, `open-roi`, `attach`, `remove-rule`, `set-length`, `clear`, `connectome`, `set-weights`, `set-value`, `select-edge`, `clear-edge`, `stats`, `save-tract`, `add-connection`, `apply-tract`, `rename-tract`, `delete-tract`, `load-names`, `export-matrix`, `export-selection`, and `export-file` with `what` one of `count`, `length`, `weight`, `value`, `edges`, `nodes`, `streamlines`, `methods`, `recipe`, `svg`, `png`. A job writes under `--out` through Tetravox's text channel (8 MiB) and figure channel, so it has no folder sheet and cannot write `.tck`: `export-selection` followed by `tckedit in.tck out.tck -tck_weights_in selection.txt -minweight 0.5` is that route, and a `streamlines.csv` of a very large file may exceed the text cap, which refuses rather than truncates.

## How close to MRtrix

Every number below is on the real 200,000-streamline file, 32,799,983 points, with a real FreeSurfer aseg, through the real app (`e2e/whole.spec.ts`), and the same through a test host (`pnpm run agreement`). `scripts/reference/compare_export.py` reads our exports and MRtrix's files with numpy.

- Filters: symmetric difference 0 against `tckedit -include`, `-exclude`, `-ends_only`, spheres, `-minlength`, `-maxlength`, on all 12 recipes in `scripts/reference/tracts.json`. Our `.tck` files equal `tckedit`'s point for point and pass `tckinfo`.
- *Starts and ends in* has no `tckedit` option. It is checked against `tck2connectome -assignment_end_voxels -out_assignments`: the region paired with itself.
- Counts: sum|diff| 0 against `tck2connectome`, radial and end voxel, upper and symmetric, and every `-out_assignments` row equal.
- Weights, mean length and mean FA matrices are within 2e-3 relative + 1e-3 of `tck2connectome`, which accumulates in float32. Measured: 4.9e-11, 1.1e-4 and 3.4e-7 at worst.
- Per-streamline length against `tckstats -dump`: 0.00064 mm at worst, within its six printed digits. FA against `tcksample -stat_tck mean`: 8.9e-7 at worst.

Three measured facts live in the code. `tckedit` widens `-minlength` and `-maxlength` by `step_size / (2 * downsample_factor)`, and by nothing with no `step_size`. A point outside a sampled image counts as 0, as `tcksample` reads it. A value's mean over a connection is plain, as `-stat_edge mean` is with no `-tck_weights_in`.

**Not covered:** `tckedit` upsamples a streamline before testing regions when its header step is coarse against the voxels or a sphere's radius (0.5 mm step, 1 mm voxels here needs none); a coarser tractogram or a sphere smaller than the step has not been compared. Real `.trk` and `.trx` are checked against fixture coordinates, not against MRtrix.

## Developing

```sh
pnpm install
pnpm run verify      # typecheck, vitest, build, zero-imports check, the app's own manifest validator

# References. MRTRIX_BIN is a directory holding the MRtrix3 3.0.8 binaries; inputs default to the reference dataset,
# and TRACT_TOOLS_TCK, _ASEG, _FA, _WEIGHTS override them.
MRTRIX_BIN=<dir> scripts/reference/whole_refs.sh <refs>
MRTRIX_BIN=<dir> scripts/reference/thin_refs.sh <thin>

TRACT_TOOLS_WHOLE=<refs> pnpm run agreement                     # the model, in Node, on the whole file
TRACT_TOOLS_THIN=<thin> TRACT_TOOLS_WHOLE=<refs> pnpm run e2e   # hidden, real app; needs a built checkout (TETRAVOX_CHECKOUT)
scripts/reference/mutate_check.sh <export dir> <refs>           # spoils each reference: every one must come back red
```

`TRACT_TOOLS_PYTHON` names a Python with numpy, `TRACT_TOOLS_SHOTS` a folder for screenshots. Without the variables, the real-data tests skip and say why.

The bundle is one ESM file with no imports. `src/kernels/` is pure, `src/model.ts` holds state and commands, `src/exporter.ts` writes the folder, `src/ui/` is chrome. `test/reference.test.ts` runs a 148 KB subset of older references, regenerated by `scripts/reference/make_fixture.py`. The host's stylesheet holds only classes the app itself uses, so a class it lacks is an inline style; the e2e checks.

## Licence

MIT.
