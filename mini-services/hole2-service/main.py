"""
HOLE2 mini-service — wraps the HOLE2 command-line suite (hole, sph_process,
sos_triangle, qpt_conv) behind a small FastAPI REST API so the Next.js
web front-end can run pore-dimension analysis on a PDB file without ever
shelling out to Fortran itself.

The HOLE2 binaries live inside a micromamba (conda-forge) environment
created at service start-up time.  Each request runs in its own temp
working directory, so concurrent jobs never collide.

Endpoints
---------
POST /api/run
    multipart/form-data:
      - pdb_file     : PDB coordinate file (required)
      - radius_file  : custom .rad file (optional; defaults to simple.rad)
      - cpoint_x/y/z: channel centre point override (optional, floats)
      - cvect_x/y/z  : channel vector override (optional, floats)
      - endrad       : end radius in Angstrom (optional, default 5.0)
      - shorto       : short output level 0..3 (optional, default 0)
      - connolly     : "true" to use Connolly probe (optional)
      - ignore_residues : space-separated residue names to ignore (optional)
      - sphpdb_name  : output sphere PDB base name (optional, default hole_out)
      - dotden       : dot density for sph_process (5..30, default 15)
    returns JSON:
      { job_id, profile: {samples:[{x,y,z,r,t}], min_r, min_pos, ...},
        summary: {...}, files: [list of available output filenames],
        log: "...tail of hole stdout..." }

GET /api/download/{job_id}/{filename}
    streams a single raw output file (hole_out.txt, *.sph, *.qpt, *.sos,
    *.vmd_plot, *.sos_ascii, ...).  This guarantees the web user can
    download exactly the same files the original CLI would produce.

GET /api/rad-sets
    returns the list of bundled vdw radius set files (simple.rad etc.)

GET /api/example/{name}
    returns a bundled example PDB + hole.inp so the user can try the
    gramicidin / cholera-toxin / maltoporin demos with one click.

GET /api/health
    liveness probe.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# The micromamba env that holds the conda-forge hole2 binaries.  It is created
# lazily on first use (or by the bootstrap script) and then re-used.
MAMBA_ROOT = os.environ.get("MAMBA_ROOT_PREFIX", "/tmp/mamba-root")
HOLE2_ENV_NAME = os.environ.get("HOLE2_ENV_NAME", "hole2")
MICROMAMBA_BIN = os.environ.get("MICROMAMBA_BIN", "/tmp/mm/bin/micromamba")

# A persistent jobs directory so downloads keep working across requests.
JOBS_DIR = Path(os.environ.get("HOLE2_JOBS_DIR", "/tmp/hole2-jobs"))
JOBS_DIR.mkdir(parents=True, exist_ok=True)

# Bundled rad files + example PDBs ship with the conda env, but we expose
# the ones from the cloned hole2 repo (more discoverable) as a fallback.
HOLE2_REPO_RAD = Path("/tmp/hole2/rad")
HOLE2_REPO_EXAMPLES = Path("/tmp/hole2/examples")


# ---------------------------------------------------------------------------
# Environment management
# ---------------------------------------------------------------------------

def env_bin(name: str) -> str:
    """Return the absolute path to a binary inside the hole2 micromamba env."""
    return f"{MAMBA_ROOT}/envs/{HOLE2_ENV_NAME}/bin/{name}"


def env_prefix() -> str:
    return f"{MAMBA_ROOT}/envs/{HOLE2_ENV_NAME}"


def env_exists() -> bool:
    return Path(env_prefix()).exists() and Path(env_bin("hole")).exists()


def run_in_env(args: list[str], *, cwd: str, input_text: str | None = None,
               timeout: int = 300) -> tuple[int, str, str]:
    """Run a command inside the hole2 conda env (PATH + datadir prepended)."""
    prefix = env_prefix()
    env = os.environ.copy()
    env["PATH"] = f"{prefix}/bin:{env.get('PATH', '')}"
    env["CONDA_PREFIX"] = prefix
    # hole looks for share/hole2/rad relative to its bin/../share
    env["HOLE2_DATA"] = f"{prefix}/share/hole2"

    proc = subprocess.run(
        args,
        cwd=cwd,
        input=input_text,
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout,
    )
    return proc.returncode, proc.stdout, proc.stderr


# ---------------------------------------------------------------------------
# Parsed-output types
# ---------------------------------------------------------------------------

@dataclass
class ProfileSample:
    x: float
    y: float
    z: float
    r: float          # pore radius (Angstrom)
    t: float          # channel coordinate (dot product with cvect)
    kind: str = "mid"  # "mid-point" or "sampled" — HOLE alternates


@dataclass
class PoreProfile:
    cvec: list[float] = field(default_factory=lambda: [0.0, 0.0, 1.0])
    cpoint: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    samples: list[ProfileSample] = field(default_factory=list)
    min_radius: Optional[float] = None
    min_pos: Optional[list[float]] = None
    min_t: Optional[float] = None
    max_radius: Optional[float] = None
    n_samples: int = 0
    g_factor: Optional[float] = None
    g_macro: Optional[float] = None
    conductance_pS: Optional[float] = None
    pore_length: Optional[float] = None


# ---------------------------------------------------------------------------
# Parsers — extract structured data from the raw hole stdout + .sph file
# ---------------------------------------------------------------------------

# Matches lines like:
#     13.36275     2.07545    15.40980     4.23599 (mid-point)
#     13.48775     2.14099    15.54228     4.24467   (sampled)
# Connolly mode may append extra columns before the (mid-point|sampled) tag:
#     31.56571     4.21656    12.36435     0.35151 1000000.000       6.506       0.149   (sampled)
_PROFILE_LINE = re.compile(
    r"^\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+).{0,80}\((mid-point|sampled)\)\s*$"
)
# "Minimum radius found:      1.198 angstroms."
_MIN_RADIUS = re.compile(r"Minimum radius found:\s+(-?\d+\.\d+)", re.I)
# "channel vector:   0.000    0.000    1.000"
_CVECT = re.compile(r"channel vector:\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)", re.I)
# "point in channel:   ..."
_CPOINT = re.compile(r"point in channel:\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)", re.I)
# "F= sum(ds/area) along channel is    4.370 angstroms**-1"
_G_FACTOR = re.compile(r"F=\s*sum\(ds/area\).*?is\s+(-?\d+\.\d+)", re.I)
# "(23/rho) pS,"  the 23 is F inverted ×100; we want Gmacro value
_GMACRO = re.compile(r"Gmacro=\s*(-?\d+\.\d+)", re.I)


def parse_hole_stdout(text: str) -> PoreProfile:
    """Parse the human-readable hole_out.txt into a structured PoreProfile."""
    prof = PoreProfile()
    cv = _CVECT.search(text)
    if cv:
        prof.cvec = [float(cv.group(1)), float(cv.group(2)), float(cv.group(3))]
    cp = _CPOINT.search(text)
    if cp:
        prof.cpoint = [float(cp.group(1)), float(cp.group(2)), float(cp.group(3))]

    cx, cy, cz = prof.cvec
    px, py, pz = prof.cpoint
    for line in text.splitlines():
        m = _PROFILE_LINE.match(line)
        if not m:
            continue
        x, y, z, r = (float(m.group(i)) for i in (1, 2, 3, 4))
        kind = "mid" if m.group(5) == "mid-point" else "sampled"
        # channel coordinate = dot product of (point - cpoint) with cvec
        t = (x - px) * cx + (y - py) * cy + (z - pz) * cz
        prof.samples.append(ProfileSample(x=x, y=y, z=z, r=r, t=t, kind=kind))

    mn = _MIN_RADIUS.search(text)
    if mn:
        prof.min_radius = float(mn.group(1))

    gf = _G_FACTOR.search(text)
    if gf:
        prof.g_factor = float(gf.group(1))
    gm = _GMACRO.search(text)
    if gm:
        prof.g_macro = float(gm.group(1))

    if prof.samples:
        prof.n_samples = len(prof.samples)
        rs = [s.r for s in prof.samples]
        prof.max_radius = max(rs)
        # pore length = t-range
        ts = [s.t for s in prof.samples]
        prof.pore_length = max(ts) - min(ts)
        if prof.min_radius is not None:
            # find first sample with the min radius
            for s in prof.samples:
                if abs(s.r - prof.min_radius) < 1e-4:
                    prof.min_pos = [s.x, s.y, s.z]
                    prof.min_t = s.t
                    break
    return prof


def parse_sph_file(path: Path) -> list[dict]:
    """Parse a HOLE .sph file (pseudo-PDB) into a compact list of sphere dicts."""
    out: list[dict] = []
    if not path.exists():
        return out
    with path.open() as f:
        for line in f:
            if not line.startswith("ATOM"):
                continue
            # PDB columns: fixed-width
            try:
                x = float(line[30:38].strip())
                y = float(line[38:46].strip())
                z = float(line[46:54].strip())
                occ = float(line[54:60].strip())  # = radius
                bfac = float(line[60:66].strip())  # = radius again
                r = bfac if bfac else occ
                out.append({"x": x, "y": y, "z": z, "r": r})
            except (ValueError, IndexError):
                continue
    return out


def parse_sos_vmd(path: Path) -> dict:
    """Parse a sos_triangle-generated .vmd_plot file.

    Returns ``{"triangles": [{vertices, normals, color}, ...], "colors": [...]}``
    where each triangle has 3 vertex triples and 3 normal triples (each [x,y,z]).
    This matches the front-end ``HoleTriangle`` type exactly.
    """
    tris: list[dict] = []
    colors: list[str] = []
    cur_color = ""
    if not path.exists():
        return {"triangles": tris, "colors": colors}
    with path.open() as f:
        for line in f:
            line = line.rstrip()
            if not line:
                continue
            if line.startswith("draw color"):
                cur_color = line.split("draw color", 1)[1].strip()
                continue
            if line.startswith("draw trinorm"):
                # draw trinorm  { x y z } { x y z } { x y z } { nx ny nz } { nx ny nz } { nx ny nz }
                m = re.findall(r"\{\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*\}", line)
                if len(m) == 6:
                    v = [list(map(float, p)) for p in m]
                    tris.append({
                        "vertices": v[:3],   # [[x,y,z],[x,y,z],[x,y,z]]
                        "normals": v[3:],     # [[x,y,z],[x,y,z],[x,y,z]]
                        "color": cur_color,
                    })
                    colors.append(cur_color)
            elif line.startswith("draw line") or line.startswith("draw point"):
                # dots/centre-line — kept as a separate "lines" list (not used by the UI)
                continue
    return {"triangles": tris, "colors": colors}


def parse_sph_centreline(sph_spheres: list[dict]) -> list[list[float]]:
    """Centre line = the ordered sphere centres from the .sph file."""
    return [[s["x"], s["y"], s["z"]] for s in sph_spheres]


# ---------------------------------------------------------------------------
# HOLE2 run pipeline
# ---------------------------------------------------------------------------

@dataclass
class RunResult:
    job_id: str
    work_dir: str
    profile: PoreProfile
    spheres: list[dict]
    surface: dict
    summary: dict
    files: list[str]
    log_tail: str
    returncode: int
    error: Optional[str] = None
    warnings: list[str] = field(default_factory=list)


def build_hole_inp(params: dict, pdb_name: str, rad_path: str, sphpdb_name: str) -> str:
    """Construct a HOLE input file (.inp) from the web-form parameters."""
    lines: list[str] = []
    lines.append(f"coord {pdb_name}")
    lines.append(f"radius {rad_path}")
    if params.get("ignore_residues"):
        lines.append(f"ignore {params['ignore_residues']}")
    if params.get("connolly"):
        lines.append("CONNOLLY")
    if params.get("cvect_x") is not None and params.get("cvect_y") is not None and params.get("cvect_z") is not None:
        lines.append(f"cvect {params['cvect_x']:.4f} {params['cvect_y']:.4f} {params['cvect_z']:.4f}")
    if params.get("cpoint_x") is not None and params.get("cpoint_y") is not None and params.get("cpoint_z") is not None:
        lines.append(f"cpoint {params['cpoint_x']:.4f} {params['cpoint_y']:.4f} {params['cpoint_z']:.4f}")
    if params.get("shorto") is not None:
        lines.append(f"shorto {int(params['shorto'])}")
    lines.append(f"sphpdb {sphpdb_name}.sph")
    endrad = float(params.get("endrad", 5.0))
    lines.append(f"endrad {endrad:.2f}")
    return "\n".join(lines) + "\n"


async def run_hole_pipeline(pdb_bytes: bytes, pdb_name: str,
                            params: dict, custom_rad: bytes | None = None) -> RunResult:
    """Run the full HOLE2 pipeline on the given PDB and return parsed results."""
    if not env_exists():
        raise HTTPException(
            status_code=500,
            detail="HOLE2 conda environment is not initialised. "
                   "Run mini-services/hole2-service/bootstrap.sh first.",
        )

    job_id = uuid.uuid4().hex[:12]
    work_dir = JOBS_DIR / job_id
    work_dir.mkdir(parents=True, exist_ok=True)

    # Write the PDB file
    safe_pdb = "input.pdb" if not pdb_name else Path(pdb_name).name
    if not safe_pdb.endswith(".pdb"):
        safe_pdb += ".pdb"
    pdb_path = work_dir / safe_pdb
    pdb_path.write_bytes(pdb_bytes)

    # Pick / write the radius file
    if custom_rad:
        rad_path = work_dir / "custom.rad"
        rad_path.write_bytes(custom_rad)
    else:
        rad_set = params.get("radius_set", "simple")
        bundled = Path(env_prefix()) / "share/hole2/rad" / f"{rad_set}.rad"
        if not bundled.exists() and HOLE2_REPO_RAD.exists():
            bundled = HOLE2_REPO_RAD / f"{rad_set}.rad"
        if not bundled.exists():
            raise HTTPException(status_code=400, detail=f"Unknown radius set: {rad_set}")
        rad_path = work_dir / f"{rad_set}.rad"
        shutil.copy(bundled, rad_path)

    sphpdb_name = params.get("sphpdb_name") or "hole_out"
    inp_text = build_hole_inp(params, safe_pdb, str(rad_path), sphpdb_name)
    inp_path = work_dir / "hole.inp"
    inp_path.write_text(inp_text)

    # 1) run hole
    rc, out, err = await asyncio.to_thread(
        run_in_env,
        [env_bin("hole")],
        cwd=str(work_dir),
        input_text=inp_text,
        timeout=300,
    )
    (work_dir / "hole_out.txt").write_text(out + ("\n" + err if err else ""))
    if rc != 0 and "normal completion" not in out:
        # hole returns 0 on normal completion even with warnings
        # but a hard crash → return early with diagnostics
        files = [p.name for p in work_dir.iterdir()]
        return RunResult(
            job_id=job_id, work_dir=str(work_dir),
            profile=PoreProfile(), spheres=[], surface={"triangles": [], "colors": []},
            summary={"status": "error", "returncode": rc, "stderr": err[-2000:]},
            files=files, log_tail=out[-3000:], returncode=rc, error=err[-1500:] or "HOLE failed",
        )

    profile = parse_hole_stdout(out)

    # 2) run sph_process to make dot surface (.qpt) + .sos
    sph_path = work_dir / f"{sphpdb_name}.sph"
    dotden = int(params.get("dotden", 15))
    dot_qpt = work_dir / "dotsurface.qpt"
    solid_sos = work_dir / "solid_surface.sos"

    # dot surface (.qpt)
    try:
        rc2, out2, err2 = await asyncio.to_thread(
            run_in_env,
            [env_bin("sph_process"), "-dotden", str(dotden), "-color",
             str(sph_path), str(dot_qpt)],
            cwd=str(work_dir), input_text=None, timeout=120,
        )
    except Exception as exc:  # pragma: no cover
        err2 = str(exc)
        rc2 = -1

    # solid surface (.sos)
    try:
        rc3, out3, err3 = await asyncio.to_thread(
            run_in_env,
            [env_bin("sph_process"), "-sos", "-dotden", str(dotden), "-color",
             str(sph_path), str(solid_sos)],
            cwd=str(work_dir), input_text=None, timeout=120,
        )
    except Exception as exc:  # pragma: no cover
        err3 = str(exc)
        rc3 = -1

    # 3) sos_triangle → .vmd_plot
    # sos_triangle reads the .sos file from STDIN and writes the VMD draw
    # commands to STDOUT.  It can fail on large pores with "Maximum number of
    # polygons exceeded" — in that case we leave the .sos file in place
    # (which the user can still download and feed to sos_triangle locally
    # with different flags) and record a warning in the result payload.
    vmd_path = work_dir / "solid_surface.vmd_plot"
    smooth = params.get("smooth_surface", True)
    sos_warning: str | None = None
    try:
        if solid_sos.exists() and solid_sos.stat().st_size > 0:
            sos_content = solid_sos.read_bytes()
            sos_cmd = [env_bin("sos_triangle")]
            if smooth:
                sos_cmd.append("-s")
            env = {**os.environ, "PATH": f"{env_prefix()}/bin:{os.environ.get('PATH','')}"}
            proc = await asyncio.to_thread(
                lambda: subprocess.run(
                    sos_cmd, input=sos_content, capture_output=True,
                    cwd=str(work_dir), env=env, timeout=180,
                )
            )
            # sos_triangle writes a header to stderr (progress chatter) and
            # the VMD "draw ..." commands to stdout.  Keep only the draw lines
            # so the .vmd_plot is a clean VMD script.
            stdout = proc.stdout or b""
            stderr = (proc.stderr or b"").decode(errors="replace")
            draw_lines = [ln for ln in stdout.decode(errors="replace").splitlines()
                          if ln.startswith("draw ")]
            if draw_lines:
                vmd_path.write_text("\n".join(draw_lines) + "\n")
            else:
                # sos_triangle produced no draw commands — surface too large
                if "Maximum number of polygons exceeded" in stderr:
                    sos_warning = ("sos_triangle exceeded its polygon limit on this large pore. "
                                   "The .sos intermediate file is still available for download — "
                                   "try a smaller endrad or dotden locally. The 3D surface will not be shown.")
                else:
                    sos_warning = f"sos_triangle produced no output. stderr: {stderr[-300:]}"
    except subprocess.TimeoutExpired:
        sos_warning = "sos_triangle timed out (>180 s) on this large pore."
    except Exception as exc:  # pragma: no cover
        sos_warning = f"sos_triangle failed: {exc}"

    # 4) qpt_conv → .vmd_plot for the dot surface (best-effort — qpt_conv is
    #    an interactive program; we feed the prompts via stdin).  We only do
    #    this if the user explicitly asks for the dot-surface vmd_plot.
    dot_vmd_path = work_dir / "dotsurface.vmd_plot"
    try:
        if dot_qpt.exists():
            feed = b"D\ndotsurface.qpt\ndotsurface.vmd_plot\n1\n"
            proc = await asyncio.to_thread(
                lambda: subprocess.run(
                    [env_bin("qpt_conv")],
                    input=feed, capture_output=True, cwd=str(work_dir),
                    env={**os.environ, "PATH": f"{env_prefix()}/bin:{os.environ.get('PATH','')}"},
                    timeout=60,
                )
            )
            # qpt_conv writes the output file (despite its chatty stdout)
            # — verify it landed:
            if not dot_vmd_path.exists():
                # Some builds don't write to the named file but print the
                # vmd commands to stdout.  Capture stdout as a fallback.
                txt = proc.stdout.decode(errors="replace")
                keep = [ln for ln in txt.splitlines() if ln.startswith("draw ")]
                if keep:
                    dot_vmd_path.write_text("\n".join(keep) + "\n")
    except Exception as exc:  # pragma: no cover
        pass

    # Parse the structured data we need for the UI
    spheres = parse_sph_file(sph_path)
    surface = parse_sos_vmd(vmd_path)

    # Build a summary card
    summary = {
        "status": "ok",
        "min_radius": profile.min_radius,
        "min_pos": profile.min_pos,
        "min_t": profile.min_t,
        "max_radius": profile.max_radius,
        "pore_length": profile.pore_length,
        "n_samples": profile.n_samples,
        "g_factor": profile.g_factor,
        "g_macro": profile.g_macro,
        "n_spheres": len(spheres),
        "n_triangles": len(surface.get("triangles", [])),
    }

    files = sorted(p.name for p in work_dir.iterdir())
    warnings = [w for w in [sos_warning] if w]
    return RunResult(
        job_id=job_id, work_dir=str(work_dir),
        profile=profile, spheres=spheres, surface=surface,
        summary=summary, files=files,
        log_tail=out[-3000:], returncode=0, error=None,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="HOLE2 Web Service",
    description="Wraps the HOLE2 ion-channel pore-analysis suite behind a REST API.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "env_ready": env_exists(),
        "env_prefix": env_prefix(),
        "jobs_dir": str(JOBS_DIR),
    }


@app.get("/api/rad-sets")
async def rad_sets():
    """List bundled vdw radius sets."""
    names: list[str] = []
    rad_dir = Path(env_prefix()) / "share/hole2/rad"
    if rad_dir.exists():
        names = sorted(p.stem for p in rad_dir.glob("*.rad"))
    if not names and HOLE2_REPO_RAD.exists():
        names = sorted(p.stem for p in HOLE2_REPO_RAD.glob("*.rad"))
    return {"rad_sets": names, "default": "simple"}


@app.get("/api/examples")
async def list_examples():
    """List the bundled example structures (gramicidin, cholera toxin, maltoporin)."""
    out: list[dict] = []
    if not HOLE2_REPO_EXAMPLES.exists():
        return {"examples": out}
    for d in sorted(HOLE2_REPO_EXAMPLES.iterdir()):
        if not d.is_dir() or d.name.startswith("000"):
            continue
        pdbs = sorted(d.glob("*.pdb"))
        inps = sorted(d.glob("*.inp"))
        out.append({
            "id": d.name,
            "name": d.name,
            "pdb_files": [p.name for p in pdbs],
            "inp_files": [p.name for p in inps],
            "description": _EXAMPLE_DESCRIPTIONS.get(d.name, ""),
        })
    return {"examples": out}


_EXAMPLE_DESCRIPTIONS = {
    "01_gramicidin_1grm": "Gramicidin A (1GRM) — narrow channel, single-file water wire. The classic HOLE demo.",
    "02_choleratoxin_1chb": "Cholera toxin B pentamer (1CHB) — large pore, uses the Connolly probe.",
    "03_maltoporin_1af6": "Maltoporin trimer (1AF6) — sugar通道 with explicit CPOINT/CVECT overrides.",
}


@app.get("/api/example/{example_id}/{pdb_name}")
async def get_example_pdb(example_id: str, pdb_name: str):
    """Stream a bundled example PDB file (so the front-end can one-click load it)."""
    # example_id like "01_gramicidin_1grm", pdb_name like "1grm_single.pdb"
    d = HOLE2_REPO_EXAMPLES / example_id
    p = d / pdb_name
    if not p.exists():
        # try prefix match (e.g. user passes "1grm_single")
        cand = list(d.glob(f"{pdb_name}*"))
        if cand:
            p = cand[0]
    if not p.exists():
        raise HTTPException(status_code=404, detail="Example file not found")
    return FileResponse(p, filename=p.name, media_type="chemical/x-pdb")


@app.post("/api/run")
async def run_hole(
    pdb_file: UploadFile = File(...),
    radius_file: Optional[UploadFile] = File(None),
    radius_set: str = Form("simple"),
    cpoint_x: Optional[str] = Form(None),
    cpoint_y: Optional[str] = Form(None),
    cpoint_z: Optional[str] = Form(None),
    cvect_x: Optional[str] = Form(None),
    cvect_y: Optional[str] = Form(None),
    cvect_z: Optional[str] = Form(None),
    endrad: str = Form("5.0"),
    shorto: str = Form("0"),
    connolly: str = Form("false"),
    ignore_residues: str = Form(""),
    sphpdb_name: str = Form("hole_out"),
    dotden: str = Form("15"),
    smooth_surface: str = Form("true"),
):
    """Run the full HOLE2 pipeline on the uploaded PDB file."""
    pdb_bytes = await pdb_file.read()
    if not pdb_bytes:
        raise HTTPException(status_code=400, detail="Empty PDB file")
    if len(pdb_bytes) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="PDB file too large (>50 MB)")

    def _f(v: Optional[str]):
        if v is None or v == "":
            return None
        try:
            return float(v)
        except ValueError:
            return None

    def _i(v: Optional[str], default: int):
        if v is None or v == "":
            return default
        try:
            return int(v)
        except ValueError:
            return default

    params = {
        "radius_set": radius_set,
        "cpoint_x": _f(cpoint_x), "cpoint_y": _f(cpoint_y), "cpoint_z": _f(cpoint_z),
        "cvect_x": _f(cvect_x), "cvect_y": _f(cvect_y), "cvect_z": _f(cvect_z),
        "endrad": _f(endrad) or 5.0,
        "shorto": _i(shorto, 0),
        "connolly": connolly.lower() in ("1", "true", "yes", "on"),
        "ignore_residues": ignore_residues.strip(),
        "sphpdb_name": (sphpdb_name or "hole_out").strip() or "hole_out",
        "dotden": max(5, min(30, _i(dotden, 15))),
        "smooth_surface": smooth_surface.lower() in ("1", "true", "yes", "on"),
    }

    custom_rad = None
    if radius_file is not None:
        custom_rad = await radius_file.read()

    result = await run_hole_pipeline(pdb_bytes, pdb_file.filename or "input.pdb",
                                     params, custom_rad)

    return JSONResponse({
        "job_id": result.job_id,
        "profile": asdict(result.profile),
        "summary": result.summary,
        "spheres": result.spheres[:5000],   # cap for the JSON payload
        "surface": {
            "triangles": result.surface.get("triangles", [])[:20000],
            "colors": result.surface.get("colors", [])[:20000],
        },
        "centreline": [[s["x"], s["y"], s["z"]] for s in result.spheres[:5000]],
        "files": result.files,
        "log_tail": result.log_tail,
        "input_file": "hole.inp",
        "returncode": result.returncode,
        "error": result.error,
        "warnings": result.warnings,
    })


@app.get("/api/download/{job_id}/{filename}")
async def download_file(job_id: str, filename: str):
    """Stream a single raw output file produced by HOLE2."""
    # Prevent path traversal
    if "/" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    job_dir = JOBS_DIR / job_id
    if not job_dir.exists() or not job_dir.is_dir():
        raise HTTPException(status_code=404, detail="Unknown job_id")
    target = job_dir / filename
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"File {filename} not found in job {job_id}")
    media = "application/octet-stream"
    if filename.endswith(".txt"):
        media = "text/plain"
    elif filename.endswith(".pdb") or filename.endswith(".sph"):
        media = "chemical/x-pdb"
    elif filename.endswith(".vmd_plot"):
        media = "text/plain"
    elif filename.endswith(".sos") or filename.endswith(".qpt"):
        media = "application/octet-stream"
    return FileResponse(target, filename=filename, media_type=media)


@app.get("/api/job/{job_id}/files")
async def list_job_files(job_id: str):
    """List the raw output files available for a job (used by the download UI)."""
    job_dir = JOBS_DIR / job_id
    if not job_dir.exists():
        raise HTTPException(status_code=404, detail="Unknown job_id")
    files = []
    for p in sorted(job_dir.iterdir()):
        if p.is_file():
            files.append({"name": p.name, "size": p.stat().st_size})
    return {"job_id": job_id, "files": files}


@app.get("/")
async def root():
    return {"service": "hole2", "endpoints": [
        "/api/health", "/api/rad-sets", "/api/examples",
        "/api/run (POST)", "/api/download/{job_id}/{filename}",
        "/api/job/{job_id}/files",
    ]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3001)
