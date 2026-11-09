"""FastAPI backend service for pg-copilot.

Provides endpoints for PostgreSQL telemetry collection, AI diagnostics,
air-gapped snapshot ingestion, and sandbox database resets.
"""

import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

# Ensure repo root is on sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from analyzer.catalog_queries import collect_full_telemetry
from analyzer.db import get_readonly_connection
from agent.advisor_agent import AdvisorReport, generate_ai_diagnosis

load_dotenv()

app = FastAPI(
    title="pg-copilot API",
    description="AI-Native PostgreSQL Health, Index & Vacuum Advisor Backend",
    version="1.0.0",
)

# Enable CORS for frontend clients (Vite dev server default: http://localhost:5173)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# Request / Response Schemas
# ============================================================================

class DiagnoseRequest(BaseModel):
    db_url: str
    api_key: Optional[str] = None
    provider: Optional[str] = None


class DiagnoseSnapshotRequest(BaseModel):
    telemetry: Dict[str, Any]
    api_key: Optional[str] = None
    provider: Optional[str] = None


class ReseedRequest(BaseModel):
    db_url: Optional[str] = None


# ============================================================================
# Helpers
# ============================================================================

def resolve_effective_uri(input_uri: str) -> str:
    """Validate connection and gracefully fallback between 5432 and 5433 if needed."""
    try:
        with get_readonly_connection(input_uri) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1;")
        return input_uri
    except Exception as primary_err:
        if ":5432/" in input_uri:
            alt_uri = input_uri.replace(":5432/", ":5433/")
            try:
                with get_readonly_connection(alt_uri) as conn:
                    with conn.cursor() as cur:
                        cur.execute("SELECT 1;")
                return alt_uri
            except Exception:
                pass
        elif ":5433/" in input_uri:
            alt_uri = input_uri.replace(":5433/", ":5432/")
            try:
                with get_readonly_connection(alt_uri) as conn:
                    with conn.cursor() as cur:
                        cur.execute("SELECT 1;")
                return alt_uri
            except Exception:
                pass
        raise primary_err


# ============================================================================
# API Endpoints
# ============================================================================

@app.get("/api/health")
def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "service": "pg-copilot-api"}


@app.post("/api/diagnose")
def diagnose_database(req: DiagnoseRequest):
    """Collect read-only catalog telemetry and generate an AI/Deterministic diagnosis."""
    if not req.db_url:
        raise HTTPException(status_code=400, detail="Database URL is required.")

    try:
        effective_uri = resolve_effective_uri(req.db_url)
        telemetry = collect_full_telemetry(effective_uri)
        report = generate_ai_diagnosis(
            telemetry_dict=telemetry,
            api_key=req.api_key,
            provider=req.provider,
        )
        report_dict = report.model_dump() if hasattr(report, "model_dump") else report.dict()
        return {
            "status": "success",
            "effective_uri": effective_uri,
            "telemetry": telemetry,
            "report": report_dict,
        }
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to analyze database: {str(e)}",
        )


@app.post("/api/diagnose-snapshot")
def diagnose_snapshot(req: DiagnoseSnapshotRequest):
    """Analyze an uploaded air-gapped telemetry.json snapshot."""
    if not req.telemetry:
        raise HTTPException(status_code=400, detail="Telemetry payload is required.")

    # Validate essential diagnostic keys
    expected_keys = {"unused_indexes", "vacuum_bloat_candidates", "missing_index_candidates", "stale_stats_candidates"}
    if not any(k in req.telemetry for k in expected_keys):
        raise HTTPException(
            status_code=400,
            detail="Invalid telemetry snapshot format. Missing catalog keys.",
        )

    try:
        report = generate_ai_diagnosis(
            telemetry_dict=req.telemetry,
            api_key=req.api_key,
            provider=req.provider,
        )
        report_dict = report.model_dump() if hasattr(report, "model_dump") else report.dict()
        return {
            "status": "success",
            "telemetry": req.telemetry,
            "report": report_dict,
        }
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to analyze telemetry snapshot: {str(e)}",
        )


@app.post("/api/reseed")
def reseed_sandbox_db(req: ReseedRequest):
    """Execute seed_dirty_db.py to reset the PostgreSQL sandbox database."""
    target_uri = req.db_url or os.getenv("DATABASE_URL") or "postgresql://postgres:postgres@localhost:5433/perf_sandbox"

    try:
        effective_uri = resolve_effective_uri(target_uri)
    except Exception:
        effective_uri = target_uri

    env = os.environ.copy()
    env["DATABASE_URL"] = effective_uri

    seed_script = REPO_ROOT / "seed_dirty_db.py"
    proc = subprocess.run(
        [sys.executable, str(seed_script), effective_uri],
        capture_output=True,
        text=True,
        env=env,
    )

    if proc.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Seeding failed: {proc.stderr or proc.stdout}",
        )

    return {
        "status": "success",
        "message": "Sandbox database successfully re-seeded with degraded production scenarios.",
        "stdout": proc.stdout,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api.main:app", host="0.0.0.0", port=8000, reload=True)

