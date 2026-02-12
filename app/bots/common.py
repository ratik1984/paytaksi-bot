from __future__ import annotations
from decimal import Decimal
from sqlalchemy.orm import Session
from ..models import User, Wallet, Role

def get_or_create_user(db: Session, telegram_id: int, role: Role, name: str = "") -> User:
    u = db.query(User).filter_by(telegram_id=telegram_id).one_or_none()
    if u is None:
        u = User(telegram_id=telegram_id, role=role, name=name or "")
        db.add(u)
        db.flush()
        w = Wallet(user_id=u.id, balance=Decimal("0.00"))
        db.add(w)
        db.commit()
        db.refresh(u)
    else:
        # role update only if same
        pass
    return u
