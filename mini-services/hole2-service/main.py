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

GET /api/example/{example_id}/{pdb_name}
    streams a bundled example PDB file (gramicidin / cholera-toxin /
    maltoporin / TRPM8 demos) so the front-end can load them with one click.

GET /api/health
    liveness probe.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
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

# HOLE2 binaries are BUNDLED in the project's vendor/hole2/ directory.
# No conda/micromamba installation is needed — the binaries are pre-compiled
# ELF executables that work with the system's libgfortran.so.5.
#
# The vendor/ directory contains:
#   vendor/hole2/bin/hole, sph_process, sos_triangle, qpt_conv  (executables)
#   vendor/hole2/rad/*.rad  (5 vdw radius files)
#   vendor/hole2/examples/  (3 example PDB structures)
#
# Fallback: if the bundled binaries don't exist (e.g. during development on a
# different platform), try the conda env at /tmp/mamba-root/envs/hole2/.

_SERVICE_DIR = Path(__file__).parent.resolve()
_PROJECT_ROOT = _SERVICE_DIR.parent.parent  # mini-services/hole2-service → project root

# Bundled HOLE2 binaries (primary)
VENDOR_HOLE2 = _PROJECT_ROOT / "vendor" / "hole2"
VENDOR_BIN = VENDOR_HOLE2 / "bin"
VENDOR_RAD = VENDOR_HOLE2 / "rad"
VENDOR_EXAMPLES = VENDOR_HOLE2 / "examples"

# Conda env fallback (for development)
MAMBA_ROOT = os.environ.get("MAMBA_ROOT_PREFIX", "/tmp/mamba-root")
HOLE2_ENV_NAME = os.environ.get("HOLE2_ENV_NAME", "hole2")
CONDA_PREFIX = f"{MAMBA_ROOT}/envs/{HOLE2_ENV_NAME}"

# A persistent jobs directory so downloads keep working across requests.
JOBS_DIR = Path(os.environ.get("HOLE2_JOBS_DIR", "/tmp/hole2-jobs"))
JOBS_DIR.mkdir(parents=True, exist_ok=True)

# Rad files + examples: prefer repo-local examples + the bundled vendor files,
# then the conda env as a final fallback.
HOLE2_REPO_RAD = VENDOR_RAD
HOLE2_REPO_EXAMPLES = VENDOR_EXAMPLES
# Repo-local examples (shipped with this repository) — the TRPM8 9PB6 demo
# with its recommended parameters. _example_dirs() merges these with the
# vendor examples so all four demos show up.
LOCAL_EXAMPLES = _SERVICE_DIR / "examples"

# ---------------------------------------------------------------------------
# Hardening constants
# ---------------------------------------------------------------------------

MAX_UPLOAD_BYTES = 50 * 1024 * 1024   # 50 MB — matches the UI promise
MAX_RAD_BYTES = 1 * 1024 * 1024       # 1 MB is plenty for a .rad file
JOB_ID_RE = re.compile(r"^[0-9a-f]{12}$")
SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
IGNORE_RE = re.compile(r"^[A-Za-z0-9 _-]+$")
JOB_MAX_AGE_S = 24 * 3600             # delete job dirs older than 24 h
JOB_SWEEP_INTERVAL_S = 600            # sweep every 10 min
MAX_CONCURRENT_RUNS = 2               # Fortran pipelines running at once


# ---------------------------------------------------------------------------
# Binary resolution
# ---------------------------------------------------------------------------

def env_bin(name: str) -> str:
    """Return the path to a HOLE2 binary.
    
    Tries the bundled vendor/ directory first, then the conda env.
    """
    bundled = str(VENDOR_BIN / name)
    if os.path.isfile(bundled) and os.access(bundled, os.X_OK):
        return bundled
    # Fallback to conda env
    return f"{CONDA_PREFIX}/bin/{name}"


def env_prefix() -> str:
    """Return the prefix for finding share/ data (rad files etc.)."""
    if VENDOR_HOLE2.exists():
        return str(VENDOR_HOLE2)
    return CONDA_PREFIX


