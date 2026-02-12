from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import User, Role


def get_or_create_user(db: Session, telegram_id: int, role: Role, full_name: str = "") -> User:
    u = db.query(User).filter(User.telegram_id == telegram_id).one_or_none()
    if u:
        # do not overwrite role if already set (keep first role)
        if not u.full_name and full_name:
            u.full_name = full_name
            db.commit()
        return u
    u = User(
        telegram_id=telegram_id,
        role=role,
        full_name=full_name[:120],
        is_approved=False if role == Role.driver else True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u
