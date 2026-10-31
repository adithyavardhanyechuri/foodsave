import os, asyncio, json, uuid, base64, certifi, math, random, string
import io, hmac, re
import qrcode
from datetime import datetime, timedelta
from typing import Optional, List
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends, status, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import socketio
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, EmailStr
from bson import ObjectId
from bson.errors import InvalidId
import jwt as pyjwt
import bcrypt
import httpx
import uvicorn
from dotenv import load_dotenv

load_dotenv()

# ─── Config ────────────────────────────────────────────────────────────────
MONGO_URI             = os.getenv("MONGO_URI", "mongodb://localhost:27017")
DB_NAME               = os.getenv("DB_NAME", "foodsave")
JWT_SECRET            = os.getenv("JWT_SECRET", "foodsave_secret_change_in_prod")
JWT_EXPIRE_DAYS       = int(os.getenv("JWT_EXPIRE_DAYS", "7"))
MAPBOX_TOKEN          = os.getenv("MAPBOX_TOKEN", "")
CLIENT_URL            = os.getenv("CLIENT_URL", "http://localhost:5173")
GROQ_API_KEY          = os.getenv("GROQ_API_KEY", "")

# Cold chain monitor interval — 30s for dev, 1800s (30min) for prod
COLD_CHAIN_INTERVAL   = int(os.getenv("COLD_CHAIN_INTERVAL_SEC", "1800"))
COLD_CHAIN_CHECKS     = int(os.getenv("COLD_CHAIN_MAX_CHECKS",   "12"))

# ─── Groq Model Fallback Chain ─────────────────────────────────────────────
# Primary → fastest / cheapest. Fallbacks used automatically on rate-limit or error.
GROQ_MODELS: List[str] = [
    os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"),
    "openai/gpt-oss-20b",                                    # fallback 4
]

# Vision model fallback chain
GROQ_VISION_MODELS: List[str] = [
    os.getenv("GROQ_VISION_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct"),
    "meta-llama/llama-4-maverick-17b-128e-instruct",      # fallback vision
]

# ─── Distance & Safety Constants ──────────────────────────────────────────
LIVE_LOC_MOVED_THRESHOLD_KM = 0.1

COLD_CHAIN_LIMITS = {
    "dairy":      2.0,
    "meals":      4.0,
    "bakery":     6.0,
    "produce":    8.0,
    "beverages":  4.0,
    "snacks":     8.0,
    "grains":    24.0,
    "default":    4.0,
}

# ─── Role Definitions ──────────────────────────────────────────────────────
ROLE_FEATURES = {
    "donor": {
        "can_post": True,
        "can_claim": False,
        "can_use_ai": True,
        "can_use_route_optimizer": False,
        "can_manage_volunteers": False,
        "can_see_org_dashboard": False,
        "can_see_impact_report": True,
        "can_see_waste_prediction": True,
        "can_see_photo_analysis": True,
        "can_see_ai_chat": True,
        "can_see_leaderboard": True,
        "can_manage_shifts": False,
    },
    "ngo_admin": {
        "can_post": False,
        "can_claim": False,
        "can_claim_via_volunteer": True,
        "can_use_ai": False,
        "can_use_route_optimizer": False,
        "can_manage_volunteers": True,
        "can_see_org_dashboard": True,
        "can_see_impact_report": False,
        "can_see_waste_prediction": False,
        "can_see_photo_analysis": False,
        "can_see_ai_chat": False,
        "can_see_leaderboard": True,
        "can_manage_shifts": True,
    },
    "volunteer": {
        "can_post": False,
        "can_claim": True,
        "can_use_ai": True,
        "can_use_route_optimizer": True,
        "can_manage_volunteers": False,
        "can_see_org_dashboard": False,
        "can_see_impact_report": False,
        "can_see_waste_prediction": False,
        "can_see_photo_analysis": False,
        "can_see_ai_chat": True,
        "can_see_leaderboard": True,
        "can_manage_shifts": False,
    },
    "individual": {
        "can_post": True,
        "can_claim": True,
        "can_use_ai": False,
        "can_use_route_optimizer": False,
        "can_manage_volunteers": False,
        "can_see_org_dashboard": False,
        "can_see_impact_report": False,
        "can_see_waste_prediction": False,
        "can_see_photo_analysis": False,
        "can_see_ai_chat": False,
        "can_see_leaderboard": True,
        "can_manage_shifts": False,
    },
    "admin": {
        "can_post": True,
        "can_claim": True,
        "can_use_ai": True,
        "can_use_route_optimizer": True,
        "can_manage_volunteers": True,
        "can_see_org_dashboard": True,
        "can_see_impact_report": True,
        "can_see_waste_prediction": True,
        "can_see_photo_analysis": True,
        "can_see_ai_chat": True,
        "can_see_leaderboard": True,
        "can_manage_shifts": True,
    },
}

FIXED_LOCATION_TYPES  = {"restaurant", "hotel", "ngo", "orphanage"}
MOBILE_LOCATION_TYPES = {"volunteer", "individual"}


def get_user_role(location_type: str) -> str:
    return {
        "restaurant": "donor",
        "hotel":      "donor",
        "individual": "individual",
        "ngo":        "ngo_admin",
        "orphanage":  "ngo_admin",
        "volunteer":  "volunteer",
        "admin":      "admin",
    }.get(location_type, "individual")


def get_role_features(role: str) -> dict:
    return ROLE_FEATURES.get(role, ROLE_FEATURES["individual"])


def generate_org_code() -> str:
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=8))


# ─── MongoDB ───────────────────────────────────────────────────────────────
mongo_client: AsyncIOMotorClient = None
db = None


async def get_db():
    return db


# ─── Socket.io ─────────────────────────────────────────────────────────────
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False,
)


# ─── Lifespan ──────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global mongo_client, db
    mongo_client = AsyncIOMotorClient(
        MONGO_URI,
        tlsCAFile=certifi.where(),
        serverSelectionTimeoutMS=30000,
    )
    db = mongo_client[DB_NAME]

    # Core indexes
    await db.users.create_index("email", unique=True)
    await db.users.create_index("orgCode", sparse=True)
    await db.listings.create_index([("location", "2dsphere")])
    await db.listings.create_index("status")
    await db.listings.create_index("expiresAt")
    await db.listings.create_index("userId")
    await db.listings.create_index("locationId")
    await db.claims.create_index("listingId")
    await db.claims.create_index("claimantUserId")
    await db.claims.create_index("volunteerUserId")
    await db.claims.create_index("ngoUserId")
    await db.messages.create_index([("fromUserId", 1), ("toUserId", 1)])
    await db.messages.create_index("createdAt")
    await db.chat_rooms.create_index("participants")
    await db.chat_rooms.create_index("listingId")
    await db.notifications.create_index([("userId", 1), ("read", 1)])
    await db.notifications.create_index([("userId", 1), ("deleted", 1)])
    await db.waste_predictions.create_index([("locationId", 1), ("predictedDate", 1)])
    # FIX: sessionId index added for fast chat history lookup
    await db.ai_chat_sessions.create_index([("userId", 1), ("createdAt", -1)])
    await db.ai_chat_sessions.create_index("sessionId", unique=True, sparse=True)
    await db.impact_reports.create_index([("createdAt", -1)])
    await db.volunteer_shifts.create_index([("ngoUserId", 1), ("date", 1)])
    await db.volunteer_shifts.create_index("volunteerId", sparse=True)
    await db.cold_chain_logs.create_index([("claimId", 1), ("createdAt", -1)])
    # FIX: reviews index (was missing)
    await db.reviews.create_index([("targetUserId", 1), ("createdAt", -1)])
    await db.reviews.create_index([("claimId", 1), ("fromUserId", 1)], unique=True, sparse=True)

    print(f"MongoDB connected. Primary Groq model: {GROQ_MODELS[0]}")
    print(f"Cold chain monitor interval: {COLD_CHAIN_INTERVAL}s")
    yield
    mongo_client.close()


# ─── FastAPI App ───────────────────────────────────────────────────────────
app = FastAPI(title="FoodSave API", version="7.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

socket_app = socketio.ASGIApp(sio, other_asgi_app=app)


# ─── Helpers ───────────────────────────────────────────────────────────────
def oid(id_str: str) -> ObjectId:
    try:
        return ObjectId(id_str)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=400, detail="Invalid ID format")


def serialize(doc) -> dict:
    if doc is None:
        return None
    result = {}
    for k, v in doc.items():
        if isinstance(v, ObjectId):
            result[k] = str(v)
        elif isinstance(v, datetime):
            result[k] = v.isoformat()
        elif isinstance(v, dict):
            result[k] = serialize(v)
        elif isinstance(v, list):
            result[k] = [
                serialize(i) if isinstance(i, dict)
                else (str(i) if isinstance(i, ObjectId) else i)
                for i in v
            ]
        else:
            result[k] = v
    return result


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def create_token(user_id: str, role: str = "individual") -> str:
    payload = {
        "userId": user_id,
        "role":   role,
        "exp":    datetime.utcnow() + timedelta(days=JWT_EXPIRE_DAYS),
    }
    return pyjwt.encode(payload, JWT_SECRET, algorithm="HS256")


def haversine_km(lat1, lng1, lat2, lng2) -> float:
    R = 6371.0
    dlat = (lat2 - lat1) * math.pi / 180
    dlng = (lng2 - lng1) * math.pi / 180
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1 * math.pi / 180)
        * math.cos(lat2 * math.pi / 180)
        * math.sin(dlng / 2) ** 2
    )
    return round(R * 2 * math.asin(math.sqrt(a)), 2)


def get_effective_location(user_doc: dict) -> tuple[Optional[float], Optional[float], bool]:
    live_enabled   = user_doc.get("liveLocationEnabled", False)
    primary_loc    = (user_doc.get("locations") or [{}])[0]
    profile_coords = primary_loc.get("location", {}).get("coordinates", [])
    live_coords    = user_doc.get("liveLocation", {}).get("coordinates", [])

    has_profile = len(profile_coords) == 2
    has_live    = len(live_coords) == 2

    if not live_enabled or not has_live:
        if has_profile:
            return profile_coords[1], profile_coords[0], False
        return None, None, False

    if not has_profile:
        return live_coords[1], live_coords[0], True

    dist = haversine_km(
        profile_coords[1], profile_coords[0],
        live_coords[1],    live_coords[0],
    )
    if dist > LIVE_LOC_MOVED_THRESHOLD_KM:
        return live_coords[1], live_coords[0], True
    return profile_coords[1], profile_coords[0], False


def get_distance_response(
    viewer_lat: Optional[float],
    viewer_lng: Optional[float],
    live_enabled: bool,
    target_lat: float,
    target_lng: float,
) -> dict:
    if viewer_lat is None or viewer_lng is None:
        if not live_enabled:
            return {"distanceKm": None, "distanceStatus": "enable_live_location"}
        return {"distanceKm": None, "distanceStatus": "unavailable"}
    km = haversine_km(viewer_lat, viewer_lng, target_lat, target_lng)
    return {"distanceKm": km, "distanceStatus": "ok"}


def get_cold_chain_limit(category: str) -> float:
    return COLD_CHAIN_LIMITS.get(category, COLD_CHAIN_LIMITS["default"])


# ─── Auth Dependency ───────────────────────────────────────────────────────
security = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    database=Depends(get_db),
):
    token = credentials.credentials
    try:
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        user    = await database.users.find_one({"_id": oid(payload["userId"])})
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        return serialize(user)
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except pyjwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


# ─── Pydantic Models ───────────────────────────────────────────────────────
class LocationModel(BaseModel):
    name: str
    type: str
    address: str
    lat: float
    lng: float
    capacity: Optional[int] = None


class RegisterModel(BaseModel):
    name: str
    email: EmailStr
    password: str
    locationType: str
    locationName: str
    locationAddress: Optional[str] = ""
    coordinates: Optional[List[float]] = None
    orgCode: Optional[str] = None


class LoginModel(BaseModel):
    email: EmailStr
    password: str


class ChangePasswordModel(BaseModel):
    currentPassword: str
    newPassword: str


class ListingCreate(BaseModel):
    foodName: str
    category: str
    quantity: float
    servings: Optional[int] = None
    expiresAt: str
    locationId: str
    description: Optional[str] = ""
    allergens: Optional[List[str]] = []
    isVeg: Optional[bool] = True
    scheduledFor: Optional[str] = None
    photoUrl: Optional[str] = None


class NaturalLanguageListingRequest(BaseModel):
    text: str
    locationId: str


class ClaimCreate(BaseModel):
    listingId: str
    note: Optional[str] = ""
    peopleCount: Optional[int] = 0


class ReviewCreate(BaseModel):
    claimId: str
    targetUserId: str
    rating: int
    comment: Optional[str] = ""


class MessageCreate(BaseModel):
    toUserId: str
    text: str
    claimId: Optional[str] = None
    listingId: Optional[str] = None


class ChatRoomCreate(BaseModel):
    participantIds: List[str]
    listingId: Optional[str] = None
    name: Optional[str] = ""


class AlertSettings(BaseModel):
    radiusKm: float = 5.0
    minQuantityKg: float = 1.0
    categories: List[str] = []
    notifyUrgentOnly: bool = False


class DirectionRequest(BaseModel):
    fromLat: float
    fromLng: float
    toLat: float
    toLng: float
    mode: str = "driving"


class ConfirmPickupBody(BaseModel):
    qrCode: str
class ScanPickupBody(BaseModel):
    qrData: str


class AISearchRequest(BaseModel):
    query: str
    lat: Optional[float] = None
    lng: Optional[float] = None

class AIChatMessage(BaseModel):
    message: str
    sessionId: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None


class FoodPhotoAnalyze(BaseModel):
    imageBase64: str
    mimeType: Optional[str] = "image/jpeg"


class WastePredictionRequest(BaseModel):
    locationId: str


class RouteOptimizeRequest(BaseModel):
    claimIds: List[str]
    startLat: float
    startLng: float


class FoodSafetyCheckRequest(BaseModel):
    foodName: str
    description: str
    quantity: float
    expiresAt: str
    category: str


class ImpactReportRequest(BaseModel):
    startDate: Optional[str] = None
    endDate: Optional[str] = None
    locationId: Optional[str] = None


class LiveLocationToggle(BaseModel):
    enabled: bool
    lat: Optional[float] = None
    lng: Optional[float] = None


class ShiftCreate(BaseModel):
    date: str
    startTime: str
    endTime: str
    maxVolunteers: int = 3
    note: Optional[str] = ""
    area: Optional[str] = ""


class ColdChainCheckIn(BaseModel):
    claimId: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    note: Optional[str] = ""


# ─── Groq AI Helpers with Model Fallback Chain ─────────────────────────────

async def _groq_post(endpoint: str, body: dict, timeout: float = 30.0) -> dict:
    """
    POST to a Groq endpoint with automatic model fallback.
    Tries each model in GROQ_MODELS (or GROQ_VISION_MODELS) in order.
    Retries with exponential backoff on 429 / 5xx.
    """
    if not GROQ_API_KEY:
        raise HTTPException(status_code=500, detail="Groq API key not configured")

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type":  "application/json",
    }
    # Determine which model list to use based on endpoint/body
    model_list = body.pop("__model_list__", GROQ_MODELS)
    last_error = "Unknown error"

    for model_idx, model in enumerate(model_list):
        body["model"] = model
        for attempt in range(3):  # up to 3 retries per model
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    r = await client.post(
                        f"https://api.groq.com/openai/v1/{endpoint}",
                        headers=headers,
                        json=body,
                    )
                if r.status_code == 200:
                    return r.json()
                # Rate-limited: back off then try next model
                if r.status_code == 429:
                    wait = (2 ** attempt) + random.random()
                    print(f"[Groq] Rate limit on {model}, attempt {attempt+1}, waiting {wait:.1f}s")
                    await asyncio.sleep(wait)
                    last_error = f"Rate limit on {model}"
                    if attempt == 2:
                        break  # try next model
                    continue
                # Model not available / bad request — try next model immediately
                if r.status_code in (400, 404, 422):
                    last_error = f"{model}: {r.status_code} {r.text[:200]}"
                    print(f"[Groq] Model {model} unavailable ({r.status_code}): {r.text[:300]}")
                    break
                # Server error — retry with backoff
                wait = (2 ** attempt) + random.random()
                print(f"[Groq] Server error {r.status_code} on {model}, retrying in {wait:.1f}s")
                await asyncio.sleep(wait)
                last_error = f"{model}: {r.status_code}"
            except (httpx.TimeoutException, httpx.ConnectError) as e:
                wait = (2 ** attempt) + random.random()
                print(f"[Groq] Network error on {model}: {e}, retrying in {wait:.1f}s")
                await asyncio.sleep(wait)
                last_error = str(e)

    raise HTTPException(
        status_code=502,
        detail=f"All Groq models exhausted. Last error: {last_error}. Models tried: {model_list}"
    )


async def call_groq(
    system_prompt: str,
    user_message: str,
    max_tokens: int = 1000,
    json_mode: bool = False,
    conversation_history: Optional[List[dict]] = None,
) -> str:
    """
    Call Groq text completion with model fallback chain.
    Optionally pass conversation_history for multi-turn chat.
    """
    if json_mode:
        system_prompt += "\n\nCRITICAL: Respond ONLY with valid JSON. No preamble, no explanation, no markdown backticks, no trailing text."

    messages = [{"role": "system", "content": system_prompt}]
    if conversation_history:
        messages.extend(conversation_history)
    messages.append({"role": "user", "content": user_message})

    body: dict = {
        "__model_list__": list(GROQ_MODELS),
        "max_tokens": max_tokens* 3,
        "messages": messages,
        "temperature": 0.3,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}

    data = await _groq_post("chat/completions", body)
    return data["choices"][0]["message"]["content"]


