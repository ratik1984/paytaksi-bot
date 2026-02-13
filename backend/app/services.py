import math
from .config import settings


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def calc_fare(distance_km: float) -> tuple[float, float]:
    """Returns (fare_azn, commission_azn)."""
    fare = settings.BASE_FARE_AZN
    if distance_km > settings.BASE_DISTANCE_KM:
        extra = distance_km - settings.BASE_DISTANCE_KM
        fare += extra * settings.PER_KM_AZN
    fare = round(fare, 2)
    commission = round(fare * settings.COMMISSION_RATE, 2)
    return fare, commission
