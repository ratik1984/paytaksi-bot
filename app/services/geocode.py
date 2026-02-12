from __future__ import annotations
import requests

# OpenStreetMap Nominatim
# Respect usage policy: provide a valid User-Agent and don't spam.
UA = "PayTaksiBot/1.0 (contact: admin@example.com)"

def search_places(query: str, limit: int = 5, country_codes: str = "az") -> list[dict]:
    url = "https://nominatim.openstreetmap.org/search"
    params = {
        "q": query,
        "format": "jsonv2",
        "addressdetails": 1,
        "limit": limit,
        "countrycodes": country_codes,
    }
    r = requests.get(url, params=params, headers={"User-Agent": UA}, timeout=10)
    r.raise_for_status()
    return r.json()

def reverse_geocode(lat: float, lon: float) -> str:
    url = "https://nominatim.openstreetmap.org/reverse"
    params = {"lat": lat, "lon": lon, "format": "jsonv2"}
    r = requests.get(url, params=params, headers={"User-Agent": UA}, timeout=10)
    r.raise_for_status()
    data = r.json()
    return data.get("display_name", "") or ""