async def call_groq_vision(
    system_prompt: str,
    user_text: str,
    image_base64: str,
    mime_type: str = "image/jpeg",
    max_tokens: int = 800,
    json_mode: bool = False,
) -> str:
    """Call Groq vision with vision model fallback chain."""
    if json_mode:
        system_prompt += "\n\nCRITICAL: Respond ONLY with valid JSON. No preamble, no explanation, no markdown backticks."

    body: dict = {
        "__model_list__": list(GROQ_VISION_MODELS),
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,{image_base64}"},
                    },
                    {"type": "text", "text": user_text},
                ],
            },
        ],
        "temperature": 0.2,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}

    data = await _groq_post("chat/completions", body, timeout=45.0)
    return data["choices"][0]["message"]["content"]


def _safe_json_parse(text: str) -> Optional[dict]:
    """Safely parse JSON, stripping common AI response wrappers."""
    text = text.strip()
    # Strip markdown fences
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to extract first JSON object
        start = text.find("{")
        end   = text.rfind("}") + 1
        if start != -1 and end > start:
            try:
                return json.loads(text[start:end])
            except Exception:
                pass
    return None


# ─── Socket.io Events ──────────────────────────────────────────────────────
@sio.event
async def connect(sid, environ, auth):
    if not auth or not auth.get("token"):
        raise ConnectionRefusedError("Authentication required")
    try:
        payload = pyjwt.decode(auth["token"], JWT_SECRET, algorithms=["HS256"])
        user_id = payload["userId"]
        await sio.save_session(sid, {"userId": user_id})
        city = environ.get("HTTP_X_CITY", "default")
        await sio.enter_room(sid, city)
        await sio.enter_room(sid, f"user:{user_id}")
        await db.users.update_one(
            {"_id": oid(user_id)},
            {"$set": {"online": True, "lastSeen": datetime.utcnow()}},
        )
        await sio.emit("user:online", {"userId": user_id})
    except Exception as e:
        raise ConnectionRefusedError(str(e))


@sio.event
async def disconnect(sid):
    try:
        session = await sio.get_session(sid)
        user_id = session.get("userId")
        if user_id:
            await db.users.update_one(
                {"_id": oid(user_id)},
                {"$set": {"online": False, "lastSeen": datetime.utcnow()}},
            )
            await sio.emit("user:offline", {"userId": user_id})
    except Exception:
        pass


@sio.event
async def chat_message(sid, data):
    session      = await sio.get_session(sid)
    from_user_id = session["userId"]
    to_user_id   = data.get("toUserId")
    room_id      = data.get("roomId")
    text         = data.get("text", "").strip()
    if not text:
        return
    msg_doc = {
        "_id":        ObjectId(),
        "fromUserId": oid(from_user_id),
        "toUserId":   oid(to_user_id) if to_user_id else None,
        "roomId":     oid(room_id)    if room_id    else None,
        "listingId":  oid(data["listingId"]) if data.get("listingId") else None,
        "claimId":    oid(data["claimId"])   if data.get("claimId")   else None,
        "text":       text,
        "read":       False,
        "createdAt":  datetime.utcnow(),
    }
    await db.messages.insert_one(msg_doc)
    payload               = serialize(msg_doc)
    sender                = await db.users.find_one({"_id": oid(from_user_id)}, {"name": 1})
    payload["senderName"] = sender.get("name", "") if sender else ""
    if room_id:
        await sio.emit("chat:message", payload, room=f"room:{room_id}")
        await db.chat_rooms.update_one(
            {"_id": oid(room_id)},
            {"$set": {"lastMessage": text, "lastMessageAt": datetime.utcnow(), "lastMessageBy": from_user_id}},
        )
    elif to_user_id:
        await sio.emit("chat:message", payload, room=f"user:{to_user_id}")
        await sio.emit("chat:message", payload, room=f"user:{from_user_id}")


@sio.event
async def join_room(sid, data):
    room_id = data.get("roomId")
    if room_id:
        await sio.enter_room(sid, f"room:{room_id}")


@sio.event
async def leave_room(sid, data):
    room_id = data.get("roomId")
    if room_id:
        await sio.leave_room(sid, f"room:{room_id}")


@sio.event
async def typing(sid, data):
    session    = await sio.get_session(sid)
    to_user_id = data.get("toUserId")
    room_id    = data.get("roomId")
    payload    = {"userId": session["userId"], "isTyping": data.get("isTyping", True)}
    if room_id:
        await sio.emit("chat:typing", payload, room=f"room:{room_id}", skip_sid=sid)
    elif to_user_id:
        await sio.emit("chat:typing", payload, room=f"user:{to_user_id}")


@sio.event
async def location_update(sid, data):
    session = await sio.get_session(sid)
    user_id = session["userId"]
    lat     = data.get("lat")
    lng     = data.get("lng")
    if lat and lng:
        await db.users.update_one(
            {"_id": oid(user_id)},
            {"$set": {
                "liveLocation":          {"type": "Point", "coordinates": [lng, lat]},
                "liveLocationUpdatedAt": datetime.utcnow(),
            }},
        )
    await sio.emit("volunteer:location", {
        "userId":    user_id,
        "lat":       lat,
        "lng":       lng,
        "timestamp": datetime.utcnow().isoformat(),
    })


