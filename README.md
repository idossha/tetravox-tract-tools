# Tract tools: a Tetravox extension

`tetravox.tract-tools` answers three questions about a tractogram you have open, without writing a file per attempt: which streamlines meet these rules (`tckedit`), which streamlines are in this edge (`tck2connectome` and `connectome2tck`), and what does each streamline sample (`tcksample -stat_tck`).

It needs a Tetravox with `scene.tracts`. **The published 0.8.0 lacks it**; the panel says so and does nothing else.

## Install

Through **File ▸ Extensions…** once it is catalogued. Before that, from a checkout: `pnpm install && pnpm run sideload`, restart Tetravox, and consent in File ▸ Extensions….

## Using it

**Select.** Add a sphere at the crosshair, or search a label volume's regions by id or name, or take the region under the crosshair. Each rule includes or excludes, and can count only the two end points. Every include must be met and any exclude rejects. Add a length range. The count updates as you edit. The result is the `tract-tools:selected` field and the layer's `keepField`, so your own filter still applies. **Clear** removes them. Spheres are drawn at their world radius by a points layer.

A sphere tests **segments** by default, so a streamline crossing a small sphere between two points counts; **pt** switches to `tckedit`'s point test. Regions always test points, through the label volume's nearest voxel.

**Connectome.** Choose a label volume and **Compute**. *End voxel* reads the voxel under each end. *Radial* (default 4 mm) takes the labelled voxel whose centre is nearest, as `tck2connectome` does. *Attached* takes an `-out_assignments` file attached to the tractogram, read as `name[0]`, `name[1]`. Add a per-streamline weight (SIFT2, say) and a field whose weighted mean colours the map. Node 0 is excluded and the matrix is symmetric. Hover for nodes and counts, click a cell for an edge, click the left strip for a node, click again to clear. It combines with the rules above. **⧉** gives the map its own window. **Names…** loads a FreeSurfer (`id name r g b a`) or MRtrix (`id short long r g b a`) table; `.ctab` must be renamed `.txt`, because Tetravox reads only `.txt`, `.csv`, `.tsv`, `.json` and `.fcsv`, up to 1 MiB. **edge groups** writes `tract-tools:edge` for the layer's group controls; groups are numbered, not named, because a field carries no names.

**Statistics.** Mean, median, min and max of a per-point field, written as `<field>:<stat>`. The mean is length-weighted as MRtrix's is. A non-finite sample is skipped: Tetravox samples `NaN` outside a volume, where MRtrix reads 0, so for a streamline leaving the image a statistic of a field sampled in Tetravox covers what is inside it, while a `.tsf` from `tcksample` carries MRtrix's zeros (measured with a cropped FA).

**Export.** The matrix as `.csv`, N×N where N is the largest node id, weighted when a weight is chosen. The selection as one row of 0/1:

```sh
tckedit in.tck out.tck -tck_weights_in selection.txt -minweight 0.5
```

That line is the route to a `.tck`: the extension cannot write one, because the host's binary channel takes only `.png` and `.pdf`. A selection needs every streamline in the file held, so over a display budget it refuses and says why. Above Tetravox's 8 MiB text cap either export refuses rather than truncating.

**Scenes.** A saved scene holds the recipe (rules, volume by file name, modes, selected edge, node names) and recomputes when opened, once the files are open. A budget change recomputes too. Over a budget subset the panel says results cover the displayed streamlines only.

**Jobs.** Every computation is an operation: `add-sphere`, `add-region`, `set-length`, `clear`, `connectome`, `select-edge`, `clear-edge`, `stats`, `export-matrix`, `export-selection`, `load-names`. Each returns `{selected, edges, nodes, ...}`.

```json
{ "type": "module", "module": "tetravox.tract-tools", "op": "add-region", "args": { "volume": "nodes.nii.gz", "labels": "140" } }
```

## How close to MRtrix

`pnpm run agreement` (`scripts/reference/agreement.sh <dir>`) runs all 2000 streamlines of the reference set against what MRtrix 3.0.8 wrote, read by nibabel and numpy. Selections have symmetric difference 0, assignments are 100% equal and matrices have sum|diff| 0.

Length needed one measured fact: `tckedit` widens `-minlength` and `-maxlength` by `step_size / (2 * downsample_factor)`, and by nothing when the header has no `step_size`. That was bisected over edited headers (0.0833, 0.1666, 0.25, 0.0416 mm), it is what the extension applies from a `.tck` header, and without it 6 of 2000 differ.

`tckedit` can upsample a streamline before testing regions when its step is coarse against the voxel. On the reference (0.5 mm step, 1 mm voxels) point tests are exact without it. A coarser tractogram has not been compared.

## Developing

```sh
pnpm install
pnpm run verify      # typecheck, vitest, build, zero-imports check, the app's own manifest validator
pnpm run agreement   # needs the reference directory
TRACT_TOOLS_MX=<dir> TETRAVOX_CHECKOUT=<tetravox> TRACT_TOOLS_SHOTS=<dir> pnpm run e2e  # hidden, needs a built checkout
```

The bundle is one ESM file with no imports. `src/kernels/` is pure, `src/model.ts` holds state and commands, `src/Panel.tsx` is chrome. `test/reference.test.ts` runs a 148 KB subset of the references, regenerated by `scripts/reference/make_fixture.py`. The host's stylesheet holds only classes the app itself uses, so a class it lacks is an inline style; the e2e checks.

## Licence

MIT.
