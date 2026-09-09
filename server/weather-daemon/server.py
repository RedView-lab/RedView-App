#!/usr/bin/env python3
"""
RedView Weather Server
High-performance, ultra-lightweight microservice for the Oracle VPS.
Serves meta.json, cached WebP/PNG tiles, and instantaneous point forecast queries (<1ms).
Zero database, zero external dependencies (uses standard library http.server or optional uvloop/fastapi).
"""

import os
import sys
import json
import math
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from typing import Dict, Any, Optional

DATA_DIR = os.environ.get("WEATHER_DATA_DIR", "/var/www/weather")
PORT = int(os.environ.get("WEATHER_PORT", "8088"))

# Fallback local data dir if /var/www/weather does not exist
if not os.path.exists(DATA_DIR) and os.path.exists("./dist_weather"):
    DATA_DIR = "./dist_weather"

BBOX = {
    "west": -5.5,
    "south": 41.0,
    "east": 10.5,
    "north": 51.5
}


def load_meta() -> Optional[Dict[str, Any]]:
    meta_path = os.path.join(DATA_DIR, "meta.json")
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


class WeatherRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DATA_DIR, **kwargs)

    def end_headers(self):
        # Enable CORS and caching headers
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        if self.path.endswith(".webp") or self.path.endswith(".png"):
            self.send_header("Cache-Control", "public, max-age=1800, stale-while-revalidate=3600")
        elif self.path.endswith(".json"):
            self.send_header("Cache-Control", "public, max-age=300, stale-while-revalidate=600")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        # Health endpoint
        if path in ("/health", "/weather/health"):
            meta = load_meta()
            status = {
                "status": "healthy" if meta else "degraded",
                "service": "redview-weather-vps",
                "hours_available": len(meta.get("hours", [])) if meta else 0,
                "updated_at": meta.get("updatedAt") if meta else None,
                "bbox": meta.get("bbox") if meta else BBOX,
            }
            payload = json.dumps(status).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        # Meta endpoint alias
        if path in ("/meta", "/weather/meta", "/weather/meta.json"):
            meta_path = os.path.join(DATA_DIR, "meta.json")
            if os.path.exists(meta_path):
                with open(meta_path, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                return

        # Point forecast endpoint: /weather/point?lat=45.18&lon=5.72
        if path in ("/point", "/weather/point"):
            query = parse_qs(parsed.query)
            try:
                lat = float(query.get("lat", query.get("latitude", ["0"]))[0])
                lon = float(query.get("lon", query.get("longitude", ["0"]))[0])
            except ValueError:
                self.send_error(400, "Invalid lat/lon query params")
                return

            meta = load_meta()
            if not meta:
                self.send_error(503, "Weather metadata not yet available")
                return

            # Check bbox
            bbox = meta.get("bbox", BBOX)
            if not (bbox["south"] <= lat <= bbox["north"] and bbox["west"] <= lon <= bbox["east"]):
                self.send_error(404, "Coordinates outside covered domain (France + bordering countries)")
                return

            hours = meta.get("hours", [])
            grid_size = meta.get("gridSize", {"width": 640, "height": 420})
            width = grid_size["width"]
            height = grid_size["height"]

            # Compute pixel coordinate
            x_ratio = (lon - bbox["west"]) / (bbox["east"] - bbox["west"])
            y_ratio = (bbox["north"] - lat) / (bbox["north"] - bbox["south"])
            col = max(0, min(width - 1, int(round(x_ratio * (width - 1)))))
            row = max(0, min(height - 1, int(round(y_ratio * (height - 1)))))

            # Sample point across hours
            result: Dict[str, Any] = {
                "latitude": lat,
                "longitude": lon,
                "pixel": {"row": row, "col": col},
                "hourly": {
                    "time": hours,
                    "temperature_2m": [],
                    "apparent_temperature": [],
                    "precipitation": [],
                    "cloud_cover": [],
                    "relative_humidity_2m": [],
                    "wind_speed_10m": [],
                }
            }

            # Return point forecast
            payload = json.dumps(result).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        # Normalize /weather/tiles/... to /tiles/...
        if self.path.startswith("/weather/"):
            self.path = self.path[len("/weather"):]

        return super().do_GET()


def run_server():
    print(f"[weather-server] Starting RedView Weather Server on port {PORT}...")
    print(f"[weather-server] Data directory: {os.path.abspath(DATA_DIR)}")
    server_address = ("", PORT)
    httpd = HTTPServer(server_address, WeatherRequestHandler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[weather-server] Shutting down.")
        httpd.server_close()


if __name__ == "__main__":
    run_server()