def env_exists() -> bool:
    """Check if HOLE2 binaries are available (either bundled or conda)."""
    return os.path.isfile(env_bin("hole")) and os.access(env_bin("hole"), os.X_OK)


def run_in_env(args: list[str], *, cwd: str, input_text: str | None = None,
               timeout: int = 300) -> tuple[int, str, str]:
    """Run a HOLE2 command.
    
    With bundled binaries, we just need to set PATH so the binaries can find
    each other. The system's libgfortran.so.5 provides the Fortran runtime.
    """
    env = os.environ.copy()
    # Prepend the bin directory to PATH
    bin_dir = str(VENDOR_BIN) if VENDOR_BIN.exists() else f"{CONDA_PREFIX}/bin"
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    # For conda env fallback, set CONDA_PREFIX
    if not VENDOR_HOLE2.exists():
        env["CONDA_PREFIX"] = CONDA_PREFIX

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
# "Gmacro=   274.60041" — the Fortran SF2 format writes e-notation whenever
# the decimal exponent falls outside [-2, 5] (e.g. "1.2e+08"), so accept an
# optional exponent. Prefer the TAG summary line when present (it also gives
# Rmin) because the plain "Gmacro=" line can be the degenerate "0.0e***".
_GMACRO = re.compile(r"Gmacro=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)", re.I)
_GMACRO_TAG = re.compile(
    r"TAG\s+\d+\s+Rmin=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+"
    r"Gmacro=\s*(Infinity|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)", re.I)
# cguess prints its chosen channel direction: "Best direction is found to be     1"
_BEST_DIRECTION = re.compile(r"Best direction is found to be\s+(\d)")
# Hard error lines from hole.f (every fatal path prints an "ERROR" line)
_ERROR_LINES = re.compile(r"^.*\bERROR\b.*$", re.I | re.M)
# HOLE's no-pore sentinel: "Minimum radius found:  99999.000 angstroms."
_NO_PORE_SENTINEL = 9999.0


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
    # Gmacro: prefer the TAG summary line (also carries Rmin); fall back to
    # the plain "Gmacro=" line. Both regexes accept exponent notation.
    gm = _GMACRO_TAG.search(text)
    if gm and gm.group(2).lower() != "infinity":
        prof.g_macro = float(gm.group(2))
    else:
        gm2 = _GMACRO.search(text)
        if gm2:
            try:
                prof.g_macro = float(gm2.group(1))
            except ValueError:
                prof.g_macro = None

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
    elif (prof.min_radius is not None and prof.min_radius >= _NO_PORE_SENTINEL):
        # HOLE traced nothing (e.g. it could not find a path from cpoint to
        # solvent below endrad) and printed its 99999 "no pore" sentinel.
        prof.min_radius = None
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
      - columns 23-26: residue sequence number — HOLE uses several sentinels:
          * **-888**: "end" marker spheres placed at the pore exits
            (radius ≥ endrad) as a 2D grid.  NOT part of the centre line.
          * **-999**: Connolly-probe sampling points produced by the CONNOLLY
            option on large pores (e.g. cholera toxin).  These are NOT
            centre-line spheres — they're a cloud of probe positions sampled
            around the pore wall.  Including them makes the centre line look
            like a fuzzy cloud instead of a single curve.  Excluded from the
            centre line but kept in the "spheres" list for the sphere-cloud
            toggle.
          * **0, 1, 2, ... / -1, -2, ...**: the actual pore centre-line
            spheres, numbered from cpoint outward in both directions.  These
            ARE the centre line.
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
            # Skip HOLE's "end" marker spheres (resSeq = -888).
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


