# HOLE2 Web — Ion-channel pore-analysis studio

A browser-based GUI for the [HOLE2 program](https://github.com/osmart/hole2) (Smart, Goodfellow & Wallace, 1996) — the classic tool for analysing the pore dimensions of ion channels and other macromolecular holes.

Upload a PDB structure, configure the pore probe, and HOLE2 will:
1. Compute the maximum-radius sphere that fits at each point along the pore centre-line.
2. Produce a triangulated pore surface coloured by the HOLE zone convention (red = too narrow for water, green = single-water file, blue = wide).
3. Output the **exact same files** the original command-line suite produces — `hole_out.txt`, `hole_out.sph`, `solid_surface.sos`, `solid_surface.vmd_plot`, etc. — available for download byte-for-byte.

The 3D viewer is built with [three.js](https://threejs.org) and is inspired by [**MolVision**](https://github.com/Jing0715-fer/MolVision) (MIT, Jing0715-fer), with a cartoon-ribbon + ball-and-stick renderer for the protein and a flat-shaded vertex-coloured mesh for the HOLE pore surface.

---

## ✨ Features

| Feature | Description |
|---|---|
| 📂 **PDB upload / examples** | Drag-and-drop a PDB file, or one-click load one of the 4 bundled examples (gramicidin A 1GRM, cholera toxin 1CHB, maltoporin 1AF6, **avian TRPM8 9PB6**) with their recommended parameters pre-filled. |
| ⚙️ **Full parameter form** | All HOLE control cards: `coord`, `radius`, `cpoint`, `cvect`, `endrad`, `shorto`, `ignore`, `connolly`, `sphpdb`, `dotden`. Plus the 5 bundled vdw radius sets (`simple`, `amberuni`, `bondi`, `hardcore`, `xplor`). |
| 🧠 **Actionable failure hints** | When HOLE cannot trace a pore (e.g. auto-guess picks the wrong axis, or a wide vestibule stops the trace at the first cavity), the UI explains what happened and suggests concrete fixes (explicit CVECT/CPOINT, larger endrad, residue ignores). |
| 🎛️ **3D viewer** | Cartoon ribbons (protein) / tubes (nucleic), ball-and-stick atoms with half-bond-coloured cylinders, HOLE pore surface (red/green/blue vertex-coloured mesh), centre-line tube, and optional probe-sphere cloud. Toggle visibility + adjust surface opacity live. |
| 📈 **2D pore-profile chart** | Recharts plot of pore radius R vs. channel coordinate t, with the HOLE zone colour bands (red/green/blue), reference lines at the constriction point and zone thresholds. |
| 📊 **Summary card** | Min radius, max radius, pore length, G factor F, G_macro conductance (pS), constriction position, sphere/triangle counts. |
| 📥 **Output downloads** | All 7 raw HOLE2 output files downloadable exactly as the CLI produces them. |
| 🎓 **Capture PNG** | One-click screenshot of the current 3D scene. |
| 🌗 **Responsive** | Single-column mobile, 3-column desktop layout with sticky header & footer. |

---

## 🏗️ Architecture

```
Browser ─── Next.js :3000 (this repo, src/)
              │  /api/hole/* route handler (src/app/api/hole/[...path]/route.ts)
              │      ├─ proxies requests to the FastAPI service on 127.0.0.1:3001
              │      └─ spawns / restarts the Python service as a child process
              ▼
          FastAPI :3001 (mini-services/hole2-service/)
              └── hole / sph_process / sos_triangle / qpt_conv
                  (conda-forge hole2 2.3.1 via micromamba)
```

- **Frontend** (`src/`): Next.js 16 + React 19 + TypeScript + Tailwind 4 + shadcn/ui + three.js (CDN r128) + recharts.
  - `src/app/page.tsx` — single-page layout: header + 3-column grid (form / 3D viewer + profile tabs / controls + results) + sticky footer.
  - `src/app/api/hole/[...path]/route.ts` — **Node route handler that proxies every `/api/hole/<path>` request to the Python service**, spawning (and re-spawning on death) the uvicorn process as a child of the Next.js server. This removes any dependency on gateway port-forwarding (`XTransformPort`) and keeps the service alive for the lifetime of the web server.
  - `src/lib/hole/types.ts` — shared types matching the Python service's JSON payload.
  - `src/lib/hole/pdb.ts` — minimal PDB/mmCIF parser (atoms, residues, chains, bonds) with spatial-hash bond inference for large structures.
  - `src/lib/hole/viewer.ts` — three.js `HoleViewer` class: cartoon tubes, ball-stick instanced mesh, HOLE surface BufferGeometry, centre-line tube, sphere cloud. `fitView` computes instanced-mesh bounding boxes manually (three r128 lacks `InstancedMesh.computeBoundingBox`) and the depth-cue fog scales with the camera distance so large structures stay visible.
  - `src/lib/hole/api.ts` — REST client calling the relative `/api/hole/*` proxy paths.
  - `src/components/hole/` — `RunForm`, `Viewer3D`, `ViewerControls`, `ProfileChart`, `ResultsPanel`.

- **Backend** (`mini-services/hole2-service/`): Python FastAPI service that wraps the 4 HOLE2 binaries.
  - `main.py` — endpoints: `/api/health`, `/api/rad-sets`, `/api/examples`, `/api/example/{id}/{pdb}`, `POST /api/run`, `GET /api/download/{job_id}/{filename}`, `/api/job/{job_id}/files`, `/api/job/{job_id}/zip`, `/api/pdb/{pdb_id}`.
  - `bootstrap.sh` — idempotent micromamba env setup (downloads + installs `hole2` + `gfortran` from conda-forge).
  - Runs are capped at 2 concurrent pipelines; upload bodies are size-checked early (50 MB PDB cap); job directories are swept after 24 h; `job_id`/filename parameters are validated against strict patterns (no path traversal); `cguess`-chosen directions and no-pore failures are parsed into actionable warnings.
  - Each request runs in `/tmp/hole2-jobs/<job_id>/` so concurrent jobs never collide.
  - Parses `hole_out.txt` (cvec, cpoint, profile samples, min radius, G factor, G_macro), `hole_out.sph` (sphere centres), and `solid_surface.vmd_plot` (triangles+normals+colours) into structured JSON for the UI.

---

## 🚀 Local development

### Prerequisites
- Node.js 18+ and [bun](https://bun.sh)
- Python 3.10+ (for the mini-service)
- Internet access on first run (to download the conda-forge hole2 package)

### Setup
```bash
# 1. Install the HOLE2 conda-forge env (idempotent — only runs once)
bash mini-services/hole2-service/bootstrap.sh

# 2. Install frontend deps
bun install

# 3. Start the Next.js dev server on port 3000
bun run dev
# The /api/hole/* route handler automatically spawns the Python HOLE2
# service on 127.0.0.1:3001 on the first API call (and restarts it if it
# dies). To run it manually instead:
#   cd mini-services/hole2-service && python3 -m uvicorn main:app --host 127.0.0.1 --port 3001
```

Open http://localhost:81/ (via the Caddy gateway) or http://localhost:3000/ (direct) in your browser.

### Bundled examples
| Example | Structure | Pore type | Key params |
|---|---|---|---|
| Gramicidin A (1GRM) | narrow channel | single-file water wire | `endrad 5.0` |
| Cholera toxin B pentamer (1CHB) | large pore | uses Connolly probe + ignores HOH | `connolly`, `ignore HOH TIP WAT` |
| Maltoporin trimer (1AF6) | sugar channel | needs explicit CPOINT + CVECT | `cvect 0 0 1`, `cpoint -14.285 47.809 82.707`, `ignore FRU GLC MG HOH` |
| **Avian TRPM8 (9PB6)** | large multi-domain tetramer | menthol-bound cryo-EM; wide ~19 Å central cavity defeats the default `endrad 5` and the cguess auto-direction | `cvect 0 0 1`, `cpoint 209.639 209.636 202.5`, `endrad 22.0` |

---

## 🩺 Troubleshooting: "no pore detected" on large channels

If HOLE completes but reports **“could not trace a pore”** (the web UI shows a notice with hints), it is usually one of these — all are properties of the auto-guess heuristics on large/complex channels, not bugs:

1. **cguess picked the wrong channel axis.** HOLE's auto-guess chooses the direction with the largest *average* pore radius through the centre — for multi-domain tetramers like TRPM8 (9PB6) with big lateral cavities this is often X or Y instead of the true pore axis. *Fix:* provide an explicit `CVECT` (for a C4-symmetric tetramer: the symmetry axis, e.g. `0 0 1`) and a `CPOINT` on that axis.
2. **A vestibule / central cavity wider than `endrad`.** The trace stops as soon as the sphere radius exceeds `endrad` (default 5 Å). TRPM8's central cavity is ≈19 Å wide, so the run ends immediately inside the cavity. *Fix:* raise `endrad` above the cavity radius (20–25 Å for 9PB6).
3. **Solvent / ligands / detergents inside the pore.** *Fix:* add them to `ignore` (e.g. `HOH TIP WAT`).

The 9PB6 TRPM8 example demonstrates all of this: with defaults it fails with the 99999 “no pore” sentinel; with `CVECT 0 0 1`, `CPOINT 209.639 209.636 202.5` and `ENDRAD 22.0` it traces the full pore — min radius **2.11 Å** at the PHE969 selectivity-filter constriction, the ~15 Å central cavity, the S6 gate constrictions (R1072/K1079/I1090 ≈ 2.4–2.6 Å) and a predicted G_macro of ≈ **400 pS** (1 M KCl).

---

## 📦 Output files (identical to the original CLI)

| File | Description |
|---|---|
| `hole_out.txt` | Human-readable HOLE log + per-sample pore profile (the main output). |
| `hole_out.sph` | Sphere centres in pseudo-PDB format (B-factor = radius). |
| `dotsurface.qpt` | Binary dot-surface file (Hydra/Quanta plot format). |
| `solid_surface.sos` | Intermediate solid-surface file (input to `sos_triangle`). |
| `solid_surface.vmd_plot` | VMD `draw trinorm` commands for the solid surface. |
| `hole.inp` | The HOLE input file used for this run. |
| `simple.rad` | Van der Waals radii set used. |

> **Note on large pores**: `sos_triangle` has a built-in polygon limit. For very large pores (e.g. the cholera-toxin pentamer at `endrad 5.0`) the solid-surface triangulation may fail with "Maximum number of polygons exceeded". The `.sos` intermediate file is still produced and downloadable — you can run `sos_triangle` locally with different flags. The web UI shows a non-fatal notice when this happens; the pore-profile chart and all other outputs are unaffected.

---

## 🧪 Algorithmic fidelity

The web app does **not** re-implement HOLE2's algorithms. It runs the original Fortran binaries (`hole`, `sph_process`, `sos_triangle`, `qpt_conv`) from the official conda-forge `hole2 2.3.1` package, byte-for-byte. The web layer only:

1. Constructs the `.inp` file from the form parameters.
2. Runs the binaries with the same stdin/stdout redirection the CLI uses.
3. Parses the human-readable `hole_out.txt` + the `.sph` + the `.vmd_plot` into JSON for the UI.

So the scientific results — minimum radius, pore length, G factor, G_macro conductance, sphere positions, triangle mesh — are exactly what you would get running `hole < hole.inp > hole_out.txt` locally.

---

## 📚 References

- **HOLE2**: Smart, O.S., Goodfellow, J.M., Wallace, B.A. (1993). *The pore dimensions of gramicidin A.* Biophys. J., 65, 2455–2460. [doi:10.1016/S0006-3495(93)81293-1](https://doi.org/10.1016/S0006-3495(93)81293-1)
- **HOLE2 2.2/2.3**: Smart, O.S., Neduvelil, J.G., Wang, X., Wallace, B.A., Sansom, M.S.P. (1996). *HOLE: a program for the analysis of the pore dimensions of ion channel structural models.* J. Mol. Graph., 14, 354–360. [doi:10.1016/S0263-7855(97)00009-X](https://doi.org/10.1016/S0263-7855(97)00009-X)
- **HOLE2 repo**: https://github.com/osmart/hole2 (Apache 2.0)
- **HOLE2 homepage**: http://www.holeprogram.org/
- **MolVision** (3D viewer inspiration, MIT): https://github.com/Jing0715-fer/MolVision

---

## 📄 License

This web application is released under the MIT License. The HOLE2 Fortran suite it wraps is Apache 2.0 (© Oliver Smart 1993–2016). The bundled examples and radius files come from the HOLE2 distribution. The 3D viewer design is inspired by MolVision (MIT, © 2026 Jing0715-fer).
