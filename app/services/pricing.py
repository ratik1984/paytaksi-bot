from decimal import Decimal

DEFAULT_BASE_FARE = Decimal("3.50")
DEFAULT_INCLUDED_KM = Decimal("3.0")
DEFAULT_PER_KM_AFTER = Decimal("0.40")
DEFAULT_COMMISSION_RATE = Decimal("0.10")  # 10%

def calc_fare(distance_km: Decimal,
              base_fare: Decimal = DEFAULT_BASE_FARE,
              included_km: Decimal = DEFAULT_INCLUDED_KM,
              per_km_after: Decimal = DEFAULT_PER_KM_AFTER) -> Decimal:
    if distance_km <= included_km:
        return base_fare
    extra = distance_km - included_km
    return (base_fare + extra * per_km_after).quantize(Decimal("0.01"))

def calc_commission(fare: Decimal, rate: Decimal = DEFAULT_COMMISSION_RATE) -> Decimal:
    return (fare * rate).quantize(Decimal("0.01"))