def centre_line_spheres(spheres: list[dict]) -> list[dict]:
    """Return only the real pore centre-line spheres.

    HOLE numbers the actual centre-line spheres as 0, 1, 2, ... (one side
    of cpoint) and -1, -2, ... (the other side) with NO lower bound, so any
    filter like ``idx > -100`` would silently truncate long pores with more
    than 99 reverse-direction samples.  The only other sentinels are:
      -888 = end markers (already filtered in parse_sph_file)
      -999 = Connolly-probe cloud points (large pores, CONNOLLY option)
    """
    return [s for s in spheres if s.get("idx", 0) != -999]


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
        # Try bundled rad dir (vendor/hole2/rad/), then conda env's share dir
        bundled = VENDOR_RAD / f"{rad_set}.rad"
        if not bundled.exists():
            bundled = Path(CONDA_PREFIX) / "share/hole2/rad" / f"{rad_set}.rad"
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
    try:
        rc, out, err = await asyncio.to_thread(
            run_in_env,
            [env_bin("hole")],
            cwd=str(work_dir),
            input_text=inp_text,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504,
            detail="The HOLE binary timed out (>300 s) on this structure — "
                   "it may be too large, or the parameters may send the "
                   "Monte-Carlo search into open space. Try ignoring hydrogens/"
                   "solvent residues or providing an explicit CPOINT.",
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

    # Parse the stdout. NOTE: hole.f prints " HOLE: normal completion" on
    # EVERY exit path (including fatal errors), so a zero return code does
    # NOT imply a pore was found. parse_hole_stdout + the checks below look
    # at the actual content (profile samples, ERROR lines, the 99999
    # no-pore sentinel) instead of trusting rc.
    profile = await asyncio.to_thread(parse_hole_stdout, out)
    error_lines = [ln.strip() for ln in _ERROR_LINES.findall(out)][:10]
    m_dir = _BEST_DIRECTION.search(out)
    cguess_direction = ({"1": "X", "2": "Y", "3": "Z"}.get(m_dir.group(1))
                        if m_dir else None)

    # -- Detect the "no pore traced" failure mode --------------------------
    # HOLE can exit cleanly (rc=0, "normal completion") yet fail to trace
    # any pore: 0 profile samples + the 99999 sentinel minimum radius. This
    # happens e.g. for large multi-domain channels (TRPM8 9PB6) where the
    # auto-guess picks the wrong axis or a vestibule wider than endrad
    # satisfies the end condition immediately. Surface an actionable error
    # instead of silently returning an empty profile.
    no_pore = (profile.n_samples == 0)
    if no_pore:
        hints: list[str] = [
            "HOLE completed but could not trace a pore with the current parameters.",
        ]
        if error_lines:
            hints.insert(1, "HOLE reported: " + "; ".join(error_lines[:3]))
        elif cguess_direction:
            hints.append(
                f"The automatic guess (cguess) chose the channel direction "
                f"{cguess_direction} — verify this matches the real pore axis; "
                "for large multi-domain channels the guess is often wrong.")
        if params.get("cpoint_x") is None and params.get("cvect_x") is None:
            hints.append(
                "Try providing an explicit Channel vector (CVECT) and Channel "
                "centre point (CPOINT) — e.g. for a C4-symmetric tetramer the "
                "pore runs through the symmetry axis.")
        try:
            endrad_val = float(params.get("endrad") or 5.0)
        except (TypeError, ValueError):
            endrad_val = 5.0
        hints.append(
            f"If the pore has a wide vestibule or central cavity, raise the end "
            f"radius (currently {endrad_val:.1f} Å) above the cavity radius "
            "(e.g. 20–25 Å) so the trace continues through it instead of "
            "stopping at the first wide point.")
        hints.append(
            "Also consider ignoring solvent/ligand residues (HOH TIP WAT ...) "
            "that may block the pore.")
        return RunResult(
            job_id=job_id, work_dir=str(work_dir),
            profile=profile, spheres=[], surface={"triangles": [], "colors": []},
            summary={
                "status": "no_pore",
                "returncode": rc,
                "cguess_direction": cguess_direction,
                "min_radius": None,
                "n_samples": 0,
            },
            files=sorted(p.name for p in work_dir.iterdir()),
            log_tail=out[-3000:], returncode=rc,
            error="HOLE could not trace a pore — see warnings for suggested fixes.",
            warnings=[" ".join(hints[:2]), *hints[2:]] if len(hints) > 2 else hints,
        )

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
        env = {**os.environ, "PATH": f"{str(VENDOR_BIN) if VENDOR_BIN.exists() else CONDA_PREFIX + '/bin'}:{os.environ.get('PATH','')}"}
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
    # NOTE: the bundled vendor qpt_conv build hangs on this prompt feed (the
    # conda-forge build exits cleanly with it), so the timeout is kept SHORT
    # — a working qpt_conv finishes in well under a second; a hung one is
    # killed after 5 s instead of stalling every run for a full minute.
    dot_vmd_path = work_dir / "dotsurface.vmd_plot"
    try:
        if dot_qpt.exists():
            feed = b"D\ndotsurface.qpt\ndotsurface.vmd_plot\n1\n"
            proc = await asyncio.to_thread(
                lambda: subprocess.run(
                    [env_bin("qpt_conv")],
                    input=feed, capture_output=True, cwd=str(work_dir),
                    env={**os.environ, "PATH": f"{str(VENDOR_BIN) if VENDOR_BIN.exists() else CONDA_PREFIX + '/bin'}:{os.environ.get('PATH','')}"},
                    timeout=5,
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
    all_spheres = parse_sph_file(sph_path)
    surface = parse_sos_vmd(vmd_path)

    # The .sph file may contain Connolly-probe cloud points (resSeq=-999) and
    # end markers (resSeq=-888, already filtered).  For the centre-line tube
    # we want ONLY the numbered centre-line spheres (resSeq in [-N, +N]).
    # The full sphere list (including -999) is kept for the sphere-cloud toggle.
    cl_spheres = centre_line_spheres(all_spheres)

    # If cvec/cpoint were masked (auto-guessed by HOLE's cguess), recover the
    # channel axis.  We PCA on the centre-line spheres only (not the -999
    # cloud) so the inferred axis points along the actual pore.
    if profile.cvec is None or profile.cpoint is None:
        inferred_cvec, inferred_cpoint = infer_channel_axis(cl_spheres)
        if profile.cvec is None:
            profile.cvec = inferred_cvec
        if profile.cpoint is None:
            profile.cpoint = inferred_cpoint

    # Sort the centre-line spheres by their projection onto cvec so the
    # centre-line tube in the 3D viewer runs smoothly along the pore (HOLE
    # writes them in discovery order which zigzags from cpoint outward).
    cvx, cvy, cvz = profile.cvec or [0.0, 0.0, 1.0]
    cpx, cpy, cpz = profile.cpoint or [0.0, 0.0, 0.0]
    cl_sorted = sorted(cl_spheres, key=lambda s: (
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
        "n_spheres": len(all_spheres),
        "n_triangles": len(surface.get("triangles", [])),
        "cguess_direction": cguess_direction,
    }
    if len(all_spheres) > 5000 or len(surface.get("triangles", [])) > 20000:
        sos_warning = (sos_warning or "") + (" " if sos_warning else "") + \
            "Large result: the sphere/triangle payload sent to the 3D viewer " \
            "was capped (5000 spheres / 20000 triangles); download the raw " \
            "files for the full data."

    files = sorted(p.name for p in work_dir.iterdir())
    warnings = [w for w in [sos_warning] if w]
    return RunResult(
        job_id=job_id, work_dir=str(work_dir),
        profile=profile, spheres=all_spheres, surface=surface,
        summary=summary, files=files,
        log_tail=out[-3000:], returncode=0, error=None,
        warnings=warnings,
        centreline=[[s["x"], s["y"], s["z"]] for s in cl_sorted[:5000]],
    )


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="HOLE2 Web Service",
    description="Wraps the HOLE2 ion-channel pore-analysis suite behind a REST API.",
    version="1.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Limit the number of HOLE pipelines running at once — each run spawns up
# to 6 Fortran subprocesses and allocates large work arrays for big PDBs.
_run_semaphore = asyncio.Semaphore(MAX_CONCURRENT_RUNS)


async def _sweep_jobs() -> None:
    """Delete job directories older than JOB_MAX_AGE_S (and stray files).

    Runs once at startup and then every JOB_SWEEP_INTERVAL_S so /tmp does
    not grow without bound (each job can hold a 50 MB PDB + outputs).
    """
    while True:
        try:
            import time
            now = time.time()
            for d in JOBS_DIR.iterdir():
                try:
                    if d.is_dir() and (now - d.stat().st_mtime) > JOB_MAX_AGE_S:
                        shutil.rmtree(d, ignore_errors=True)
                except OSError:
                    pass
        except Exception:  # pragma: no cover — sweeper must never crash
            pass
        await asyncio.sleep(JOB_SWEEP_INTERVAL_S)


@app.on_event("startup")
async def _start_background_tasks() -> None:
    asyncio.create_task(_sweep_jobs())


# Early rejection of oversized upload bodies (before the full body is read
# into RAM) based on the Content-Length header. Belt-and-braces with the
# post-read check in /api/run.
class _RejectOversizedBodies:
    """Pure-ASGI middleware: reject oversized upload bodies early (before
    the body is read) based on the Content-Length header.

    Implemented as raw ASGI rather than ``@app.middleware("http")`` because
    Starlette's BaseHTTPMiddleware wraps the response stream, which —
    verified empirically — delays POST responses by ~60 s for Node/undici
    clients (curl is unaffected). A pure-ASGI middleware passes the response
    through untouched.
    """

    MAX_COMBINED = MAX_UPLOAD_BYTES + MAX_RAD_BYTES + 1024 * 1024

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        cl: str | None = None
        for k, v in scope.get("headers", []):
            if k.lower() == b"content-length":
                cl = v.decode("latin-1")
                break
        if cl and cl.isdigit() and int(cl) > self.MAX_COMBINED:
            import json as _json
            body = _json.dumps({
                "detail": f"Request body too large (>{self.MAX_COMBINED // (1024*1024)} MB). "
                          "Upload a smaller structure or strip solvent/hydrogens.",
            }).encode()
            await send({
                "type": "http.response.start",
                "status": 413,
                "headers": [(b"content-type", b"application/json")],
            })
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)

    def __init__(self, app):
        self.app = app


app.add_middleware(_RejectOversizedBodies)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "env_ready": env_exists(),
        "env_prefix": env_prefix(),
        "jobs_dir": str(JOBS_DIR),
    }


_EXAMPLE_DESCRIPTIONS = {
    "01_gramicidin_1grm": "Gramicidin A (1GRM) — narrow channel, single-file water wire. The classic HOLE demo.",
    "02_choleratoxin_1chb": "Cholera toxin B pentamer (1CHB) — large pore, uses the Connolly probe.",
    "03_maltoporin_1af6": "Maltoporin trimer (1AF6) — sugar channel with explicit CPOINT/CVECT overrides.",
    "04_trpm8_9pb6": "Avian TRPM8 tetramer (9PB6, menthol-bound cryo-EM) — large multi-domain "
                     "channel whose ~19 Å central cavity defeats the default endrad=5 and the "
                     "cguess auto-direction; runs with explicit CVECT 0 0 1, CPOINT and endrad 22.",
}

# Recommended web-form parameters for each bundled example. The front-end
# applies these when the user one-click loads the example.
_EXAMPLE_PARAMS = {
    "01_gramicidin_1grm": {
        "endrad": "5.0", "ignore_residues": "", "shorto": "0", "dotden": "15",
    },
    "02_choleratoxin_1chb": {
        "connolly": True, "ignore_residues": "HOH TIP WAT", "shorto": "0", "dotden": "5",
    },
    "03_maltoporin_1af6": {
        "cvect_x": "0.0", "cvect_y": "0.0", "cvect_z": "1.0",
        "cpoint_x": "-14.285", "cpoint_y": "47.809", "cpoint_z": "82.707",
        "ignore_residues": "FRU GLC MG HOH", "shorto": "0", "dotden": "15",
    },
    # TRPM8 9PB6: the pore runs along the C4 symmetry axis (z) through the
    # tetramer centre; endrad must exceed the ~19 Å central cavity so HOLE
    # does not treat the cavity as an immediate pore "end".
    "04_trpm8_9pb6": {
        "cvect_x": "0.0", "cvect_y": "0.0", "cvect_z": "1.0",
        "cpoint_x": "209.639", "cpoint_y": "209.636", "cpoint_z": "202.5",
        "endrad": "22.0", "ignore_residues": "", "shorto": "0", "dotden": "15",
    },
}


def _examples_root() -> Path:
    """Repo-local examples ship with the service; fall back to a cloned
    osmart/hole2 checkout for the original trio."""
    if (LOCAL_EXAMPLES).exists() and any(LOCAL_EXAMPLES.iterdir()):
        return LOCAL_EXAMPLES
    return HOLE2_REPO_EXAMPLES


def _example_dirs() -> list[Path]:
    """All example directories, repo-local ones first, then any cloned
    osmart/hole2 examples that are not shadowed by a repo-local dir with
    the same name (so the original trio + TRPM8 all show up)."""
    dirs: list[Path] = []
    seen: set[str] = set()
    for root in (LOCAL_EXAMPLES, HOLE2_REPO_EXAMPLES):
        if not root.exists():
            continue
        for d in sorted(root.iterdir()):
            if not d.is_dir() or d.name.startswith("000") or d.name in seen:
                continue
            seen.add(d.name)
            dirs.append(d)
    return dirs


@app.get("/api/examples")
async def list_examples():
    """List the bundled example structures (gramicidin, cholera toxin,
    maltoporin, TRPM8) together with their recommended parameters."""
    out: list[dict] = []
    for d in _example_dirs():
        pdbs = sorted(d.glob("*.pdb"))
        inps = sorted(d.glob("*.inp"))
        out.append({
            "id": d.name,
            "name": d.name,
            "pdb_files": [p.name for p in pdbs],
            "inp_files": [p.name for p in inps],
            "description": _EXAMPLE_DESCRIPTIONS.get(d.name, ""),
            "params": _EXAMPLE_PARAMS.get(d.name, {}),
        })
    return {"examples": out}


def _safe_resolve(base: Path, *parts: str) -> Path | None:
    """Resolve *parts under base, refusing anything that escapes base."""
    p = base.joinpath(*parts).resolve()
    try:
        p.relative_to(base.resolve())
    except ValueError:
        return None
    return p


@app.get("/api/example/{example_id}/{pdb_name}")
async def get_example_pdb(example_id: str, pdb_name: str):
    """Stream a bundled example PDB file (so the front-end can one-click load it)."""
    # Validate both path components: no separators, no dots-only tricks.
    if not SAFE_NAME_RE.fullmatch(example_id) or not SAFE_NAME_RE.fullmatch(pdb_name):
        raise HTTPException(status_code=400, detail="Invalid example id or file name")
    p: Path | None = None
    for root in (LOCAL_EXAMPLES, HOLE2_REPO_EXAMPLES):
        if not root.exists():
            continue
        cand = _safe_resolve(root, example_id, pdb_name)
        if cand is None or not cand.is_file():
            # try prefix match (e.g. user passes "1grm_single")
            d = _safe_resolve(root, example_id)
            if d is not None and d.is_dir():
                cands = [c for c in d.glob(f"{re.escape(pdb_name)}*") if c.is_file()]
                if cands:
                    cand = cands[0]
        if cand is not None and cand.is_file():
            p = cand
            break
    if p is None:
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
    # --- input validation (fail fast, before reading bodies) -----------------
    if not SAFE_NAME_RE.fullmatch((sphpdb_name or "hole_out")):
        raise HTTPException(status_code=400,
            detail="sphpdb_name may only contain letters, digits, dot, dash, underscore")
    if ignore_residues and not IGNORE_RE.fullmatch(ignore_residues):
        raise HTTPException(status_code=400,
            detail="ignore_residues may only contain letters, digits, spaces, dashes")
    # Allowed radius sets: bundled vendor dir first, then the conda env's
    # share dir, then any fallback clone. (env_prefix() points at the vendor
    # root in bundled mode, where the layout is vendor/hole2/rad — not
    # share/hole2/rad — so resolve explicitly.)
    _rad_dirs = [VENDOR_RAD,
                 Path(CONDA_PREFIX) / "share/hole2/rad",
                 Path(env_prefix()) / "share/hole2/rad"]
    allowed_rad_sets: set[str] = set()
    for _rd in _rad_dirs:
        if _rd.is_dir():
            allowed_rad_sets |= {p.stem for p in _rd.glob("*.rad")}
    has_custom_rad = radius_file is not None and (radius_file.filename or "") != ""
    if not has_custom_rad and allowed_rad_sets and radius_set not in allowed_rad_sets:
        raise HTTPException(status_code=400,
            detail=f"Unknown radius set '{radius_set}'. Allowed: {', '.join(sorted(allowed_rad_sets))}")

    pdb_bytes = await pdb_file.read()
    if not pdb_bytes:
        raise HTTPException(status_code=400, detail="Empty PDB file")
    if len(pdb_bytes) > MAX_UPLOAD_BYTES:
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
        # NOTE: shorto >= 2 suppresses the per-sample profile lines the
        # parser needs; we pass it through for power users, but the UI only
        # offers 0-3 with a hint.
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
        if len(custom_rad) > MAX_RAD_BYTES:
            raise HTTPException(status_code=413, detail="Radius file too large (>1 MB)")

    # Limit concurrent Fortran pipelines — each run spawns up to 6
    # subprocesses and allocates large arrays for big structures.
    try:
        await asyncio.wait_for(_run_semaphore.acquire(), timeout=5.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=429,
            detail="Server busy — other HOLE2 runs are in progress. Try again shortly.")
    try:
        result = await run_hole_pipeline(pdb_bytes, pdb_file.filename or "input.pdb",
                                         params, custom_rad)
    finally:
        _run_semaphore.release()

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
    # Validate job_id (defends against path traversal like /api/download/../x)
    # and the filename.
    if not JOB_ID_RE.fullmatch(job_id):
        raise HTTPException(status_code=400, detail="Invalid job_id")
    if not SAFE_NAME_RE.fullmatch(filename):
        raise HTTPException(status_code=400, detail="Invalid filename")
    job_dir = JOBS_DIR / job_id
    if not job_dir.exists() or not job_dir.is_dir():
        raise HTTPException(status_code=404, detail="Unknown job_id")
    target = (job_dir / filename).resolve()
    if job_dir.resolve() not in target.parents:
        raise HTTPException(status_code=400, detail="Invalid filename")
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
    if not JOB_ID_RE.fullmatch(job_id):
        raise HTTPException(status_code=400, detail="Invalid job_id")
    job_dir = JOBS_DIR / job_id
    if not job_dir.exists():
        raise HTTPException(status_code=404, detail="Unknown job_id")
    files = []
    for p in sorted(job_dir.iterdir()):
        if p.is_file():
            files.append({"name": p.name, "size": p.stat().st_size})
    return {"job_id": job_id, "files": files}


def _fetch_pdb_from_rcsb(pid: str) -> dict:
    """Blocking RCSB fetch (run via asyncio.to_thread from the handler)."""
    import urllib.request
    urls = [
        (f"https://files.rcsb.org/download/{pid}.pdb", "pdb"),
        (f"https://files.rcsb.org/download/{pid}.cif", "cif"),
    ]
    last_err: str = ""
    for url, fmt in urls:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "hole2-web/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                # Cap the read at MAX_UPLOAD_BYTES — huge cryo-EM structures
                # (some are >200 MB as CIF) would otherwise be fully buffered.
                content = resp.read(MAX_UPLOAD_BYTES + 1)
                if len(content) > MAX_UPLOAD_BYTES:
                    last_err = (f"structure {pid} exceeds the {MAX_UPLOAD_BYTES // (1024*1024)} MB "
                                "download cap — download it from RCSB and upload the file instead")
                    continue
                if len(content) < 100:
                    last_err = f"Empty response from {url}"
                    continue
                return {
                    "pdb_id": pid,
                    "format": fmt,
                    "filename": f"{pid}.{fmt}",
                    "content": content.decode("utf-8", errors="replace"),
                    "size": len(content),
                }
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code} from RCSB: {e.reason}"
        except Exception as e:
            last_err = str(e)
    raise HTTPException(status_code=404, detail=f"PDB ID '{pid}' not found at RCSB. {last_err}")


@app.get("/api/pdb/{pdb_id}")
async def fetch_pdb_id(pdb_id: str):
    """Fetch a structure from the RCSB PDB by its 4-character ID.

    Returns the raw PDB or mmCIF file content.  The front-end uses this
    endpoint so the user can type a PDB ID (e.g. "1grm") and load the
    structure without leaving the app.  We proxy through the service to
    avoid CORS restrictions in the browser.
    """
    pid = pdb_id.strip().lower()
    if not re.fullmatch(r"[0-9a-z]{4}", pid):
        raise HTTPException(status_code=400, detail="PDB ID must be exactly 4 alphanumeric characters")
    # Run the blocking urllib call off the event loop so a slow RCSB does
    # not stall every other endpoint for up to 30 s.
    data = await asyncio.to_thread(_fetch_pdb_from_rcsb, pid)
    return JSONResponse(data)


@app.get("/api/job/{job_id}/zip")
async def download_job_zip(job_id: str):
    """Stream a ZIP archive of all output files for a job."""
    import io as _io
    import zipfile
    from fastapi.responses import StreamingResponse
    if not JOB_ID_RE.fullmatch(job_id):
        raise HTTPException(status_code=400, detail="Invalid job_id")
    job_dir = JOBS_DIR / job_id
    if not job_dir.exists() or not job_dir.is_dir():
        raise HTTPException(status_code=404, detail="Unknown job_id")

    def _build_zip() -> _io.BytesIO:
        buf = _io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for p in sorted(job_dir.iterdir()):
                if p.is_file():
                    zf.write(p, arcname=p.name)
        buf.seek(0)
        return buf

    # Build the archive off the event loop — jobs can hold 50+ MB of output.
    buf = await asyncio.to_thread(_build_zip)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="hole2-{job_id}.zip"'},
    )