# ─── AUTH ──────────────────────────────────────────────────────────────────
@app.post("/api/auth/register", status_code=201)
async def register(body: RegisterModel, database=Depends(get_db)):
    existing = await database.users.find_one({"email": body.email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    coords = body.coordinates or [78.3896, 17.4401]
    role   = get_user_role(body.locationType)

    linked_ngo = None
    if body.locationType == "volunteer":
        if not body.orgCode:
            raise HTTPException(status_code=400, detail="Volunteers must provide an Organisation Code.")
        org_user = await database.users.find_one({"orgCode": body.orgCode.strip().upper()})
        if not org_user:
            raise HTTPException(status_code=404, detail=f"No organisation found with code '{body.orgCode}'.")
        if get_user_role(org_user.get("locations", [{}])[0].get("type", "")) != "ngo_admin":
            raise HTTPException(status_code=400, detail="That code belongs to a non-NGO account.")
        org_location = org_user.get("locations", [{}])[0]
        linked_ngo = {
            "userId":       str(org_user["_id"]),
            "name":         org_user.get("name", ""),
            "orgCode":      body.orgCode.strip().upper(),
            "locationId":   str(org_location.get("_id", "")),
            "locationName": org_location.get("name", ""),
            "locationType": org_location.get("type", ""),
            "address":      org_location.get("address", ""),
            "coordinates":  org_location.get("location", {}).get("coordinates", []),
        }

    location_doc = {
        "_id":         ObjectId(),
        "name":        body.locationName,
        "type":        body.locationType,
        "address":     body.locationAddress or "",
        "location":    {"type": "Point", "coordinates": coords},
        "verified":    False,
        "rating":      0,
        "reviewCount": 0,
        "createdAt":   datetime.utcnow(),
    }

    org_code = None
    if body.locationType in ["ngo", "orphanage"]:
        while True:
            candidate = generate_org_code()
            if not await database.users.find_one({"orgCode": candidate}):
                org_code = candidate
                break

    user_doc = {
        "_id":                   ObjectId(),
        "name":                  body.name,
        "email":                 body.email,
        "phone":                 "",
        "passwordHash":          hash_password(body.password),
        "locations":             [location_doc],
        "activeLocationId":      location_doc["_id"],
        "role":                  role,
        "orgCode":               org_code,
        "linkedNGO":             linked_ngo,
        "linkedVolunteers":      [],
        "fcmToken":              None,
        "language":              "en",
        "badges":                [],
        "alertSettings": {
            "radiusKm":         5.0,
            "minQuantityKg":    1.0,
            "categories":       [],
            "notifyUrgentOnly": False,
        },
        "liveLocationEnabled":   False,
        "liveLocation":          {"type": "Point", "coordinates": coords},
        "liveLocationUpdatedAt": datetime.utcnow(),
        "online":                False,
        "lastSeen":              datetime.utcnow(),
        "createdAt":             datetime.utcnow(),
        "features":              get_role_features(role),
        "monthlyPoints":         0,
        "totalPoints":           0,
        "monthlyResetAt":        datetime.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0),
    }

    await database.users.insert_one(user_doc)

    if linked_ngo:
        await database.users.update_one(
            {"_id": oid(linked_ngo["userId"])},
            {"$addToSet": {"linkedVolunteers": {
                "userId":       str(user_doc["_id"]),
                "name":         body.name,
                "email":        body.email,
                "locationType": "volunteer",
                "joinedAt":     datetime.utcnow().isoformat(),
            }}},
        )
        notif = {
            "_id":       ObjectId(),
            "userId":    oid(linked_ngo["userId"]),
            "type":      "volunteer:joined",
            "title":     f"🚴 New volunteer joined: {body.name}",
            "body":      f"{body.name} has registered as a volunteer for {linked_ngo['locationName']}",
            "data":      {"volunteerId": str(user_doc["_id"]), "volunteerName": body.name},
            "read":      False,
            "deleted":   False,
            "createdAt": datetime.utcnow(),
        }
        await database.notifications.insert_one(notif)
        await sio.emit("notification:new", serialize(notif), room=f"user:{linked_ngo['userId']}")

    token           = create_token(str(user_doc["_id"]), role)
    user_serialized = serialize(user_doc)
    user_serialized.pop("passwordHash", None)
    return {"token": token, "user": user_serialized}


@app.post("/api/auth/login")
async def login(body: LoginModel, database=Depends(get_db)):
    user = await database.users.find_one({"email": body.email})
    if not user or not verify_password(body.password, user["passwordHash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    role            = user.get("role", "individual")
    token           = create_token(str(user["_id"]), role)
    user_serialized = serialize(user)
    user_serialized.pop("passwordHash", None)
    return {"token": token, "user": user_serialized}


@app.get("/api/auth/me")
async def get_me(current_user=Depends(get_current_user)):
    current_user.pop("passwordHash", None)
    return current_user


@app.post("/api/auth/refresh")
async def refresh_token(current_user=Depends(get_current_user)):
    """Issue a fresh JWT for an authenticated user."""
    new_token = create_token(current_user["_id"], current_user.get("role", "individual"))
    return {"token": new_token}


@app.put("/api/auth/change-password")
async def change_password(
    body: ChangePasswordModel,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    user = await database.users.find_one({"_id": oid(current_user["_id"])})
    if not verify_password(body.currentPassword, user["passwordHash"]):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    if len(body.newPassword) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")
    await database.users.update_one(
        {"_id": oid(current_user["_id"])},
        {"$set": {"passwordHash": hash_password(body.newPassword)}},
    )
    return {"message": "Password changed successfully"}


# ─── ORG CODE LOOKUP ───────────────────────────────────────────────────────
@app.get("/api/org/lookup/{org_code}")
async def lookup_org_by_code(org_code: str, database=Depends(get_db)):
    org = await database.users.find_one({"orgCode": org_code.strip().upper()})
    if not org:
        raise HTTPException(status_code=404, detail="No organisation found with that code.")
    loc = org.get("locations", [{}])[0]
    return {
        "userId":       str(org["_id"]),
        "name":         org["name"],
        "orgCode":      org.get("orgCode", ""),
        "locationType": loc.get("type", ""),
        "locationName": loc.get("name", ""),
        "address":      loc.get("address", ""),
        "coordinates":  loc.get("location", {}).get("coordinates", []),
        "verified":     loc.get("verified", False),
    }


# ─── LIVE LOCATION TOGGLE ──────────────────────────────────────────────────
@app.put("/api/users/me/live-location-toggle")
async def toggle_live_location(
    body: LiveLocationToggle,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    update: dict = {"liveLocationEnabled": body.enabled}
    if body.enabled:
        if body.lat is not None and body.lng is not None:
            update["liveLocation"]          = {"type": "Point", "coordinates": [body.lng, body.lat]}
            update["liveLocationUpdatedAt"] = datetime.utcnow()
    else:
        user_full      = await database.users.find_one({"_id": oid(current_user["_id"])})
        profile_coords = (user_full.get("locations") or [{}])[0]\
            .get("location", {}).get("coordinates", [78.3896, 17.4401])
        update["liveLocation"]          = {"type": "Point", "coordinates": profile_coords}
        update["liveLocationUpdatedAt"] = datetime.utcnow()

    await database.users.update_one({"_id": oid(current_user["_id"])}, {"$set": update})
    updated = await database.users.find_one({"_id": oid(current_user["_id"])})
    updated.pop("passwordHash", None)
    await sio.emit("user:live_location_status", {
        "userId":  current_user["_id"],
        "enabled": body.enabled,
        "lat":     body.lat,
        "lng":     body.lng,
    })
    return {"ok": True, "liveLocationEnabled": body.enabled, "user": serialize(updated)}


# ─── LOCATION ROUTES ───────────────────────────────────────────────────────
@app.post("/api/locations")
async def add_location(
    body: LocationModel,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    location_doc = {
        "_id":         ObjectId(),
        "name":        body.name,
        "type":        body.type,
        "address":     body.address,
        "location":    {"type": "Point", "coordinates": [body.lng, body.lat]},
        "capacity":    body.capacity,
        "verified":    False,
        "rating":      0,
        "reviewCount": 0,
        "createdAt":   datetime.utcnow(),
    }
    await database.users.update_one(
        {"_id": oid(current_user["_id"])},
        {"$push": {"locations": location_doc}},
    )
    return serialize(location_doc)


@app.put("/api/locations/switch/{location_id}")
async def switch_location(
    location_id: str,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    user       = await database.users.find_one({"_id": oid(current_user["_id"])})
    new_active = next(
        (loc for loc in user.get("locations", []) if str(loc["_id"]) == location_id), None
    )
    if not new_active:
        raise HTTPException(status_code=404, detail="Location not found")
    new_role = get_user_role(new_active.get("type", ""))
    await database.users.update_one(
        {"_id": oid(current_user["_id"])},
        {"$set": {
            "activeLocationId": oid(location_id),
            "role":             new_role,
            "features":         get_role_features(new_role),
        }},
    )
    updated = await database.users.find_one({"_id": oid(current_user["_id"])})
    updated.pop("passwordHash", None)
    return serialize(updated)


@app.post("/api/locations/geocode")
async def geocode_address(body: dict):
    address = body.get("address", "")
    if not MAPBOX_TOKEN:
        raise HTTPException(status_code=400, detail="Mapbox token not configured")
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"https://api.mapbox.com/geocoding/v5/mapbox.places/{address}.json",
            params={"access_token": MAPBOX_TOKEN, "limit": 5, "country": "IN", "proximity": "78.3896,17.4401"},
        )
        return r.json()


@app.put("/api/users/me/location")
async def update_my_live_location(
    body: dict,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    lat = body.get("lat")
    lng = body.get("lng")
    if lat is None or lng is None:
        raise HTTPException(status_code=400, detail="lat and lng are required")
    await database.users.update_one(
        {"_id": oid(current_user["_id"])},
        {"$set": {
            "liveLocation":          {"type": "Point", "coordinates": [float(lng), float(lat)]},
            "liveLocationUpdatedAt": datetime.utcnow(),
        }},
    )
    return {"ok": True, "lat": lat, "lng": lng}


# ─── LISTING ROUTES ────────────────────────────────────────────────────────
@app.post("/api/listings", status_code=201)
async def create_listing(
    body: ListingCreate,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    role     = current_user.get("role", "individual")
    features = get_role_features(role)
    if not features.get("can_post"):
        raise HTTPException(status_code=403, detail="Your account type cannot post food listings.")

    user     = await database.users.find_one({"_id": oid(current_user["_id"])})
    location = next((loc for loc in user.get("locations", []) if str(loc["_id"]) == body.locationId), None)
    if not location:
        raise HTTPException(status_code=404, detail="Location not found")

    expires_at = datetime.fromisoformat(body.expiresAt.replace("Z", "+00:00").replace("+00:00", ""))
    is_urgent  = (expires_at - datetime.utcnow()).total_seconds() < 7200

    listing_doc = {
        "_id":               ObjectId(),
        "userId":            oid(current_user["_id"]),
        "locationId":        oid(body.locationId),
        "foodName":          body.foodName,
        "category":          body.category,
        "quantity":          body.quantity,
        "servings":          body.servings or int(body.quantity * 4),
        "description":       body.description or "",
        "allergens":         body.allergens or [],
        "isVeg":             body.isVeg if body.isVeg is not None else True,
        "photoUrl":          body.photoUrl,
        "expiresAt":         expires_at,
        "status":            "active",
        "source":            "manual",
        "isUrgent":          is_urgent,
        "aiFlagged":         False,
        "location":          location["location"],
        "restaurantName":    location["name"],
        "restaurantAddress": location["address"],
        "restaurantType":    location.get("type", ""),
        "donorUserId":       str(current_user["_id"]),
        "createdAt":         datetime.utcnow(),
        "viewCount":         0,
        "claimCount":        0,
        "coldChainLimit":    get_cold_chain_limit(body.category),
        "pickedUpAt":        None,
    }

    if body.scheduledFor:
        listing_doc["scheduledFor"] = datetime.fromisoformat(body.scheduledFor.replace("Z", ""))
        listing_doc["status"]       = "scheduled"

    await database.listings.insert_one(listing_doc)
    serialized = serialize(listing_doc)
    await sio.emit("listing:new", serialized)
    asyncio.create_task(_notify_nearby_users(listing_doc, database))
    if GROQ_API_KEY:
        asyncio.create_task(_ai_safety_check_background(listing_doc, database))

    return serialized


@app.post("/api/listings/from-text", status_code=201)
async def create_listing_from_text(
    body: NaturalLanguageListingRequest,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    """Parse a natural language description into a structured listing using Groq."""
    role     = current_user.get("role", "individual")
    features = get_role_features(role)
    if not features.get("can_post"):
        raise HTTPException(status_code=403, detail="Your account type cannot post food listings.")

    user     = await database.users.find_one({"_id": oid(current_user["_id"])})
    location = next((loc for loc in user.get("locations", []) if str(loc["_id"]) == body.locationId), None)
    if not location:
        raise HTTPException(status_code=404, detail="Location not found")

    system = (
        "You are a food listing parser for a food donation platform. "
        "Extract structured listing info from natural language. "
        "For expiresAt, calculate from now if relative time is given. "
        "Respond ONLY in English. Today/now is: " + datetime.utcnow().isoformat()
    )
    user_msg = (
        f'Parse this food donation description into a structured listing:\n"{body.text}"\n\n'
        'Return ONLY JSON with these fields:\n'
        '{\n'
        '  "foodName": "string",\n'
        '  "category": "meals|bakery|produce|dairy|snacks|beverages|grains|other",\n'
        '  "quantity": number (kg, estimate if not given),\n'
        '  "servings": number (estimate: quantity * 4),\n'
        '  "isVeg": true/false,\n'
        '  "description": "string (cleaned up description, English only)",\n'
        '  "expiresAt": "ISO datetime string (default: 4 hours from now if not specified)",\n'
        '  "allergens": [],\n'
        '  "confidence": 0.0-1.0\n'
        '}'
    )

    response = await call_groq(system, user_msg, max_tokens=400, json_mode=True)
    parsed   = _safe_json_parse(response)
    if not parsed:
        raise HTTPException(status_code=502, detail="AI could not parse the listing text. Please try again.")

    expires_at_str = parsed.get("expiresAt", (datetime.utcnow() + timedelta(hours=4)).isoformat())
    try:
        expires_at = datetime.fromisoformat(expires_at_str.replace("Z", ""))
    except Exception:
        expires_at = datetime.utcnow() + timedelta(hours=4)

    is_urgent   = (expires_at - datetime.utcnow()).total_seconds() < 7200
    listing_doc = {
        "_id":               ObjectId(),
        "userId":            oid(current_user["_id"]),
        "locationId":        oid(body.locationId),
        "foodName":          parsed.get("foodName", "Food"),
        "category":          parsed.get("category", "meals"),
        "quantity":          float(parsed.get("quantity", 1)),
        "servings":          int(parsed.get("servings", 4)),
        "description":       parsed.get("description", body.text),
        "allergens":         parsed.get("allergens", []),
        "isVeg":             parsed.get("isVeg", True),
        "photoUrl":          None,
        "expiresAt":         expires_at,
        "status":            "active",
        "source":            "natural_language",
        "isUrgent":          is_urgent,
        "aiFlagged":         False,
        "location":          location["location"],
        "restaurantName":    location["name"],
        "restaurantAddress": location["address"],
        "restaurantType":    location.get("type", ""),
        "donorUserId":       str(current_user["_id"]),
        "createdAt":         datetime.utcnow(),
        "viewCount":         0,
        "claimCount":        0,
        "coldChainLimit":    get_cold_chain_limit(parsed.get("category", "meals")),
        "pickedUpAt":        None,
        "nlParseConfidence": parsed.get("confidence", 0.8),
        "originalText":      body.text,
    }

    await database.listings.insert_one(listing_doc)
    serialized = serialize(listing_doc)
    await sio.emit("listing:new", serialized)
    asyncio.create_task(_notify_nearby_users(listing_doc, database))
    # FIX: run AI safety check on NL listings too
    if GROQ_API_KEY:
        asyncio.create_task(_ai_safety_check_background(listing_doc, database))

    return {**serialized, "parsed": parsed}


# ─── Listing deletion ──────────────────────────────────────────────────────
@app.delete("/api/listings/{listing_id}")
async def delete_listing(
    listing_id: str,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    listing = await database.listings.find_one({"_id": oid(listing_id)})
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    if str(listing["userId"]) != current_user["_id"] and current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Not your listing")
    if listing.get("status") in ["claimed", "picked_up"]:
        raise HTTPException(status_code=409, detail="Cannot delete a listing that has been claimed. Cancel it instead.")
    await database.listings.update_one(
        {"_id": oid(listing_id)},
        {"$set": {"status": "deleted", "deletedAt": datetime.utcnow()}},
    )
    await sio.emit("listing:cancelled", {"listingId": listing_id})
    return {"message": "Listing deleted"}


async def _ai_safety_check_background(listing_doc: dict, database):
    try:
        system = (
            "You are a food safety inspector AI for a food donation platform. "
            "Analyze the listing and flag any genuine concerns. "
            "Only flag if there is a REAL safety concern — do not be overly cautious."
        )
        expires_at      = listing_doc.get("expiresAt")
        hours_to_expire = (
            (expires_at if isinstance(expires_at, datetime) else datetime.utcnow())
            - datetime.utcnow()
        ).total_seconds() / 3600
        user_msg = (
            f"Food listing safety check:\n"
            f"- Name: {listing_doc.get('foodName')}\n"
            f"- Category: {listing_doc.get('category')}\n"
            f"- Description: {listing_doc.get('description')}\n"
            f"- Quantity: {listing_doc.get('quantity')} kg\n"
            f"- Expires in: {round(hours_to_expire, 1)} hours\n\n"
            f"Respond ONLY with JSON: "
            f'{{"flagged": true/false, "reason": "...", "severity": "low|medium|high"}}'
        )
        response = await call_groq(system, user_msg, max_tokens=200, json_mode=True)
        result   = _safe_json_parse(response)
        if result and result.get("flagged"):
            await database.listings.update_one(
                {"_id": listing_doc["_id"]},
                {"$set": {
                    "aiFlagged":    True,
                    "flagReason":   result.get("reason", ""),
                    "flagSeverity": result.get("severity", "medium"),
                    "status":       "pending_review" if result.get("severity") == "high" else "active",
                }},
            )
            await sio.emit("listing:flagged", {
                "listingId": str(listing_doc["_id"]),
                "reason":    result.get("reason", ""),
                "severity":  result.get("severity", "medium"),
            })
    except Exception as e:
        print(f"AI safety check error: {e}")


async def _notify_nearby_users(listing_doc: dict, database):
    """
    Notify nearby volunteers/individuals about new listings.
    FIX: uses direct coordinate comparison with haversine instead of
    $near on embedded array (which requires a top-level 2dsphere index).
    """
    try:
        coords = listing_doc.get("location", {}).get("coordinates", [])
        if not coords or len(coords) < 2:
            return

        lng_center, lat_center = coords[0], coords[1]
        expires_at    = listing_doc.get("expiresAt")
        expires_at_dt = (
            expires_at if isinstance(expires_at, datetime)
            else datetime.fromisoformat(expires_at) if isinstance(expires_at, str)
            else None
        )
        hours_left = (
            round((expires_at_dt - datetime.utcnow()).total_seconds() / 3600, 1)
            if expires_at_dt else None
        )
        is_urgent   = hours_left is not None and hours_left < 2
        poster_id   = str(listing_doc.get("userId", ""))
        food_name   = listing_doc.get("foodName", "Food")
        rest_name   = listing_doc.get("restaurantName", "A donor")
        quantity    = listing_doc.get("quantity", 0)
        listing_id  = str(listing_doc["_id"])

        # Pull all candidate users within a rough bounding box (~10 km)
        degree_delta = 0.1  # ~11 km
        candidate_users = await database.users.find({
            "role": {"$in": ["individual", "volunteer"]},
        }).limit(500).to_list(500)

        for user in candidate_users:
            user_id = str(user["_id"])
            if user_id == poster_id:
                continue
            u_lat, u_lng, _ = get_effective_location(user)
            if u_lat is None or u_lng is None:
                continue
            dist = haversine_km(lat_center, lng_center, u_lat, u_lng)
            if dist > 10:  # 10 km radius
                continue

            alert_settings = user.get("alertSettings", {})
            if quantity < alert_settings.get("minQuantityKg", 1.0):
                continue
            cats = alert_settings.get("categories", [])
            if cats and listing_doc.get("category") not in cats:
                continue
            if alert_settings.get("notifyUrgentOnly") and not is_urgent:
                continue

            notif_title = (
                f"⚡ Urgent! {food_name}" if is_urgent
                else f"🍽 New food available: {food_name}"
            )
            notif_body = (
                f"{rest_name} • {quantity} kg"
                + (f" • {hours_left}h left" if hours_left else "")
                + f" • {dist} km away"
            )
            notif_doc = {
                "_id":       ObjectId(),
                "userId":    user["_id"],
                "type":      "listing:new",
                "title":     notif_title,
                "body":      notif_body,
                "data": {
                    "listingId":      listing_id,
                    "foodName":       food_name,
                    "quantity":       quantity,
                    "restaurantName": rest_name,
                    "donorUserId":    poster_id,
                    "expiresAt":      expires_at_dt.isoformat() if expires_at_dt else None,
                    "hoursLeft":      hours_left,
                    "urgent":         is_urgent,
                    "distanceKm":     dist,
                    "coordinates":    coords,
                },
                "read":      False,
                "deleted":   False,
                "createdAt": datetime.utcnow(),
            }
            await database.notifications.insert_one(notif_doc)
            await sio.emit("notification:new", serialize(notif_doc), room=f"user:{user_id}")
    except Exception as e:
        print(f"Notification task error: {e}")


@app.get("/api/listings/nearby")
async def get_nearby_listings(
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    radius: float = 10000,
    category: Optional[str] = None,
    urgent_only: bool = False,
    is_veg: Optional[bool] = None,
    sort_by: str = "distance",
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    user_full    = await database.users.find_one({"_id": oid(current_user["_id"])})
    viewer_lat, viewer_lng, viewer_is_live = get_effective_location(user_full)
    live_enabled = user_full.get("liveLocationEnabled", False)

    if lat is not None and lng is not None:
        viewer_lat, viewer_lng = lat, lng
    elif viewer_lat is None:
        raise HTTPException(status_code=400, detail="Could not determine your location.")

    query = {
        "status":    "active",
        "expiresAt": {"$gt": datetime.utcnow()},
        "userId":    {"$ne": oid(current_user["_id"])},
        "location": {
            "$near": {
                "$geometry":    {"type": "Point", "coordinates": [viewer_lng, viewer_lat]},
                "$maxDistance": radius,
            }
        },
    }
    if category and category != "all":
        query["category"] = category
    if urgent_only:
        query["isUrgent"] = True
    if is_veg is not None:
        query["isVeg"] = is_veg

    listings = await database.listings.find(query).limit(50).to_list(50)
    if sort_by == "expiry":
        listings.sort(key=lambda x: x.get("expiresAt", datetime.max))
    elif sort_by == "quantity":
        listings.sort(key=lambda x: x.get("quantity", 0), reverse=True)

    ids = [l["_id"] for l in listings]
    asyncio.create_task(_bump_views(ids, database))

    result = []
    for l in listings:
        s      = serialize(l)
        coords = l.get("location", {}).get("coordinates", [])
        dist_payload = (
            get_distance_response(viewer_lat, viewer_lng, live_enabled, coords[1], coords[0])
            if len(coords) == 2
            else {"distanceKm": None, "distanceStatus": "unavailable"}
        )
        s.update(dist_payload)
        s["viewerIsLive"]     = viewer_is_live
        s["coldChainWarning"] = _cold_chain_warning(l)
        result.append(s)
    return result


def _cold_chain_warning(listing: dict) -> Optional[str]:
    picked_up_at = listing.get("pickedUpAt")
    if not picked_up_at:
        return None
    if isinstance(picked_up_at, str):
        picked_up_at = datetime.fromisoformat(picked_up_at)
    elapsed_hours = (datetime.utcnow() - picked_up_at).total_seconds() / 3600
    limit         = get_cold_chain_limit(listing.get("category", "meals"))
    if elapsed_hours > limit:
        return f"⚠️ In transit {round(elapsed_hours, 1)}h — exceeds {limit}h safe limit for {listing.get('category', 'this food')}"
    return None


async def _bump_views(ids: list, database):
    if ids:
        await database.listings.update_many({"_id": {"$in": ids}}, {"$inc": {"viewCount": 1}})


@app.get("/api/listings/all-map")
async def get_all_map_listings(current_user=Depends(get_current_user), database=Depends(get_db)):
    listings = await database.listings.find({
        "status":    "active",
        "expiresAt": {"$gt": datetime.utcnow()},
    }).limit(200).to_list(200)
    return [serialize(l) for l in listings]


@app.get("/api/listings/mine")
async def get_my_listings(
    status_filter: Optional[str] = None,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    query = {"userId": oid(current_user["_id"])}
    if status_filter:
        query["status"] = status_filter
    listings = await database.listings.find(query).sort("createdAt", -1).to_list(100)
    return [serialize(l) for l in listings]


@app.get("/api/listings/{listing_id}")
async def get_listing(listing_id: str, current_user=Depends(get_current_user), database=Depends(get_db)):
    listing = await database.listings.find_one({"_id": oid(listing_id)})
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    return serialize(listing)


@app.put("/api/listings/{listing_id}")
async def update_listing(
    listing_id: str,
    body: dict,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    listing = await database.listings.find_one({"_id": oid(listing_id)})
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    if str(listing["userId"]) != current_user["_id"] and current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Not your listing")
    allowed = {k: v for k, v in body.items()
               if k in ["foodName", "category", "quantity", "expiresAt", "status", "description", "photoUrl"]}
    await database.listings.update_one({"_id": oid(listing_id)}, {"$set": allowed})
    updated    = await database.listings.find_one({"_id": oid(listing_id)})
    serialized = serialize(updated)
    if body.get("status") == "cancelled":
        await sio.emit("listing:cancelled", {"listingId": listing_id})
    return serialized


# ─── CLAIM ROUTES ──────────────────────────────────────────────────────────
@app.post("/api/claims", status_code=201)
async def create_claim(
    body: ClaimCreate,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    role     = current_user.get("role", "individual")
    features = get_role_features(role)

    if role == "donor":
        raise HTTPException(status_code=403, detail="Restaurant/hotel accounts cannot claim food.")
    if not features.get("can_claim"):
        raise HTTPException(status_code=403, detail="NGO accounts cannot claim directly. Your volunteers must claim.")

    listing_check = await database.listings.find_one({"_id": oid(body.listingId)})
    if not listing_check:
        raise HTTPException(status_code=404, detail="Listing not found")
    if str(listing_check["userId"]) == current_user["_id"]:
        raise HTTPException(status_code=403, detail="You cannot claim your own listing")

    user      = await database.users.find_one({"_id": oid(current_user["_id"])})
    active_id = user.get("activeLocationId")
    active_loc = next(
        (loc for loc in user.get("locations", []) if str(loc.get("_id")) == str(active_id)),
        user.get("locations", [{}])[0] if user.get("locations") else {},
    )
    loc_type = active_loc.get("type", "individual")
    if loc_type in ["restaurant", "hotel"]:
        raise HTTPException(status_code=403, detail="Restaurant/hotel accounts cannot claim food listings.")

    listing = await database.listings.find_one_and_update(
        {"_id": oid(body.listingId), "status": "active"},
        {
            "$set": {"status": "claimed", "claimedAt": datetime.utcnow()},
            "$inc": {"claimCount": 1},
        },
        return_document=True,
    )
    if not listing:
        raise HTTPException(status_code=409, detail="Sorry, this food was just claimed by someone else!")

    ngo_user_id = None
    ngo_name    = None
    if role == "volunteer" and user.get("linkedNGO"):
        ngo_user_id = user["linkedNGO"].get("userId")
        ngo_name    = user["linkedNGO"].get("locationName") or user["linkedNGO"].get("name")

    claim_doc = {
        "_id":                  ObjectId(),
        "listingId":            oid(body.listingId),
        "claimantUserId":       oid(current_user["_id"]),
        "claimantName":         current_user["name"],
        "claimantRole":         role,
        "claimantLocationType": loc_type,
        "ngoUserId":            oid(ngo_user_id) if ngo_user_id else None,
        "ngoName":              ngo_name,
        "volunteerUserId":      oid(current_user["_id"]) if role == "volunteer" else None,
        "volunteerName":        current_user["name"] if role == "volunteer" else None,
        "status":               "confirmed",
        "note":                 body.note or "",
        "peopleCount":          body.peopleCount or 0,
        "pickupQrCode":         str(uuid.uuid4()),
        "pickupConfirmedAt":    None,
        "deliveredAt":          None,
        "createdAt":            datetime.utcnow(),
        "pickedUpAt":           None,
        "coldChainAlerted":     False,
        "coldChainLogs":        [],
    }
    await database.claims.insert_one(claim_doc)
    serialized_claim = serialize(claim_doc)

    await sio.emit("listing:claimed", {"listingId": body.listingId, "claimedBy": current_user["name"]})
    donor_view = {k: v for k, v in serialized_claim.items() if k != "pickupQrCode"}
    await sio.emit("claim:new", donor_view, room=f"user:{str(listing['userId'])}")

    if ngo_user_id:
        notif = {
            "_id":       ObjectId(),
            "userId":    oid(ngo_user_id),
            "type":      "claim:by_volunteer",
            "title":     f"🚴 {current_user['name']} claimed food",
            "body":      f"{listing.get('foodName')} ({listing.get('quantity')} kg) from {listing.get('restaurantName')}",
            "data":      {"claimId": str(claim_doc["_id"]), "listingId": str(listing["_id"]), "volunteerName": current_user["name"]},
            "read":      False,
            "deleted":   False,
            "createdAt": datetime.utcnow(),
        }
        await database.notifications.insert_one(notif)
        await sio.emit("notification:new", serialize(notif), room=f"user:{ngo_user_id}")

    donor_notif = {
        "_id":       ObjectId(),
        "userId":    listing["userId"],
        "type":      "claim:new",
        "title":     f"✅ {current_user['name']} claimed your food",
        "body":      f"{listing.get('foodName')} ({listing.get('quantity')} kg) has been claimed",
        "data":      {"claimId": str(claim_doc["_id"]), "listingId": str(listing["_id"]), "claimantName": current_user["name"]},
        "read":      False,
        "deleted":   False,
        "createdAt": datetime.utcnow(),
    }
    await database.notifications.insert_one(donor_notif)
    await sio.emit("notification:new", serialize(donor_notif), room=f"user:{str(listing['userId'])}")

    room_doc = {
        "_id":           ObjectId(),
        "participants":  [oid(current_user["_id"]), listing["userId"]],
        "listingId":     listing["_id"],
        "claimId":       claim_doc["_id"],
        "name":          f"{listing['foodName']} pickup",
        "lastMessage":   "",
        "lastMessageAt": datetime.utcnow(),
        "createdAt":     datetime.utcnow(),
    }
    await database.chat_rooms.insert_one(room_doc)
    serialized_room = serialize(room_doc)
    await sio.emit("room:new", serialized_room, room=f"user:{current_user['_id']}")
    await sio.emit("room:new", serialized_room, room=f"user:{str(listing['userId'])}")

    return {**serialized_claim, "chatRoom": serialized_room}


@app.get("/api/claims/mine")
async def get_my_claims(current_user=Depends(get_current_user), database=Depends(get_db)):
    pipeline = [
        {"$match": {"claimantUserId": oid(current_user["_id"])}},
        {"$lookup": {"from": "listings", "localField": "listingId", "foreignField": "_id", "as": "listing"}},
        {"$unwind": {"path": "$listing", "preserveNullAndEmptyArrays": True}},
        {"$sort": {"createdAt": -1}},
        {"$limit": 50},
    ]
    claims = await database.claims.aggregate(pipeline).to_list(50)
    return [serialize(c) for c in claims]


@app.get("/api/claims/incoming")
async def get_incoming_claims(current_user=Depends(get_current_user), database=Depends(get_db)):
    my_listing_ids = await database.listings.distinct("_id", {"userId": oid(current_user["_id"])})
    pipeline = [
        {"$match": {"listingId": {"$in": my_listing_ids}}},
        {"$lookup": {"from": "listings", "localField": "listingId", "foreignField": "_id", "as": "listing"}},
        {"$lookup": {"from": "users",    "localField": "claimantUserId", "foreignField": "_id", "as": "claimant"}},
        {"$unwind": {"path": "$listing",  "preserveNullAndEmptyArrays": True}},
        {"$unwind": {"path": "$claimant", "preserveNullAndEmptyArrays": True}},
        {"$sort": {"createdAt": -1}},
        {"$limit": 50},
    ]
    claims = await database.claims.aggregate(pipeline).to_list(50)
    result = []
    for c in claims:
        s = serialize(c)
        if "claimant" in s:
            s["claimant"].pop("passwordHash", None)
        s.pop("pickupQrCode", None)

        result.append(s)
    return result


@app.get("/api/claims/org")
async def get_org_claims(current_user=Depends(get_current_user), database=Depends(get_db)):
    if current_user.get("role") != "ngo_admin":
        raise HTTPException(status_code=403, detail="Only NGO admins can access this.")
    pipeline = [
        {"$match": {"ngoUserId": oid(current_user["_id"])}},
        {"$lookup": {"from": "listings", "localField": "listingId",      "foreignField": "_id", "as": "listing"}},
        {"$lookup": {"from": "users",    "localField": "claimantUserId", "foreignField": "_id", "as": "volunteer"}},
        {"$unwind": {"path": "$listing",   "preserveNullAndEmptyArrays": True}},
        {"$unwind": {"path": "$volunteer", "preserveNullAndEmptyArrays": True}},
        {"$sort": {"createdAt": -1}},
        {"$limit": 100},
    ]
    claims = await database.claims.aggregate(pipeline).to_list(100)
    result = []
    for c in claims:
        s = serialize(c)
        if "volunteer" in s:
            s["volunteer"].pop("passwordHash", None)
        result.append(s)
    return result


@app.get("/api/claims/all-for-route")
async def get_all_claims_for_route(current_user=Depends(get_current_user), database=Depends(get_db)):
    if current_user.get("role") != "volunteer":
        raise HTTPException(status_code=403, detail="Route optimization is for volunteers only.")
    pipeline = [
        {"$match": {"claimantUserId": oid(current_user["_id"]), "status": {"$in": ["confirmed", "picked_up"]}}},
        {"$lookup": {"from": "listings", "localField": "listingId", "foreignField": "_id", "as": "listing"}},
        {"$unwind": {"path": "$listing", "preserveNullAndEmptyArrays": True}},
        {"$sort": {"createdAt": -1}},
        {"$limit": 30},
    ]
    claims = await database.claims.aggregate(pipeline).to_list(30)
    return [serialize(c) for c in claims]

# ─── QR PICKUP (claimant shows QR → donor scans) ───────────────────────────
def _qr_payload(claim_id: str, code: str) -> str:
    return f"foodsave:pickup:{claim_id}:{code}"


def _qr_data_uri(payload: str) -> str:
    img = qrcode.make(payload, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


@app.get("/api/claims/{claim_id}/qr")
async def get_claim_qr(
    claim_id: str,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    """Delivery person (claimant/volunteer) fetches the QR image to show to the donor."""
    claim = await database.claims.find_one({"_id": oid(claim_id)})
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")
    is_claimant = (
        str(claim["claimantUserId"]) == current_user["_id"]
        or str(claim.get("volunteerUserId") or "") == current_user["_id"]
    )
    if not is_claimant:
        raise HTTPException(status_code=403, detail="Not your claim")
    if claim.get("status") != "confirmed":
        raise HTTPException(status_code=409, detail=f"Pickup already {claim.get('status')}.")
    payload = _qr_payload(claim_id, claim["pickupQrCode"])
    return {"claimId": claim_id, "qrPayload": payload, "qrImage": _qr_data_uri(payload)}


@app.post("/api/claims/scan-pickup")
async def scan_pickup(
    body: ScanPickupBody,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    """Donor (hotel / restaurant / individual) scans the claimant's QR to complete pickup."""
    parts = body.qrData.strip().split(":")
    if len(parts) != 4 or parts[0] != "foodsave" or parts[1] != "pickup":
        raise HTTPException(status_code=400, detail="Not a valid FoodSave pickup QR code")
    claim_id, code = parts[2], parts[3]

    claim = await database.claims.find_one({"_id": oid(claim_id)})
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")
    if not hmac.compare_digest(str(claim["pickupQrCode"]), code):
        raise HTTPException(status_code=400, detail="Invalid QR code")

    listing = await database.listings.find_one({"_id": claim["listingId"]})
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    if str(listing["userId"]) != current_user["_id"] and current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Only the donor of this food can scan the pickup QR")
    if claim.get("status") != "confirmed":
        raise HTTPException(status_code=409, detail=f"Pickup already {claim.get('status')}.")

    now = datetime.utcnow()
    res = await database.claims.update_one(
        {"_id": claim["_id"], "status": "confirmed"},   # atomic: prevents double scan
        {"$set": {"status": "picked_up", "pickupConfirmedAt": now, "pickedUpAt": now}},
    )
    if res.modified_count == 0:
        raise HTTPException(status_code=409, detail="Pickup already completed.")
    await database.listings.update_one({"_id": listing["_id"]}, {"$set": {"pickedUpAt": now}})

    asyncio.create_task(_start_cold_chain_monitor(claim_id, database))

    event = {"claimId": claim_id, "status": "picked_up"}
    await sio.emit("claim:updated", event, room=f"user:{str(claim['claimantUserId'])}")
    await sio.emit("claim:updated", event, room=f"user:{str(listing['userId'])}")
    if claim.get("ngoUserId"):
        await sio.emit("claim:updated", event, room=f"user:{str(claim['ngoUserId'])}")

    notif = {
        "_id": ObjectId(), "userId": claim["claimantUserId"], "type": "pickup:confirmed",
        "title": "✅ Pickup confirmed",
        "body": f"{listing.get('restaurantName')} confirmed handover of {listing.get('foodName')}. Deliver it safely!",
        "data": {"claimId": claim_id, "listingId": str(listing["_id"])},
        "read": False, "deleted": False, "createdAt": now,
    }
    await database.notifications.insert_one(notif)
    await sio.emit("notification:new", serialize(notif), room=f"user:{str(claim['claimantUserId'])}")

    return {
        "message": "Pickup completed",
        "status": "picked_up",
        "claimId": claim_id,
        "claimantName": claim.get("claimantName"),
        "foodName": listing.get("foodName"),
    }


@app.put("/api/claims/{claim_id}/deliver")
async def confirm_delivery(
    claim_id: str,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    claim   = await database.claims.find_one({"_id": oid(claim_id)})
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")
    listing  = await database.listings.find_one({"_id": claim.get("listingId")})
    is_donor = listing and str(listing.get("userId", "")) == current_user["_id"]
    can_deliver = (
        str(claim["claimantUserId"]) == current_user["_id"]
        or str(claim.get("volunteerUserId", "")) == current_user["_id"]
        or is_donor
    )
    if not can_deliver:
        raise HTTPException(status_code=403, detail="Not authorized")

    now = datetime.utcnow()
    await database.claims.update_one(
        {"_id": oid(claim_id)},
        {"$set": {"status": "delivered", "deliveredAt": now}},
    )
    await database.listings.update_one({"_id": claim["listingId"]}, {"$set": {"status": "completed"}})
    await sio.emit("claim:updated", {"claimId": claim_id, "status": "delivered"}, room=f"user:{str(claim['claimantUserId'])}")
    if claim.get("ngoUserId"):
        await sio.emit("claim:updated", {"claimId": claim_id, "status": "delivered"}, room=f"user:{str(claim['ngoUserId'])}")

    asyncio.create_task(_check_and_award_badges(str(claim["claimantUserId"]), database))
    asyncio.create_task(_award_points(str(claim["claimantUserId"]), 10, database))
    # FIX: donor also gets points for a successful pickup
    if listing:
        asyncio.create_task(_award_points(str(listing["userId"]), 5, database))

    return {"message": "Delivery confirmed", "status": "delivered"}


async def _check_and_award_badges(user_id: str, database):
    try:
        delivered_count = await database.claims.count_documents({"claimantUserId": oid(user_id), "status": "delivered"})
        milestones = [
            (1,   "first_pickup",  "First Pickup",  "🎯"),
            (10,  "ten_pickups",   "10 Pickups",    "🏅"),
            (25,  "quarter_hero",  "25 Pickups",    "⭐"),
            (50,  "fifty_hero",    "Food Hero",     "🦸"),
            (100, "century",       "Century Club",  "💯"),
        ]
        for threshold, badge_id, label, icon in milestones:
            if delivered_count >= threshold:
                await database.users.update_one(
                    {"_id": oid(user_id), "badges.id": {"$ne": badge_id}},
                    {"$addToSet": {"badges": {"id": badge_id, "label": label, "icon": icon}}},
                )
    except Exception as e:
        print(f"Badge award error: {e}")


# ─── Cold Chain Monitor ────────────────────────────────────────────────────
async def _start_cold_chain_monitor(claim_id: str, database):
    """Background task: check at intervals if food has been in transit too long."""
    try:
        await asyncio.sleep(COLD_CHAIN_INTERVAL)
        for _ in range(COLD_CHAIN_CHECKS):
            await asyncio.sleep(COLD_CHAIN_INTERVAL)
            claim = await database.claims.find_one({"_id": oid(claim_id)})
            if not claim or claim.get("status") in ["delivered", "cancelled"]:
                break
            listing = await database.listings.find_one({"_id": claim.get("listingId")})
            if not listing:
                break
            picked_up_at = claim.get("pickedUpAt")
            if not picked_up_at:
                break
            if isinstance(picked_up_at, str):
                picked_up_at = datetime.fromisoformat(picked_up_at)
            elapsed_hours = (datetime.utcnow() - picked_up_at).total_seconds() / 3600
            limit         = get_cold_chain_limit(listing.get("category", "meals"))
            if elapsed_hours > limit and not claim.get("coldChainAlerted"):
                await database.claims.update_one(
                    {"_id": oid(claim_id)},
                    {"$set": {"coldChainAlerted": True}},
                )
                warning_notif = {
                    "_id":       ObjectId(),
                    "userId":    claim["claimantUserId"],
                    "type":      "cold_chain:warning",
                    "title":     "⚠️ Cold chain alert!",
                    "body":      f"{listing.get('foodName')} has been in transit {round(elapsed_hours, 1)}h — safe limit is {limit}h. Please deliver ASAP.",
                    "data":      {"claimId": claim_id, "elapsedHours": round(elapsed_hours, 1), "limitHours": limit},
                    "read":      False,
                    "deleted":   False,
                    "createdAt": datetime.utcnow(),
                }
                await database.notifications.insert_one(warning_notif)
                await sio.emit("notification:new", serialize(warning_notif), room=f"user:{str(claim['claimantUserId'])}")
                if claim.get("ngoUserId"):
                    ngo_notif = {**warning_notif, "_id": ObjectId(), "userId": claim["ngoUserId"]}
                    await database.notifications.insert_one(ngo_notif)
                    await sio.emit("notification:new", serialize(ngo_notif), room=f"user:{str(claim['ngoUserId'])}")
                break
    except Exception as e:
        print(f"Cold chain monitor error: {e}")


@app.post("/api/claims/{claim_id}/cold-chain-checkin")
async def cold_chain_checkin(
    claim_id: str,
    body: ColdChainCheckIn,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    claim = await database.claims.find_one({"_id": oid(claim_id)})
    if not claim:
        raise HTTPException(status_code=404, detail="Claim not found")
    if str(claim["claimantUserId"]) != current_user["_id"]:
        raise HTTPException(status_code=403, detail="Not your claim")

    listing       = await database.listings.find_one({"_id": claim.get("listingId")})
    picked_up_at  = claim.get("pickedUpAt")
    elapsed_hours = None
    if picked_up_at:
        if isinstance(picked_up_at, str):
            picked_up_at = datetime.fromisoformat(picked_up_at)
        elapsed_hours = round((datetime.utcnow() - picked_up_at).total_seconds() / 3600, 2)

    limit   = get_cold_chain_limit(listing.get("category", "meals")) if listing else 4.0
    log_doc = {
        "_id":          ObjectId(),
        "claimId":      oid(claim_id),
        "volunteerId":  oid(current_user["_id"]),
        "lat":          body.lat,
        "lng":          body.lng,
        "note":         body.note or "",
        "elapsedHours": elapsed_hours,
        "limitHours":   limit,
        "safe":         (elapsed_hours <= limit) if elapsed_hours is not None else True,
        "createdAt":    datetime.utcnow(),
    }
    await database.cold_chain_logs.insert_one(log_doc)
    await database.claims.update_one(
        {"_id": oid(claim_id)},
        {"$push": {"coldChainLogs": str(log_doc["_id"])}},
    )
    return serialize(log_doc)


@app.get("/api/claims/{claim_id}/cold-chain")
async def get_cold_chain_logs(
    claim_id: str,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    logs = await database.cold_chain_logs.find({"claimId": oid(claim_id)}).sort("createdAt", 1).to_list(50)
    return [serialize(l) for l in logs]


# ─── NGO VOLUNTEER MANAGEMENT ──────────────────────────────────────────────
@app.get("/api/ngo/volunteers")
async def get_ngo_volunteers(current_user=Depends(get_current_user), database=Depends(get_db)):
    if current_user.get("role") != "ngo_admin":
        raise HTTPException(status_code=403, detail="Only NGO admins can access this.")
    user   = await database.users.find_one({"_id": oid(current_user["_id"])})
    linked = user.get("linkedVolunteers", [])
    result = []
    for vol_ref in linked:
        vol_user = await database.users.find_one({"_id": oid(vol_ref["userId"])})
        if not vol_user:
            continue
        active_claims   = await database.claims.count_documents({"claimantUserId": oid(vol_ref["userId"]), "status": {"$in": ["confirmed", "picked_up"]}})
        total_delivered = await database.claims.count_documents({"claimantUserId": oid(vol_ref["userId"]), "status": "delivered"})
        live_loc        = vol_user.get("liveLocation", {}).get("coordinates", [])
        live_enabled    = vol_user.get("liveLocationEnabled", False)
        result.append({
            "userId":              vol_ref["userId"],
            "name":                vol_user.get("name", ""),
            "email":               vol_user.get("email", ""),
            "online":              vol_user.get("online", False),
            "lastSeen":            vol_user.get("lastSeen", "").isoformat() if isinstance(vol_user.get("lastSeen"), datetime) else vol_user.get("lastSeen", ""),
            "joinedAt":            vol_ref.get("joinedAt", ""),
            "activeClaims":        active_claims,
            "totalDelivered":      total_delivered,
            "avgRating":           vol_user.get("avgRating", 0),
            "liveLocation":        live_loc,
            "liveLocationEnabled": live_enabled,
            "badges":              vol_user.get("badges", []),
            "monthlyPoints":       vol_user.get("monthlyPoints", 0),
        })
    return result


@app.get("/api/ngo/stats")
async def get_ngo_stats(current_user=Depends(get_current_user), database=Depends(get_db)):
    if current_user.get("role") != "ngo_admin":
        raise HTTPException(status_code=403, detail="Only NGO admins can access this.")
    ngo_id = oid(current_user["_id"])
    total_pipeline = [
        {"$match": {"ngoUserId": ngo_id, "status": {"$in": ["picked_up", "delivered"]}}},
        {"$lookup": {"from": "listings", "localField": "listingId", "foreignField": "_id", "as": "listing"}},
        {"$unwind": "$listing"},
        {"$group": {"_id": None, "totalKg": {"$sum": "$listing.quantity"}, "totalMeals": {"$sum": "$listing.servings"}, "totalClaims": {"$sum": 1}}},
    ]
    result = await database.claims.aggregate(total_pipeline).to_list(1)
    stats  = result[0] if result else {"totalKg": 0, "totalMeals": 0, "totalClaims": 0}
    stats.pop("_id", None)
    stats["activeVolunteers"] = len(await database.claims.distinct("claimantUserId", {"ngoUserId": ngo_id, "status": {"$in": ["confirmed", "picked_up"]}}))
    user = await database.users.find_one({"_id": ngo_id})
    stats["totalVolunteers"] = len(user.get("linkedVolunteers", []))
    stats["orgCode"]         = user.get("orgCode", "")
    stats["orgName"]         = user.get("name", "")
    return stats


# ─── Volunteer Shift Scheduling ───────────────────────────────────────────
@app.post("/api/shifts", status_code=201)
async def create_shift(
    body: ShiftCreate,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    if current_user.get("role") != "ngo_admin":
        raise HTTPException(status_code=403, detail="Only NGO admins can create shifts.")
    shift_doc = {
        "_id":           ObjectId(),
        "ngoUserId":     oid(current_user["_id"]),
        "ngoName":       current_user.get("name", ""),
        "date":          body.date,
        "startTime":     body.startTime,
        "endTime":       body.endTime,
        "maxVolunteers": body.maxVolunteers,
        "note":          body.note or "",
        "area":          body.area or "",
        "volunteers":    [],
        "status":        "open",
        "createdAt":     datetime.utcnow(),
    }
    await database.volunteer_shifts.insert_one(shift_doc)
    user = await database.users.find_one({"_id": oid(current_user["_id"])})
    for vol_ref in user.get("linkedVolunteers", []):
        notif = {
            "_id":       ObjectId(),
            "userId":    oid(vol_ref["userId"]),
            "type":      "shift:new",
            "title":     f"📅 New shift: {body.date} {body.startTime}–{body.endTime}",
            "body":      f"{current_user.get('name', 'Your NGO')} posted a new pickup shift. Claim it now!",
            "data":      {"shiftId": str(shift_doc["_id"]), "date": body.date, "startTime": body.startTime, "endTime": body.endTime},
            "read":      False,
            "deleted":   False,
            "createdAt": datetime.utcnow(),
        }
        await database.notifications.insert_one(notif)
        await sio.emit("notification:new", serialize(notif), room=f"user:{vol_ref['userId']}")
    return serialize(shift_doc)


@app.get("/api/shifts")
async def get_shifts(
    ngo_id: Optional[str] = None,
    date: Optional[str] = None,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    query: dict = {}
    if current_user.get("role") == "ngo_admin":
        query["ngoUserId"] = oid(current_user["_id"])
    elif current_user.get("role") == "volunteer":
        user   = await database.users.find_one({"_id": oid(current_user["_id"])})
        linked = user.get("linkedNGO", {})
        if linked and linked.get("userId"):
            query["ngoUserId"] = oid(linked["userId"])
        query["status"] = "open"
    elif ngo_id:
        query["ngoUserId"] = oid(ngo_id)

    if date:
        query["date"] = date
    else:
        today = datetime.utcnow().strftime("%Y-%m-%d")
        query["date"] = {"$gte": today}

    shifts = await database.volunteer_shifts.find(query).sort("date", 1).limit(50).to_list(50)
    return [serialize(s) for s in shifts]


@app.post("/api/shifts/{shift_id}/claim")
async def claim_shift(shift_id: str, current_user=Depends(get_current_user), database=Depends(get_db)):
    if current_user.get("role") != "volunteer":
        raise HTTPException(status_code=403, detail="Only volunteers can claim shifts.")
    shift = await database.volunteer_shifts.find_one({"_id": oid(shift_id)})
    if not shift:
        raise HTTPException(status_code=404, detail="Shift not found")
    if shift.get("status") != "open":
        raise HTTPException(status_code=409, detail="This shift is no longer open.")
    if any(v["userId"] == current_user["_id"] for v in shift.get("volunteers", [])):
        raise HTTPException(status_code=409, detail="You already claimed this shift.")

    vol_entry      = {"userId": current_user["_id"], "name": current_user["name"], "claimedAt": datetime.utcnow().isoformat()}
    new_volunteers = shift.get("volunteers", []) + [vol_entry]
    new_status     = "full" if len(new_volunteers) >= shift.get("maxVolunteers", 3) else "open"
    await database.volunteer_shifts.update_one(
        {"_id": oid(shift_id)},
        {"$push": {"volunteers": vol_entry}, "$set": {"status": new_status}},
    )
    notif = {
        "_id":       ObjectId(),
        "userId":    shift["ngoUserId"],
        "type":      "shift:claimed",
        "title":     f"🚴 {current_user['name']} joined your shift",
        "body":      f"Shift on {shift['date']} {shift['startTime']}–{shift['endTime']}",
        "data":      {"shiftId": shift_id, "volunteerId": current_user["_id"], "volunteerName": current_user["name"]},
        "read":      False,
        "deleted":   False,
        "createdAt": datetime.utcnow(),
    }
    await database.notifications.insert_one(notif)
    await sio.emit("notification:new", serialize(notif), room=f"user:{str(shift['ngoUserId'])}")
    return {"ok": True, "status": new_status, "volunteersCount": len(new_volunteers)}


@app.delete("/api/shifts/{shift_id}/claim")
async def unclaim_shift(shift_id: str, current_user=Depends(get_current_user), database=Depends(get_db)):
    shift = await database.volunteer_shifts.find_one({"_id": oid(shift_id)})
    if not shift:
        raise HTTPException(status_code=404, detail="Shift not found")
    new_volunteers = [v for v in shift.get("volunteers", []) if v["userId"] != current_user["_id"]]
    new_status     = "open" if len(new_volunteers) < shift.get("maxVolunteers", 3) else "full"
    await database.volunteer_shifts.update_one(
        {"_id": oid(shift_id)},
        {"$set": {"volunteers": new_volunteers, "status": new_status}},
    )
    return {"ok": True, "status": new_status}


@app.delete("/api/shifts/{shift_id}")
async def cancel_shift(shift_id: str, current_user=Depends(get_current_user), database=Depends(get_db)):
    if current_user.get("role") != "ngo_admin":
        raise HTTPException(status_code=403, detail="Only NGO admins can cancel shifts.")
    shift = await database.volunteer_shifts.find_one({"_id": oid(shift_id)})
    if not shift or str(shift["ngoUserId"]) != current_user["_id"]:
        raise HTTPException(status_code=404, detail="Shift not found or not yours.")
    await database.volunteer_shifts.update_one({"_id": oid(shift_id)}, {"$set": {"status": "cancelled"}})
    for vol in shift.get("volunteers", []):
        notif = {
            "_id":       ObjectId(),
            "userId":    oid(vol["userId"]),
            "type":      "shift:cancelled",
            "title":     f"❌ Shift cancelled: {shift['date']} {shift['startTime']}",
            "body":      f"{current_user.get('name', 'Your NGO')} cancelled this shift.",
            "data":      {"shiftId": shift_id},
            "read":      False,
            "deleted":   False,
            "createdAt": datetime.utcnow(),
        }
        await database.notifications.insert_one(notif)
        await sio.emit("notification:new", serialize(notif), room=f"user:{vol['userId']}")
    return {"ok": True}


# ─── MAP PINS ──────────────────────────────────────────────────────────────
@app.get("/api/map/pins")
async def get_all_map_pins(current_user=Depends(get_current_user), database=Depends(get_db)):
    viewer_full = await database.users.find_one({"_id": oid(current_user["_id"])})
    viewer_lat, viewer_lng, viewer_is_live = get_effective_location(viewer_full)
    live_enabled = viewer_full.get("liveLocationEnabled", False)

    listings = await database.listings.find({
        "status":    "active",
        "expiresAt": {"$gt": datetime.utcnow()},
    }).limit(200).to_list(200)

    listing_ids  = [l["_id"] for l in listings]
    claim_counts = {}
    if listing_ids:
        pipeline = [
            {"$match": {"listingId": {"$in": listing_ids}, "status": {"$in": ["confirmed", "picked_up", "delivered"]}}},
            {"$group": {"_id": "$listingId", "count": {"$sum": 1}}},
        ]
        for c in await database.claims.aggregate(pipeline).to_list(200):
            claim_counts[str(c["_id"])] = c["count"]

    serialized_listings = []
    for l in listings:
        s               = serialize(l)
        s["isOwn"]      = str(l["userId"]) == current_user["_id"]
        s["claimCount"] = claim_counts.get(str(l["_id"]), 0)
        coords          = l.get("location", {}).get("coordinates", [])
        dist_payload = (
            get_distance_response(viewer_lat, viewer_lng, live_enabled, coords[1], coords[0])
            if len(coords) == 2
            else {"distanceKm": None, "distanceStatus": "unavailable"}
        )
        s.update(dist_payload)
        s["viewerIsLive"]     = viewer_is_live
        s["coldChainWarning"] = _cold_chain_warning(l)
        serialized_listings.append(s)

    users     = await database.users.find({}).limit(500).to_list(500)
    user_pins = []
    for user in users:
        for loc in user.get("locations", []):
            if not loc.get("location"):
                continue
            loc_type       = loc.get("type", "")
            profile_coords = loc["location"]["coordinates"]
            if loc_type in MOBILE_LOCATION_TYPES:
                pin_lat, pin_lng, pin_is_live = get_effective_location(user)
                pin_coords = [pin_lng, pin_lat] if pin_lat is not None else profile_coords
            else:
                pin_coords  = profile_coords
                pin_is_live = False
            dist_payload = (
                get_distance_response(viewer_lat, viewer_lng, live_enabled, pin_coords[1], pin_coords[0])
                if len(pin_coords) == 2
                else {"distanceKm": None, "distanceStatus": "unavailable"}
            )
            pin = {
                "type":                "user_location",
                "locationType":        loc_type,
                "name":                loc.get("name"),
                "locationName":        loc.get("name"),
                "address":             loc.get("address"),
                "coordinates":         pin_coords,
                "profileCoordinates":  profile_coords,
                "verified":            loc.get("verified", False),
                "userId":              str(user["_id"]),
                "userName":            user.get("name", ""),
                "online":              user.get("online", False),
                "liveLocationEnabled": user.get("liveLocationEnabled", False),
                "pinIsLive":           pin_is_live,
                "viewerIsLive":        viewer_is_live,
            }
            pin.update(dist_payload)
            user_pins.append(pin)

    return {
        "listings":  serialized_listings,
        "userPins":  user_pins,
        "viewerLocation": {
            "lat":         viewer_lat,
            "lng":         viewer_lng,
            "isLive":      viewer_is_live,
            "liveEnabled": live_enabled,
        },
    }


@app.get("/api/map/nearby-orgs")
async def get_nearby_orgs(
    lat: float, lng: float,
    radius: float = 10000,
    org_type: Optional[str] = None,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    viewer_full = await database.users.find_one({"_id": oid(current_user["_id"])})
    viewer_lat, viewer_lng, viewer_is_live = get_effective_location(viewer_full)
    live_enabled = viewer_full.get("liveLocationEnabled", False)
    if lat is not None and lng is not None:
        viewer_lat, viewer_lng = lat, lng
        viewer_is_live = True

    type_filter = {
        "restaurant": ["restaurant", "hotel"],
        "ngo":        ["ngo", "orphanage"],
    }.get(org_type, ["restaurant", "hotel", "ngo", "orphanage", "individual"])

    try:
        pipeline = [
            {"$unwind": "$locations"},
            {"$match": {
                "locations.location": {
                    "$near": {
                        "$geometry":    {"type": "Point", "coordinates": [lng, lat]},
                        "$maxDistance": radius,
                    }
                },
                "locations.type": {"$in": type_filter},
            }},
            {"$project": {"_id": 1, "name": 1, "online": 1, "liveLocationEnabled": 1, "liveLocation": 1, "location": "$locations"}},
            {"$limit": 50},
        ]
        orgs = await database.users.aggregate(pipeline).to_list(50)
    except Exception:
        all_users = await database.users.find({}).limit(200).to_list(200)
        orgs = []
        for u in all_users:
            for loc_doc in u.get("locations", []):
                if loc_doc.get("type") in type_filter:
                    orgs.append({
                        "_id": u["_id"], "name": u["name"],
                        "online": u.get("online", False),
                        "liveLocationEnabled": u.get("liveLocationEnabled", False),
                        "liveLocation": u.get("liveLocation"),
                        "location": loc_doc,
                    })

    result = []
    for org in orgs:
        org_s = serialize(org)
        if org_s["_id"] == current_user["_id"]:
            continue
        loc            = org_s.get("location", {})
        loc_type       = loc.get("type", "")
        active_count   = await database.listings.count_documents({"userId": oid(str(org_s["_id"])), "status": "active"})
        profile_coords = loc.get("location", {}).get("coordinates", [])
        if loc_type in MOBILE_LOCATION_TYPES:
            org_live_coords = (org_s.get("liveLocation") or {}).get("coordinates", [])
            if org_s.get("liveLocationEnabled") and len(org_live_coords) == 2 and len(profile_coords) == 2:
                moved         = haversine_km(profile_coords[1], profile_coords[0], org_live_coords[1], org_live_coords[0])
                target_coords = org_live_coords if moved > LIVE_LOC_MOVED_THRESHOLD_KM else profile_coords
            else:
                target_coords = profile_coords
        else:
            target_coords = profile_coords

        dist_payload = (
            get_distance_response(viewer_lat, viewer_lng, live_enabled, target_coords[1], target_coords[0])
            if len(target_coords) == 2
            else {"distanceKm": None, "distanceStatus": "unavailable"}
        )
        entry = {
            "userId":              org_s["_id"],
            "name":                org_s.get("name", ""),
            "online":              org_s.get("online", False),
            "locationType":        loc_type,
            "locationName":        loc.get("name", ""),
            "address":             loc.get("address", ""),
            "coordinates":         target_coords,
            "profileCoordinates":  profile_coords,
            "verified":            loc.get("verified", False),
            "activeListings":      active_count,
            "liveLocationEnabled": org_s.get("liveLocationEnabled", False),
            "viewerIsLive":        viewer_is_live,
        }
        entry.update(dist_payload)
        result.append(entry)
    result.sort(key=lambda x: x.get("distanceKm") if x.get("distanceKm") is not None else 99999)
    return result


@app.get("/api/listings/{listing_id}/claim-status")
async def get_listing_claim_status(
    listing_id: str,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    listing = await database.listings.find_one({"_id": oid(listing_id)})
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    claim       = await database.claims.find_one({"listingId": oid(listing_id), "status": {"$in": ["confirmed", "picked_up"]}}, sort=[("createdAt", -1)])
    claim_count = await database.claims.count_documents({"listingId": oid(listing_id)})
    is_own      = str(listing.get("userId", "")) == current_user["_id"]
    viewer_full = await database.users.find_one({"_id": oid(current_user["_id"])})
    viewer_lat, viewer_lng, viewer_is_live = get_effective_location(viewer_full)
    live_enabled = viewer_full.get("liveLocationEnabled", False)
    coords       = listing.get("location", {}).get("coordinates", [])
    dist_payload = (
        get_distance_response(viewer_lat, viewer_lng, live_enabled, coords[1], coords[0])
        if len(coords) == 2
        else {"distanceKm": None, "distanceStatus": "unavailable"}
    )
    return {
        "listingId":        listing_id,
        "listingStatus":    listing.get("status", "active"),
        "isClaimed":        listing.get("status") in ["claimed", "completed"],
        "isOwn":            is_own,
        "claimCount":       claim_count,
        "claim":            ({k: v for k, v in serialize(claim).items() if k != "pickupQrCode"} if claim else None),
        "claimedBy":        claim.get("claimantName", "") if claim else None,
        "viewerIsLive":     viewer_is_live,
        "coldChainWarning": _cold_chain_warning(listing),
        **dist_payload,
    }


# ─── DIRECTIONS ────────────────────────────────────────────────────────────
@app.get("/api/directions")
async def get_directions(
    from_lat: float, from_lng: float,
    to_lat: float, to_lng: float,
    mode: str = "driving",
    current_user=Depends(get_current_user),
):
    if not MAPBOX_TOKEN:
        dist = haversine_km(from_lat, from_lng, to_lat, to_lng)
        return {
            "routes": [{
                "distance": dist * 1000,
                "duration": dist / 30 * 3600,
                "geometry": {"type": "LineString", "coordinates": [[from_lng, from_lat], [to_lng, to_lat]]},
            }],
            "fallback": True,
        }
    profile = {"driving": "mapbox/driving", "walking": "mapbox/walking", "cycling": "mapbox/cycling"}.get(mode, "mapbox/driving")
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"https://api.mapbox.com/directions/v5/{profile}/{from_lng},{from_lat};{to_lng},{to_lat}",
            params={"access_token": MAPBOX_TOKEN, "steps": "true", "geometries": "geojson", "overview": "full"},
        )
        return r.json()


@app.post("/api/directions")
async def get_directions_post(body: DirectionRequest, current_user=Depends(get_current_user)):
    return await get_directions(body.fromLat, body.fromLng, body.toLat, body.toLng, body.mode, current_user)


# ─── CHAT ROUTES ───────────────────────────────────────────────────────────
@app.post("/api/chat/rooms", status_code=201)
async def create_chat_room(
    body: ChatRoomCreate,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    participant_oids = [oid(p) for p in body.participantIds]
    if oid(current_user["_id"]) not in participant_oids:
        participant_oids.append(oid(current_user["_id"]))
    query = {"participants": {"$all": participant_oids, "$size": len(participant_oids)}}
    if body.listingId:
        query["listingId"] = oid(body.listingId)
    existing = await database.chat_rooms.find_one(query)
    if existing:
        return serialize(existing)
    participant_docs = await database.users.find({"_id": {"$in": participant_oids}}, {"name": 1}).to_list(20)
    names    = [d.get("name", "") for d in participant_docs]
    room_doc = {
        "_id":              ObjectId(),
        "participants":     participant_oids,
        "participantNames": names,
        "listingId":        oid(body.listingId) if body.listingId else None,
        "name":             body.name or " & ".join(names[:2]),
        "lastMessage":      "",
        "lastMessageAt":    datetime.utcnow(),
        "createdAt":        datetime.utcnow(),
    }
    await database.chat_rooms.insert_one(room_doc)
    serialized = serialize(room_doc)
    for p_id in participant_oids:
        await sio.emit("room:new", serialized, room=f"user:{str(p_id)}")
    return serialized


@app.get("/api/chat/rooms")
async def get_my_chat_rooms(current_user=Depends(get_current_user), database=Depends(get_db)):
    rooms  = await database.chat_rooms.find({"participants": oid(current_user["_id"])}).sort("lastMessageAt", -1).limit(30).to_list(30)
    result = []
    for room in rooms:
        r = serialize(room)
        if room.get("listingId"):
            listing  = await database.listings.find_one({"_id": room["listingId"]}, {"foodName": 1, "restaurantName": 1, "status": 1})
            r["listing"] = serialize(listing) if listing else None
        unread           = await database.messages.count_documents({"roomId": room["_id"], "fromUserId": {"$ne": oid(current_user["_id"])}, "read": False})
        r["unreadCount"] = unread
        others = [p for p in room.get("participants", []) if str(p) != current_user["_id"]]
        if others:
            other_user       = await database.users.find_one({"_id": others[0]}, {"name": 1})
            r["otherName"]   = other_user.get("name", "") if other_user else ""
            r["otherUserId"] = str(others[0])
        result.append(r)
    return result


@app.get("/api/chat/rooms/{room_id}/messages")
async def get_room_messages(
    room_id: str, page: int = 1, limit: int = 50,
    current_user=Depends(get_current_user), database=Depends(get_db),
):
    room = await database.chat_rooms.find_one({"_id": oid(room_id)})
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if oid(current_user["_id"]) not in room.get("participants", []):
        raise HTTPException(status_code=403, detail="Not a participant")
    skip     = (page - 1) * limit
    messages = await database.messages.find({"roomId": oid(room_id)}).sort("createdAt", -1).skip(skip).limit(limit).to_list(limit)
    messages.reverse()
    await database.messages.update_many(
        {"roomId": oid(room_id), "fromUserId": {"$ne": oid(current_user["_id"])}, "read": False},
        {"$set": {"read": True}},
    )
    result       = []
    sender_cache = {}
    for msg in messages:
        s       = serialize(msg)
        from_id = str(msg.get("fromUserId", ""))
        if from_id not in sender_cache:
            u = await database.users.find_one({"_id": msg["fromUserId"]}, {"name": 1})
            sender_cache[from_id] = u.get("name", "") if u else ""
        s["senderName"] = sender_cache[from_id]
        s["senderId"]   = from_id
        result.append(s)
    return result


# ─── AI FEATURES ───────────────────────────────────────────────────────────

@app.get("/api/ai/chat/sessions")
async def get_ai_chat_sessions(
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    """Fetch all AI chat sessions for the current user."""
    features = get_role_features(current_user.get("role", "individual"))
    if not features.get("can_see_ai_chat"):
        raise HTTPException(status_code=403, detail="AI chat is not available for your account type.")
    sessions = await database.ai_chat_sessions.find(
        {"userId": oid(current_user["_id"])}
    ).sort("createdAt", -1).limit(20).to_list(20)
    return [
        {
            "sessionId":    s.get("sessionId", ""),
            "messageCount": len(s.get("messages", [])),
            "createdAt":    s.get("createdAt", "").isoformat() if isinstance(s.get("createdAt"), datetime) else s.get("createdAt", ""),
            "lastMessage":  s["messages"][-1]["content"][:80] if s.get("messages") else "",
        }
        for s in sessions
    ]


@app.get("/api/ai/chat/sessions/{session_id}")
async def get_ai_chat_session(
    session_id: str,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    """Fetch full message history for an AI chat session."""
    features = get_role_features(current_user.get("role", "individual"))
    if not features.get("can_see_ai_chat"):
        raise HTTPException(status_code=403, detail="AI chat is not available for your account type.")
    session = await database.ai_chat_sessions.find_one({
        "sessionId": session_id,
        "userId":    oid(current_user["_id"]),
    })
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return serialize(session)


@app.post("/api/ai/chat")
async def ai_chatbot(
    body: AIChatMessage,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    """
    FoodSave AI assistant — English only, grounded in real platform data.
    Supports multi-turn conversation via sessionId.
    """
    features = get_role_features(current_user.get("role", "individual"))
    if not features.get("can_see_ai_chat"):
        raise HTTPException(status_code=403, detail="AI chat is not available for your account type.")

    # Resolve user location
    user_lat = body.lat
    user_lng = body.lng
    if user_lat is None or user_lng is None:
        user_full = await database.users.find_one({"_id": oid(current_user["_id"])})
        eff_lat, eff_lng, _ = get_effective_location(user_full)
        if eff_lat and eff_lng:
            user_lat, user_lng = eff_lat, eff_lng

    # Fetch active listings nearby
    geo_filter = {}
    if user_lat and user_lng:
        geo_filter = {"location": {"$near": {"$geometry": {"type": "Point", "coordinates": [user_lng, user_lat]}, "$maxDistance": 15000}}}
    active_listings = await database.listings.find({
        "status":    "active",
        "expiresAt": {"$gt": datetime.utcnow()},
        **geo_filter,
    }).limit(20).to_list(20)

    # Platform-wide stats
    analytics_result = await database.listings.aggregate([
        {"$match": {"status": {"$in": ["claimed", "delivered", "completed"]}}},
        {"$group": {"_id": None, "totalKg": {"$sum": "$quantity"}, "totalClaims": {"$sum": 1}, "totalServings": {"$sum": "$servings"}}},
    ]).to_list(1)
    analytics = analytics_result[0] if analytics_result else {"totalKg": 0, "totalClaims": 0, "totalServings": 0}
    total_users = await database.users.count_documents({})

    # Build listing summaries for context
    listing_summaries = []
    for l in active_listings:
        expires_at = l.get("expiresAt", datetime.utcnow())
        if isinstance(expires_at, str):
            expires_at = datetime.fromisoformat(expires_at)
        hours_left = round((expires_at - datetime.utcnow()).total_seconds() / 3600, 1)
        dist_str   = ""
        if user_lat and l.get("location", {}).get("coordinates"):
            coords   = l["location"]["coordinates"]
            d        = haversine_km(user_lat, user_lng, coords[1], coords[0])
            dist_str = f"{d} km away"
        cold_warn = _cold_chain_warning(l)
        listing_summaries.append(
            f"• ID:{str(l['_id'])} | {l.get('foodName')} ({l.get('category')}) | "
            f"{l.get('quantity')} kg | ~{l.get('servings', 0)} servings | "
            f"{'🌿 Veg' if l.get('isVeg') else '🍖 Non-veg'} | "
            f"{dist_str} | {hours_left}h left | from {l.get('restaurantName', 'unknown')}"
            + (f" | ⚠️ {cold_warn}" if cold_warn else "")
        )

    # Load conversation history for multi-turn (last 10 turns)
    session_id = body.sessionId or str(uuid.uuid4())
    history: List[dict] = []
    existing_session = await database.ai_chat_sessions.find_one({
        "sessionId": session_id,
        "userId":    oid(current_user["_id"]),
    })
    if existing_session and existing_session.get("messages"):
        raw_history = existing_session["messages"][-20:]  # last 20 messages = 10 turns
        history = [{"role": m["role"], "content": m["content"]} for m in raw_history]

    # System prompt — English only, FoodSave data only
    system = f"""You are FoodSave AI, the official assistant for the FoodSave food rescue platform.

STRICT RULES:
1. Always respond in English only. Do NOT switch to any other language even if the user writes in one.
2. Only discuss topics related to FoodSave: food listings, pickups, donations, volunteering, food safety, cold chain, waste reduction, and platform features.
3. If asked about unrelated topics, politely redirect: "I can only help with FoodSave topics."
4. Never invent food listings — only reference the real data provided below.
5. Be concise, friendly, and action-oriented. Keep responses under 180 words.

PLATFORM DATA (as of {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}):
- Total food rescued: {round(analytics.get('totalKg', 0), 1)} kg | {analytics.get('totalServings', 0)} meals served | {analytics.get('totalClaims', 0)} successful pickups
- Active users: {total_users}
- User: {current_user.get('name')} (role: {current_user.get('role')})

ACTIVE FOOD LISTINGS NEARBY:
{chr(10).join(listing_summaries) if listing_summaries else 'No active listings found near your location right now.'}

HOW TO HELP:
- Tell users what food is available and from where.
- Guide volunteers on how to claim and pick up food.
- Explain cold chain rules (dairy: 2h, meals: 4h, bakery: 6h, produce: 8h).
- Help donors understand how to post listings.
- Share impact stats when asked."""

    response_text = await call_groq(
        system,
        body.message,
        max_tokens=450,
        conversation_history=history,
    )

    # Persist to session (upsert)
    now = datetime.utcnow()
    await database.ai_chat_sessions.update_one(
        {"sessionId": session_id},
        {
            "$push": {
                "messages": {
                    "$each": [
                        {"role": "user",      "content": body.message,    "at": now.isoformat()},
                        {"role": "assistant", "content": response_text,   "at": now.isoformat()},
                    ]
                }
            },
            "$set":       {"updatedAt": now},
            "$setOnInsert": {
                "userId":    oid(current_user["_id"]),
                "sessionId": session_id,
                "createdAt": now,
            },
        },
        upsert=True,
    )

    return {
        "reply":         response_text,
        "sessionId":     session_id,
        "listingsFound": len(active_listings),
        "model":         GROQ_MODELS[0],
    }


@app.delete("/api/ai/chat/sessions/{session_id}")
async def delete_ai_chat_session(
    session_id: str,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    result = await database.ai_chat_sessions.delete_one({
        "sessionId": session_id,
        "userId":    oid(current_user["_id"]),
    })
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"message": "Session deleted"}


@app.post("/api/ai/analyze-food-photo")
async def analyze_food_photo(
    body: FoodPhotoAnalyze,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    features = get_role_features(current_user.get("role", "individual"))
    if not features.get("can_see_photo_analysis"):
        raise HTTPException(status_code=403, detail="Photo analysis is only available for restaurant/hotel accounts.")

    system = (
        "You are a food analysis AI for the FoodSave donation platform. "
        "Analyze the food photo accurately and extract structured information. "
        "Respond only in English."
    )
    user_msg = (
        "Analyze this food photo and provide structured details:\n"
        "- foodName: what food is this\n"
        "- category: one of meals/snacks/bakery/produce/dairy/beverages/grains/other\n"
        "- estimatedQuantityKg: estimated weight in kg\n"
        "- estimatedServings: number of people this can feed\n"
        "- isVeg: true if vegetarian, false otherwise\n"
        "- allergens: array of potential allergens (e.g. gluten, dairy, nuts)\n"
        "- safetyConcern: true only if there are visible spoilage/safety issues\n"
        "- safetyConcernReason: explain if safetyConcern is true\n"
        "- confidence: 0.0-1.0 confidence score\n\n"
        "Return ONLY valid JSON with these exact keys."
    )
    response = await call_groq_vision(system, user_msg, body.imageBase64, body.mimeType, max_tokens=500, json_mode=True)
    result   = _safe_json_parse(response)
    if not result:
        raise HTTPException(status_code=502, detail="AI returned invalid response. Please try again.")

    return {
        "success":  True,
        "analysis": result,
        "suggestedListing": {
            "foodName":  result.get("foodName", ""),
            "category":  result.get("category", "meals"),
            "quantity":  result.get("estimatedQuantityKg", 0),
            "servings":  result.get("estimatedServings", 0),
            "isVeg":     result.get("isVeg", True),
            "allergens": result.get("allergens", []),
            "aiFlagged": result.get("safetyConcern", False),
            "flagReason": result.get("safetyConcernReason", ""),
        },
    }


@app.post("/api/ai/predict-waste")
async def predict_waste(
    body: WastePredictionRequest,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    features = get_role_features(current_user.get("role", "individual"))
    if not features.get("can_see_waste_prediction"):
        raise HTTPException(status_code=403, detail="Waste prediction is only available for restaurant/hotel accounts.")

    thirty_days_ago = datetime.utcnow() - timedelta(days=30)
    history = await database.listings.find({
        "locationId": oid(body.locationId),
        "createdAt":  {"$gte": thirty_days_ago},
    }).sort("createdAt", -1).to_list(200)

    if len(history) < 5:
        return {
            "predictions": [],
            "message":     f"Not enough history yet — need at least 5 listings to predict (you have {len(history)}).",
            "dataPoints":  len(history),
        }

    history_summary = []
    for l in history:
        created = l.get("createdAt", datetime.utcnow())
        if isinstance(created, str):
            created = datetime.fromisoformat(created)
        history_summary.append(
            f"- {created.strftime('%A %H:%M')} | {l.get('foodName')} | "
            f"{l.get('quantity')} kg | {l.get('category')} | {l.get('status')}"
        )

    user     = await database.users.find_one({"_id": oid(current_user["_id"])})
    location = next((loc for loc in user.get("locations", []) if str(loc["_id"]) == body.locationId), None)
    location_name = location.get("name", "This location") if location else "This location"

    system   = (
        "You are a food waste prediction AI for the FoodSave platform. "
        "Analyze historical food donation patterns and predict future surplus. "
        "Respond only in English with valid JSON."
    )
    user_msg = (
        f"Restaurant/Donor: {location_name}\n"
        f"History (last 30 days, {len(history)} entries):\n"
        f"{chr(10).join(history_summary[:60])}\n\n"
        f"Today: {datetime.utcnow().strftime('%A, %B %d %H:%M UTC')}\n\n"
        f"Analyze the patterns and return ONLY JSON:\n"
        f'{{"predictions": [{{'
        f'"dayOfWeek": "Monday", "date": "YYYY-MM-DD", "timeWindow": "12:00-14:00", '
        f'"estimatedQuantityKg": 5.0, "category": "meals", "confidence": 0.8, '
        f'"reason": "Consistently posts on Mondays around lunch"'
        f'}}], "weeklyPattern": "...", "peakDay": "...", "peakTime": "...", "topCategories": [...]}}'
    )

    response = await call_groq(system, user_msg, max_tokens=900, json_mode=True)
    result   = _safe_json_parse(response)
    if not result:
        raise HTTPException(status_code=502, detail="AI prediction returned invalid data. Please try again.")

    return {"locationId": body.locationId, "locationName": location_name, "dataPoints": len(history), **result}


@app.post("/api/ai/optimize-route")
async def optimize_ngo_route(
    body: RouteOptimizeRequest,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    if current_user.get("role") != "volunteer":
        raise HTTPException(status_code=403, detail="Route optimization is only available for volunteers.")
    if not body.claimIds:
        raise HTTPException(status_code=400, detail="No claim IDs provided")

    claims_data = []
    for claim_id in body.claimIds:
        claim = await database.claims.find_one({"_id": oid(claim_id)})
        if not claim or str(claim.get("claimantUserId", "")) != current_user["_id"]:
            continue
        listing = await database.listings.find_one({"_id": claim.get("listingId")})
        if not listing:
            continue
        expires_at = listing.get("expiresAt", datetime.utcnow() + timedelta(hours=4))
        if isinstance(expires_at, str):
            expires_at = datetime.fromisoformat(expires_at)
        hours_left = (expires_at - datetime.utcnow()).total_seconds() / 3600
        coords     = listing.get("location", {}).get("coordinates", [])
        if coords:
            claims_data.append({
                "claimId":           str(claim["_id"]),
                "listingId":         str(listing["_id"]),
                "foodName":          listing.get("foodName", ""),
                "restaurantName":    listing.get("restaurantName", ""),
                "restaurantAddress": listing.get("restaurantAddress", ""),
                "quantity":          listing.get("quantity", 0),
                "hoursLeft":         round(hours_left, 1),
                "urgency":           "high" if hours_left < 1.5 else "medium" if hours_left < 3 else "low",
                "lat":               coords[1],
                "lng":               coords[0],
                "expiresAt":         expires_at.isoformat(),
                "isVeg":             listing.get("isVeg", True),
                "category":          listing.get("category", ""),
                "coldChainLimit":    get_cold_chain_limit(listing.get("category", "meals")),
            })

    if not claims_data:
        raise HTTPException(status_code=404, detail="No valid authorized claims with location data found")

    def sort_key(c):
        urgency_score = {"high": 0, "medium": 1, "low": 2}[c["urgency"]]
        dist          = haversine_km(body.startLat, body.startLng, c["lat"], c["lng"])
        return (urgency_score, dist)

    optimized_order = sorted(claims_data, key=sort_key)

    if MAPBOX_TOKEN and len(claims_data) > 1:
        try:
            waypoint_str = f"{body.startLng},{body.startLat}"
            for c in claims_data:
                waypoint_str += f";{c['lng']},{c['lat']}"
            url = f"https://api.mapbox.com/optimized-trips/v1/mapbox/driving/{waypoint_str}"
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(url, params={
                    "access_token": MAPBOX_TOKEN,
                    "roundtrip":    "false",
                    "source":       "first",
                    "destination":  "any",
                    "geometries":   "geojson",
                })
                mapbox_data = r.json()
                if mapbox_data.get("code") == "Ok" and mapbox_data.get("trips"):
                    waypoint_order = mapbox_data["trips"][0].get("waypoint_index", [])
                    if waypoint_order and len(waypoint_order) > 1:
                        claims_indices = [i - 1 for i in waypoint_order[1:] if i > 0]
                        candidate      = [claims_data[i] for i in claims_indices if i < len(claims_data)]
                        if len(candidate) == len(claims_data):
                            optimized_order = candidate
        except Exception as e:
            print(f"Mapbox route optimization error: {e}")

    total_km = 0.0
    prev_lat, prev_lng = body.startLat, body.startLng
    for c in optimized_order:
        total_km  += haversine_km(prev_lat, prev_lng, c["lat"], c["lng"])
        prev_lat, prev_lng = c["lat"], c["lng"]

    return {
        "optimizedRoute":      optimized_order,
        "totalStops":          len(optimized_order),
        "estimatedDistanceKm": round(total_km, 2),
        "estimatedTimeMin":    round(total_km / 30 * 60),
        "startPoint":          {"lat": body.startLat, "lng": body.startLng},
    }


@app.post("/api/ai/food-safety-check")
async def food_safety_check(
    body: FoodSafetyCheckRequest,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    features = get_role_features(current_user.get("role", "individual"))
    if not features.get("can_post"):
        raise HTTPException(status_code=403, detail="Only donors can use the food safety checker.")
    try:
        expires_at_dt   = datetime.fromisoformat(body.expiresAt.replace("Z", ""))
        hours_to_expire = (expires_at_dt - datetime.utcnow()).total_seconds() / 3600
    except Exception:
        hours_to_expire = 24

    system = (
        "You are a professional food safety inspector AI for the FoodSave donation platform. "
        "Your job is to flag genuine food safety issues ONLY. Do not be overly strict — donated food is often fine. "
        "Respond only in English."
    )
    user_msg = (
        f"Food donation safety check:\n"
        f"- Name: {body.foodName}\n"
        f"- Category: {body.category}\n"
        f"- Description: {body.description}\n"
        f"- Quantity: {body.quantity} kg\n"
        f"- Expires in: {round(hours_to_expire, 1)} hours\n\n"
        f"Return ONLY JSON with keys: flagged (bool), reason (string), severity (low/medium/high), "
        f"recommendations (string array), safeToPost (bool), storageAdvice (string)"
    )

    response = await call_groq(system, user_msg, max_tokens=350, json_mode=True)
    result   = _safe_json_parse(response)
    if not result:
        result = {"flagged": False, "reason": "", "severity": "low", "recommendations": [], "safeToPost": True, "storageAdvice": ""}
    return result


@app.post("/api/ai/generate-impact-report")
async def generate_impact_report(
    body: ImpactReportRequest,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    features = get_role_features(current_user.get("role", "individual"))
    if not features.get("can_see_impact_report"):
        raise HTTPException(status_code=403, detail="Impact reports are not available for your account type.")

    now      = datetime.utcnow()
    start_dt = datetime.fromisoformat(body.startDate) if body.startDate else now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end_dt   = datetime.fromisoformat(body.endDate)   if body.endDate   else now
    date_filter = {"createdAt": {"$gte": start_dt, "$lte": end_dt}}

    total_result = await database.listings.aggregate([
        {"$match": {"status": {"$in": ["claimed", "delivered", "picked_up"]}, **date_filter}},
        {"$group": {"_id": None, "totalKg": {"$sum": "$quantity"}, "totalServings": {"$sum": "$servings"}, "totalListings": {"$sum": 1}}},
    ]).to_list(1)
    totals = total_result[0] if total_result else {"totalKg": 0, "totalServings": 0, "totalListings": 0}

    top_donors = await database.listings.aggregate([
        {"$match": {"status": {"$in": ["claimed", "delivered"]}, **date_filter}},
        {"$group": {"_id": "$restaurantName", "kg": {"$sum": "$quantity"}, "count": {"$sum": 1}, "meals": {"$sum": "$servings"}}},
        {"$sort": {"kg": -1}}, {"$limit": 5},
    ]).to_list(5)

    category_breakdown = await database.listings.aggregate([
        {"$match": {"status": {"$in": ["claimed", "delivered"]}, **date_filter}},
        {"$group": {"_id": "$category", "kg": {"$sum": "$quantity"}, "count": {"$sum": 1}}},
        {"$sort": {"kg": -1}},
    ]).to_list(10)

    total_kg      = round(totals.get("totalKg", 0), 1)
    co2_offset    = round(total_kg * 2.5, 1)
    water_saved   = round(total_kg * 1000, 0)
    total_users   = await database.users.count_documents({})
    total_vols    = await database.users.count_documents({"role": "volunteer"})
    total_donors  = await database.users.count_documents({"role": "donor"})

    data_summary = (
        f"FOODSAVE IMPACT REPORT\n"
        f"Period: {start_dt.strftime('%B %d, %Y')} to {end_dt.strftime('%B %d, %Y')}\n\n"
        f"KEY METRICS:\n"
        f"- Food rescued: {total_kg} kg\n"
        f"- Meals provided: {totals.get('totalServings', 0)}\n"
        f"- CO2 emissions offset: {co2_offset} kg\n"
        f"- Water saved: {water_saved:,.0f} litres\n"
        f"- Successful pickups: {totals.get('totalListings', 0)}\n"
        f"- Platform users: {total_users} ({total_donors} donors, {total_vols} volunteers)\n\n"
        f"TOP DONORS:\n"
        + "\n".join([f"- {d['_id']}: {round(d['kg'],1)} kg, {d.get('meals',0)} meals" for d in top_donors]) + "\n\n"
        f"FOOD CATEGORIES RESCUED:\n"
        + "\n".join([f"- {c['_id']}: {round(c['kg'],1)} kg" for c in category_breakdown])
    )

    system = (
        "You are an impact report writer for FoodSave, a food waste reduction platform in India. "
        "Write an inspiring, professional impact report in English. "
        "Use the data provided. Include clear sections with headers. "
        "Highlight the human impact. Keep it under 600 words."
    )
    report_text = await call_groq(system, data_summary, max_tokens=1400)

    report_doc = {
        "_id":         ObjectId(),
        "generatedBy": oid(current_user["_id"]),
        "startDate":   start_dt,
        "endDate":     end_dt,
        "reportText":  report_text,
        "metrics": {
            "totalKg":       total_kg,
            "totalServings": totals.get("totalServings", 0),
            "co2Offset":     co2_offset,
            "totalUsers":    total_users,
        },
        "createdAt": datetime.utcnow(),
    }
    await database.impact_reports.insert_one(report_doc)

    return {
        "reportId":   str(report_doc["_id"]),
        "reportText": report_text,
        "period":     {"start": start_dt.isoformat(), "end": end_dt.isoformat()},
        "metrics": {
            "totalKg":          total_kg,
            "totalServings":    totals.get("totalServings", 0),
            "totalListings":    totals.get("totalListings", 0),
            "co2OffsetKg":      co2_offset,
            "waterSavedLitres": water_saved,
            "totalUsers":       total_users,
            "totalVolunteers":  total_vols,
            "totalDonors":      total_donors,
        },
        "topDonors":         [{"name": d["_id"], "kg": round(d["kg"], 1), "meals": d.get("meals", 0)} for d in top_donors],
        "categoryBreakdown": [{"category": c["_id"], "kg": round(c["kg"], 1)} for c in category_breakdown],
    }


# ─── Points & Leaderboard ─────────────────────────────────────────────────
async def _award_points(user_id: str, points: int, database):
    try:
        await database.users.update_one(
            {"_id": oid(user_id)},
            {"$inc": {"monthlyPoints": points, "totalPoints": points}},
        )
        user = await database.users.find_one({"_id": oid(user_id)}, {"monthlyPoints": 1})
        mp   = user.get("monthlyPoints", 0) if user else 0
        if mp >= 100:
            badge = {"id": "top_volunteer_month", "label": "Top Volunteer", "icon": "🏆"}
            await database.users.update_one(
                {"_id": oid(user_id), "badges.id": {"$ne": "top_volunteer_month"}},
                {"$addToSet": {"badges": badge}},
            )
    except Exception as e:
        print(f"Award points error: {e}")


@app.get("/api/leaderboard")
async def get_leaderboard(
    type: str = "donors",
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    if type == "donors":
        results = await database.listings.aggregate([
            {"$match": {"status": {"$in": ["claimed", "delivered", "completed"]}}},
            {"$group": {"_id": "$restaurantName", "kg": {"$sum": "$quantity"}, "count": {"$sum": 1}, "meals": {"$sum": "$servings"}}},
            {"$sort": {"kg": -1}}, {"$limit": 10},
        ]).to_list(10)
        return [{"name": r["_id"], "kg": round(r["kg"], 1), "listings": r["count"], "meals": r.get("meals", 0)} for r in results]

    elif type == "volunteers":
        results = await database.claims.aggregate([
            {"$match": {"status": "delivered", "claimantRole": "volunteer"}},
            {"$lookup": {"from": "listings", "localField": "listingId", "foreignField": "_id", "as": "listing"}},
            {"$unwind": "$listing"},
            {"$group": {"_id": "$claimantUserId", "name": {"$first": "$claimantName"}, "kg": {"$sum": "$listing.quantity"}, "deliveries": {"$sum": 1}}},
            {"$sort": {"kg": -1}}, {"$limit": 10},
        ]).to_list(10)
        enriched = []
        for r in results:
            user = await database.users.find_one({"_id": r["_id"]}, {"badges": 1, "monthlyPoints": 1, "totalPoints": 1})
            enriched.append({
                "userId":        str(r["_id"]),
                "name":          r.get("name", ""),
                "kg":            round(r["kg"], 1),
                "deliveries":    r["deliveries"],
                "badges":        user.get("badges", [])        if user else [],
                "monthlyPoints": user.get("monthlyPoints", 0)  if user else 0,
                "totalPoints":   user.get("totalPoints", 0)    if user else 0,
            })
        return enriched

    elif type == "monthly":
        users = await database.users.find(
            {"monthlyPoints": {"$gt": 0}},
            {"name": 1, "monthlyPoints": 1, "totalPoints": 1, "badges": 1, "role": 1}
        ).sort("monthlyPoints", -1).limit(10).to_list(10)
        return [
            {
                "userId":        str(u["_id"]),
                "name":          u.get("name", ""),
                "monthlyPoints": u.get("monthlyPoints", 0),
                "totalPoints":   u.get("totalPoints", 0),
                "badges":        u.get("badges", []),
                "role":          u.get("role", ""),
            }
            for u in users
        ]

    else:  # NGOs
        results = await database.claims.aggregate([
            {"$match": {"status": {"$in": ["picked_up", "delivered"]}, "ngoUserId": {"$exists": True, "$ne": None}}},
            {"$lookup": {"from": "listings", "localField": "listingId", "foreignField": "_id", "as": "listing"}},
            {"$unwind": "$listing"},
            {"$group": {"_id": "$ngoUserId", "name": {"$first": "$ngoName"}, "kg": {"$sum": "$listing.quantity"}, "claims": {"$sum": 1}}},
            {"$sort": {"kg": -1}}, {"$limit": 10},
        ]).to_list(10)
        return [{"userId": str(r["_id"]), "name": r.get("name", ""), "kg": round(r["kg"], 1), "claims": r["claims"]} for r in results]


@app.post("/api/leaderboard/reset-monthly")
async def reset_monthly_points(current_user=Depends(get_current_user), database=Depends(get_db)):
    """Admin-only: reset monthly points. Protected against double-reset within same month."""
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    # FIX: prevent double-reset in same calendar month
    first_of_month = datetime.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    sample = await database.users.find_one({"monthlyResetAt": {"$gte": first_of_month}})
    if sample:
        raise HTTPException(status_code=409, detail="Monthly points have already been reset this month.")
    await database.users.update_many(
        {},
        {
            "$set": {"monthlyPoints": 0, "monthlyResetAt": datetime.utcnow()},
            "$pull": {"badges": {"id": "top_volunteer_month"}},  # clear monthly badge too
        },
    )
    return {"ok": True, "message": "Monthly points and top-volunteer badges reset"}


# ─── ANALYTICS ─────────────────────────────────────────────────────────────
@app.get("/api/analytics/city")
async def city_analytics(current_user=Depends(get_current_user), database=Depends(get_db)):
    now         = datetime.utcnow()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    kg_result   = await database.listings.aggregate([
        {"$match": {"status": {"$in": ["claimed", "delivered", "picked_up", "completed"]}}},
        {"$group": {"_id": None, "total": {"$sum": "$quantity"}, "servings": {"$sum": "$servings"}}},
    ]).to_list(1)
    total_kg       = kg_result[0]["total"]    if kg_result else 0
    total_servings = kg_result[0]["servings"] if kg_result else 0
    monthly_result = await database.listings.aggregate([
        {"$match": {"status": {"$in": ["claimed", "delivered"]}, "createdAt": {"$gte": month_start}}},
        {"$group": {"_id": None, "kg": {"$sum": "$quantity"}}},
    ]).to_list(1)
    monthly_kg      = monthly_result[0]["kg"] if monthly_result else 0
    total_users     = await database.users.count_documents({})
    active_listings = await database.listings.count_documents({"status": "active"})
    return {
        "totalKgSaved":   round(total_kg, 1),
        "totalMeals":     total_servings,
        "activeListings": active_listings,
        "monthlyKg":      round(monthly_kg, 1),
        "co2Offset":      round(total_kg * 2.5, 1),
        "waterSaved":     round(total_kg * 1000, 0),
        "totalUsers":     total_users,
    }


@app.get("/api/analytics/restaurant/{location_id}")
async def restaurant_analytics(location_id: str, current_user=Depends(get_current_user), database=Depends(get_db)):
    now         = datetime.utcnow()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_kg    = await database.listings.aggregate([
        {"$match": {"locationId": oid(location_id), "createdAt": {"$gte": today_start}}},
        {"$group": {"_id": None, "kg": {"$sum": "$quantity"}}},
    ]).to_list(1)
    total = await database.listings.aggregate([
        {"$match": {"locationId": oid(location_id), "status": {"$in": ["claimed", "delivered", "completed"]}}},
        {"$group": {"_id": None, "kg": {"$sum": "$quantity"}, "meals": {"$sum": "$servings"}}},
    ]).to_list(1)
    return {
        "todayKg":         round(today_kg[0]["kg"] if today_kg else 0, 1),
        "totalKg":         round(total[0]["kg"]     if total    else 0, 1),
        "totalMeals":      total[0]["meals"]         if total    else 0,
        "activeListings":  await database.listings.count_documents({"locationId": oid(location_id), "status": "active"}),
        "claimedListings": await database.listings.count_documents({"locationId": oid(location_id), "status": {"$in": ["claimed", "delivered", "completed"]}}),
        "co2Offset":       round((total[0]["kg"] if total else 0) * 2.5, 1),
    }


@app.get("/api/analytics/volunteer/{user_id}")
async def volunteer_analytics(user_id: str, current_user=Depends(get_current_user), database=Depends(get_db)):
    result = await database.claims.aggregate([
        {"$match": {"claimantUserId": oid(user_id), "status": "delivered"}},
        {"$lookup": {"from": "listings", "localField": "listingId", "foreignField": "_id", "as": "listing"}},
        {"$unwind": "$listing"},
        {"$group": {"_id": None, "totalKg": {"$sum": "$listing.quantity"}, "totalDeliveries": {"$sum": 1}, "totalMeals": {"$sum": "$listing.servings"}}},
    ]).to_list(1)
    stats = result[0] if result else {"totalKg": 0, "totalDeliveries": 0, "totalMeals": 0}
    stats.pop("_id", None)
    stats["activeClaims"]  = await database.claims.count_documents({"claimantUserId": oid(user_id), "status": {"$in": ["confirmed", "picked_up"]}})
    user                   = await database.users.find_one({"_id": oid(user_id)}, {"monthlyPoints": 1, "totalPoints": 1, "badges": 1})
    stats["monthlyPoints"] = user.get("monthlyPoints", 0) if user else 0
    stats["totalPoints"]   = user.get("totalPoints", 0)   if user else 0
    stats["badges"]        = user.get("badges", [])        if user else []
    return stats


# ─── NOTIFICATIONS ─────────────────────────────────────────────────────────
@app.get("/api/notifications")
async def get_notifications(
    unread_only: bool = False,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    query = {
        "userId": oid(current_user["_id"]),
        "$or": [{"deleted": {"$exists": False}}, {"deleted": False}],
    }
    if unread_only:
        query["read"] = False
    notifs = await database.notifications.find(query).sort("createdAt", -1).limit(50).to_list(50)
    return [serialize(n) for n in notifs]


@app.put("/api/notifications/read-all")
async def mark_all_read(current_user=Depends(get_current_user), database=Depends(get_db)):
    await database.notifications.update_many({"userId": oid(current_user["_id"])}, {"$set": {"read": True}})
    return {"message": "All notifications marked as read"}


@app.put("/api/notifications/{notif_id}/read")
async def mark_notification_read(notif_id: str, current_user=Depends(get_current_user), database=Depends(get_db)):
    await database.notifications.update_one(
        {"_id": oid(notif_id), "userId": oid(current_user["_id"])},
        {"$set": {"read": True}},
    )
    return {"message": "Marked as read"}


@app.delete("/api/notifications/{notif_id}")
async def delete_notification(notif_id: str, current_user=Depends(get_current_user), database=Depends(get_db)):
    result = await database.notifications.delete_one({"_id": oid(notif_id), "userId": oid(current_user["_id"])})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Notification not found.")
    await sio.emit("notification:deleted", {"notifId": notif_id}, room=f"user:{current_user['_id']}")
    return {"message": "Notification deleted", "notifId": notif_id}


@app.delete("/api/notifications")
async def delete_all_notifications(current_user=Depends(get_current_user), database=Depends(get_db)):
    result = await database.notifications.delete_many({"userId": oid(current_user["_id"])})
    await sio.emit("notification:cleared", {"userId": current_user["_id"]}, room=f"user:{current_user['_id']}")
    return {"message": "All notifications deleted", "count": result.deleted_count}


# ─── REVIEWS ───────────────────────────────────────────────────────────────
@app.post("/api/reviews", status_code=201)
async def create_review(body: ReviewCreate, current_user=Depends(get_current_user), database=Depends(get_db)):
    # FIX: prevent duplicate reviews per claim per reviewer
    existing = await database.reviews.find_one({
        "claimId":    oid(body.claimId),
        "fromUserId": oid(current_user["_id"]),
    })
    if existing:
        raise HTTPException(status_code=409, detail="You have already reviewed this claim.")

    review_doc = {
        "_id":          ObjectId(),
        "claimId":      oid(body.claimId),
        "fromUserId":   oid(current_user["_id"]),
        "targetUserId": oid(body.targetUserId),
        "rating":       max(1, min(5, body.rating)),
        "comment":      body.comment,
        "createdAt":    datetime.utcnow(),
    }
    await database.reviews.insert_one(review_doc)
    result = await database.reviews.aggregate([
        {"$match": {"targetUserId": oid(body.targetUserId)}},
        {"$group": {"_id": None, "avg": {"$avg": "$rating"}, "count": {"$sum": 1}}},
    ]).to_list(1)
    if result:
        await database.users.update_one(
            {"_id": oid(body.targetUserId)},
            {"$set": {"avgRating": round(result[0]["avg"], 1), "reviewCount": result[0]["count"]}},
        )
    return serialize(review_doc)


# ─── USER PROFILE ──────────────────────────────────────────────────────────
@app.get("/api/users/{user_id}/public")
async def get_public_profile(user_id: str, current_user=Depends(get_current_user), database=Depends(get_db)):
    user = await database.users.find_one({"_id": oid(user_id)})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    donated_result = await database.listings.aggregate([
        {"$match": {"userId": oid(user_id), "status": {"$in": ["claimed", "delivered", "completed"]}}},
        {"$group": {"_id": None, "kg": {"$sum": "$quantity"}}},
    ]).to_list(1)
    total_donated = donated_result[0]["kg"] if donated_result else 0
    reviews       = await database.reviews.find({"targetUserId": oid(user_id)}).sort("createdAt", -1).limit(10).to_list(10)
    return {
        "_id":                 str(user["_id"]),
        "name":                user["name"],
        "role":                user.get("role", "individual"),
        "online":              user.get("online", False),
        "avgRating":           user.get("avgRating", 0),
        "reviewCount":         user.get("reviewCount", 0),
        "badges":              user.get("badges", []),
        "totalKgDonated":      round(total_donated, 1),
        "orgCode":             user.get("orgCode"),
        "linkedNGO":           user.get("linkedNGO"),
        "liveLocationEnabled": user.get("liveLocationEnabled", False),
        "monthlyPoints":       user.get("monthlyPoints", 0),
        "totalPoints":         user.get("totalPoints", 0),
        "locations":           [serialize(l) for l in user.get("locations", [])],
        "reviews":             [serialize(r) for r in reviews],
    }


@app.put("/api/users/me")
async def update_profile(body: dict, current_user=Depends(get_current_user), database=Depends(get_db)):
    allowed = {k: v for k, v in body.items() if k in ["name", "phone", "language", "fcmToken"]}
    await database.users.update_one({"_id": oid(current_user["_id"])}, {"$set": allowed})
    updated = await database.users.find_one({"_id": oid(current_user["_id"])})
    updated.pop("passwordHash", None)
    return serialize(updated)


@app.put("/api/users/me/alerts")
async def update_alert_settings(body: AlertSettings, current_user=Depends(get_current_user), database=Depends(get_db)):
    await database.users.update_one({"_id": oid(current_user["_id"])}, {"$set": {"alertSettings": body.dict()}})
    return {"message": "Alert settings updated"}


# ─── SEARCH ────────────────────────────────────────────────────────────────
@app.get("/api/search")
async def search(
    q: str,
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    results  = {"listings": [], "organizations": []}
    listings = await database.listings.find({
        "status":    "active",
        "expiresAt": {"$gt": datetime.utcnow()},
        "$or": [
            {"foodName":       {"$regex": q, "$options": "i"}},
            {"restaurantName": {"$regex": q, "$options": "i"}},
            {"category":       {"$regex": q, "$options": "i"}},
            {"description":    {"$regex": q, "$options": "i"}},
        ],
    }).limit(20).to_list(20)
    results["listings"] = [serialize(l) for l in listings]
    users = await database.users.find({
        "locations": {"$elemMatch": {"$or": [
            {"name":    {"$regex": q, "$options": "i"}},
            {"address": {"$regex": q, "$options": "i"}},
        ]}}
    }).limit(10).to_list(10)
    for user in users:
        for loc in user.get("locations", []):
            if q.lower() in loc.get("name", "").lower() or q.lower() in loc.get("address", "").lower():
                results["organizations"].append({
                    "userId":       str(user["_id"]),
                    "userName":     user["name"],
                    "locationName": loc.get("name", ""),
                    "locationType": loc.get("type", ""),
                    "address":      loc.get("address", ""),
                    "coordinates":  loc.get("location", {}).get("coordinates", []),
                    "verified":     loc.get("verified", False),
                })
    return results

@app.post("/api/search/ai")
async def ai_search(
    body: AISearchRequest,
    current_user=Depends(get_current_user),
    database=Depends(get_db),
):
    """'veg food near me expiring soon' → structured filters via Groq → Mongo query."""
    q = body.query.strip()
    if not q:
        raise HTTPException(status_code=400, detail="Query is required")

    filters, used_ai = None, False
    if GROQ_API_KEY:
        try:
            system = (
                "You convert food-search requests into JSON filters for a food donation platform. "
                "Respond in English with JSON only."
            )
            msg = (
                f'Request: "{q}"\n'
                'Return JSON: {"keywords": [food words only], '
                '"category": "meals|bakery|produce|dairy|snacks|beverages|grains|null", '
                '"isVeg": true|false|null, "urgentOnly": true|false, '
                '"minQuantityKg": number|null, "maxDistanceKm": number|null, '
                '"sortBy": "distance|expiry|quantity"}'
            )
            filters = _safe_json_parse(await call_groq(system, msg, max_tokens=250, json_mode=True))
            used_ai = filters is not None
        except Exception as e:
            print(f"AI search parse error: {e}")
    if not filters:
        filters = {"keywords": [w for w in q.split() if len(w) > 2], "sortBy": "distance"}

    user_full = await database.users.find_one({"_id": oid(current_user["_id"])})
    v_lat, v_lng, _ = get_effective_location(user_full)
    live_enabled = user_full.get("liveLocationEnabled", False)
    if body.lat is not None and body.lng is not None:
        v_lat, v_lng = body.lat, body.lng

    mongo_q: dict = {
        "status": "active",
        "expiresAt": {"$gt": datetime.utcnow()},
        "userId": {"$ne": oid(current_user["_id"])},
    }
    valid_cats = {"meals", "bakery", "produce", "dairy", "snacks", "beverages", "grains"}
    if filters.get("category") in valid_cats:
        mongo_q["category"] = filters["category"]
    if isinstance(filters.get("isVeg"), bool):
        mongo_q["isVeg"] = filters["isVeg"]
    if filters.get("urgentOnly") is True:
        mongo_q["isUrgent"] = True
    if isinstance(filters.get("minQuantityKg"), (int, float)):
        mongo_q["quantity"] = {"$gte": float(filters["minQuantityKg"])}
    kws = [k for k in (filters.get("keywords") or []) if isinstance(k, str) and k.strip()][:6]
    if kws:
        mongo_q["$or"] = [
            {f: {"$regex": re.escape(k), "$options": "i"}}
            for k in kws for f in ("foodName", "description", "category", "restaurantName")
        ]
    if v_lat is not None and v_lng is not None:
        km = filters.get("maxDistanceKm")
        km = min(max(float(km), 1), 50) if isinstance(km, (int, float)) else 15
        mongo_q["location"] = {"$near": {
            "$geometry": {"type": "Point", "coordinates": [v_lng, v_lat]},
            "$maxDistance": km * 1000,
        }}

    listings = await database.listings.find(mongo_q).limit(30).to_list(30)
    if filters.get("sortBy") == "expiry":
        listings.sort(key=lambda x: x.get("expiresAt", datetime.max))
    elif filters.get("sortBy") == "quantity":
        listings.sort(key=lambda x: x.get("quantity", 0), reverse=True)

    results = []
    for l in listings:
        s = serialize(l)
        c = l.get("location", {}).get("coordinates", [])
        s.update(get_distance_response(v_lat, v_lng, live_enabled, c[1], c[0])
                 if len(c) == 2 else {"distanceKm": None, "distanceStatus": "unavailable"})
        results.append(s)
    return {"query": q, "interpreted": filters, "usedAI": used_ai, "count": len(results), "results": results}
# ─── ADMIN ROUTES ──────────────────────────────────────────────────────────
@app.get("/api/admin/users")
async def admin_get_users(current_user=Depends(get_current_user), database=Depends(get_db)):
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    users = await database.users.find({}).sort("createdAt", -1).limit(100).to_list(100)
    return [serialize({**u, "passwordHash": None}) for u in users]


@app.get("/api/admin/stats")
async def admin_stats(current_user=Depends(get_current_user), database=Depends(get_db)):
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    total_users     = await database.users.count_documents({})
    total_listings  = await database.listings.count_documents({})
    active_listings = await database.listings.count_documents({"status": "active"})
    total_claims    = await database.claims.count_documents({})
    delivered       = await database.claims.count_documents({"status": "delivered"})
    flagged         = await database.listings.count_documents({"aiFlagged": True})
    kg_result       = await database.listings.aggregate([
        {"$match": {"status": {"$in": ["claimed", "delivered", "completed"]}}},
        {"$group": {"_id": None, "kg": {"$sum": "$quantity"}}},
    ]).to_list(1)
    total_kg = round(kg_result[0]["kg"] if kg_result else 0, 1)
    role_counts = {}
    for role in ROLE_FEATURES:
        role_counts[role] = await database.users.count_documents({"role": role})
    return {
        "totalUsers":      total_users,
        "roleBreakdown":   role_counts,
        "totalListings":   total_listings,
        "activeListings":  active_listings,
        "totalClaims":     total_claims,
        "deliveredClaims": delivered,
        "flaggedListings": flagged,
        "totalKgRescued":  total_kg,
        "co2OffsetKg":     round(total_kg * 2.5, 1),
    }


@app.get("/api/admin/flagged-listings")
async def get_flagged_listings(current_user=Depends(get_current_user), database=Depends(get_db)):
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    listings = await database.listings.find({"aiFlagged": True}).to_list(50)
    return [serialize(l) for l in listings]


@app.put("/api/admin/listings/{listing_id}/approve")
async def approve_flagged_listing(listing_id: str, current_user=Depends(get_current_user), database=Depends(get_db)):
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    listing = await database.listings.find_one({"_id": oid(listing_id)})
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    await database.listings.update_one(
        {"_id": oid(listing_id)},
        {"$set": {"aiFlagged": False, "status": "active", "flagReason": "", "approvedBy": current_user["_id"]}},
    )
    updated = await database.listings.find_one({"_id": oid(listing_id)})
    await sio.emit("listing:new", serialize(updated))
    # FIX: notify donor that their listing was approved
    notif = {
        "_id":       ObjectId(),
        "userId":    listing["userId"],
        "type":      "listing:approved",
        "title":     "✅ Your food listing has been approved",
        "body":      f"{listing.get('foodName')} was reviewed by our team and is now live.",
        "data":      {"listingId": listing_id},
        "read":      False,
        "deleted":   False,
        "createdAt": datetime.utcnow(),
    }
    await database.notifications.insert_one(notif)
    await sio.emit("notification:new", serialize(notif), room=f"user:{str(listing['userId'])}")
    return {"message": "Listing approved and donor notified"}


@app.put("/api/admin/listings/{listing_id}/reject")
async def reject_flagged_listing(listing_id: str, body: dict, current_user=Depends(get_current_user), database=Depends(get_db)):
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    reason  = body.get("reason", "Does not meet safety standards")
    listing = await database.listings.find_one({"_id": oid(listing_id)})
    if not listing:
        raise HTTPException(status_code=404, detail="Listing not found")
    await database.listings.update_one(
        {"_id": oid(listing_id)},
        {"$set": {"status": "rejected", "rejectedBy": current_user["_id"], "rejectionReason": reason}},
    )
    notif = {
        "_id":       ObjectId(),
        "userId":    listing["userId"],
        "type":      "listing:rejected",
        "title":     "❌ Your food listing was rejected",
        "body":      f"{listing.get('foodName')} was removed: {reason}",
        "data":      {"listingId": listing_id, "reason": reason},
        "read":      False,
        "deleted":   False,
        "createdAt": datetime.utcnow(),
    }
    await database.notifications.insert_one(notif)
    await sio.emit("notification:new", serialize(notif), room=f"user:{str(listing['userId'])}")
    return {"message": "Listing rejected and donor notified"}


@app.put("/api/admin/users/{user_id}/verify")
async def verify_user_location(user_id: str, current_user=Depends(get_current_user), database=Depends(get_db)):
    """Admin verifies a restaurant/NGO location."""
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    await database.users.update_one(
        {"_id": oid(user_id)},
        {"$set": {"locations.$[].verified": True}},
    )
    return {"message": "User location(s) verified"}


# ─── HEALTH CHECK ──────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "status":                    "ok",
        "version":                   "7.0.0",
        "timestamp":                 datetime.utcnow().isoformat(),
        "role_system":               "enabled",
        "roles":                     list(ROLE_FEATURES.keys()),
        "ai_provider":               "groq",
        "primary_model":             GROQ_MODELS[0],
        "fallback_models":           GROQ_MODELS[1:],
        "vision_model":              GROQ_VISION_MODELS[0],
        "vision_fallback":           GROQ_VISION_MODELS[1:],
        "ai_configured":             bool(GROQ_API_KEY),
        "mapbox_configured":         bool(MAPBOX_TOKEN),
        "live_location_threshold_km": LIVE_LOC_MOVED_THRESHOLD_KM,
        "cold_chain_interval_sec":   COLD_CHAIN_INTERVAL,
        "cold_chain_limits":         COLD_CHAIN_LIMITS,
        "fixed_location_types":      list(FIXED_LOCATION_TYPES),
        "mobile_location_types":     list(MOBILE_LOCATION_TYPES),
        "features": [
            "model_fallback_chain",
            "multi_turn_ai_chat",
            "english_only_ai",
            "natural_language_listings",
            "volunteer_shift_scheduling",
            "cold_chain_tracking",
            "monthly_leaderboard_points",
            "token_refresh",
            "change_password",
            "delete_listing",
            "reject_listing",
            "admin_stats",
            "donor_points",
            "duplicate_review_prevention",
            "safe_json_parsing",
            "ai_chat_history",
            "qr_scan_pickup",
            "ai_nl_search",
        ],
    }


@app.get("/api/roles/features")
async def get_my_features(current_user=Depends(get_current_user)):
    role = current_user.get("role", "individual")
    return {
        "role":                role,
        "features":            get_role_features(role),
        "orgCode":             current_user.get("orgCode"),
        "linkedNGO":           current_user.get("linkedNGO"),
        "liveLocationEnabled": current_user.get("liveLocationEnabled", False),
    }


# ─── Run ───────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run(
        "main:socket_app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )