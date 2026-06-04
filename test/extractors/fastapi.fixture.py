# Spec 11 fixture — FastAPI app with 3 routes + Pydantic model.
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class User(BaseModel):
    id: int
    email: str
    name: str


@app.get("/users")
def list_users():
    return []


@app.post("/users")
def create_user(user: User):
    return user


@app.get("/users/{user_id}")
def get_user(user_id: int):
    return {"id": user_id}
