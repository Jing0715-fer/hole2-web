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
    """One sampled point along the pore centre-line.

    The HOLE profile table (printed near the end of hole_out.txt) has the
    columns:  cenxyz.cvec | radius | cen_line_D | sum{s/(area)}  | (sampled/mid-point)

    * ``t``  = cenxyz.cvec — the channel coordinate (dot product of the
      sphere centre with CVECT).  This is what HOLE itself uses as the
      abscissa of the pore-radius graph.
    * ``r``  = radius — the pore radius at that point (Ångström).
    * ``cen_line_d`` = cen_line_D — distance along the centre line.
    * ``cond_integral`` = sum{s/(area)} — the cumulative conductance integral.
    * ``kind`` — "mid-point" or "sampled" (HOLE alternates between them).
    """
    t: float                 # channel coordinate (cenxyz.cvec)
    r: float                 # pore radius (Å)
    cen_line_d: float = 0.0  # distance along centre line
    cond_integral: float = 0.0  # sum{s/(area)} conductance integral
    kind: str = "mid"        # "mid-point" or "sampled"


@dataclass
class PoreProfile:
    """Parsed pore-profile data from hole_out.txt + hole_out.sph."""
    # cvec / cpoint are masked with ************************ when HOLE auto-guesses
    # them (the common case).  We try to parse them from the log, but when
    # masked we leave them as None and infer the channel axis from the .sph
    # sphere centres via PCA (see infer_channel_axis()).
    cvec: Optional[list[float]] = None
    cpoint: Optional[list[float]] = None
    samples: list[ProfileSample] = field(default_factory=list)
    min_radius: Optional[float] = None
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

# Matches a HOLE profile-table line, e.g.:
#     13.36275     2.07545    15.40980     4.23599 (mid-point)
#     13.48775     2.14099    15.54228     4.24467   (sampled)
# The 4 numeric columns are (per the HOLE header "cenxyz.cvec  radius  cen_line_D  sum{s/(area)}"):
#   col 1 = cenxyz.cvec (channel coordinate t)
#   col 2 = radius (pore radius in Å)
#   col 3 = cen_line_D (distance along centre line)
#   col 4 = sum{s/(area)} (conductance integral)
# Connolly mode may append extra columns before the (mid-point|sampled) tag:
#     31.56571     4.21656    12.36435     0.35151 1000000.000       6.506       0.149   (sampled)
_PROFILE_LINE = re.compile(
    r"^\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+).{0,80}\((mid-point|sampled)\)\s*$"
)
# "Minimum radius found:      1.198 angstroms."
_MIN_RADIUS = re.compile(r"Minimum radius found:\s+(-?\d+\.\d+)", re.I)
# "channel vector:   0.000    0.000    1.000"  (masked with *** when auto-guessed)
_CVECT = re.compile(r"channel vector:\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)", re.I)
# "point in channel:   ..."  (masked with *** when auto-guessed)
_CPOINT = re.compile(r"point in channel:\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)", re.I)
# When HOLE auto-guesses (cguess), the "channel vector:" line is masked with
# "************************", but cguess then prints the actual values on a
# separate line:  "CPOINT      -0.0178     -0.0122      4.2174" /
# "CVECT        0.0000      1.0000      0.0000".  We parse these as a fallback.
_CGUESS_CVECT = re.compile(r"^CVECT\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)", re.I | re.M)
_CGUESS_CPOINT = re.compile(r"^CPOINT\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)", re.I | re.M)
# "F= sum(ds/area) along channel is    4.370 angstroms**-1"
_G_FACTOR = re.compile(r"F=\s*sum\(ds/area\).*?is\s+(-?\d+\.\d+)", re.I)
# "Gmacro=   274.60041"
_GMACRO = re.compile(r"Gmacro=\s*(-?\d+\.\d+)", re.I)


