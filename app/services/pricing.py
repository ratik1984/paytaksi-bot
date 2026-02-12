from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

BASE_FARE = Decimal("3.50")
INCLUDED_KM = Decimal("3.0")
PER_KM_AFTER = Decimal("0.40")
COMMISSION_RATE = Decimal("0.10")


def calc_fare(distance_km: float) -> Decimal:
    d = Decimal(str(max(0.0, distance_km)))
    fare = BASE_FARE
    if d > INCLUDED_KM:
        extra = (d - INCLUDED_KM) * PER_KM_AFTER
        fare += extra
    return fare.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def calc_commission(fare: Decimal) -> Decimal:
    return (fare * COMMISSION_RATE).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