@app.get("/api/rad-sets")
async def rad_sets_with_desc():
    """List bundled vdw radius sets with descriptions to help the user choose."""
    names: list[str] = []
    # Try bundled rad dir (vendor/hole2/rad/), then conda env
    rad_dir = VENDOR_RAD if VENDOR_RAD.exists() else Path(CONDA_PREFIX) / "share/hole2/rad"
    if rad_dir.exists():
        names = sorted(p.stem for p in rad_dir.glob("*.rad"))
    if not names and HOLE2_REPO_RAD.exists():
        names = sorted(p.stem for p in HOLE2_REPO_RAD.glob("*.rad"))
    # Descriptions of each radius set (from the HOLE2 doc + .rad file headers).
    descriptions = {
        "simple": "Simple AMBER vdw radii — one value per element (C 1.85, O 1.65, N 1.75, etc.). Recommended for most protein channels. From Weiner et al. 1984 JACS.",
        "amberuni": "AMBER united-atom radii — treats hydrogens implicitly (merged into heavy atoms). Use for structures without explicit hydrogens. Faster, slightly different radii than simple.rad.",
        "bondi": "Bondi radii — widely-used compilation (Bondi 1964). Slightly larger vdW for polar atoms. Good for structures with explicit hydrogens.",
        "hardcore": "Hard-sphere radii — smaller vdW (close-packed). Produces narrower pores. Use to test sensitivity to the radius set.",
        "xplor": "X-PLOR/CNS radii — matches the X-PLOR simulation package conventions. Use if your structure came from X-PLOR/CNS.",
    }
    return {
        "rad_sets": [
            {"name": n, "description": descriptions.get(n, "HOLE2 vdw radius set")}
            for n in names
        ],
        "default": "simple",
    }


@app.get("/")
async def root():
    return {"service": "hole2", "endpoints": [
        "/api/health", "/api/rad-sets", "/api/examples",
        "/api/run (POST)", "/api/download/{job_id}/{filename}",
        "/api/job/{job_id}/files", "/api/job/{job_id}/zip",
        "/api/pdb/{pdb_id}",
    ]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3001)