def parse_hole_stdout(text: str) -> PoreProfile:
    """Parse the human-readable hole_out.txt into a structured PoreProfile.

    The profile table near the end of the log has columns:
        cenxyz.cvec | radius | cen_line_D | sum{s/(area)} | (sampled/mid-point)
    We capture col 1 as the channel coordinate t and col 2 as the pore radius r.
    """
    prof = PoreProfile()

    # cvec / cpoint — HOLE masks "channel vector:" and "point in channel:"
    # with "************************" when it auto-guesses via cguess.  But
    # cguess also prints the actual values on separate CVECT/CPOINT lines
    # right after the masking.  We try the explicit line first, then fall
    # back to the cguess-printed line.
    cv = _CVECT.search(text)
    if cv:
        prof.cvec = [float(cv.group(1)), float(cv.group(2)), float(cv.group(3))]
    else:
        cvg = _CGUESS_CVECT.search(text)
        if cvg:
            prof.cvec = [float(cvg.group(1)), float(cvg.group(2)), float(cvg.group(3))]
    cp = _CPOINT.search(text)
    if cp:
        prof.cpoint = [float(cp.group(1)), float(cp.group(2)), float(cp.group(3))]
    else:
        cpg = _CGUESS_CPOINT.search(text)
        if cpg:
            prof.cpoint = [float(cpg.group(1)), float(cpg.group(2)), float(cpg.group(3))]

    # Profile samples — capture the 4 columns from each (sampled/mid-point) line
    for line in text.splitlines():
        m = _PROFILE_LINE.match(line)
        if not m:
            continue
        t = float(m.group(1))      # cenxyz.cvec — channel coordinate
        r = float(m.group(2))      # radius — pore radius (Å)
        cen_line_d = float(m.group(3))
        cond_int = float(m.group(4))
        kind = "mid" if m.group(5) == "mid-point" else "sampled"
        prof.samples.append(ProfileSample(
            t=t, r=r, cen_line_d=cen_line_d,
            cond_integral=cond_int, kind=kind,
        ))

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
        ts = [s.t for s in prof.samples]
        prof.pore_length = max(ts) - min(ts)
        # Find the constriction point — the sample with the smallest radius.
        # We use the actual minimum of the parsed samples (not the rounded
        # value from the "Minimum radius found:" line) so the t-value matches
        # exactly.
        min_sample = min(prof.samples, key=lambda s: s.r)
        prof.min_radius = min_sample.r
        prof.min_t = min_sample.t
    return prof


def infer_channel_axis(spheres: list[dict]) -> tuple[list[float], list[float]]:
    """Infer the pore channel axis + centre from the .sph sphere centres.

    HOLE masks cvec/cpoint with "************************" in the log when
    it auto-guesses them (the common case).  We recover the channel
    direction by PCA on the sphere centres — the dominant axis of variation
    IS the channel direction.  The centroid is a good approximation of
    cpoint.

    Returns (cvec_unit, cpoint) or ([0,0,1], [0,0,0]) if too few spheres.
    """
    if len(spheres) < 4:
        return [0.0, 0.0, 1.0], [0.0, 0.0, 0.0]
    import math
    n = len(spheres)
    # centroid
    cx = sum(s["x"] for s in spheres) / n
    cy = sum(s["y"] for s in spheres) / n
    cz = sum(s["z"] for s in spheres) / n
    # covariance matrix (3x3, symmetric)
    sxx = syy = szz = sxy = sxz = syz = 0.0
    for s in spheres:
        dx, dy, dz = s["x"] - cx, s["y"] - cy, s["z"] - cz
        sxx += dx * dx; syy += dy * dy; szz += dz * dz
        sxy += dx * dy; sxz += dx * dz; syz += dy * dz
    cov = [
        sxx / n, sxy / n, sxz / n,
        sxy / n, syy / n, syz / n,
        sxz / n, syz / n, szz / n,
    ]
    # Jacobi eigen-decomposition of the 3x3 symmetric matrix
    m = list(cov)
    v = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    for _ in range(50):
        off = 0.0
        for i in range(3):
            for j in range(i + 1, 3):
                off += m[i * 3 + j] * m[i * 3 + j]
        if off < 1e-18:
            break
        for p in range(2):
            for q in range(p + 1, 3):
                if abs(m[p * 3 + q]) < 1e-16:
                    continue
                theta = (m[q * 3 + q] - m[p * 3 + p]) / (2 * m[p * 3 + q])
                t = math.copysign(1.0, theta) / (abs(theta) + math.sqrt(theta * theta + 1))
                c = 1.0 / math.sqrt(t * t + 1)
                s = t * c
                for k in range(3):
                    mkp = m[k * 3 + p]; mkq = m[k * 3 + q]
                    m[k * 3 + p] = c * mkp - s * mkq
                    m[k * 3 + q] = s * mkp + c * mkq
                for k in range(3):
                    mpk = m[p * 3 + k]; mqk = m[q * 3 + k]
                    m[p * 3 + k] = c * mpk - s * mqk
                    m[q * 3 + k] = s * mpk + c * mqk
                for k in range(3):
                    vkp = v[k * 3 + p]; vkq = v[k * 3 + q]
                    v[k * 3 + p] = c * vkp - s * vkq
                    v[k * 3 + q] = s * vkp + c * vkq
    # eigenvalues = m[0], m[4], m[8]; eigenvectors = columns of v
    vals = [m[0], m[4], m[8]]
    vecs = [
        [v[0], v[3], v[6]],
        [v[1], v[4], v[7]],
        [v[2], v[5], v[8]],
    ]
    # pick the eigenvector with the largest eigenvalue = channel direction
    best = max(range(3), key=lambda i: vals[i])
    axis = vecs[best]
    # normalise
    norm = math.sqrt(sum(c * c for c in axis))
    if norm < 1e-12:
        return [0.0, 0.0, 1.0], [cx, cy, cz]
    cvec = [c / norm for c in axis]
    return cvec, [cx, cy, cz]


