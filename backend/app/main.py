
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
import os

app = FastAPI()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
def read_root():
    return {"status": "PayTaksi API running"}

@app.get("/admin")
def admin():
    return {"login": "Ratik", "password": "0123456789"}
