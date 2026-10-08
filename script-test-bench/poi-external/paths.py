# -*- coding: utf-8 -*-
"""Paths of the POI external-sources study (docs/audits/2026-09-23-poi-external-sources.md).

REPO         repository root, resolved from this file.
SYSTEM_TEMP  where the raw downloads were left (AllThePlaces zip, SIRENE parquet).
WORK         intermediate files of the study: POI_STUDY_DIR, default
             <system temp>/redview-poi-study (the .mjs steps use the same rule).
"""
import os
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SYSTEM_TEMP = Path(tempfile.gettempdir())
WORK = Path(os.environ.get('POI_STUDY_DIR', SYSTEM_TEMP / 'redview-poi-study'))
WORK.mkdir(parents=True, exist_ok=True)