def parse_sph_file(path: Path) -> list[dict]:
    """Parse a HOLE .sph file (pseudo-PDB) into a compact list of sphere dicts.

    Each ATOM record represents one pore-sphere centre:
      - columns 31-54: x, y, z of the sphere centre
      - columns 55-60: occupancy (= pore radius for real spheres; a large
        number for "end" markers)
      - columns 61-66: B-factor (= pore radius for real spheres; 0.00 for
        "end" markers)
      - columns 23-26: residue sequence number — real spheres have a
        non-negative index (0, 1, 2, ...); HOLE uses **-888** as a sentinel
        for the "end" marker spheres it places at the pore exits (where
        radius ≥ endrad).  These end markers form a 2D grid at each exit
        and would distort the centre line if included, so we skip them.
    """
    out: list[dict] = []
    if not path.exists():
        return out
    with path.open() as f:
        for line in f:
            if not line.startswith("ATOM"):
                continue
            try:
                res_seq = int(line[22:26].strip())
            except (ValueError, IndexError):
                res_seq = 0
            # Skip HOLE's "end" marker spheres (residue sequence = -888).
            # These are placed at the pore exits (radius ≥ endrad) as a 2D
            # grid and are NOT part of the pore centre line.  Note: HOLE
            # numbers the spheres on one side of cpoint as 0, 1, 2, ... and
            # the other side as -1, -2, ... — those negative-indexed spheres
            # ARE real pore spheres and must be kept.
            if res_seq == -888:
                continue
            # PDB columns: fixed-width
            try:
                x = float(line[30:38].strip())
                y = float(line[38:46].strip())
                z = float(line[46:54].strip())
                bfac = float(line[60:66].strip())  # B-factor = pore radius
                r = bfac
                out.append({"x": x, "y": y, "z": z, "r": r, "idx": res_seq})
            except (ValueError, IndexError):
                continue
    return out


def parse_sos_vmd(path: Path) -> dict:
    """Parse a sos_triangle-generated .vmd_plot file.

    Returns ``{"triangles": [{vertices, normals, color}, ...], "colors": [...]}``
    where each triangle has 3 vertex triples and 3 normal triples (each [x,y,z]).

    sos_triangle has two output modes:
      - Smooth (-s):  ``draw trinorm  {v0} {v1} {v2} {n0} {n1} {n2}``
        (6 triples — 3 vertices + 3 normals)
      - Faceted (default):  ``draw triangle  {v0} {v1} {v2}``
        (3 triples — vertices only, no normals; we compute the face normal
        via the cross product of two edges)
    """
    import math

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
                # Smooth mode: 6 triples = 3 vertices + 3 normals
                m = re.findall(r"\{\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*\}", line)
                if len(m) == 6:
                    v = [list(map(float, p)) for p in m]
                    tris.append({
                        "vertices": v[:3],
                        "normals": v[3:],
                        "color": cur_color,
                    })
                    colors.append(cur_color)
            elif line.startswith("draw triangle"):
                # Faceted mode: 3 triples = vertices only, no normals.
                # Compute the face normal via cross product of two edges.
                m = re.findall(r"\{\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*\}", line)
                if len(m) == 3:
                    v = [list(map(float, p)) for p in m]
                    # v0, v1, v2
                    e1 = [v[1][i] - v[0][i] for i in range(3)]
                    e2 = [v[2][i] - v[0][i] for i in range(3)]
                    # normal = e1 × e2
                    nx = e1[1] * e2[2] - e1[2] * e2[1]
                    ny = e1[2] * e2[0] - e1[0] * e2[2]
                    nz = e1[0] * e2[1] - e1[1] * e2[0]
                    norm = math.sqrt(nx * nx + ny * ny + nz * nz)
                    if norm > 1e-12:
                        nx /= norm; ny /= norm; nz /= norm
                    n = [[nx, ny, nz]] * 3  # flat normal shared by all 3 verts
                    tris.append({
                        "vertices": v,
                        "normals": n,
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
    # Centre-line points sorted by channel coordinate (for the 3D viewer tube)
    centreline: list[list[float]] = field(default_factory=list)


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
    # polygons exceeded".  In that case we automatically retry with a lower
    # dot density (dotden=5) and faceted (non-smooth) mode — if that also
    # fails, we leave the .sos file in place for download and record a warning.
    vmd_path = work_dir / "solid_surface.vmd_plot"
    smooth = params.get("smooth_surface", True)
    sos_warning: str | None = None

    async def _try_sos_triangle(sos_content: bytes, use_smooth: bool) -> tuple[list[str], str, int]:
        """Run sos_triangle once and return (draw_lines, stderr, returncode)."""
        sos_cmd = [env_bin("sos_triangle")]
        if use_smooth:
            sos_cmd.append("-s")
        env = {**os.environ, "PATH": f"{env_prefix()}/bin:{os.environ.get('PATH','')}"}
        proc = await asyncio.to_thread(
            lambda: subprocess.run(
                sos_cmd, input=sos_content, capture_output=True,
                cwd=str(work_dir), env=env, timeout=180,
            )
        )
        stdout = (proc.stdout or b"").decode(errors="replace")
        stderr = (proc.stderr or b"").decode(errors="replace")
        draw_lines = [ln for ln in stdout.splitlines() if ln.startswith("draw ")]
        return draw_lines, stderr, proc.returncode

    try:
        if solid_sos.exists() and solid_sos.stat().st_size > 0:
            sos_content = solid_sos.read_bytes()
            # First attempt with the user-requested settings
            draw_lines, stderr, _ = await _try_sos_triangle(sos_content, smooth)
            if not draw_lines and "Maximum number of polygons exceeded" in stderr:
                # Auto-fallback: regenerate .sos with dotden=5 (minimum density)
                # and try again with faceted (non-smooth) mode.  This handles
                # large pores like the cholera-toxin pentamer.  Keep the
                # original .sos as .sos.full for download.
                try:
                    # Preserve the original high-density .sos for download
                    if solid_sos.exists():
                        shutil.copy2(solid_sos, work_dir / "solid_surface.sos.full")
                    rc_fb, _, _ = await asyncio.to_thread(
                        run_in_env,
                        [env_bin("sph_process"), "-sos", "-dotden", "5", "-color",
                         str(sph_path), str(solid_sos)],
                        cwd=str(work_dir), input_text=None, timeout=120,
                    )
                    if solid_sos.exists() and solid_sos.stat().st_size > 0:
                        sos_content = solid_sos.read_bytes()
                        draw_lines, stderr, _ = await _try_sos_triangle(sos_content, False)
                        if draw_lines:
                            sos_warning = ("sos_triangle exceeded its polygon limit with the "
                                           "requested settings — used auto-fallback (dotden=5, "
                                           "faceted surface) to generate the 3D mesh. The full-density "
                                           ".sos is also available as solid_surface.sos.full.")
                except Exception:
                    pass

            if draw_lines:
                vmd_path.write_text("\n".join(draw_lines) + "\n")
            else:
                if "Maximum number of polygons exceeded" in stderr:
                    sos_warning = ("sos_triangle exceeded its polygon limit on this large pore, "
                                   "even with the auto-fallback (dotden=5, faceted). "
                                   "The .sos intermediate file is still available for download — "
                                   "try a smaller endrad locally. The 3D surface will not be shown.")
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

    # If cvec/cpoint were masked (auto-guessed by HOLE's cguess), recover the
    # channel axis from the .sph sphere centres via PCA.  This lets us build
    # a properly-ordered centre line (sorted by channel coordinate) and
    # report the constriction position in 3D.
    if profile.cvec is None or profile.cpoint is None:
        inferred_cvec, inferred_cpoint = infer_channel_axis(spheres)
        if profile.cvec is None:
            profile.cvec = inferred_cvec
        if profile.cpoint is None:
            profile.cpoint = inferred_cpoint

    # Sort the .sph spheres by their projection onto cvec so the centre-line
    # tube in the 3D viewer runs smoothly along the pore (HOLE writes them in
    # discovery order which zigzags from the cpoint outward in both directions).
    cvx, cvy, cvz = profile.cvec or [0.0, 0.0, 1.0]
    cpx, cpy, cpz = profile.cpoint or [0.0, 0.0, 0.0]
    spheres_sorted = sorted(spheres, key=lambda s: (
        (s["x"] - cpx) * cvx + (s["y"] - cpy) * cvy + (s["z"] - cpz) * cvz
    ))

    # Build a summary card
    summary = {
        "status": "ok",
        "min_radius": profile.min_radius,
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
        centreline=[[s["x"], s["y"], s["z"]] for s in spheres_sorted[:5000]],
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
        # Centre-line points sorted by channel coordinate (cvec projection)
        # so the 3D viewer's tube runs smoothly along the pore.
        "centreline": result.centreline[:5000],
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
