import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { io } from "socket.io-client";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { Html5Qrcode } from "html5-qrcode";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";
mapboxgl.accessToken = MAPBOX_TOKEN;

const api = async (path, options = {}) => {
  const token = localStorage.getItem("fs_token");
  const res = await fetch(`${API}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || data.message || "Request failed");
  return data;
};

const Icon = ({ name, size = 16, className = "" }) => (
  <i className={`ti ti-${name} ${className}`} style={{ fontSize: size }} aria-hidden="true" />
);

// ── Design Tokens ──────────────────────────────────────────────────────────
const T = {
  bg: "#F7F5F2",
  bgCard: "#FFFFFF",
  bgMuted: "#F2EFE9",
  bgNav: "rgba(255,255,255,0.97)",
  primary: "#E8622A",
  primaryLight: "#FEF0E9",
  primaryDark: "#C44D18",
  primaryGrad: "linear-gradient(135deg,#E8622A,#C44D18)",
  accent: "#1B7A6E",
  accentLight: "#E3F4F2",
  accentDark: "#155F56",
  accentGrad: "linear-gradient(135deg,#1B7A6E,#155F56)",
  amber: "#D97706",
  amberLight: "#FEF3C7",
  info: "#3B6CB7",
  infoLight: "#EBF1FB",
  text: "#1C1917",
  textMuted: "#6B6560",
  textLight: "#A8A29E",
  border: "#E5E1DC",
  borderLight: "#F0ECE7",
  danger: "#DC2626",
  dangerLight: "#FEE2E2",
  success: "#059669",
  successLight: "#D1FAE5",
  warn: "#D97706",
  warnLight: "#FEF3C7",
  aiGrad: "linear-gradient(135deg,#4F46E5,#7C3AED)",
  aiLight: "#EEF2FF",
  aiDark: "#3730A3",
  pinUrgent: "#DC2626",
  pinExpiring: "#D97706",
  pinAvail: "#1B7A6E",
  pinOwn: "#9CA3AF",
  shadow: "0 2px 12px rgba(28,25,23,0.08)",
  shadowMd: "0 6px 24px rgba(28,25,23,0.12)",
  shadowLg: "0 16px 48px rgba(28,25,23,0.16)",
};

const PIN_COLORS = {
  restaurant: "#3B6CB7", hotel: "#3B6CB7", ngo: "#1B7A6E",
  orphanage: "#7C3AED", individual: "#D97706", volunteer: "#E8622A",
};

const TYPE_LABELS = {
  restaurant: "Restaurant", hotel: "Hotel",
  ngo: "NGO / Charity", orphanage: "Orphanage / Shelter",
  individual: "Individual", volunteer: "Volunteer",
};

const TYPE_ICONS = { restaurant: "🍽", hotel: "🏨", individual: "👤", ngo: "🏛", orphanage: "🏠", volunteer: "🚴" };

const TYPE_NAME_PLACEHOLDER = {
  restaurant: "Restaurant name (e.g. Spice Garden)",
  hotel: "Hotel name (e.g. Grand Hyatt)",
  ngo: "NGO name (e.g. Hunger Relief Foundation)",
  orphanage: "Shelter/orphanage name",
  individual: "Your full name",
  volunteer: "Your name / alias",
};

const TYPE_NAME_LABEL = {
  restaurant: "Restaurant name",
  hotel: "Hotel name",
  ngo: "Organisation name",
  orphanage: "Shelter / orphanage name",
  individual: "Your name",
  volunteer: "Your name / alias",
};

const FIXED_LOCATION_TYPES = new Set(["restaurant", "hotel", "ngo", "orphanage"]);
const MOBILE_LOCATION_TYPES = new Set(["volunteer", "individual"]);
const LIVE_LOC_MOVED_THRESHOLD_KM = 0.2;

const getMapStyle = () => {
  const hour = new Date().getHours();
  return (hour < 6 || hour >= 19)
    ? "mapbox://styles/mapbox/navigation-night-v1"
    : "mapbox://styles/mapbox/light-v11";
};

// ── Brand Logo SVG ─────────────────────────────────────────────────────────
const BrandIcon = ({ size = 32 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="32" height="32" rx="9" fill="url(#brandGrad)" />
    <defs>
      <linearGradient id="brandGrad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
        <stop stopColor="#E8622A" />
        <stop offset="1" stopColor="#C44D18" />
      </linearGradient>
    </defs>
    <line x1="10" y1="7" x2="10" y2="13" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
    <line x1="13" y1="7" x2="13" y2="13" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
    <path d="M10 13 Q11.5 15 11.5 17 L11.5 25" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
    <path d="M18 10 L22 10 L22 16" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M22 10 L17 16" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
  </svg>
);

// ── AI Spark Icon (replaces robot emoji) ──────────────────────────────────
const AISparkIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="32" height="32" rx="9" fill="url(#aiGrad)" />
    <defs>
      <linearGradient id="aiGrad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
        <stop stopColor="#E8622A" />
        <stop offset="1" stopColor="#C44D18" />
      </linearGradient>
    </defs>
    <line x1="10" y1="7" x2="10" y2="13" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
    <line x1="13" y1="7" x2="13" y2="13" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
    <path d="M10 13 Q11.5 15 11.5 17 L11.5 25" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
    <path d="M18 10 L22 10 L22 16" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M22 10 L17 16" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
  </svg>
);

// ── Global Styles ──────────────────────────────────────────────────────────
const GlobalStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=Lora:ital,wght@0,600;1,400&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Plus Jakarta Sans', sans-serif; background: ${T.bg}; color: ${T.text}; }
    button { font-family: 'Plus Jakarta Sans', sans-serif; cursor: pointer; }
    input, select, textarea { font-family: 'Plus Jakarta Sans', sans-serif; }
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 4px; }
    .mapboxgl-popup-content { border-radius: 16px !important; padding: 0 !important; border: 1px solid ${T.border} !important; box-shadow: ${T.shadowMd} !important; overflow: hidden; }
    .mapboxgl-popup-tip { display: none !important; }
    .mapboxgl-ctrl-bottom-right { bottom: 40px !important; }
    .mapboxgl-ctrl-attrib, .mapboxgl-ctrl-attrib-inner, .mapboxgl-ctrl-logo { display: none !important; }
    .mapboxgl-ctrl-bottom-left { display: none !important; }
    @keyframes pulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.18);opacity:0.82} }
    @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
    @keyframes slideUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
    @keyframes notifPop { 0%{opacity:0;transform:translateY(-12px) scale(0.96)} 100%{opacity:1;transform:translateY(0) scale(1)} }
    @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
    @keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
    @keyframes typingDot { 0%,80%,100%{transform:scale(0.6);opacity:0.4} 40%{transform:scale(1);opacity:1} }
    .fade-in { animation: fadeIn 0.22s ease; }
    .slide-up { animation: slideUp 0.28s ease; }
    .notif-pop { animation: notifPop 0.3s ease; }
    .spin { animation: spin 0.9s linear infinite; }
    .urgent-pulse { animation: pulse 1.6s ease-in-out infinite; }
    .btn-primary { background: ${T.primaryGrad}; color:#fff; border:none; border-radius:10px; padding:9px 18px; font-size:13px; font-weight:700; cursor:pointer; transition:opacity 0.14s,transform 0.1s; letter-spacing:0.1px; }
    .btn-primary:hover { opacity:0.9; transform:translateY(-1px); }
    .btn-primary:disabled { opacity:0.5; cursor:not-allowed; transform:none; }
    .btn-secondary { background:#fff; color:${T.textMuted}; border:1.5px solid ${T.border}; border-radius:10px; padding:9px 16px; font-size:13px; font-weight:500; cursor:pointer; transition:background 0.12s,border-color 0.12s; }
    .btn-secondary:hover { background:${T.bgMuted}; border-color:${T.textLight}; }
    .btn-done { background:${T.accentGrad}; color:#fff; border:none; border-radius:10px; padding:9px 16px; font-size:13px; font-weight:700; cursor:pointer; transition:opacity 0.14s; }
    .btn-done:hover { opacity:0.88; }
    .btn-ai { background:${T.aiGrad}; color:#fff; border:none; border-radius:10px; padding:9px 16px; font-size:13px; font-weight:700; cursor:pointer; transition:opacity 0.14s; }
    .btn-ai:hover { opacity:0.88; }
    .btn-ai:disabled { opacity:0.5; cursor:not-allowed; }
    .btn-volunteer { background:${T.primaryGrad}; color:#fff; border:none; border-radius:10px; padding:9px 16px; font-size:13px; font-weight:700; cursor:pointer; transition:opacity 0.14s; }
    .btn-volunteer:hover { opacity:0.88; }
    .btn-volunteer:disabled { opacity:0.5; cursor:not-allowed; }
    .btn-danger { background:${T.danger}; color:#fff; border:none; border-radius:10px; padding:9px 16px; font-size:13px; font-weight:700; cursor:pointer; transition:opacity 0.14s; }
    .btn-danger:hover { opacity:0.88; }
    .card { background:${T.bgCard}; border-radius:14px; border:1.5px solid ${T.border}; }
    input:focus, select:focus, textarea:focus { outline:2px solid ${T.primary}; outline-offset:-1px; }
    .fs-marker { cursor: pointer; filter: drop-shadow(0 3px 6px rgba(0,0,0,0.22)); transition: transform 0.15s; }
    .fs-marker:hover { transform: scale(1.12) translateY(-2px); }
    .fs-marker.urgent { animation: pulse 1.6s ease-in-out infinite; }
    .fs-marker.faded { opacity: 0.45; }
    .fs-org-marker { cursor: pointer; filter: drop-shadow(0 2px 5px rgba(0,0,0,0.18)); transition: transform 0.15s; }
    .fs-org-marker:hover { transform: scale(1.15) translateY(-2px); }
    @keyframes liveGlow { 0%,100%{box-shadow:0 0 0 0 rgba(27,122,110,0.4)} 50%{box-shadow:0 0 0 6px rgba(27,122,110,0)} }
    .live-active { animation: liveGlow 2s ease-in-out infinite; }
    .ai-chat-bubble-user { background: ${T.aiGrad}; color: #fff; border-radius: 18px 18px 4px 18px; }
    .ai-chat-bubble-ai { background: ${T.bgCard}; color: ${T.text}; border-radius: 18px 18px 18px 4px; border: 1.5px solid ${T.border}; }
    .typing-dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:${T.textLight}; animation: typingDot 1.4s infinite ease-in-out; }
    .typing-dot:nth-child(1){animation-delay:0s}
    .typing-dot:nth-child(2){animation-delay:0.2s}
    .typing-dot:nth-child(3){animation-delay:0.4s}
    .ai-sidebar-item { display:flex; align-items:center; gap:9px; padding:9px 10px; border-radius:10px; border:none; background:transparent; color:${T.textMuted}; font-size:13px; font-weight:500; text-align:left; cursor:pointer; width:100%; transition:background 0.12s,color 0.12s; }
    .ai-sidebar-item:hover { background:${T.aiLight}; color:${T.aiDark}; }
    .ai-sidebar-item.active { background:${T.aiLight}; color:${T.aiDark}; font-weight:700; }
  `}</style>
);

function buildPinSVG({ color, emoji, label, labelBg, urgent, faded, isOwn }) {
  const labelW = Math.min(Math.max(label.length * 7 + 20, 52), 110);
  const svgW = Math.max(40, labelW + 4);
  const cx = svgW / 2;
  const pinH = 46;
  const pinW = 36;
  const pinX = cx - pinW / 2;
  const tipY = pinH;
  const labelY = pinH + 6;
  const labelH = 18;
  const labelX = cx - labelW / 2;
  const totalH = labelY + labelH + 4;
  const urgentAttr = urgent ? ' class="fs-marker urgent"' : (faded ? ' class="fs-marker faded"' : ' class="fs-marker"');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${totalH}" viewBox="0 0 ${svgW} ${totalH}"${urgentAttr}>
    <defs><filter id="ps" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.25)"/></filter></defs>
    <path d="M${cx} ${tipY} Q${pinX - 2} ${pinH - 14} ${pinX} ${pinH - 28} A${pinW / 2} ${pinW / 2} 0 1 1 ${pinX + pinW} ${pinH - 28} Q${cx + pinW / 2 + 2} ${pinH - 14} ${cx} ${tipY}Z" fill="${color}" filter="url(#ps)"/>
    <circle cx="${cx}" cy="${pinH - 28}" r="10" fill="white" opacity="0.95"/>
    <text x="${cx}" y="${pinH - 23}" text-anchor="middle" font-size="11" font-family="sans-serif">${emoji}</text>
    <rect x="${labelX}" y="${labelY}" width="${labelW}" height="${labelH}" rx="9" fill="${labelBg}" opacity="0.93"/>
    <text x="${cx}" y="${labelY + 12}" text-anchor="middle" font-size="10" font-family="'Plus Jakarta Sans',sans-serif" font-weight="700" fill="white" paint-order="stroke" stroke="rgba(0,0,0,0.15)" stroke-width="2">${label}</text>
  </svg>`;
}

function buildOrgPinSVG({ color, emoji }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="38" viewBox="0 0 32 38" class="fs-org-marker">
    <defs><filter id="ops" x="-30%" y="-20%" width="160%" height="150%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.2)"/></filter></defs>
    <path d="M16 36 Q2 24 2 14 A14 14 0 1 1 30 14 Q30 24 16 36Z" fill="${color}" filter="url(#ops)" opacity="0.88"/>
    <circle cx="16" cy="14" r="7" fill="white" opacity="0.92"/>
    <text x="16" y="18" text-anchor="middle" font-size="9" font-family="sans-serif">${emoji}</text>
  </svg>`;
}

// ── haversine util ─────────────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.asin(Math.sqrt(a)) * 10) / 10;
}

// ── Live Location Hook ─────────────────────────────────────────────────────
function useEffectiveLocation(user) {
  return useMemo(() => {
    const primaryLoc = user?.locations?.[0];
    const profileCoords = primaryLoc?.location?.coordinates;
    const liveEnabled = user?.liveLocationEnabled || false;
    const liveCoords = user?.liveLocation?.coordinates;

    if (!liveEnabled || !liveCoords || liveCoords.length < 2) {
      if (profileCoords && profileCoords.length === 2)
        return { lat: profileCoords[1], lng: profileCoords[0], isLive: false, liveEnabled };
      return { lat: null, lng: null, isLive: false, liveEnabled };
    }
    if (!profileCoords || profileCoords.length < 2)
      return { lat: liveCoords[1], lng: liveCoords[0], isLive: true, liveEnabled };

    const dist = haversineKm(profileCoords[1], profileCoords[0], liveCoords[1], liveCoords[0]);
    if (dist > LIVE_LOC_MOVED_THRESHOLD_KM)
      return { lat: liveCoords[1], lng: liveCoords[0], isLive: true, liveEnabled };
    return { lat: profileCoords[1], lng: profileCoords[0], isLive: false, liveEnabled };
  }, [user?._id, user?.liveLocationEnabled, user?.liveLocation?.coordinates, user?.locations]);
}

// ── Compact Live Location Button ───────────────────────────────────────────
function LiveLocButton({ user, onToggle, toggling }) {
  const liveEnabled = user?.liveLocationEnabled || false;
  return (
    <button
      onClick={onToggle}
      disabled={toggling}
      title={liveEnabled ? "Live location ON — click to disable" : "Live location OFF — click to enable"}
      className={liveEnabled ? "live-active" : ""}
      style={{
        display: "flex", alignItems: "center", gap: 5,
        padding: "5px 12px", borderRadius: 20, border: "none",
        background: liveEnabled ? "linear-gradient(135deg,#1B7A6E,#155F56)" : "#fff",
        color: liveEnabled ? "#fff" : T.textMuted,
        fontSize: 12, fontWeight: 700, cursor: toggling ? "not-allowed" : "pointer",
        boxShadow: T.shadow,
        border: liveEnabled ? "none" : `1.5px solid ${T.border}`,
        transition: "all 0.2s", opacity: toggling ? 0.7 : 1,
      }}
    >
      {toggling
        ? <Icon name="loader-2" size={12} className="spin" />
        : <span style={{ fontSize: 11 }}>{liveEnabled ? "📡" : "📍"}</span>
      }
      {liveEnabled ? "Live ON" : "Live OFF"}
    </button>
  );
}

// ── Toast ──────────────────────────────────────────────────────────────────
function ToastNotification({ notif, onClose, onChat }) {
  useEffect(() => { const t = setTimeout(onClose, 8000); return () => clearTimeout(t); }, []);
  return (
    <div className="notif-pop" style={{ position: "fixed", top: 72, right: 16, zIndex: 9999, width: 340, background: T.bgCard, borderRadius: 16, boxShadow: T.shadowLg, border: `1.5px solid ${T.border}`, overflow: "hidden" }}>
      <div style={{ height: 3, background: notif.urgent ? `linear-gradient(90deg,${T.danger},${T.primary})` : `linear-gradient(90deg,${T.primary},${T.amber})` }} />
      <div style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: notif.urgent ? T.dangerLight : T.primaryLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>{notif.urgent ? "🔴" : "🍽"}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{notif.urgent ? "⚡ Urgent pickup nearby!" : "New food available!"}</div>
            <div style={{ fontSize: 12, color: T.textMuted }}><strong>{notif.foodName}</strong> · {notif.quantity} kg</div>
            <div style={{ fontSize: 11, color: T.textLight }}>{notif.restaurantName}</div>
            {notif.hoursLeft !== undefined && (
              <div style={{ fontSize: 11, color: notif.urgent ? T.danger : T.accent, fontWeight: 700, marginTop: 2 }}>
                ⏰ {notif.hoursLeft < 1 ? `${Math.round(notif.hoursLeft * 60)}m left` : `${notif.hoursLeft.toFixed(1)}h left`}
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, color: T.textLight, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          {onChat && (
            <button onClick={() => { onChat(notif); onClose(); }} className="btn-secondary" style={{ flex: 1, fontSize: 11, padding: "6px 0", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
              <Icon name="message-2" size={12} /> Chat
            </button>
          )}
          <button onClick={onClose} className="btn-primary" style={{ flex: 1, fontSize: 11, padding: "6px 0" }}>View</button>
        </div>
      </div>
    </div>
  );
}

// ── Notification Panel ─────────────────────────────────────────────────────
function NotificationPanel({ notifications, onClose, onMarkAllRead, onDeleteNotif, onDeleteAll, onChat }) {
  return (
    <div className="fade-in" style={{ position: "absolute", top: 48, right: 0, width: 380, maxHeight: 520, overflowY: "auto", background: T.bgCard, border: `1.5px solid ${T.border}`, borderRadius: 16, zIndex: 999, boxShadow: T.shadowLg }}>
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.borderLight}`, display: "flex", justifyContent: "space-between", alignItems: "center", background: T.bgMuted, borderRadius: "16px 16px 0 0" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Notifications</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onMarkAllRead} style={{ fontSize: 11, color: T.primary, background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>Mark all read</button>
          {notifications.length > 0 && (
            <button onClick={onDeleteAll} style={{ fontSize: 11, color: T.danger, background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>Delete all</button>
          )}
        </div>
      </div>
      {notifications.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: T.textLight, fontSize: 13 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🔔</div>No notifications yet
        </div>
      ) : notifications.map((n, i) => (
        <div key={n._id || i} style={{ padding: "12px 16px", borderBottom: `1px solid ${T.borderLight}`, background: n.read ? T.bgCard : T.primaryLight, opacity: n.read ? 0.8 : 1, position: "relative" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <div style={{ fontSize: 18, flexShrink: 0 }}>{n.type === "listing:new" ? "🍽" : n.type === "claim:new" ? "✅" : n.type === "volunteer:joined" ? "🚴" : "🔔"}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{n.title}</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>{n.body}</div>
              <div style={{ fontSize: 10, color: T.textLight, marginTop: 3 }}>
                {new Date(n.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
            <button onClick={() => onDeleteNotif(n._id)} title="Delete notification"
              style={{ background: "none", border: "none", cursor: "pointer", color: T.textLight, fontSize: 15, padding: "2px 4px", borderRadius: 6, flexShrink: 0 }}
              onMouseEnter={e => e.currentTarget.style.color = T.danger}
              onMouseLeave={e => e.currentTarget.style.color = T.textLight}>×</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── NGO Bio Modal ──────────────────────────────────────────────────────────
function NGOBioModal({ org, onClose, onStartChat, viewerLat, viewerLng, viewerIsLive }) {
  const [checkingDist, setCheckingDist] = useState(false);
  const [overrideDist, setOverrideDist] = useState(null);
  if (!org) return null;

  const isNGO = ["ngo", "orphanage"].includes(org?.locationType);
  const color = isNGO ? T.accent : T.primary;
  const bgColor = isNGO ? T.accentLight : T.primaryLight;

  const displayDist = overrideDist ?? org?.distanceKm;
  const distStatus = overrideDist != null ? "ok" : (org?.distanceStatus || (displayDist != null ? "ok" : "unavailable"));

  const checkFromLive = () => {
    setCheckingDist(true);
    navigator.geolocation?.getCurrentPosition(pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      const targetCoords = org.coordinates;
      if (targetCoords?.length === 2) {
        setOverrideDist(haversineKm(lat, lng, targetCoords[1], targetCoords[0]));
      }
      setCheckingDist(false);
    }, () => setCheckingDist(false));
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(28,25,23,0.5)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div className="fade-in" onClick={e => e.stopPropagation()}
        style={{ background: T.bgCard, borderRadius: 20, width: 420, maxHeight: "90vh", overflowY: "auto", boxShadow: T.shadowLg }}>
        <div style={{ background: bgColor, padding: "24px 24px 20px", borderRadius: "20px 20px 0 0", position: "relative" }}>
          <button onClick={onClose} style={{ position: "absolute", top: 14, right: 14, background: "rgba(255,255,255,0.8)", border: "none", borderRadius: "50%", width: 30, height: 30, fontSize: 18, cursor: "pointer" }}>×</button>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, boxShadow: T.shadow }}>
              {TYPE_ICONS[org.locationType] || "📍"}
            </div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700 }}>{org.locationName || org.name}</div>
              <div style={{ fontSize: 12, color, fontWeight: 600, marginTop: 3 }}>{TYPE_LABELS[org.locationType] || org.locationType}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 4 }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: org.online ? T.success : T.border }} />
                <span style={{ fontSize: 11, color: org.online ? T.success : T.textLight, fontWeight: 600 }}>{org.online ? "Online now" : "Offline"}</span>
              </div>
            </div>
          </div>
        </div>
        <div style={{ padding: "18px 24px 24px" }}>
          {org.address && (
            <div style={{ display: "flex", gap: 8, marginBottom: 14, padding: "10px 12px", background: T.bgMuted, borderRadius: 10 }}>
              <Icon name="map-pin" size={14} />
              <span style={{ fontSize: 13, color: T.textMuted }}>{org.address}</span>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
            <div style={{ background: T.accentLight, borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: T.accentDark }}>{org.activeListings || 0}</div>
              <div style={{ fontSize: 11, color: T.accent, marginTop: 2 }}>Active listings</div>
            </div>
            <div style={{ background: T.bgMuted, borderRadius: 10, padding: "10px 12px" }}>
              {distStatus === "enable_live_location" ? (
                <div><div style={{ fontSize: 12, color: T.amber, fontWeight: 700 }}>📍 Enable live loc</div><div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>for real distance</div></div>
              ) : (
                <>
                  <div style={{ fontSize: 18, fontWeight: 700, color: T.text }}>{displayDist != null ? `${displayDist} km` : "—"}</div>
                  <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{viewerIsLive || overrideDist != null ? "📡 Live distance" : "Distance away"}</div>
                </>
              )}
            </div>
          </div>
          <button onClick={checkFromLive} disabled={checkingDist}
            style={{ width: "100%", marginBottom: 12, padding: "8px", background: T.bgMuted, border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 12, color: T.textMuted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            {checkingDist ? <Icon name="loader-2" size={12} className="spin" /> : <Icon name="current-location" size={12} />}
            Check distance from my current location
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { onStartChat(org.userId, org.locationName || org.name); onClose(); }}
              className="btn-primary" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <Icon name="message-2" size={14} /> Chat about food
            </button>
            {org.coordinates?.length === 2 && (
              <a href={`https://maps.google.com/maps?q=${org.coordinates[1]},${org.coordinates[0]}`}
                target="_blank" rel="noopener noreferrer" className="btn-secondary"
                style={{ padding: "9px 14px", textDecoration: "none", display: "flex", alignItems: "center", gap: 5 }}>
                <Icon name="brand-google-maps" size={13} /> Navigate
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Navbar ─────────────────────────────────────────────────────────────────
function Navbar({ user, activePage, setActivePage, activeLocation, onSwitchLocation, unreadCount, onLogout, notifications, onMarkAllRead, onDeleteNotif, onDeleteAll, onStartChat, onToggleLiveLoc, togglingLiveLoc }) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const initials = user?.name?.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2) || "?";
  const locType = activeLocation?.type;
  const isRestaurant = ["restaurant", "hotel"].includes(locType);
  const isNGO = ["ngo", "orphanage"].includes(locType);
  const isVolunteer = locType === "volunteer";
  const unreadNotifCount = notifications.filter(n => !n.read).length;
  const features = user?.features || {};

  const navItems = [
    { id: "map", label: "Live map", icon: "map-2" },
    { id: "dashboard", label: "Dashboard", icon: "layout-dashboard" },
    { id: "chat", label: "Messages", icon: "message-2", badge: unreadCount },
    ...(features.can_see_ai_chat || features.can_see_waste_prediction || features.can_see_photo_analysis || features.can_use_route_optimizer
      ? [{ id: "ai", label: "AI Tools", icon: "sparkles" }]
      : []),
    ...(features.can_post ? [{ id: "post", label: "Post food", icon: "plus-circle" }] : []),
    ...(isNGO ? [{ id: "org", label: "Org Dashboard", icon: "building-community" }] : []),
    ...(isVolunteer || (features.can_claim && !isNGO) ? [{ id: "claims", label: "My claims", icon: "clipboard-check" }] : []),
  ];

  const roleColor = isRestaurant ? T.info : isNGO ? T.accent : isVolunteer ? T.primary : T.amber;
  const roleBg = isRestaurant ? T.infoLight : isNGO ? T.accentLight : isVolunteer ? T.primaryLight : T.amberLight;

  return (
    <nav style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 1000, background: T.bgNav, backdropFilter: "blur(16px)", borderBottom: `1px solid ${T.border}`, height: 56, display: "flex", alignItems: "center", padding: "0 20px", justifyContent: "space-between", boxShadow: T.shadow }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => setActivePage("map")}>
        <BrandIcon size={32} />
        <span style={{ fontFamily: "'Lora', serif", fontSize: 20, color: T.text, letterSpacing: "-0.2px" }}>
          Food<span style={{ color: T.primary }}>Save</span>
        </span>
      </div>
      <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
        {navItems.map(item => (
          <button key={item.id} onClick={() => setActivePage(item.id)}
            style={{ position: "relative", display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 9, border: "none", background: activePage === item.id ? (item.id === "ai" ? T.aiLight : T.primaryLight) : "transparent", color: activePage === item.id ? (item.id === "ai" ? T.aiDark : T.primaryDark) : T.textMuted, fontSize: 13, fontWeight: activePage === item.id ? 700 : 500, transition: "all 0.12s" }}>
            <Icon name={item.icon} size={14} />{item.label}
            {item.badge > 0 && (
              <div style={{ position: "absolute", top: 2, right: 4, minWidth: 16, height: 16, borderRadius: 8, background: T.danger, color: "#fff", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, padding: "0 3px" }}>
                {item.badge > 9 ? "9+" : item.badge}
              </div>
            )}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <LiveLocButton user={user} onToggle={onToggleLiveLoc} toggling={togglingLiveLoc} />
        {user?.locations?.length > 1 && (
          <select value={activeLocation?._id || ""} onChange={e => onSwitchLocation(e.target.value)}
            style={{ fontSize: 12, padding: "5px 8px", borderRadius: 9, border: `1px solid ${T.border}`, background: T.bgMuted, color: T.text, maxWidth: 130 }}>
            {user.locations.map(loc => <option key={loc._id} value={loc._id}>{loc.name}</option>)}
          </select>
        )}
        <div style={{ position: "relative" }}>
          <button onClick={() => { setShowNotifPanel(!showNotifPanel); setShowUserMenu(false); }}
            style={{ position: "relative", background: showNotifPanel ? T.primaryLight : "transparent", border: "none", borderRadius: 9, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <Icon name="bell" size={17} />
            {unreadNotifCount > 0 && (
              <div style={{ position: "absolute", top: 2, right: 2, width: 15, height: 15, borderRadius: "50%", background: T.danger, color: "#fff", fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>
                {unreadNotifCount > 9 ? "9+" : unreadNotifCount}
              </div>
            )}
          </button>
          {showNotifPanel && (
            <NotificationPanel
              notifications={notifications}
              onClose={() => setShowNotifPanel(false)}
              onMarkAllRead={() => { onMarkAllRead(); }}
              onDeleteNotif={(id) => { onDeleteNotif(id); }}
              onDeleteAll={() => { onDeleteAll(); setShowNotifPanel(false); }}
              onChat={(data) => { if (data?.userId) onStartChat(data.userId, data.name || data.restaurantName); }}
            />
          )}
        </div>
        <div style={{ fontSize: 11, padding: "4px 10px", borderRadius: 20, background: roleBg, color: roleColor, fontWeight: 700 }}>
          {TYPE_ICONS[locType]} {TYPE_LABELS[locType] || "User"}
        </div>
        <div style={{ position: "relative" }}>
          <div onClick={() => { setShowUserMenu(!showUserMenu); setShowNotifPanel(false); }}
            style={{ width: 36, height: 36, borderRadius: "50%", background: T.primaryGrad, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800, color: "#fff", cursor: "pointer", boxShadow: `0 2px 8px rgba(232,98,42,0.35)` }}>
            {initials}
          </div>
          {showUserMenu && (
            <div className="fade-in" style={{ position: "absolute", top: 44, right: 0, background: T.bgCard, border: `1.5px solid ${T.border}`, borderRadius: 14, minWidth: 190, zIndex: 999, boxShadow: T.shadowMd, overflow: "hidden" }}>
              <div style={{ padding: "12px 14px", borderBottom: `1px solid ${T.borderLight}`, background: T.bgMuted }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{user?.name}</div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{user?.email}</div>
                {user?.role === "ngo_admin" && user?.orgCode && (
                  <div style={{ marginTop: 6, fontSize: 11, background: T.accentLight, color: T.accentDark, padding: "3px 8px", borderRadius: 6, fontWeight: 700, display: "inline-block" }}>
                    Org Code: {user.orgCode}
                  </div>
                )}
              </div>
              {[{ label: "Profile & Locations", icon: "user-circle", page: "profile" }, { label: "Settings", icon: "settings", page: "settings" }].map(item => (
                <button key={item.page} onClick={() => { setActivePage(item.page); setShowUserMenu(false); }}
                  style={{ width: "100%", padding: "10px 14px", background: "transparent", border: "none", display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.text, textAlign: "left", cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background = T.bgMuted}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <Icon name={item.icon} size={14} />{item.label}
                </button>
              ))}
              <button onClick={() => { onLogout(); setShowUserMenu(false); }}
                style={{ width: "100%", padding: "10px 14px", background: "transparent", border: "none", borderTop: `1px solid ${T.borderLight}`, display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.danger, textAlign: "left", cursor: "pointer" }}>
                <Icon name="logout" size={14} />Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}

// ── Map Page ───────────────────────────────────────────────────────────────
function MapPage({ user, activeLocation, socket, setActivePage, onStartChat }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersRef = useRef({});
  const orgMarkersRef = useRef({});
  const [listings, setListings] = useState([]);
  const [sidebarListings, setSidebarListings] = useState([]);
  const [selectedFilter, setSelectedFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showDirections, setShowDirections] = useState(false);
  const [directionsData, setDirectionsData] = useState(null);
  const [loadingDirections, setLoadingDirections] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [showOrgPins, setShowOrgPins] = useState(true);
  const [mapZoom, setMapZoom] = useState(12);
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [claimedListings, setClaimedListings] = useState(new Set());
  const [selectedPin, setSelectedPin] = useState(null);
  const [aiMode, setAiMode] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiInfo, setAiInfo] = useState(null);
  const popupRef = useRef(null);
  const filters = ["all", "meals", "bakery", "produce", "dairy"];

    const effectiveLoc = useEffectiveLocation(user);

  const locType = activeLocation?.type;
  const canClaim = !["restaurant", "hotel"].includes(locType);

  const runAiSearch = async () => {
    if (!searchQuery.trim()) return;
    setAiBusy(true);
    try {
      const res = await api("/api/search/ai", {
        method: "POST",
        body: { query: searchQuery, lat: viewerLat ?? undefined, lng: viewerLng ?? undefined },
      });
      setAiMode(true);
      setAiInfo(res.interpreted);
      setListings(res.results || []);
    } catch (e) { alert(e.message); }
    setAiBusy(false);
  };

  const clearAiSearch = () => {
    setAiMode(false); setAiInfo(null); setSearchQuery("");
    fetchListings();
  };

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;
    mapInstance.current = new mapboxgl.Map({ container: mapRef.current, style: getMapStyle(), center: [78.3896, 17.4401], zoom: 12 });
    mapInstance.current.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-right");
    mapInstance.current.on("zoom", () => { if (mapInstance.current) setMapZoom(mapInstance.current.getZoom()); });
    navigator.geolocation?.getCurrentPosition(pos => {
      const { longitude, latitude } = pos.coords;
      setUserLocation({ lng: longitude, lat: latitude });
      mapInstance.current?.flyTo({ center: [longitude, latitude], zoom: 13 });
      const el = document.createElement("div");
      el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${T.info};border:3px solid #fff;box-shadow:0 0 0 4px rgba(59,108,183,0.25)`;
      new mapboxgl.Marker(el).setLngLat([longitude, latitude]).addTo(mapInstance.current);
    });
    return () => { mapInstance.current?.remove(); mapInstance.current = null; };
  }, []);

  const viewerLat = effectiveLoc.lat || userLocation?.lat;
  const viewerLng = effectiveLoc.lng || userLocation?.lng;

  const fetchListings = useCallback(async () => {
    try {
      const data = await api("/api/map/pins");
      setListings(data.listings || []);
      setSidebarListings(data.listings || []);
      renderOrgPins(data.userPins || []);
    } catch (e) { console.error(e); }
  }, []);

  const renderOrgPins = (pins) => {
    if (!mapInstance.current) return;
    Object.values(orgMarkersRef.current).forEach(m => m.remove());
    orgMarkersRef.current = {};
    pins.forEach(pin => {
      if (!pin.coordinates) return;
      const [lng, lat] = pin.coordinates;
      const el = document.createElement("div");
      el.innerHTML = buildOrgPinSVG({ color: PIN_COLORS[pin.locationType] || "#888", emoji: TYPE_ICONS[pin.locationType] || "📍" });
      el.style.cssText = "cursor:pointer;";
      el.addEventListener("click", e => { e.stopPropagation(); setSelectedOrg(pin); });
      const key = `${lng}_${lat}_${pin.userId}`;
      const marker = new mapboxgl.Marker({ element: el, anchor: "bottom" }).setLngLat([lng, lat]).addTo(mapInstance.current);
      orgMarkersRef.current[key] = marker;
    });
  };

  useEffect(() => { fetchListings(); }, [fetchListings]);

  useEffect(() => {
    Object.values(orgMarkersRef.current).forEach(m => {
      m.getElement().style.display = (showOrgPins && mapZoom >= 11) ? "block" : "none";
    });
  }, [showOrgPins, mapZoom]);

  useEffect(() => {
    if (!socket) return;
    const handleNew = (listing) => setListings(prev => [listing, ...prev.filter(l => l._id !== listing._id)]);
    const handleClaimed = ({ listingId }) => {
      setClaimedListings(prev => new Set([...prev, listingId]));
      setTimeout(() => {
        setListings(prev => prev.filter(l => l._id !== listingId));
        setClaimedListings(prev => { const s = new Set(prev); s.delete(listingId); return s; });
        if (markersRef.current[listingId]) { markersRef.current[listingId].remove(); delete markersRef.current[listingId]; }
      }, 2000);
    };
    socket.on("listing:new", handleNew);
    socket.on("listing:claimed", handleClaimed);
    socket.on("listing:cancelled", ({ listingId }) => handleClaimed({ listingId }));
    return () => { socket.off("listing:new", handleNew); socket.off("listing:claimed", handleClaimed); socket.off("listing:cancelled"); };
  }, [socket]);

  useEffect(() => {
    if (!mapInstance.current) return;
    const filtered = listings.filter(l => {
      if (selectedFilter !== "all" && l.category !== selectedFilter) return false;
      if (searchQuery && !aiMode && !l.foodName?.toLowerCase().includes(searchQuery.toLowerCase())  && !l.restaurantName?.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
    const filteredIds = new Set(filtered.map(l => l._id));
    Object.keys(markersRef.current).forEach(id => {
      if (!filteredIds.has(id)) { markersRef.current[id].remove(); delete markersRef.current[id]; }
    });
    filtered.forEach(listing => {
      if (!listing.location?.coordinates) return;
      const [lng, lat] = listing.location.coordinates;
      const hoursLeft = (new Date(listing.expiresAt) - new Date()) / 3600000;
      const isExpired = hoursLeft <= 0;
      const isOwn = listing.isOwn;
      const isClaimed = claimedListings.has(listing._id) || listing.claimCount > 0;
      const color = isOwn ? T.pinOwn : isClaimed ? "#888" : isExpired ? "#666" : hoursLeft < 2 ? T.pinUrgent : hoursLeft < 5 ? T.pinExpiring : T.pinAvail;
      const emoji = isClaimed ? "🔒" : isExpired ? "⛔" : isOwn ? "📌" : "🍽";
      let label = "", labelBg = color;
      if (isClaimed) { label = "CLAIMED"; labelBg = "#666"; }
      else if (isExpired) { label = "EXPIRED"; labelBg = "#555"; }
      else if (isOwn) { label = "YOURS"; labelBg = T.pinOwn; }
      else if (hoursLeft < 2) { label = `⚡ ${Math.round(hoursLeft * 60)}m`; labelBg = T.pinUrgent; }
      else if (hoursLeft < 5) { label = `${hoursLeft.toFixed(1)}h left`; labelBg = T.pinExpiring; }
      else { label = `${Math.round(hoursLeft)}h left`; labelBg = T.pinAvail; }
      const urgent = !isOwn && !isExpired && !isClaimed && hoursLeft < 2;
      const faded = isExpired || isClaimed;
      if (markersRef.current[listing._id]) {
        markersRef.current[listing._id].getElement().innerHTML = buildPinSVG({ color, emoji, label, labelBg, urgent, faded, isOwn });
        return;
      }
      const el = document.createElement("div");
      el.innerHTML = buildPinSVG({ color, emoji, label, labelBg, urgent, faded, isOwn });
      el.style.cssText = "position:relative;";
      if (!isExpired && !isClaimed) {
        el.addEventListener("click", e => { e.stopPropagation(); setSelectedPin(listing); showPopupOnMap(listing); });
      }
      const marker = new mapboxgl.Marker({ element: el, anchor: "bottom" }).setLngLat([lng, lat]).addTo(mapInstance.current);
      markersRef.current[listing._id] = marker;
    });
    setSidebarListings(filtered);
    }, [listings, selectedFilter, searchQuery, claimedListings, canClaim, aiMode]);

  const showPopupOnMap = (listing) => {
    if (!mapInstance.current || !listing.location?.coordinates) return;
    const [lng, lat] = listing.location.coordinates;
    if (popupRef.current) popupRef.current.remove();
    const container = document.createElement("div");
    container.style.cssText = "min-width:240px;padding:16px;font-family:'Plus Jakarta Sans',sans-serif;";
    const hoursLeft = ((new Date(listing.expiresAt) - new Date()) / 3600000).toFixed(1);
    const isUrgent = hoursLeft < 2;
    const isOwn = listing.isOwn;
    const isClaimed = listing.claimCount > 0;

    let distStr = "";
    if (viewerLat && viewerLng) {
      const d = haversineKm(viewerLat, viewerLng, lat, lng);
      if (d != null) distStr = `${d} km ${effectiveLoc.isLive ? "📡" : "📍"}`;
    }

    let claimStatusHtml = isClaimed
      ? `<div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:#FEE2E2;border-radius:8px;margin-bottom:10px;"><span style="font-size:13px;">🔒</span><span style="font-size:12px;font-weight:700;color:#DC2626;">Already claimed (${listing.claimCount})</span></div>`
      : `<div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:#D1FAE5;border-radius:8px;margin-bottom:10px;"><span style="font-size:13px;">✅</span><span style="font-size:12px;font-weight:700;color:#059669;">Available now!</span></div>`;

    container.innerHTML = `
      <div style="font-size:15px;font-weight:700;color:#1C1917;margin-bottom:2px">${listing.restaurantName || "Listing"}</div>
      <div style="font-size:13px;color:#6B6560;margin-bottom:6px">${listing.foodName} · <strong>${listing.quantity} kg</strong>${distStr ? ` · <span style="color:#3B6CB7;font-size:11px">${distStr}</span>` : ""}</div>
      ${claimStatusHtml}
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:14px">
        ${isOwn ? `<span style="background:#F2EFE9;color:#6B6560;font-size:11px;padding:2px 8px;border-radius:20px;font-weight:600">📌 Your listing</span>`
          : isUrgent ? `<span style="background:#FEE2E2;color:#DC2626;font-size:11px;padding:2px 8px;border-radius:20px;font-weight:700">🔴 ${hoursLeft}h left</span>`
          : `<span style="background:#E3F4F2;color:#155F56;font-size:11px;padding:2px 8px;border-radius:20px;font-weight:600">${hoursLeft}h left</span>`}
        <span style="font-size:12px;color:#A8A29E">~${listing.servings || 0} servings</span>
        ${listing.isVeg ? `<span style="font-size:11px;color:#059669;font-weight:700">🟢 Veg</span>` : ""}
      </div>
      <div style="display:flex;gap:8px">
        ${isOwn
          ? `<div style="flex:1;background:#F2EFE9;color:#6B6560;border:1.5px solid #E5E1DC;border-radius:10px;padding:9px 0;font-size:11px;text-align:center;">Your listing</div>`
          : !canClaim
          ? `<div style="flex:1;background:#FEF0E9;color:#C44D18;border:1.5px solid #E8622A33;border-radius:10px;padding:9px 0;font-size:11px;text-align:center;">Donors cannot claim</div>`
          : isClaimed
          ? `<div style="flex:1;background:#FEE2E2;color:#DC2626;border-radius:10px;padding:9px 0;font-size:11px;text-align:center;font-weight:700">Already Claimed</div>`
          : `<button id="claim-btn-${listing._id}" style="flex:1;background:linear-gradient(135deg,#E8622A,#C44D18);color:#fff;border:none;border-radius:10px;padding:9px 0;font-size:13px;cursor:pointer;font-weight:700;font-family:'Plus Jakarta Sans',sans-serif">Claim now</button>`}
        <button id="dir-btn-${listing._id}" style="flex:1;background:#F2EFE9;color:#1C1917;border:1.5px solid #E5E1DC;border-radius:10px;padding:9px 0;font-size:12px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">📍 Directions</button>
      </div>`;
    popupRef.current = new mapboxgl.Popup({ offset: [0, -10], closeButton: true, maxWidth: "290px" })
      .setLngLat([lng, lat]).setDOMContent(container).addTo(mapInstance.current);
    mapInstance.current.flyTo({ center: [lng, lat], zoom: Math.max(14, mapInstance.current.getZoom()) });
    setTimeout(() => {
      if (!isOwn && canClaim && !isClaimed) {
        document.getElementById(`claim-btn-${listing._id}`)?.addEventListener("click", () => handleClaim(listing));
      }
      document.getElementById(`dir-btn-${listing._id}`)?.addEventListener("click", () => getDirections(listing));
    }, 100);
  };

  const handleClaim = async (listing) => {
    if (listing.isOwn) { alert("You cannot claim your own listing."); return; }
    if (!canClaim) { alert("Restaurant/hotel accounts cannot claim food."); return; }
    try {
      await api("/api/claims", { method: "POST", body: { listingId: listing._id } });
      if (popupRef.current) popupRef.current.remove();
      setListings(prev => prev.map(l => l._id === listing._id ? { ...l, claimCount: (l.claimCount || 0) + 1 } : l));
      alert("✅ Claimed! Check 'My claims' for QR pickup code.");
    } catch (e) { alert(e.message); }
  };

  const getDirections = async (listing) => {
    if (!listing.location?.coordinates) return;
    setLoadingDirections(true);
    const [toLng, toLat] = listing.location.coordinates;
    const fromLat = viewerLat || 17.4401;
    const fromLng = viewerLng || 78.3896;
    try {
      const data = await api(`/api/directions?from_lat=${fromLat}&from_lng=${fromLng}&to_lat=${toLat}&to_lng=${toLng}&mode=driving`);
      setDirectionsData({ data, listing, fromLat, fromLng, toLat, toLng });
      setShowDirections(true);
      if (data.routes?.[0]) {
        const route = data.routes[0].geometry;
        if (mapInstance.current?.getSource("route")) {
          mapInstance.current.getSource("route").setData({ type: "Feature", properties: {}, geometry: route });
        } else {
          mapInstance.current?.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: route } });
          mapInstance.current?.addLayer({ id: "route", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": T.primary, "line-width": 5, "line-opacity": 0.9 } });
        }
        const coords = route.coordinates;
        const bounds = coords.reduce((b, c) => b.extend(c), new mapboxgl.LngLatBounds(coords[0], coords[0]));
        mapInstance.current?.fitBounds(bounds, { padding: { top: 80, bottom: 300, left: 60, right: 60 } });
      }
    } catch { alert("Could not load directions."); }
    setLoadingDirections(false);
  };

  return (
    <div style={{ display: "flex", height: "calc(100vh - 56px)", marginTop: 56 }}>
      <div style={{ width: 340, background: T.bgCard, borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "14px 16px 10px", borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700 }}>Surplus near you <span style={{ fontSize: 12, fontWeight: 400, color: T.textMuted }}>({sidebarListings.length})</span></h2>
            <button onClick={() => setShowOrgPins(!showOrgPins)}
              style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, border: `1px solid ${T.border}`, background: showOrgPins ? T.infoLight : "transparent", color: showOrgPins ? T.info : T.textMuted, cursor: "pointer" }}>
              {showOrgPins ? "Hide orgs" : "Show orgs"}
            </button>
          </div>
          {!canClaim && (
            <div style={{ padding: "8px 10px", background: T.primaryLight, borderRadius: 8, marginBottom: 8, fontSize: 11, color: T.primaryDark, display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="info-circle" size={12} /> Donors browse only — volunteers/NGOs claim food
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: T.bgMuted, borderRadius: 10, padding: "8px 10px", border: `1px solid ${T.border}` }}>
            <Icon name="search" size={14} />
                        <input placeholder="Search, or ask AI: veg food expiring soon…" value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); if (aiMode) setAiMode(false); }}
              onKeyDown={e => { if (e.key === "Enter") runAiSearch(); }}
              style={{ background: "transparent", border: "none", outline: "none", fontSize: 13, flex: 1 }} />
            <button onClick={runAiSearch} disabled={aiBusy || !searchQuery.trim()} className="btn-ai"
              style={{ fontSize: 11, padding: "4px 9px" }}>
              {aiBusy ? "…" : "✨ AI"}
            </button>
          </div>
          {aiMode && (
            <div style={{ marginTop: 8, padding: "6px 10px", background: T.aiLight, borderRadius: 8, fontSize: 11, color: T.aiDark, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>
                ✨ AI results
                {aiInfo?.category ? ` · ${aiInfo.category}` : ""}
                {typeof aiInfo?.isVeg === "boolean" ? (aiInfo.isVeg ? " · veg" : " · non-veg") : ""}
                {aiInfo?.urgentOnly ? " · urgent" : ""}
              </span>
              <button onClick={clearAiSearch} style={{ background: "none", border: "none", color: T.aiDark, fontWeight: 700, cursor: "pointer", fontSize: 11 }}>Clear</button>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, padding: "10px 16px", borderBottom: `1px solid ${T.border}`, overflowX: "auto", flexShrink: 0 }}>
          {filters.map(f => (
            <button key={f} onClick={() => setSelectedFilter(f)}
              style={{ padding: "4px 12px", borderRadius: 20, fontSize: 12, whiteSpace: "nowrap", border: selectedFilter === f ? `1px solid ${T.primary}` : `1px solid ${T.border}`, background: selectedFilter === f ? T.primaryLight : "transparent", color: selectedFilter === f ? T.primaryDark : T.textMuted, fontWeight: selectedFilter === f ? 700 : 400, cursor: "pointer" }}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {sidebarListings.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: T.textLight, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%" }}>
              <div style={{ fontSize: 40 }}>🌿</div>
              <p style={{ marginTop: 10, fontSize: 13 }}>No listings found nearby</p>
            </div>
          ) : sidebarListings.map(listing => {
            const hoursLeft = ((new Date(listing.expiresAt) - new Date()) / 3600000).toFixed(1);
            const isExpired = hoursLeft <= 0;
            const isUrgent = !isExpired && hoursLeft < 2;
            const isOwn = listing.isOwn;
            const isClaimed = claimedListings.has(listing._id) || listing.claimCount > 0;
            let distStr = "";
            if (viewerLat && viewerLng && listing.location?.coordinates) {
              const [lngC, latC] = listing.location.coordinates;
              const d = haversineKm(viewerLat, viewerLng, latC, lngC);
              if (d != null) distStr = `${d} km${effectiveLoc.isLive ? " 📡" : ""}`;
            }
            return (
              <div key={listing._id} onClick={() => { if (!isExpired) { setSelectedPin(listing); showPopupOnMap(listing); } }}
                style={{ position: "relative", padding: "12px 16px", borderBottom: `1px solid ${T.borderLight}`, cursor: isExpired ? "default" : "pointer", background: selectedPin?._id === listing._id ? T.primaryLight : T.bgCard, opacity: isOwn ? 0.75 : 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{listing.foodName}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, background: isExpired ? T.bgMuted : T.accentLight, color: isExpired ? T.textMuted : T.accentDark, padding: "1px 8px", borderRadius: 20 }}>{listing.quantity} kg</span>
                </div>
                <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 4 }}><Icon name="building-store" size={12} /> {listing.restaurantName}{distStr ? ` · ${distStr}` : ""}</div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  {isExpired
                    ? <span style={{ fontSize: 11, background: "#555", color: "#fff", padding: "1px 7px", borderRadius: 20, fontWeight: 700 }}>⛔ Expired</span>
                    : <>
                      <span style={{ fontSize: 11, color: T.textMuted }}><Icon name="clock" size={11} /> {hoursLeft}h left</span>
                      {isOwn && <span style={{ fontSize: 11, background: T.bgMuted, color: T.textMuted, padding: "1px 7px", borderRadius: 20 }}>📌 Yours</span>}
                      {!isOwn && isUrgent && <span style={{ fontSize: 11, background: T.dangerLight, color: T.danger, padding: "1px 7px", borderRadius: 20, fontWeight: 700 }}>Urgent</span>}
                      {isClaimed
                        ? <span style={{ fontSize: 11, background: T.dangerLight, color: T.danger, padding: "1px 7px", borderRadius: 20, fontWeight: 700 }}>🔒 Claimed</span>
                        : <span style={{ fontSize: 11, background: T.successLight, color: T.success, padding: "1px 7px", borderRadius: 20, fontWeight: 700 }}>✅ Available</span>
                      }
                    </>
                  }
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ flex: 1, position: "relative" }}>
        <div ref={mapRef} style={{ width: "100%", height: "100%" }} />
        <div style={{ position: "absolute", top: 12, right: 12, display: "flex", gap: 8 }}>
          <button onClick={() => navigator.geolocation?.getCurrentPosition(pos => mapInstance.current?.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 15 }))}
            className="btn-secondary" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "7px 12px", boxShadow: T.shadow }}>
            <Icon name="current-location" size={14} /> Near me
          </button>
        </div>
        {showDirections && directionsData && (
          <div className="slide-up" style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: T.bgCard, borderTop: `1px solid ${T.border}`, borderRadius: "18px 18px 0 0", padding: "16px 20px", maxHeight: "46%", overflowY: "auto", boxShadow: "0 -6px 32px rgba(0,0,0,0.1)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>📍 Route to {directionsData.listing.restaurantName}</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{directionsData.listing.foodName} · {directionsData.listing.quantity} kg</div>
              </div>
              <button onClick={() => { setShowDirections(false); if (mapInstance.current?.getLayer("route")) { mapInstance.current.removeLayer("route"); mapInstance.current.removeSource("route"); } }}
                style={{ background: T.bgMuted, border: "none", borderRadius: "50%", width: 30, height: 30, fontSize: 16, cursor: "pointer" }}>×</button>
            </div>
            {directionsData.data?.routes?.[0] && (() => {
              const route = directionsData.data.routes[0];
              return (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
                  {[{ val: `${(route.distance / 1000).toFixed(1)} km`, label: "Distance" }, { val: `${Math.round(route.duration / 60)} min`, label: "By car" }, { val: `${Math.round(route.distance / 1000 / 5 * 60)} min`, label: "Walking est." }].map(item => (
                    <div key={item.label} style={{ background: T.bgMuted, borderRadius: 10, padding: 10, textAlign: "center" }}>
                      <div style={{ fontSize: 18, fontWeight: 700 }}>{item.val}</div>
                      <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{item.label}</div>
                    </div>
                  ))}
                </div>
              );
            })()}
            <a href={`https://maps.google.com/maps?q=${directionsData.toLat},${directionsData.toLng}`} target="_blank" rel="noopener noreferrer"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px", background: T.bgMuted, borderRadius: 9, fontSize: 13, color: T.text, textDecoration: "none", border: `1px solid ${T.border}` }}>
              <Icon name="brand-google-maps" size={15} /> Open in Google Maps
            </a>
          </div>
        )}
        {loadingDirections && (
          <div style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", background: T.bgCard, padding: "8px 18px", borderRadius: 20, fontSize: 13, boxShadow: T.shadow, whiteSpace: "nowrap" }}>
            🗺 Loading route…
          </div>
        )}
      </div>
      {selectedOrg && (
        <NGOBioModal org={selectedOrg} onClose={() => setSelectedOrg(null)} onStartChat={onStartChat}
          viewerLat={viewerLat} viewerLng={viewerLng} viewerIsLive={effectiveLoc.isLive} />
      )}
    </div>
  );
}

// ── Post Modal ─────────────────────────────────────────────────────────────
function PostModal({ user, activeLocation, onClose, onSuccess }) {
  const [form, setForm] = useState({ foodName: "", category: "meals", quantity: "", servings: "", expiresAt: "", locationId: activeLocation?._id || "", description: "", isVeg: true });
  const [loading, setLoading] = useState(false);
  const [safetyCheck, setSafetyCheck] = useState(null);
  const [checkingPhoto, setCheckingPhoto] = useState(false);
  const features = user?.features || {};

  // Reset safety check when form changes
  const updateForm = (key, val) => {
    setForm(f => ({ ...f, [key]: val }));
    if (["foodName", "category", "quantity", "expiresAt"].includes(key)) setSafetyCheck(null);
  };

  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCheckingPhoto(true);
    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = reader.result.split(",")[1];
        try {
          const result = await api("/api/ai/analyze-food-photo", { method: "POST", body: { imageBase64: base64, mimeType: file.type } });
          if (result.suggestedListing) {
            const s = result.suggestedListing;
            setForm(f => ({ ...f, foodName: s.foodName || f.foodName, category: s.category || f.category, quantity: s.quantity?.toString() || f.quantity, servings: s.servings?.toString() || f.servings, isVeg: s.isVeg !== undefined ? s.isVeg : f.isVeg }));
            setSafetyCheck(null);
          }
        } catch {}
        setCheckingPhoto(false);
      };
      reader.readAsDataURL(file);
    } catch { setCheckingPhoto(false); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.expiresAt && !safetyCheck) {
      setLoading(true);
      try {
        const check = await api("/api/ai/food-safety-check", { method: "POST", body: { foodName: form.foodName, description: form.description, quantity: parseFloat(form.quantity) || 0, expiresAt: form.expiresAt, category: form.category } });
        setSafetyCheck(check);
        if (check.flagged && check.severity === "high") { setLoading(false); return; }
      } catch {}
      setLoading(false);
    }
    setLoading(true);
    try { await api("/api/listings", { method: "POST", body: form }); onSuccess(); onClose(); }
    catch (err) { alert(err.message); }
    setLoading(false);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(28,25,23,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="fade-in" style={{ background: T.bgCard, borderRadius: 20, padding: 28, width: 480, maxHeight: "92vh", overflowY: "auto", boxShadow: T.shadowLg }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 22 }}>
          <div><h2 style={{ fontSize: 18, fontWeight: 700 }}>Post surplus food</h2><p style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>Help nearby NGOs and individuals</p></div>
          <button onClick={onClose} style={{ background: T.bgMuted, border: "none", borderRadius: "50%", width: 30, height: 30, fontSize: 18, cursor: "pointer" }}>×</button>
        </div>
        {features.can_see_photo_analysis && (
          <div style={{ marginBottom: 16, padding: "12px 14px", background: T.aiLight, borderRadius: 10, border: `1px solid #C7D2FE` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.aiDark, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
              <AISparkIcon size={14} /> AI Photo Auto-fill
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="file" accept="image/*" onChange={handlePhotoUpload} style={{ display: "none" }} />
              <span style={{ fontSize: 12, padding: "5px 12px", background: "#fff", border: `1px solid #C7D2FE`, borderRadius: 7, color: T.aiDark, fontWeight: 600 }}>
                {checkingPhoto ? "Analysing…" : "📸 Upload photo to auto-fill"}
              </span>
            </label>
          </div>
        )}
        {safetyCheck?.flagged && (
          <div style={{ marginBottom: 14, padding: "12px 14px", background: safetyCheck.severity === "high" ? T.dangerLight : T.amberLight, borderRadius: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: safetyCheck.severity === "high" ? T.danger : T.amber, marginBottom: 4 }}>
              {safetyCheck.severity === "high" ? "⚠️ Safety concern detected" : "⚡ Minor safety note"}
            </div>
            <div style={{ fontSize: 12, color: safetyCheck.severity === "high" ? T.danger : T.amber }}>{safetyCheck.reason}</div>
            {safetyCheck.severity !== "high" && (
              <button onClick={() => setSafetyCheck({ ...safetyCheck, flagged: false })} style={{ marginTop: 8, fontSize: 11, padding: "3px 8px", borderRadius: 6, border: `1px solid ${T.border}`, background: "#fff", cursor: "pointer" }}>
                Understood, post anyway
              </button>
            )}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          {[{ label: "Food name *", key: "foodName", type: "text", placeholder: "e.g. Biryani + Dal" }, { label: "Quantity (kg) *", key: "quantity", type: "number", placeholder: "e.g. 8" }, { label: "Estimated servings", key: "servings", type: "number", placeholder: "e.g. 32" }].map(({ label, key, type, placeholder }) => (
            <div key={key} style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: T.textMuted, display: "block", marginBottom: 5, fontWeight: 600 }}>{label}</label>
              <input type={type} placeholder={placeholder} required={key !== "servings"} value={form[key]} onChange={e => updateForm(key, e.target.value)}
                style={{ width: "100%", padding: "10px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13 }} />
            </div>
          ))}
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: T.textMuted, display: "block", marginBottom: 5, fontWeight: 600 }}>Category</label>
            <select value={form.category} onChange={e => updateForm("category", e.target.value)} style={{ width: "100%", padding: "10px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13 }}>
              {["meals", "bakery", "produce", "dairy"].map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: T.textMuted, display: "block", marginBottom: 5, fontWeight: 600 }}>Description (optional)</label>
            <textarea placeholder="Pickup instructions, food details…" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2}
              style={{ width: "100%", padding: "10px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13, resize: "vertical" }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, color: T.textMuted, display: "block", marginBottom: 5, fontWeight: 600 }}>Available until *</label>
            <input type="datetime-local" required value={form.expiresAt} onChange={e => updateForm("expiresAt", e.target.value)}
              style={{ width: "100%", padding: "10px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13 }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, padding: "10px 12px", background: T.bgMuted, borderRadius: 10 }}>
            <input type="checkbox" id="isVeg" checked={form.isVeg} onChange={e => setForm(f => ({ ...f, isVeg: e.target.checked }))} style={{ width: 16, height: 16 }} />
            <label htmlFor="isVeg" style={{ fontSize: 13, cursor: "pointer" }}>🟢 This is vegetarian food</label>
          </div>
          <button type="submit" disabled={loading || (safetyCheck?.flagged && safetyCheck?.severity === "high")} className="btn-primary" style={{ width: "100%", padding: 12, fontSize: 14 }}>
            {loading ? "Checking & posting…" : "Post surplus food →"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Stat Card ──────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, icon, color = T.accent }) {
  return (
    <div className="card" style={{ padding: "16px 18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 6, fontWeight: 500 }}>{label}</div>
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.5px" }}>{value}</div>
          {sub && <div style={{ fontSize: 12, color, marginTop: 3, fontWeight: 600 }}>{sub}</div>}
        </div>
        {icon && <div style={{ fontSize: 24, opacity: 0.45 }}>{icon}</div>}
      </div>
    </div>
  );
}
// ── Pickup QR (delivery person shows this to the donor) ────────────────────
function PickupQR({ claimId }) {
  const [qr, setQr] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    api(`/api/claims/${claimId}/qr`)
      .then(d => alive && setQr(d))
      .catch(e => alive && setErr(e.message));
    return () => { alive = false; };
  }, [claimId]);

  if (err) return <div style={{ fontSize: 12, color: T.danger, marginBottom: 10 }}>{err}</div>;
  if (!qr) return <div style={{ fontSize: 12, color: T.textLight, marginBottom: 10 }}>Loading QR…</div>;
  return (
    <div style={{ marginBottom: 12, padding: 14, background: T.bgMuted, borderRadius: 12, textAlign: "center" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 8 }}>
        Show this QR to the donor to collect the food
      </div>
      <img src={qr.qrImage} alt="Pickup QR" style={{ width: 220, height: 220, background: "#fff", padding: 8, borderRadius: 10 }} />
    </div>
  );
}

// ── Scan Pickup Modal (donor scans the delivery person's QR) ───────────────
function ScanPickupModal({ onClose, onDone }) {
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    const scanner = new Html5Qrcode("qr-reader");
    let started = false, handled = false;
    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 240 },
        async (text) => {
          if (handled) return;
          handled = true;
          try { await scanner.stop(); started = false; } catch {}
          try {
            const data = await api("/api/claims/scan-pickup", { method: "POST", body: { qrData: text } });
            setResult(data);
            onDone && onDone();
          } catch (e) { setError(e.message); }
        },
        () => {}
      )
      .then(() => { started = true; })
      .catch(() => setError("Could not open the camera. Allow camera access (HTTPS or localhost required)."));
    return () => { if (started) scanner.stop().then(() => scanner.clear()).catch(() => {}); };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(28,25,23,0.6)", zIndex: 5000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div className="fade-in" onClick={e => e.stopPropagation()} style={{ background: T.bgCard, borderRadius: 20, padding: 24, width: 380, boxShadow: T.shadowLg }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Scan pickup QR</div>
          <button onClick={onClose} style={{ background: T.bgMuted, border: "none", borderRadius: "50%", width: 30, height: 30, fontSize: 18, cursor: "pointer" }}>×</button>
        </div>
        {!result && <div id="qr-reader" style={{ width: "100%", minHeight: 260, borderRadius: 12, overflow: "hidden", background: "#000" }} />}
        {!result && !error && <p style={{ fontSize: 12, color: T.textMuted, marginTop: 10, textAlign: "center" }}>Ask the delivery person to show their QR and point the camera at it.</p>}
        {error && (
          <div style={{ marginTop: 12, padding: "10px 14px", background: T.dangerLight, color: T.danger, borderRadius: 10, fontSize: 13 }}>
            {error}
            <div><button onClick={onClose} className="btn-secondary" style={{ marginTop: 8, fontSize: 12 }}>Close</button></div>
          </div>
        )}
        {result && (
          <div style={{ textAlign: "center", padding: "10px 0" }}>
            <div style={{ fontSize: 44 }}>✅</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 6 }}>Pickup completed</div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>{result.foodName} → {result.claimantName}</div>
            <button onClick={onClose} className="btn-primary" style={{ marginTop: 14 }}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
// ── Nearby Orgs Panel ──────────────────────────────────────────────────────

function NearbyOrgsPanel({ activeLocation, onStartChat, user }) {
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [orgTypeFilter, setOrgTypeFilter] = useState("all");
  const [selectedOrg, setSelectedOrg] = useState(null);
  const effectiveLoc = useEffectiveLocation(user);

  useEffect(() => {
    const fetchOrgs = async () => {
      setLoading(true);
      try {
        const coords = activeLocation?.location?.coordinates || [78.3896, 17.4401];
        const viewLat = effectiveLoc.lat || coords[1];
        const viewLng = effectiveLoc.lng || coords[0];
        const data = await api(`/api/map/nearby-orgs?lat=${viewLat}&lng=${viewLng}&radius=10000&org_type=${orgTypeFilter}`);
        setOrgs(data);
      } catch {}
      setLoading(false);
    };
    fetchOrgs();
  }, [activeLocation?._id, orgTypeFilter, effectiveLoc.lat, effectiveLoc.lng]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[{ val: "all", label: "All" }, { val: "restaurant", label: "🍽 Donors" }, { val: "ngo", label: "🏛 NGOs" }].map(t => (
          <button key={t.val} onClick={() => setOrgTypeFilter(t.val)}
            style={{ padding: "5px 14px", borderRadius: 20, fontSize: 12, border: orgTypeFilter === t.val ? `1px solid ${T.primary}` : `1px solid ${T.border}`, background: orgTypeFilter === t.val ? T.primaryLight : "#fff", color: orgTypeFilter === t.val ? T.primaryDark : T.textMuted, cursor: "pointer", fontWeight: orgTypeFilter === t.val ? 700 : 400 }}>
            {t.label}
          </button>
        ))}
      </div>
      {loading ? <div style={{ textAlign: "center", padding: 40, color: T.textLight }}>Loading…</div>
        : orgs.length === 0 ? (
          <div className="card" style={{ padding: 40, textAlign: "center", color: T.textLight }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>📍</div>
            <p style={{ fontSize: 13 }}>No organisations found nearby</p>
          </div>
        )
        : orgs.map(org => (
          <div key={org.userId} className="card" style={{ padding: 14, marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: org.locationType === "ngo" || org.locationType === "orphanage" ? T.accentLight : T.infoLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0, cursor: "pointer" }} onClick={() => setSelectedOrg(org)}>
                {TYPE_ICONS[org.locationType] || "📍"}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, cursor: "pointer", color: T.info }} onClick={() => setSelectedOrg(org)}>{org.locationName || org.name}</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                  {TYPE_LABELS[org.locationType]}
                  {org.distanceStatus === "enable_live_location"
                    ? <span style={{ color: T.amber }}> · 📍 Enable live loc</span>
                    : org.distanceKm != null ? ` · ${org.distanceKm} km${effectiveLoc.isLive ? " 📡" : ""}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: org.online ? T.success : T.border }} />
                  <span style={{ fontSize: 11, color: org.online ? T.success : T.textLight, fontWeight: org.online ? 600 : 400 }}>{org.online ? "Online" : "Offline"}</span>
                </div>
                <div style={{ display: "flex", gap: 5 }}>
                  <button onClick={() => setSelectedOrg(org)} className="btn-secondary" style={{ fontSize: 11, padding: "4px 8px" }}>View</button>
                  {onStartChat && <button onClick={() => onStartChat(org)} className="btn-secondary" style={{ fontSize: 11, padding: "4px 8px", display: "flex", alignItems: "center", gap: 3 }}><Icon name="message-2" size={11} /> Chat</button>}
                </div>
              </div>
            </div>
          </div>
        ))}
      {selectedOrg && (
        <NGOBioModal org={selectedOrg} onClose={() => setSelectedOrg(null)} onStartChat={onStartChat}
          viewerLat={effectiveLoc.lat} viewerLng={effectiveLoc.lng} viewerIsLive={effectiveLoc.isLive} />
      )}
    </div>
  );
}

// ── AI Tools Page (fully redesigned) ──────────────────────────────────────
function AIToolsPage({ user, activeLocation }) {
  const features = user?.features || {};

  const tabs = [
    ...(features.can_see_ai_chat ? [{ id: "chatbot", label: "Assistant", icon: "message-chatbot", desc: "Ask anything about food near you" }] : []),
    ...(features.can_see_waste_prediction ? [{ id: "predict", label: "Waste Forecast", icon: "trending-up", desc: "Predict your surplus schedule" }] : []),
    ...(features.can_use_route_optimizer ? [{ id: "route", label: "Route Planner", icon: "route", desc: "Optimise your pickup order" }] : []),
    ...(features.can_see_impact_report ? [{ id: "report", label: "Impact Report", icon: "file-analytics", desc: "Generate a city-wide impact summary" }] : []),
    ...(features.can_post ? [{ id: "safety", label: "Safety Check", icon: "shield-check", desc: "Verify food is safe to post" }] : []),
  ];

  const [activeTab, setActiveTab] = useState(tabs[0]?.id || "");

  useEffect(() => {
    if (tabs.length > 0 && !tabs.find(t => t.id === activeTab)) {
      setActiveTab(tabs[0].id);
    }
  }, [user?.role]);

  if (tabs.length === 0) {
    return (
      <div style={{ marginTop: 56, display: "flex", alignItems: "center", justifyContent: "center", height: "calc(100vh - 56px)", flexDirection: "column", gap: 12, color: T.textMuted }}>
        <div style={{ width: 64, height: 64, borderRadius: 20, background: T.aiLight, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="lock" size={28} style={{ color: T.aiDark }} />
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>AI Tools not available</div>
        <p style={{ fontSize: 13, textAlign: "center", maxWidth: 320, color: T.textMuted }}>AI features are available for restaurant, hotel, and volunteer accounts.</p>
      </div>
    );
  }

  const currentTab = tabs.find(t => t.id === activeTab);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", height: "calc(100vh - 56px)", marginTop: 56 }}>
      {/* Sidebar */}
      <div style={{ background: T.bgCard, borderRight: `1px solid ${T.border}`, padding: "0", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "20px 16px 14px", borderBottom: `1px solid ${T.borderLight}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: T.aiGrad, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <AISparkIcon size={14} />
            </div>
            <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>AI Tools</span>
          </div>
          <p style={{ fontSize: 11, color: T.textMuted, lineHeight: 1.5 }}>Smart features to rescue more food</p>
        </div>
        <div style={{ padding: "10px 10px", flex: 1, overflowY: "auto" }}>
          {tabs.map(item => (
            <button key={item.id} onClick={() => setActiveTab(item.id)}
              className={`ai-sidebar-item${activeTab === item.id ? " active" : ""}`}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: activeTab === item.id ? T.aiGrad : T.bgMuted, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background 0.15s" }}>
                <Icon name={item.icon} size={14} style={{ color: activeTab === item.id ? "#fff" : T.textMuted }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: activeTab === item.id ? T.aiDark : T.text }}>{item.label}</div>
                <div style={{ fontSize: 10, color: T.textLight, marginTop: 1, lineHeight: 1.3 }}>{item.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div style={{ background: T.bg, overflowY: "auto" }}>
        {activeTab === "chatbot" && features.can_see_ai_chat && <AIChatPanel user={user} activeLocation={activeLocation} />}
        {activeTab === "predict" && features.can_see_waste_prediction && <WastePredictionPanel activeLocation={activeLocation} />}
        {activeTab === "route" && features.can_use_route_optimizer && <RouteOptimizerPanel user={user} activeLocation={activeLocation} />}
        {activeTab === "report" && features.can_see_impact_report && <ImpactReportPanel />}
        {activeTab === "safety" && features.can_post && (
          <div style={{ padding: 28 }}>
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>Food Safety Check</h2>
              <p style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>Verify a listing is safe before posting it.</p>
            </div>
            <FoodSafetyChecker />
          </div>
        )}
      </div>
    </div>
  );
}

// ── AI Chat Panel ──────────────────────────────────────────────────────────
function AIChatPanel({ user, activeLocation }) {
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const chatEndRef = useRef(null);
  const effectiveLoc = useEffectiveLocation(user);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);

  const fetchSessions = async () => {
    try { const data = await api("/api/ai/chat/sessions"); setSessions(data); } catch {}
  };

  const loadSession = async (sid) => {
    try {
      const data = await api(`/api/ai/chat/sessions/${sid}`);
      setSessionId(sid);
      setChatMessages(data.messages?.map(m => ({ role: m.role, content: m.content })) || []);
      setShowHistory(false);
    } catch {}
  };

  const deleteSession = async (sid, e) => {
    e.stopPropagation();
    try {
      await api(`/api/ai/chat/sessions/${sid}`, { method: "DELETE" });
      setSessions(prev => prev.filter(s => s.sessionId !== sid));
      if (sessionId === sid) { setSessionId(null); setChatMessages([]); }
    } catch {}
  };

  const newChat = () => { setSessionId(null); setChatMessages([]); setShowHistory(false); };

  const sendMessage = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    setChatMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setChatLoading(true);
    try {
      const coords = activeLocation?.location?.coordinates;
      const lat = effectiveLoc.lat || (coords ? coords[1] : undefined);
      const lng = effectiveLoc.lng || (coords ? coords[0] : undefined);
      const result = await api("/api/ai/chat", { method: "POST", body: { message: userMsg, sessionId, lat, lng } });
      setChatMessages(prev => [...prev, { role: "assistant", content: result.reply }]);
      if (result.sessionId && result.sessionId !== sessionId) setSessionId(result.sessionId);
    } catch (e) {
      setChatMessages(prev => [...prev, { role: "assistant", content: `Unable to respond right now. Please try again.` }]);
    }
    setChatLoading(false);
  };

  const suggestions = [
    "What food is available near me?",
    "Any urgent pickups right now?",
    "How much food has been rescued?",
    "Which NGOs are closest?",
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{ padding: "16px 24px", borderBottom: `1px solid ${T.border}`, background: T.bgCard, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700 }}>FoodSave Assistant</h2>
          <p style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>Ask about nearby food, NGOs, pickup tips, cold chain rules — in English only</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { fetchSessions(); setShowHistory(!showHistory); }}
            className="btn-secondary" style={{ fontSize: 12, padding: "6px 12px", display: "flex", alignItems: "center", gap: 5 }}>
            <Icon name="history" size={13} /> History
          </button>
          <button onClick={newChat} className="btn-secondary" style={{ fontSize: 12, padding: "6px 12px", display: "flex", alignItems: "center", gap: 5 }}>
            <Icon name="plus" size={13} /> New chat
          </button>
        </div>
      </div>

      {/* History drawer */}
      {showHistory && (
        <div className="fade-in" style={{ padding: "12px 24px", background: T.bgMuted, borderBottom: `1px solid ${T.border}`, maxHeight: 200, overflowY: "auto" }}>
          {sessions.length === 0 ? (
            <p style={{ fontSize: 12, color: T.textLight, textAlign: "center", padding: "12px 0" }}>No previous conversations</p>
          ) : sessions.map(s => (
            <div key={s.sessionId} onClick={() => loadSession(s.sessionId)}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", borderRadius: 8, cursor: "pointer", marginBottom: 4, background: sessionId === s.sessionId ? T.aiLight : "#fff", border: `1px solid ${T.borderLight}` }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: sessionId === s.sessionId ? T.aiDark : T.text }}>{s.lastMessage || "Conversation"}</div>
                <div style={{ fontSize: 10, color: T.textLight, marginTop: 1 }}>{s.messageCount} messages · {new Date(s.createdAt).toLocaleDateString()}</div>
              </div>
              <button onClick={(e) => deleteSession(s.sessionId, e)} style={{ background: "none", border: "none", cursor: "pointer", color: T.textLight, fontSize: 14, padding: "2px 5px" }}
                onMouseEnter={e => e.currentTarget.style.color = T.danger}
                onMouseLeave={e => e.currentTarget.style.color = T.textLight}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
        {chatMessages.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, gap: 16, paddingTop: 40 }}>
            <div style={{ width: 52, height: 52, borderRadius: 16, background: T.aiGrad, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <AISparkIcon size={26} />
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 4 }}>FoodSave Assistant</div>
              <div style={{ fontSize: 13, color: T.textMuted }}>Ask me about food near you, pickup status, or impact stats.</div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 420 }}>
              {suggestions.map(q => (
                <button key={q} onClick={() => setChatInput(q)}
                  style={{ fontSize: 12, padding: "7px 14px", borderRadius: 20, border: `1.5px solid ${T.border}`, background: "#fff", color: T.textMuted, cursor: "pointer", fontWeight: 500, transition: "all 0.12s" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = T.aiDark; e.currentTarget.style.color = T.aiDark; e.currentTarget.style.background = T.aiLight; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; e.currentTarget.style.background = "#fff"; }}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {chatMessages.map((msg, i) => (
          <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start", alignItems: "flex-end", gap: 8 }}>
            {msg.role === "assistant" && (
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: T.aiGrad, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginBottom: 2 }}>
                <AISparkIcon size={14} />
              </div>
            )}
            <div className={msg.role === "user" ? "ai-chat-bubble-user" : "ai-chat-bubble-ai"}
              style={{ maxWidth: "72%", padding: "11px 15px", fontSize: 13, lineHeight: 1.65, boxShadow: msg.role === "user" ? "none" : T.shadow, whiteSpace: "pre-wrap" }}>
              {msg.content}
            </div>
          </div>
        ))}
        {chatLoading && (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: T.aiGrad, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <AISparkIcon size={14} />
            </div>
            <div className="ai-chat-bubble-ai" style={{ padding: "13px 16px" }}>
              <div style={{ display: "flex", gap: 4 }}>
                <div className="typing-dot" />
                <div className="typing-dot" />
                <div className="typing-dot" />
              </div>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div style={{ padding: "14px 24px", borderTop: `1px solid ${T.border}`, background: T.bgCard, display: "flex", gap: 10, alignItems: "flex-end" }}>
        <textarea value={chatInput} onChange={e => setChatInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder="Ask about food, availability, NGOs… (Enter to send)" rows={1}
          style={{ flex: 1, padding: "10px 14px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 13, resize: "none", outline: "none", maxHeight: 80, fontFamily: "'Plus Jakarta Sans', sans-serif", lineHeight: 1.5 }} />
        <button onClick={sendMessage} disabled={chatLoading || !chatInput.trim()} className="btn-ai" style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 6 }}>
          <Icon name="send" size={14} /> Send
        </button>
      </div>
    </div>
  );
}

// ── Waste Prediction Panel ─────────────────────────────────────────────────
function WastePredictionPanel({ activeLocation }) {
  const [predicting, setPredicting] = useState(false);
  const [prediction, setPrediction] = useState(null);
  const [error, setError] = useState("");

  const run = async () => {
    if (!activeLocation?._id) { setError("No active location found."); return; }
    setError(""); setPredicting(true);
    try { const result = await api("/api/ai/predict-waste", { method: "POST", body: { locationId: activeLocation._id } }); setPrediction(result); }
    catch (e) { setError(e.message); }
    setPredicting(false);
  };

  return (
    <div style={{ padding: 28 }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>Waste Forecast</h2>
        <p style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>Analyse your posting history to predict when you'll have surplus next week.</p>
      </div>
      <button onClick={run} disabled={predicting} className="btn-ai" style={{ marginBottom: 24, display: "flex", alignItems: "center", gap: 7 }}>
        {predicting ? <><Icon name="loader-2" size={13} className="spin" /> Analysing history…</> : <><Icon name="chart-trend-up" size={13} /> Generate forecast</>}
      </button>
      {error && <div style={{ padding: "12px 16px", background: T.dangerLight, borderRadius: 10, fontSize: 13, color: T.danger, marginBottom: 16 }}>{error}</div>}
      {prediction && (
        <div className="fade-in">
          {prediction.message && <div style={{ padding: "12px 16px", background: T.bgMuted, borderRadius: 10, fontSize: 13, color: T.textMuted, marginBottom: 16 }}>{prediction.message}</div>}
          {prediction.weeklyPattern && (
            <div style={{ padding: "12px 16px", background: T.aiLight, borderRadius: 10, fontSize: 13, color: T.aiDark, marginBottom: 16 }}>
              <span style={{ fontWeight: 700 }}>Pattern: </span>{prediction.weeklyPattern}
            </div>
          )}
          {prediction.predictions?.map((pred, i) => (
            <div key={i} className="card" style={{ padding: 16, marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{pred.dayOfWeek}</div>
                  <div style={{ fontSize: 12, color: T.textMuted }}>{pred.timeWindow} · {pred.date}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: T.accentDark }}>{pred.estimatedQuantityKg} kg</div>
                  <div style={{ fontSize: 11, color: T.accent }}>~{Math.round(pred.estimatedQuantityKg * 4)} servings</div>
                </div>
              </div>
              <div style={{ height: 5, borderRadius: 3, background: T.bgMuted, overflow: "hidden", marginBottom: 8 }}>
                <div style={{ height: "100%", width: `${pred.confidence * 100}%`, background: T.aiGrad, borderRadius: 3 }} />
              </div>
              <div style={{ fontSize: 11, color: T.textMuted, display: "flex", justifyContent: "space-between" }}>
                <span>{pred.reason}</span>
                <span style={{ fontWeight: 700, color: T.aiDark }}>{Math.round(pred.confidence * 100)}% confidence</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Route Optimizer Panel ──────────────────────────────────────────────────
function RouteOptimizerPanel({ user, activeLocation }) {
  const [myClaims, setMyClaims] = useState([]);
  const [selectedClaimIds, setSelectedClaimIds] = useState([]);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizedRoute, setOptimizedRoute] = useState(null);
  const [error, setError] = useState("");
  const [loadingClaims, setLoadingClaims] = useState(true);
  const effectiveLoc = useEffectiveLocation(user);

  useEffect(() => {
    const fetch = async () => {
      setLoadingClaims(true);
      try { const data = await api("/api/claims/all-for-route"); setMyClaims(data); }
      catch (e) { setError(e.message); }
      setLoadingClaims(false);
    };
    fetch();
  }, []);

  const run = async () => {
    if (selectedClaimIds.length === 0) { setError("Select at least one claim."); return; }
    setError(""); setOptimizing(true);
    try {
      const coords = activeLocation?.location?.coordinates;
      const startLat = effectiveLoc.lat ?? (coords ? coords[1] : 17.4401);
      const startLng = effectiveLoc.lng ?? (coords ? coords[0] : 78.3896);
      const result = await api("/api/ai/optimize-route", { method: "POST", body: { claimIds: selectedClaimIds, startLat, startLng } });
      setOptimizedRoute(result);
    } catch (e) { setError(e.message || "Route optimization failed"); }
    setOptimizing(false);
  };

  const hasLocation = effectiveLoc.lat != null;

  return (
    <div style={{ padding: 28 }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>Route Planner</h2>
        <p style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>Calculates the most efficient pickup order for your active claims.</p>
      </div>
      <div style={{ padding: "10px 14px", background: hasLocation ? T.accentLight : T.amberLight, borderRadius: 10, marginBottom: 20, fontSize: 12, color: hasLocation ? T.accentDark : T.amber, display: "flex", alignItems: "center", gap: 6 }}>
        {hasLocation ? "📡" : "⚠️"}
        {hasLocation
          ? `Starting from ${effectiveLoc.liveEnabled ? "live" : "profile"} location (${effectiveLoc.lat?.toFixed(4)}, ${effectiveLoc.lng?.toFixed(4)})`
          : "No location found — enable live location in the navbar or set a profile location"}
      </div>
      {error && <div style={{ padding: "10px 14px", background: T.dangerLight, borderRadius: 10, marginBottom: 14, fontSize: 13, color: T.danger }}>{error}</div>}
      {loadingClaims ? <div style={{ textAlign: "center", padding: 40, color: T.textLight }}>Loading claims…</div>
        : myClaims.length === 0 ? (
          <div className="card" style={{ padding: 40, textAlign: "center", color: T.textLight }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>🗺</div>
            <p style={{ fontSize: 13 }}>No active claims to plan. Claim some food first!</p>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.textMuted }}>Select claims ({selectedClaimIds.length} of {myClaims.length}):</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setSelectedClaimIds(myClaims.map(c => c._id))} className="btn-secondary" style={{ fontSize: 11, padding: "4px 10px" }}>All</button>
                <button onClick={() => setSelectedClaimIds([])} className="btn-secondary" style={{ fontSize: 11, padding: "4px 10px" }}>None</button>
              </div>
            </div>
            {myClaims.map(claim => {
              const hoursLeft = claim.listing?.expiresAt
                ? ((new Date(claim.listing.expiresAt) - new Date()) / 3600000).toFixed(1)
                : "?";
              const isUrgent = hoursLeft !== "?" && hoursLeft < 2;
              return (
                <div key={claim._id} className="card" style={{ padding: 14, marginBottom: 8, display: "flex", alignItems: "center", gap: 12, borderLeft: `3px solid ${isUrgent ? T.danger : T.border}` }}>
                  <input type="checkbox" checked={selectedClaimIds.includes(claim._id)}
                    onChange={e => setSelectedClaimIds(prev => e.target.checked ? [...prev, claim._id] : prev.filter(id => id !== claim._id))}
                    style={{ width: 16, height: 16, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{claim.listing?.foodName || "Food"}</div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                      {claim.listing?.restaurantName} · {claim.listing?.quantity} kg
                      {hoursLeft !== "?" && <span style={{ color: isUrgent ? T.danger : T.textMuted }}> · ⏰ {hoursLeft}h left</span>}
                    </div>
                  </div>
                  {isUrgent && <span style={{ fontSize: 10, background: T.dangerLight, color: T.danger, padding: "2px 7px", borderRadius: 20, fontWeight: 700, flexShrink: 0 }}>Urgent</span>}
                </div>
              );
            })}
            <button onClick={run} disabled={optimizing || selectedClaimIds.length === 0 || !hasLocation}
              className="btn-ai" style={{ marginTop: 8, marginBottom: 24, display: "flex", alignItems: "center", gap: 7, opacity: !hasLocation ? 0.5 : 1 }}>
              {optimizing
                ? <><Icon name="loader-2" size={13} className="spin" /> Optimising…</>
                : <><Icon name="route" size={13} /> Plan route ({selectedClaimIds.length} stop{selectedClaimIds.length !== 1 ? "s" : ""})</>}
            </button>
          </>
        )}
      {optimizedRoute && (
        <div className="fade-in">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
            <StatCard label="Total stops" value={optimizedRoute.totalStops} icon="🛑" />
            <StatCard label="Distance" value={`${optimizedRoute.estimatedDistanceKm} km`} icon="🗺" />
            <StatCard label="Est. time" value={`${optimizedRoute.estimatedTimeMin} min`} icon="⏱" />
          </div>
          {optimizedRoute.optimizedRoute?.map((stop, i) => (
            <div key={stop.claimId || i} className="card" style={{ padding: 14, marginBottom: 8, borderLeft: `3px solid ${stop.urgency === "high" ? T.danger : stop.urgency === "medium" ? T.amber : T.accent}` }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <div style={{ width: 30, height: 30, borderRadius: "50%", background: T.aiGrad, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800, color: "#fff", flexShrink: 0 }}>{i + 1}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{stop.restaurantName}</div>
                  <div style={{ fontSize: 12, color: T.textMuted }}>
                    {stop.foodName} · {stop.quantity} kg
                    {stop.hoursLeft != null && <span style={{ color: stop.urgency === "high" ? T.danger : T.textMuted }}> · ⏰ {stop.hoursLeft}h left</span>}
                  </div>
                  {stop.restaurantAddress && <div style={{ fontSize: 11, color: T.textLight, marginTop: 2 }}>{stop.restaurantAddress}</div>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                  <span style={{ fontSize: 10, background: stop.urgency === "high" ? T.dangerLight : stop.urgency === "medium" ? T.amberLight : T.accentLight, color: stop.urgency === "high" ? T.danger : stop.urgency === "medium" ? T.amber : T.accent, padding: "2px 7px", borderRadius: 20, fontWeight: 700, textTransform: "uppercase" }}>{stop.urgency}</span>
                  {stop.lat && stop.lng && (
                    <a href={`https://maps.google.com/maps?q=${stop.lat},${stop.lng}`} target="_blank" rel="noopener noreferrer"
                      className="btn-secondary" style={{ padding: "4px 8px", textDecoration: "none", fontSize: 11 }}>Navigate</a>
                  )}
                </div>
              </div>
            </div>
          ))}
          {optimizedRoute.optimizedRoute?.length > 0 && optimizedRoute.optimizedRoute[0].lat && effectiveLoc.lat && (
            <a href={`https://maps.google.com/maps/dir/${effectiveLoc.lat},${effectiveLoc.lng}/${optimizedRoute.optimizedRoute.map(s => `${s.lat},${s.lng}`).join("/")}`}
              target="_blank" rel="noopener noreferrer"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "10px", background: T.bgMuted, borderRadius: 10, textDecoration: "none", color: T.text, fontSize: 13, marginTop: 8, border: `1px solid ${T.border}` }}>
              <Icon name="brand-google-maps" size={15} /> Open full route in Google Maps
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ── Impact Report Panel ────────────────────────────────────────────────────
function ImpactReportPanel() {
  const [reportPeriod, setReportPeriod] = useState({ start: "", end: "" });
  const [generatingReport, setGeneratingReport] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");

  const generate = async () => {
    setError(""); setGeneratingReport(true);
    try {
      const body = {};
      if (reportPeriod.start) body.startDate = reportPeriod.start;
      if (reportPeriod.end) body.endDate = reportPeriod.end;
      setReport(await api("/api/ai/generate-impact-report", { method: "POST", body }));
    } catch (e) { setError(e.message); }
    setGeneratingReport(false);
  };

  return (
    <div style={{ padding: 28 }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>Impact Report</h2>
        <p style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>Reads platform analytics and generates a full narrative impact report.</p>
      </div>
      <div className="card" style={{ padding: 20, marginBottom: 20, maxWidth: 540 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>From (optional)</label>
            <input type="date" value={reportPeriod.start} onChange={e => setReportPeriod(p => ({ ...p, start: e.target.value }))}
              style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>To (optional)</label>
            <input type="date" value={reportPeriod.end} onChange={e => setReportPeriod(p => ({ ...p, end: e.target.value }))}
              style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13 }} />
          </div>
        </div>
        <button onClick={generate} disabled={generatingReport} className="btn-ai" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {generatingReport ? <><Icon name="loader-2" size={13} className="spin" /> Generating…</> : <><Icon name="file-analytics" size={13} /> Generate report</>}
        </button>
      </div>
      {error && <div style={{ padding: "12px 16px", background: T.dangerLight, borderRadius: 10, fontSize: 13, color: T.danger, marginBottom: 16 }}>{error}</div>}
      {report && (
        <div className="fade-in">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 20 }}>
            <StatCard label="Food rescued" value={`${report.metrics.totalKg} kg`} icon="🥗" />
            <StatCard label="Meals provided" value={report.metrics.totalServings} icon="🍽" color="#5B21B6" />
            <StatCard label="CO₂ offset" value={`${report.metrics.co2OffsetKg} kg`} icon="🌱" />
            <StatCard label="Water saved" value={`${(report.metrics.waterSavedLitres / 1000).toFixed(0)}k L`} icon="💧" color={T.info} />
          </div>
          <div className="card" style={{ padding: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 12 }}>Generated Report</div>
            <div style={{ fontSize: 13, lineHeight: 1.8, whiteSpace: "pre-wrap", color: T.text }}>{report.reportText}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Food Safety Checker ────────────────────────────────────────────────────
function FoodSafetyChecker() {
  const [form, setForm] = useState({ foodName: "", description: "", quantity: "", expiresAt: "", category: "meals" });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const check = async (e) => {
    e.preventDefault(); setLoading(true);
    try { setResult(await api("/api/ai/food-safety-check", { method: "POST", body: { ...form, quantity: parseFloat(form.quantity) || 0 } })); }
    catch (err) { alert(err.message); }
    setLoading(false);
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <form onSubmit={check} className="card" style={{ padding: 24, marginBottom: 16 }}>
        {[
          { label: "Food name", key: "foodName", type: "text", placeholder: "e.g. Chicken Biryani" },
          { label: "Description", key: "description", type: "textarea", placeholder: "Storage conditions, notes…" },
          { label: "Quantity (kg)", key: "quantity", type: "number", placeholder: "e.g. 5" },
          { label: "Expiry date/time", key: "expiresAt", type: "datetime-local" },
        ].map(({ label, key, type, placeholder }) => (
          <div key={key} style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>{label}</label>
            {type === "textarea"
              ? <textarea placeholder={placeholder} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} rows={2}
                  style={{ width: "100%", padding: "10px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13, resize: "vertical" }} />
              : <input type={type} required={key !== "description"} placeholder={placeholder} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  style={{ width: "100%", padding: "10px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13 }} />
            }
          </div>
        ))}
        <button type="submit" disabled={loading} className="btn-ai" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {loading ? <><Icon name="loader-2" size={13} className="spin" /> Checking…</> : <><Icon name="shield-check" size={13} /> Run Safety Check</>}
        </button>
      </form>
      {result && (
        <div className="fade-in card" style={{ padding: 20, background: result.safeToPost ? T.successLight : T.dangerLight, border: `1.5px solid ${result.safeToPost ? "#6EE7B7" : "#FCA5A5"}` }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 24 }}>{result.safeToPost ? "✅" : "⚠️"}</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{result.safeToPost ? "Safe to post" : "Not recommended"}</div>
              <div style={{ fontSize: 12, color: T.textMuted }}>Severity: <strong>{result.severity}</strong></div>
            </div>
          </div>
          {result.reason && <p style={{ fontSize: 13, color: T.textMuted }}>{result.reason}</p>}
          {result.storageAdvice && <p style={{ fontSize: 12, color: T.textMuted, marginTop: 8 }}>💡 {result.storageAdvice}</p>}
        </div>
      )}
    </div>
  );
}

// ── Location Picker Modal ──────────────────────────────────────────────────
function LocationPickerModal({ onSelect, onClose, initialCoords }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markerRef = useRef(null);
  const [coords, setCoords] = useState(initialCoords || { lat: 17.4401, lng: 78.3896 });
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [manualLat, setManualLat] = useState(coords.lat.toFixed(5));
  const [manualLng, setManualLng] = useState(coords.lng.toFixed(5));
  const [tab, setTab] = useState("map");

  useEffect(() => {
    if (tab !== "map" || !mapRef.current || mapInstance.current) return;
    mapInstance.current = new mapboxgl.Map({ container: mapRef.current, style: "mapbox://styles/mapbox/light-v11", center: [coords.lng, coords.lat], zoom: 13 });
    const el = document.createElement("div");
    el.style.cssText = `width:24px;height:24px;border-radius:50%;background:${T.primary};border:3px solid #fff;box-shadow:${T.shadowMd};cursor:move;`;
    markerRef.current = new mapboxgl.Marker({ element: el, draggable: true }).setLngLat([coords.lng, coords.lat]).addTo(mapInstance.current);
    markerRef.current.on("dragend", () => {
      const lngLat = markerRef.current.getLngLat();
      setCoords({ lat: lngLat.lat, lng: lngLat.lng });
      setManualLat(lngLat.lat.toFixed(5)); setManualLng(lngLat.lng.toFixed(5));
    });
    mapInstance.current.on("click", (e) => {
      const { lng, lat } = e.lngLat;
      markerRef.current.setLngLat([lng, lat]);
      setCoords({ lat, lng }); setManualLat(lat.toFixed(5)); setManualLng(lng.toFixed(5));
    });
    return () => { mapInstance.current?.remove(); mapInstance.current = null; };
  }, [tab]);

  const searchPlaces = async (q) => {
    if (!q.trim() || q.length < 2 || !MAPBOX_TOKEN) return;
    setSearching(true);
    try {
      const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${MAPBOX_TOKEN}&country=IN&proximity=78.3896,17.4401&limit=5`);
      const data = await res.json();
      setSuggestions(data.features || []);
    } catch {}
    setSearching(false);
  };

  useEffect(() => { const t = setTimeout(() => searchPlaces(searchQuery), 400); return () => clearTimeout(t); }, [searchQuery]);

  const selectSuggestion = (feat) => {
    const [lng, lat] = feat.center;
    setCoords({ lat, lng }); setManualLat(lat.toFixed(5)); setManualLng(lng.toFixed(5));
    setSuggestions([]); setSearchQuery(feat.place_name);
    if (mapInstance.current && markerRef.current) {
      mapInstance.current.flyTo({ center: [lng, lat], zoom: 15 });
      markerRef.current.setLngLat([lng, lat]);
    }
  };

  const applyManual = () => {
    const lat = parseFloat(manualLat); const lng = parseFloat(manualLng);
    if (isNaN(lat) || isNaN(lng)) return;
    setCoords({ lat, lng });
    if (mapInstance.current && markerRef.current) {
      mapInstance.current.flyTo({ center: [lng, lat], zoom: 15 });
      markerRef.current.setLngLat([lng, lat]);
    }
  };

  const useMyLocation = () => {
    navigator.geolocation?.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      setCoords({ lat, lng }); setManualLat(lat.toFixed(5)); setManualLng(lng.toFixed(5));
      if (mapInstance.current && markerRef.current) {
        mapInstance.current.flyTo({ center: [lng, lat], zoom: 15 });
        markerRef.current.setLngLat([lng, lat]);
      }
    });
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(28,25,23,0.55)", zIndex: 4000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div className="fade-in" onClick={e => e.stopPropagation()}
        style={{ background: T.bgCard, borderRadius: 20, width: 560, maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: T.shadowLg }}>
        <div style={{ padding: "18px 20px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div><div style={{ fontSize: 15, fontWeight: 700 }}>Set your location</div><div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>Search, pin on map, or enter coordinates</div></div>
          <button onClick={onClose} style={{ background: T.bgMuted, border: "none", borderRadius: "50%", width: 30, height: 30, fontSize: 18, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ padding: "12px 20px", borderBottom: `1px solid ${T.borderLight}`, position: "relative" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: T.bgMuted, borderRadius: 10, padding: "8px 12px", border: `1.5px solid ${T.border}` }}>
              <Icon name="search" size={14} />
              <input placeholder="Search for a place…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                style={{ background: "transparent", border: "none", outline: "none", fontSize: 13, flex: 1 }} />
              {searching && <Icon name="loader-2" size={13} className="spin" />}
            </div>
            <button onClick={useMyLocation} className="btn-secondary" style={{ padding: "8px 12px", fontSize: 12, display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
              <Icon name="current-location" size={13} /> My location
            </button>
          </div>
          {suggestions.length > 0 && (
            <div style={{ position: "absolute", top: "100%", left: 20, right: 20, background: T.bgCard, border: `1.5px solid ${T.border}`, borderRadius: 12, zIndex: 10, overflow: "hidden", boxShadow: T.shadowMd, maxHeight: 220, overflowY: "auto" }}>
              {suggestions.map((feat, i) => (
                <div key={feat.id} onClick={() => selectSuggestion(feat)}
                  style={{ padding: "10px 14px", cursor: "pointer", borderBottom: i < suggestions.length - 1 ? `1px solid ${T.borderLight}` : "none", display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}
                  onMouseEnter={e => e.currentTarget.style.background = T.bgMuted}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <Icon name="map-pin" size={13} />
                  <div><div style={{ fontWeight: 600 }}>{feat.text}</div><div style={{ fontSize: 11, color: T.textMuted }}>{feat.place_name?.replace(feat.text + ", ", "")}</div></div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 4, padding: "10px 20px 0" }}>
          {["map", "coordinates"].map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: tab === t ? T.primaryLight : "transparent", color: tab === t ? T.primary : T.textMuted, fontSize: 12, fontWeight: tab === t ? 700 : 500, cursor: "pointer" }}>
              {t === "map" ? "📍 Map" : "🔢 Coordinates"}
            </button>
          ))}
        </div>
        {tab === "map" && (
          <div style={{ flex: 1, minHeight: 300, position: "relative" }}>
            <div ref={mapRef} style={{ width: "100%", height: 300 }} />
            <div style={{ padding: "10px 20px", background: T.bgMuted, borderTop: `1px solid ${T.borderLight}`, fontSize: 12, color: T.textMuted, textAlign: "center" }}>
              Click on the map or drag the pin to set your location
            </div>
          </div>
        )}
        {tab === "coordinates" && (
          <div style={{ padding: "20px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>Latitude</label>
                <input value={manualLat} onChange={e => setManualLat(e.target.value)} placeholder="e.g. 17.4401"
                  style={{ width: "100%", padding: "10px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>Longitude</label>
                <input value={manualLng} onChange={e => setManualLng(e.target.value)} placeholder="e.g. 78.3896"
                  style={{ width: "100%", padding: "10px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13 }} />
              </div>
            </div>
            <button onClick={applyManual} className="btn-secondary" style={{ fontSize: 12 }}>Apply coordinates</button>
          </div>
        )}
        <div style={{ padding: "14px 20px", borderTop: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 12, color: T.textMuted }}>📍 {coords.lat.toFixed(4)}, {coords.lng.toFixed(4)}</div>
          <button onClick={() => onSelect(coords)} className="btn-primary" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="check" size={14} /> Use this location
          </button>
        </div>
      </div>
    </div>
  );
}

// ── NGO Admin Dashboard ─────────────────────────────────────────────────────
function NGOAdminDashboard({ user, activeLocation, onStartChat }) {
  const [activeTab, setActiveTab] = useState("overview");
  const [stats, setStats] = useState(null);
  const [volunteers, setVolunteers] = useState([]);
  const [orgClaims, setOrgClaims] = useState([]);
  const [nearby, setNearby] = useState([]);
  const [loading, setLoading] = useState(false);
  const effectiveLoc = useEffectiveLocation(user);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [statsData, volData, claimsData] = await Promise.all([api("/api/ngo/stats"), api("/api/ngo/volunteers"), api("/api/claims/org")]);
      setStats(statsData); setVolunteers(volData); setOrgClaims(claimsData);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const fetchNearby = async () => {
    try {
      const coords = activeLocation?.location?.coordinates || [78.3896, 17.4401];
      const lat = effectiveLoc.lat || coords[1];
      const lng = effectiveLoc.lng || coords[0];
      setNearby(await api(`/api/listings/nearby?lat=${lat}&lng=${lng}&radius=8000`));
    } catch {}
  };

  useEffect(() => { fetchData(); fetchNearby(); }, [activeLocation?._id]);

  const tabs = [
    { id: "overview", label: "Overview", icon: "layout-dashboard" },
    { id: "volunteers", label: `Volunteers (${volunteers.length})`, icon: "users" },
    { id: "claims", label: `All claims (${orgClaims.length})`, icon: "clipboard-check" },
    { id: "browse", label: "Browse surplus", icon: "map-search" },
    { id: "donors", label: "Nearby donors", icon: "building-store" },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "210px 1fr", height: "calc(100vh - 56px)", marginTop: 56 }}>
      <div style={{ background: T.bgCard, borderRight: `1px solid ${T.border}`, padding: "16px 12px", display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ padding: "8px 8px 14px", borderBottom: `1px solid ${T.borderLight}`, marginBottom: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{activeLocation?.name || user?.name}</div>
          <div style={{ fontSize: 11, color: T.accent, marginTop: 2, fontWeight: 700 }}>🏛 NGO Admin</div>
          {stats?.orgCode && (
            <div style={{ marginTop: 8, padding: "7px 10px", background: T.accentLight, borderRadius: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>Org Code</div>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.accentDark, letterSpacing: "1px", fontFamily: "monospace", marginTop: 2 }}>{stats.orgCode}</div>
              <div style={{ fontSize: 10, color: T.accent, marginTop: 2 }}>Share with volunteers</div>
            </div>
          )}
        </div>
        {tabs.map(item => (
          <button key={item.id} onClick={() => setActiveTab(item.id)}
            style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", borderRadius: 10, border: "none", background: activeTab === item.id ? T.accentLight : "transparent", color: activeTab === item.id ? T.accentDark : T.textMuted, fontSize: 13, fontWeight: activeTab === item.id ? 700 : 500, textAlign: "left", cursor: "pointer" }}>
            <Icon name={item.icon} size={14} />{item.label}
          </button>
        ))}
      </div>
      <div style={{ background: T.bg, overflowY: "auto", padding: 24 }}>
        {activeTab === "overview" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>Organisation overview</h2>
            {loading ? <div style={{ color: T.textLight }}>Loading…</div> : stats && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 20 }}>
                  <StatCard label="Total food received" value={`${stats.totalKg || 0} kg`} icon="🥗" />
                  <StatCard label="Total meals" value={stats.totalMeals || 0} icon="🍽" color="#5B21B6" />
                  <StatCard label="Total volunteers" value={stats.totalVolunteers || 0} icon="🚴" color={T.primary} />
                  <StatCard label="Active now" value={stats.activeVolunteers || 0} icon="✅" color={T.success} />
                </div>
                <div className="card" style={{ padding: 20 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>🔑 How volunteers join your NGO</div>
                  <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.7, marginBottom: 12 }}>
                    Share your <strong>Org Code</strong> with volunteers. When they register as a Volunteer, they enter this code to link their account to your organisation.
                  </p>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: T.accentLight, borderRadius: 12 }}>
                    <div style={{ fontSize: 28 }}>🏛</div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>Your Org Code</div>
                      <div style={{ fontSize: 24, fontWeight: 800, color: T.accentDark, letterSpacing: "3px", fontFamily: "monospace" }}>{stats.orgCode}</div>
                    </div>
                    <button onClick={() => { navigator.clipboard?.writeText(stats.orgCode); alert("Copied!"); }}
                      className="btn-secondary" style={{ marginLeft: "auto", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}>
                      <Icon name="copy" size={13} /> Copy
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        {activeTab === "volunteers" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Linked volunteers ({volunteers.length})</h2>
            <p style={{ fontSize: 13, color: T.textMuted, marginBottom: 18 }}>These volunteers are linked to your organisation and claim food on your behalf.</p>
            {volunteers.length === 0 ? (
              <div className="card" style={{ padding: 48, textAlign: "center", color: T.textLight }}>
                <div style={{ fontSize: 40, marginBottom: 10 }}>🚴</div>
                <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>No volunteers yet</p>
                <p style={{ fontSize: 13 }}>Share your Org Code <strong style={{ color: T.accentDark }}>{user?.orgCode}</strong> with volunteers when they register.</p>
              </div>
            ) : volunteers.map(vol => (
              <div key={vol.userId} className="card" style={{ padding: 16, marginBottom: 10 }}>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <div style={{ width: 44, height: 44, borderRadius: "50%", background: T.primaryGrad, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, color: "#fff", flexShrink: 0 }}>
                    {vol.name?.[0]?.toUpperCase() || "V"}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{vol.name}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <div style={{ width: 7, height: 7, borderRadius: "50%", background: vol.online ? T.success : T.border }} />
                        <span style={{ fontSize: 11, color: vol.online ? T.success : T.textLight, fontWeight: 600 }}>{vol.online ? "Online" : "Offline"}</span>
                      </div>
                      {vol.liveLocationEnabled && <span style={{ fontSize: 10, background: T.infoLight, color: T.info, padding: "1px 6px", borderRadius: 10, fontWeight: 700 }}>📡 Live</span>}
                    </div>
                    <div style={{ fontSize: 12, color: T.textMuted }}>{vol.email}</div>
                    <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                      <span style={{ fontSize: 11, background: T.accentLight, color: T.accentDark, padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>{vol.totalDelivered} delivered</span>
                      <span style={{ fontSize: 11, background: T.infoLight, color: T.info, padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>{vol.activeClaims} active</span>
                      {vol.badges?.length > 0 && <span style={{ fontSize: 11, background: T.amberLight, color: T.amber, padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>{vol.badges.map(b => b.icon).join("")}</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <button onClick={() => onStartChat(vol.userId, vol.name)} className="btn-secondary" style={{ fontSize: 11, padding: "5px 10px", display: "flex", alignItems: "center", gap: 4 }}>
                      <Icon name="message-2" size={12} /> Message
                    </button>
                    {vol.liveLocation?.length === 2 && (
                      <a href={`https://maps.google.com/maps?q=${vol.liveLocation[1]},${vol.liveLocation[0]}`} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 11, padding: "5px 10px", borderRadius: 10, border: `1px solid ${T.border}`, background: "#fff", textDecoration: "none", color: T.text, display: "flex", alignItems: "center", gap: 4 }}>
                        📡 Track
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {activeTab === "claims" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>All volunteer claims</h2>
            <p style={{ fontSize: 13, color: T.textMuted, marginBottom: 18 }}>All food claims made by volunteers linked to your organisation.</p>
            {orgClaims.length === 0 ? (
              <div className="card" style={{ padding: 48, textAlign: "center", color: T.textLight }}><div style={{ fontSize: 36, marginBottom: 8 }}>📋</div><p>No claims yet.</p></div>
            ) : orgClaims.map(claim => (
              <div key={claim._id} className="card" style={{ padding: 16, marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{claim.listing?.foodName || "Food"}</div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>By <strong>{claim.volunteerName || claim.claimantName}</strong> · from {claim.listing?.restaurantName}</div>
                  </div>
                  <span style={{ fontSize: 12, padding: "4px 12px", borderRadius: 20, fontWeight: 700, background: claim.status === "delivered" ? T.successLight : claim.status === "picked_up" ? T.infoLight : T.accentLight, color: claim.status === "delivered" ? T.success : claim.status === "picked_up" ? T.info : T.accentDark }}>
                    {claim.status?.replace("_", " ")}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: T.textMuted }}>
                  {claim.listing?.quantity} kg · {new Date(claim.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            ))}
          </div>
        )}
        {activeTab === "browse" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Browse available surplus</h2>
            <div style={{ padding: "12px 16px", background: T.accentLight, borderRadius: 10, marginBottom: 20, fontSize: 13, color: T.accentDark, display: "flex", gap: 8, alignItems: "flex-start" }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>ℹ️</span>
              <div>As an NGO admin, you cannot claim food directly. Your linked volunteers claim on your behalf. Share your Org Code <strong>{user?.orgCode}</strong> with volunteers to grow your team.</div>
            </div>
            {nearby.length === 0 ? (
              <div className="card" style={{ padding: 40, textAlign: "center", color: T.textLight }}><div style={{ fontSize: 36, marginBottom: 8 }}>🍽</div><p>No nearby surplus found.</p></div>
            ) : nearby.map(listing => {
              const hoursLeft = ((new Date(listing.expiresAt) - new Date()) / 3600000).toFixed(1);
              return (
                <div key={listing._id} className="card" style={{ padding: 16, marginBottom: 10, opacity: 0.9 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>{listing.foodName}</div>
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}><Icon name="building-store" size={12} /> {listing.restaurantName}</div>
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 700, background: T.accentLight, color: T.accentDark, padding: "3px 10px", borderRadius: 20 }}>{listing.quantity} kg</span>
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12 }}>⏰ {hoursLeft}h left · ~{listing.servings} servings{listing.isVeg ? " · 🟢 veg" : ""}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => onStartChat(listing.userId, listing.restaurantName)} className="btn-secondary" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                      <Icon name="message-2" size={13} /> Contact donor
                    </button>
                    {listing.location?.coordinates && (
                      <a href={`https://maps.google.com/maps?q=${listing.location.coordinates[1]},${listing.location.coordinates[0]}`}
                        target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ padding: "9px 12px", textDecoration: "none", display: "flex", alignItems: "center" }}>🗺</a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {activeTab === "donors" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>Nearby donors</h2>
            <NearbyOrgsPanel activeLocation={activeLocation} user={user} onStartChat={org => onStartChat(org.userId, org.locationName || org.name)} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Volunteer Dashboard ────────────────────────────────────────────────────
function VolunteerDashboard({ user, activeLocation, socket, onStartChat }) {
  const [activeTab, setActiveTab] = useState("deliveries");
  const [available, setAvailable] = useState([]);
  const [myClaims, setMyClaims] = useState([]);
  const [claimingId, setClaimingId] = useState(null);
  const [justClaimed, setJustClaimed] = useState({});
  const linkedNGO = user?.linkedNGO;
  const effectiveLoc = useEffectiveLocation(user);

  const fetchData = useCallback(async () => {
    try {
      const coords = activeLocation?.location?.coordinates || [78.3896, 17.4401];
      const lat = effectiveLoc.lat || coords[1];
      const lng = effectiveLoc.lng || coords[0];
      const [listings, claims] = await Promise.all([
        api(`/api/listings/nearby?lat=${lat}&lng=${lng}&radius=8000`),
        api("/api/claims/mine"),
      ]);
      setAvailable(listings);
      setMyClaims(claims);
    } catch {}
  }, [activeLocation?._id, effectiveLoc.lat, effectiveLoc.lng]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!socket) return;
    socket.on("listing:claimed", ({ listingId }) => {
      setJustClaimed(prev => ({ ...prev, [listingId]: "taken" }));
      setTimeout(() => { setAvailable(prev => prev.filter(l => l._id !== listingId)); setJustClaimed(prev => { const s = { ...prev }; delete s[listingId]; return s; }); }, 3000);
    });
        socket.on("listing:new", (listing) => { setAvailable(prev => [listing, ...prev.filter(l => l._id !== listing._id)]); });
    socket.on("listing:cancelled", ({ listingId }) => setAvailable(prev => prev.filter(l => l._id !== listingId)));
    socket.on("claim:updated", () => fetchData());
    return () => { socket.off("listing:claimed"); socket.off("listing:cancelled"); socket.off("listing:new"); socket.off("claim:updated"); };
  }, [socket]);

  const handleClaim = async (listing) => {
    if (claimingId) return;
    setClaimingId(listing._id);
    try {
      await api("/api/claims", { method: "POST", body: { listingId: listing._id } });
      setJustClaimed(prev => ({ ...prev, [listing._id]: "mine" }));
      setTimeout(() => { setAvailable(prev => prev.filter(l => l._id !== listing._id)); setJustClaimed(prev => { const s = { ...prev }; delete s[listing._id]; return s; }); fetchData(); }, 1500);
    } catch (e) {
      if (e.message.includes("claimed")) {
        setJustClaimed(prev => ({ ...prev, [listing._id]: "taken" }));
        setTimeout(() => { setAvailable(prev => prev.filter(l => l._id !== listing._id)); }, 3000);
      } else alert(e.message);
    }
    setClaimingId(null);
  };

  const markDone = async (claim) => {
    if (!window.confirm("Mark as delivered?")) return;
    try { await api(`/api/claims/${claim._id}/deliver`, { method: "PUT" }); fetchData(); }
    catch (e) { alert(e.message); }
  };

  const tabs = [
    { id: "deliveries", label: "Available pickups", icon: "truck-delivery" },
    { id: "active", label: `My deliveries (${myClaims.length})`, icon: "clipboard-check" },
    { id: "nearby", label: "Nearby orgs", icon: "building-community" },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "210px 1fr", height: "calc(100vh - 56px)", marginTop: 56 }}>
      <div style={{ background: T.bgCard, borderRight: `1px solid ${T.border}`, padding: "16px 12px", display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ padding: "8px 8px 14px", borderBottom: `1px solid ${T.borderLight}`, marginBottom: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{user?.name}</div>
          <div style={{ fontSize: 11, color: T.primary, marginTop: 2, fontWeight: 700 }}>🚴 Volunteer</div>
          {linkedNGO && (
            <div style={{ marginTop: 8, padding: "8px 10px", background: T.primaryLight, borderRadius: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 3 }}>Delivering for</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.primaryDark }}>{linkedNGO.locationName || linkedNGO.name}</div>
              <div style={{ fontSize: 10, color: T.primary, marginTop: 2 }}>{TYPE_ICONS[linkedNGO.locationType]} {TYPE_LABELS[linkedNGO.locationType]}</div>
            </div>
          )}
          <div style={{ marginTop: 8, padding: "6px 8px", background: effectiveLoc.liveEnabled ? T.accentLight : T.amberLight, borderRadius: 8, fontSize: 10, color: effectiveLoc.liveEnabled ? T.accentDark : T.amber }}>
            {effectiveLoc.liveEnabled ? "📡 Live location ON" : "📍 Enable live location (navbar)"}
          </div>
        </div>
        {tabs.map(item => (
          <button key={item.id} onClick={() => setActiveTab(item.id)}
            style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", borderRadius: 10, border: "none", background: activeTab === item.id ? T.primaryLight : "transparent", color: activeTab === item.id ? T.primaryDark : T.textMuted, fontSize: 13, fontWeight: activeTab === item.id ? 700 : 500, textAlign: "left", cursor: "pointer" }}>
            <Icon name={item.icon} size={14} />{item.label}
          </button>
        ))}
      </div>
      <div style={{ background: T.bg, overflowY: "auto", padding: 24 }}>
        {activeTab === "deliveries" && (
          <div className="fade-in">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>Available pickup tasks ({available.length})</h2>
              <button onClick={fetchData} className="btn-secondary" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}>
                <Icon name="refresh" size={13} /> Refresh
              </button>
            </div>
            {linkedNGO && (
              <div style={{ padding: "10px 14px", background: T.primaryLight, borderRadius: 10, marginBottom: 16, fontSize: 12, color: T.primaryDark }}>
                🏛 Claiming on behalf of <strong>{linkedNGO.locationName || linkedNGO.name}</strong>
              </div>
            )}
            {available.length === 0 ? (
              <div className="card" style={{ padding: 48, textAlign: "center", color: T.textLight }}>
                <div style={{ fontSize: 36, marginBottom: 8 }}>🚴</div>
                <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>No pickups available right now</p>
                <p style={{ fontSize: 13 }}>New listings appear in real time.</p>
              </div>
            ) : available.map(listing => {
              const hoursLeft = ((new Date(listing.expiresAt) - new Date()) / 3600000).toFixed(1);
              const isUrgent = hoursLeft < 2;
              const claimState = justClaimed[listing._id];
              let distStr = "";
              if (listing.distanceKm != null) distStr = `${listing.distanceKm} km${listing.viewerIsLive ? " 📡" : ""}`;
              else if (listing.distanceStatus === "enable_live_location") distStr = "📍 Enable live loc";
              return (
                <div key={listing._id} className="card fade-in" style={{ position: "relative", padding: 16, marginBottom: 10, borderLeft: isUrgent ? `3px solid ${T.danger}` : "3px solid transparent", overflow: "hidden" }}>
                  {claimState === "taken" && (
                    <div style={{ position: "absolute", inset: 0, background: "rgba(28,25,23,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10, borderRadius: 12 }}>
                      <div style={{ background: "#fff", borderRadius: 12, padding: "14px 24px", textAlign: "center" }}>
                        <div style={{ fontSize: 24, marginBottom: 6 }}>😔</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: T.danger }}>Already claimed!</div>
                      </div>
                    </div>
                  )}
                  {claimState === "mine" && (
                    <div style={{ position: "absolute", inset: 0, background: "rgba(27,122,110,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10, borderRadius: 12 }}>
                      <div style={{ textAlign: "center", color: "#fff" }}>
                        <div style={{ fontSize: 28, marginBottom: 6 }}>✅</div>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>You claimed it!</div>
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>{listing.foodName}</div>
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                        <Icon name="building-store" size={12} /> {listing.restaurantName}
                        {distStr ? <span style={{ color: T.info }}> · {distStr}</span> : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, background: T.accentLight, color: T.accentDark, padding: "3px 10px", borderRadius: 20 }}>{listing.quantity} kg</span>
                      {isUrgent && <span style={{ fontSize: 10, background: T.dangerLight, color: T.danger, padding: "1px 6px", borderRadius: 20, fontWeight: 700 }}>🔴 Urgent</span>}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 10 }}>⏰ {hoursLeft}h left · ~{listing.servings} servings{listing.isVeg ? " · 🟢 veg" : ""}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => handleClaim(listing)} disabled={!!claimingId || !!claimState} className="btn-volunteer" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                      {claimingId === listing._id ? "Claiming…" : <><Icon name="truck-delivery" size={13} /> Claim pickup</>}
                    </button>
                    <button onClick={() => onStartChat(listing.userId, listing.restaurantName)} className="btn-secondary" style={{ padding: "9px 12px" }}><Icon name="message-2" size={14} /></button>
                    {listing.location?.coordinates && (
                      <a href={`https://maps.google.com/maps?q=${listing.location.coordinates[1]},${listing.location.coordinates[0]}`}
                        target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ padding: "9px 12px", textDecoration: "none", display: "flex", alignItems: "center" }}>🗺</a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {activeTab === "active" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>My deliveries</h2>
            {myClaims.length === 0 ? (
              <div className="card" style={{ padding: 48, textAlign: "center", color: T.textLight }}><div style={{ fontSize: 36, marginBottom: 8 }}>📋</div><p>No active deliveries. Go claim some food!</p></div>
            ) : myClaims.map(claim => (
              <div key={claim._id} className="card" style={{ padding: 16, marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{claim.listing?.foodName || "Food"}</div>
                  <span style={{ fontSize: 12, background: claim.status === "delivered" ? T.successLight : T.accentLight, color: claim.status === "delivered" ? T.success : T.accentDark, padding: "3px 10px", borderRadius: 20, fontWeight: 600 }}>{claim.status?.replace("_", " ")}</span>
                </div>
                <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 10 }}>Pick up: <strong>{claim.listing?.restaurantName}</strong> · {claim.listing?.quantity} kg</div>
                                {claim.status === "confirmed" && <PickupQR claimId={claim._id} />}
                {claim.status === "picked_up" && (
                  <div style={{ marginBottom: 10, padding: "8px 12px", background: T.infoLight, color: T.info, borderRadius: 8, fontSize: 12, fontWeight: 600 }}>
                    ✅ Donor confirmed pickup. Deliver it safely!
                  </div>
                )}
                {claim.status === "picked_up" && (
                  <button onClick={() => markDone(claim)} className="btn-done" style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                    <Icon name="circle-check" size={15} /> Mark Delivery Done
                  </button>
                )}
                {claim.status === "delivered" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", background: T.successLight, borderRadius: 10, fontSize: 13, fontWeight: 600, color: T.success }}>
                    <Icon name="circle-check" size={14} /> Completed ✓
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {activeTab === "nearby" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>Nearby organisations</h2>
            <NearbyOrgsPanel activeLocation={activeLocation} user={user} onStartChat={org => onStartChat(org.userId, org.locationName || org.name)} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Restaurant/Hotel Dashboard ─────────────────────────────────────────────
function RestaurantDashboard({ user, activeLocation, socket, onStartChat }) {
  const [myListings, setMyListings] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [incomingClaims, setIncomingClaims] = useState([]);
  const [showPost, setShowPost] = useState(false);
    const [activeTab, setActiveTab] = useState("overview");
  const [showScan, setShowScan] = useState(false);

  const locType = activeLocation?.type;
  const isHotel = locType === "hotel";

  const fetchData = async () => {
    try {
      const [listings, claims] = await Promise.all([api("/api/listings/mine"), api("/api/claims/incoming")]);
      setMyListings(listings); setIncomingClaims(claims);
      if (activeLocation?._id) {
        try { setAnalytics(await api(`/api/analytics/restaurant/${activeLocation._id}`)); } catch {}
      }
    } catch {}
  };

  useEffect(() => { fetchData(); }, [activeLocation?._id]);
  useEffect(() => {
    if (!socket) return;
        socket.on("claim:new", fetchData);
    socket.on("claim:updated", fetchData);
    return () => { socket.off("claim:new"); socket.off("claim:updated"); };
  }, [socket]);

  const cancelListing = async (id) => {
    if (!window.confirm("Cancel this listing?")) return;
    try { await api(`/api/listings/${id}`, { method: "PUT", body: { status: "cancelled" } }); fetchData(); }
    catch (e) { alert(e.message); }
  };

  const confirmPickupDone = async (claim) => {
    if (!window.confirm("Confirm the food has been picked up?")) return;
    try { await api(`/api/claims/${claim._id}/deliver`, { method: "PUT" }); fetchData(); alert("✅ Pickup confirmed!"); }
    catch (e) { alert(e.message); }
  };

  const statusStyle = (s) => ({
    active: { background: T.accentLight, color: T.accentDark },
    claimed: { background: T.infoLight, color: T.info },
    delivered: { background: T.successLight, color: T.success },
    expired: { background: T.bgMuted, color: T.textMuted },
    cancelled: { background: T.bgMuted, color: T.textMuted },
  }[s] || { background: T.bgMuted, color: T.textMuted });

  const tabs = [
    { id: "overview", label: "Overview", icon: "layout-dashboard" },
    { id: "listings", label: "My listings", icon: "list" },
    { id: "incoming", label: `Incoming (${incomingClaims.length})`, icon: "inbox" },
    { id: "nearby", label: "Nearby NGOs", icon: "building-community" },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "210px 1fr", height: "calc(100vh - 56px)", marginTop: 56 }}>
      <div style={{ background: T.bgCard, borderRight: `1px solid ${T.border}`, padding: "16px 12px", display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ padding: "8px 8px 14px", borderBottom: `1px solid ${T.borderLight}`, marginBottom: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{activeLocation?.name}</div>
          <div style={{ fontSize: 11, color: T.info, marginTop: 2, fontWeight: 700 }}>{isHotel ? "🏨 Hotel" : "🍽 Restaurant"}</div>
          <div style={{ marginTop: 8, padding: "6px 8px", background: T.infoLight, borderRadius: 8, fontSize: 10, color: T.info, lineHeight: 1.4 }}>
            You post food. NGOs & volunteers claim it.
          </div>
        </div>
        {tabs.map(item => (
          <button key={item.id} onClick={() => setActiveTab(item.id)}
            style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", borderRadius: 10, border: "none", background: activeTab === item.id ? T.primaryLight : "transparent", color: activeTab === item.id ? T.primaryDark : T.textMuted, fontSize: 13, fontWeight: activeTab === item.id ? 700 : 500, textAlign: "left", cursor: "pointer" }}>
            <Icon name={item.icon} size={14} />{item.label}
          </button>
        ))}
        <div style={{ marginTop: "auto", paddingTop: 12, borderTop: `1px solid ${T.borderLight}` }}>
          <button onClick={() => setShowPost(true)} className="btn-primary" style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Icon name="plus" size={14} /> Post surplus
          </button>
        </div>
      </div>
      <div style={{ background: T.bg, overflowY: "auto", padding: 24 }}>
        {activeTab === "overview" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>Today's overview</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 20 }}>
              <StatCard label="Kg saved today" value={analytics?.todayKg || 0} sub="kilograms" icon="🥗" />
              <StatCard label="Active listings" value={analytics?.activeListings || 0} sub="live now" icon="📋" color={T.info} />
              <StatCard label="Claimed this month" value={analytics?.claimedListings || 0} sub="pickups" icon="✅" color="#5B21B6" />
              <StatCard label="CO₂ offset" value={`${analytics?.co2Offset || 0} kg`} sub="estimated" icon="🌱" />
            </div>
            <div className="card" style={{ padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>📊 How it works</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                {[
                  { icon: "📦", title: "Post surplus", desc: "Add food you can't use before it expires" },
                  { icon: "🔔", title: "NGOs are notified", desc: "Nearby organisations & volunteers see your listing" },
                  { icon: "🚴", title: "Volunteer picks up", desc: "Food gets delivered to people who need it" },
                ].map((step, i) => (
                  <div key={i} style={{ padding: 14, background: T.bgMuted, borderRadius: 12, textAlign: "center" }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>{step.icon}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{step.title}</div>
                    <div style={{ fontSize: 11, color: T.textMuted }}>{step.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {activeTab === "listings" && (
          <div className="fade-in">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>All listings</h2>
              <button onClick={() => setShowPost(true)} className="btn-primary" style={{ display: "flex", alignItems: "center", gap: 6 }}><Icon name="plus" size={13} /> New listing</button>
            </div>
            {myListings.length === 0 ? (
              <div className="card" style={{ padding: 48, textAlign: "center", color: T.textLight }}>
                <div style={{ fontSize: 36, marginBottom: 8 }}>📋</div>
                <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>No listings yet</p>
                <button onClick={() => setShowPost(true)} className="btn-primary">Post your first surplus →</button>
              </div>
            ) : (
              <div className="card" style={{ overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 70px", padding: "8px 16px", background: T.bgMuted, borderBottom: `1px solid ${T.border}`, fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  <span>Food</span><span>Qty</span><span>Expires</span><span>Status</span><span></span>
                </div>
                {myListings.map(l => (
                  <div key={l._id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 70px", padding: "12px 16px", borderBottom: `1px solid ${T.borderLight}`, fontSize: 13, alignItems: "center" }}>
                    <span style={{ fontWeight: 500 }}>{l.foodName}</span>
                    <span>{l.quantity} kg</span>
                    <span style={{ color: T.textMuted, fontSize: 12 }}>{new Date(l.expiresAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                    <span><span style={{ ...statusStyle(l.status), fontSize: 11, padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>{l.status}</span></span>
                    <span>{l.status === "active" && <button onClick={() => cancelListing(l._id)} style={{ background: "none", border: "none", color: T.danger, fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Cancel</button>}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {activeTab === "incoming" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>Claim requests ({incomingClaims.length})</h2>
            {incomingClaims.length === 0 ? (
              <div className="card" style={{ padding: 48, textAlign: "center", color: T.textLight }}><div style={{ fontSize: 36, marginBottom: 8 }}>📥</div><p>No incoming claims yet.</p></div>
            ) : incomingClaims.map(claim => (
              <div key={claim._id} className="card" style={{ padding: 18, marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{claim.claimantName}</div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{TYPE_LABELS[claim.claimantLocationType] || claim.claimantLocationType} · {new Date(claim.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
                  </div>
                  <span style={{ fontSize: 12, padding: "4px 12px", borderRadius: 20, fontWeight: 700, ...(claim.status === "delivered" ? { background: T.successLight, color: T.success } : claim.status === "picked_up" ? { background: T.infoLight, color: T.info } : { background: T.accentLight, color: T.accentDark }) }}>
                    {claim.status?.replace("_", " ")}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: T.text, marginBottom: 12, padding: "8px 12px", background: T.bgMuted, borderRadius: 10 }}>
                  Claiming: <strong>{claim.listing?.foodName}</strong> · {claim.listing?.quantity} kg
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                    {claim.status === "confirmed" && (
                    <button onClick={() => setShowScan(true)} className="btn-done" style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, justifyContent: "center" }}>
                      <Icon name="qrcode" size={14} /> Scan pickup QR
                    </button>
                  )}
                  {claim.status === "picked_up" && (
                    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, padding: "9px 12px", background: T.infoLight, borderRadius: 10, fontSize: 13, fontWeight: 600, color: T.info }}>
                      <Icon name="circle-check" size={14} /> Handed over. Being delivered
                    </div>
                  )}
                  {claim.status === "delivered" && (
                    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, padding: "9px 12px", background: T.successLight, borderRadius: 10, fontSize: 13, fontWeight: 600, color: T.success }}>
                      <Icon name="circle-check" size={14} /> Pickup completed ✓
                    </div>
                  )}
                  <button onClick={() => onStartChat(claim.claimantUserId, claim.claimantName)} className="btn-secondary" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 5, padding: "9px 14px" }}>
                    <Icon name="message-2" size={13} /> Chat
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {activeTab === "nearby" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>NGOs & receivers near you</h2>
            <NearbyOrgsPanel activeLocation={activeLocation} user={user} onStartChat={org => onStartChat(org.userId, org.locationName || org.name)} />
          </div>
        )}
      </div>
            {showPost && <PostModal user={user} activeLocation={activeLocation} onClose={() => setShowPost(false)} onSuccess={fetchData} />}
      {showScan && <ScanPickupModal onClose={() => setShowScan(false)} onDone={fetchData} />}
    </div>
  );
}

// ── Individual Dashboard

// ── Individual Dashboard ───────────────────────────────────────────────────
function IndividualDashboard({ user, activeLocation, onStartChat }) {
  const [activeTab, setActiveTab] = useState("browse");
  const [showPost, setShowPost] = useState(false);
  const [nearby, setNearby] = useState([]);
  const [myListings, setMyListings] = useState([]);
    const [myClaims, setMyClaims] = useState([]);
  const [incoming, setIncoming] = useState([]);
  const [showScan, setShowScan] = useState(false);
  const effectiveLoc = useEffectiveLocation(user);

  const fetchData = useCallback(async () => {
    try {
      const coords = activeLocation?.location?.coordinates || [78.3896, 17.4401];
      const lat = effectiveLoc.lat || coords[1];
      const lng = effectiveLoc.lng || coords[0];
      const [n, l, c, inc] = await Promise.all([api(`/api/listings/nearby?lat=${lat}&lng=${lng}&radius=5000`), api("/api/listings/mine"), api("/api/claims/mine"), api("/api/claims/incoming")]);
      setNearby(n); setMyListings(l); setMyClaims(c); setIncoming(inc);
    } catch {}
  }, [activeLocation?._id, effectiveLoc.lat, effectiveLoc.lng]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleClaim = async (listing) => {
    try { await api("/api/claims", { method: "POST", body: { listingId: listing._id } }); fetchData(); alert("✅ Claimed! Check 'My claims'."); }
    catch (e) { alert(e.message); }
  };

  const markDone = async (claim) => {
    if (!window.confirm("Mark pickup as completed?")) return;
    try { await api(`/api/claims/${claim._id}/deliver`, { method: "PUT" }); fetchData(); }
    catch (e) { alert(e.message); }
  };

  const tabs = [
    { id: "browse", label: "Browse surplus", icon: "map-search" },
    { id: "donate", label: "Share food", icon: "heart" },
    { id: "myPosts", label: `My posts (${myListings.length})`, icon: "list" },
    { id: "claims", label: `My claims (${myClaims.length})`, icon: "clipboard-check" },
    { id: "handover", label: `Handovers (${incoming.filter(c => c.status === "confirmed").length})`, icon: "qrcode" },
    { id: "ngos", label: "Nearby NGOs", icon: "building-community" },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "210px 1fr", height: "calc(100vh - 56px)", marginTop: 56 }}>
      <div style={{ background: T.bgCard, borderRight: `1px solid ${T.border}`, padding: "16px 12px", display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ padding: "8px 8px 14px", borderBottom: `1px solid ${T.borderLight}`, marginBottom: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{user?.name}</div>
          <div style={{ fontSize: 11, color: T.amber, marginTop: 2, fontWeight: 700 }}>👤 Individual</div>
          <div style={{ marginTop: 8, padding: "6px 8px", background: effectiveLoc.liveEnabled ? T.accentLight : T.amberLight, borderRadius: 8, fontSize: 10, color: effectiveLoc.liveEnabled ? T.accentDark : T.amber }}>
            {effectiveLoc.liveEnabled ? "📡 Live location active" : "📍 Enable live location (navbar)"}
          </div>
        </div>
        {tabs.map(item => (
          <button key={item.id} onClick={() => setActiveTab(item.id)}
            style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", borderRadius: 10, border: "none", background: activeTab === item.id ? T.amberLight : "transparent", color: activeTab === item.id ? "#92400E" : T.textMuted, fontSize: 13, fontWeight: activeTab === item.id ? 700 : 500, textAlign: "left", cursor: "pointer" }}>
            <Icon name={item.icon} size={14} />{item.label}
          </button>
        ))}
        <div style={{ marginTop: "auto", paddingTop: 12, borderTop: `1px solid ${T.borderLight}` }}>
          <button onClick={() => setShowPost(true)} style={{ width: "100%", padding: "9px", background: T.primaryGrad, color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>+ Share food</button>
        </div>
      </div>
      <div style={{ background: T.bg, overflowY: "auto", padding: 24 }}>
        {activeTab === "browse" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>Food near you ({nearby.length})</h2>
            {nearby.length === 0 ? (
              <div className="card" style={{ padding: 48, textAlign: "center", color: T.textLight }}><div style={{ fontSize: 36, marginBottom: 8 }}>🍽</div><p>No surplus food found nearby right now.</p></div>
            ) : nearby.map(listing => {
              const hoursLeft = ((new Date(listing.expiresAt) - new Date()) / 3600000).toFixed(1);
              let distStr = "";
              if (listing.distanceKm != null) distStr = `${listing.distanceKm} km${listing.viewerIsLive ? " 📡" : ""}`;
              else if (listing.distanceStatus === "enable_live_location") distStr = "📍 Enable live loc";
              return (
                <div key={listing._id} className="card" style={{ padding: 16, marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>{listing.foodName}</div>
                      <div style={{ fontSize: 12, color: T.textMuted }}>{listing.restaurantName}{distStr ? <span style={{ color: T.info }}> · {distStr}</span> : ""}</div>
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 700, background: T.accentLight, color: T.accentDark, padding: "3px 10px", borderRadius: 20 }}>{listing.quantity} kg</span>
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12 }}>⏰ {hoursLeft}h left · ~{listing.servings} servings{listing.isVeg ? " · 🟢 veg" : ""}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => handleClaim(listing)} className="btn-primary" style={{ flex: 1 }}>Claim</button>
                    <button onClick={() => onStartChat(listing.userId, listing.restaurantName)} className="btn-secondary" style={{ display: "flex", alignItems: "center", gap: 5 }}><Icon name="message-2" size={13} /> Chat</button>
                    {listing.location?.coordinates && (
                      <a href={`https://maps.google.com/maps?q=${listing.location.coordinates[1]},${listing.location.coordinates[0]}`}
                        target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ padding: "9px 12px", textDecoration: "none", display: "flex", alignItems: "center" }}>🗺</a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {activeTab === "donate" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>Share your food</h2>
            <div className="card" style={{ padding: 32, textAlign: "center", border: `2px dashed ${T.border}` }}>
              <div style={{ fontSize: 52, marginBottom: 14 }}>🍲</div>
              <p style={{ fontSize: 14, color: T.textMuted, marginBottom: 16 }}>Have leftover food? Share it with someone who needs it.</p>
              <button onClick={() => setShowPost(true)} className="btn-primary" style={{ padding: "11px 28px", fontSize: 14 }}>Post food now</button>
            </div>
          </div>
        )}
        {activeTab === "myPosts" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>My posts</h2>
            {myListings.length === 0 ? <div className="card" style={{ padding: 40, textAlign: "center", color: T.textLight }}>No posts yet.</div>
              : myListings.map(l => (
              <div key={l._id} className="card" style={{ padding: 14, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div><div style={{ fontSize: 14, fontWeight: 600 }}>{l.foodName}</div><div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>{l.quantity} kg</div></div>
                <span style={{ fontSize: 11, background: l.status === "active" ? T.accentLight : T.bgMuted, color: l.status === "active" ? T.accentDark : T.textMuted, padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>{l.status}</span>
              </div>
            ))}
          </div>
        )}
        {activeTab === "claims" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>My claims</h2>
            {myClaims.length === 0 ? <div className="card" style={{ padding: 40, textAlign: "center", color: T.textLight }}>No claims yet. Browse nearby food!</div>
              : myClaims.map(c => (
              <div key={c._id} className="card" style={{ padding: 14, marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{c.listing?.foodName || "Food"}</div>
                  <span style={{ fontSize: 11, background: T.accentLight, color: T.accentDark, padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>{c.status?.replace("_", " ")}</span>
                </div>
                <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 8 }}>{c.listing?.restaurantName} · {c.listing?.quantity} kg</div>
                                {c.status === "confirmed" && <PickupQR claimId={c._id} />}
                {c.status === "picked_up" && (
                  <button onClick={() => markDone(c)} className="btn-done" style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                    <Icon name="circle-check" size={14} /> Mark Delivered
                  </button>
                )}
                {c.status === "delivered" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", background: T.successLight, borderRadius: 10, fontSize: 13, fontWeight: 600, color: T.success }}>
                    <Icon name="circle-check" size={14} /> Completed ✓
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
                {activeTab === "handover" && (
          <div className="fade-in">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>Food you're handing over</h2>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={fetchData} className="btn-secondary" style={{ fontSize: 12 }}>Refresh</button>
                <button onClick={() => setShowScan(true)} className="btn-done" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}>
                  <Icon name="qrcode" size={13} /> Scan pickup QR
                </button>
              </div>
            </div>
            {incoming.length === 0 ? (
              <div className="card" style={{ padding: 40, textAlign: "center", color: T.textLight }}>No one has claimed your food yet.</div>
            ) : incoming.map(c => (
              <div key={c._id} className="card" style={{ padding: 14, marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{c.listing?.foodName} · {c.listing?.quantity} kg</div>
                  <span style={{ fontSize: 11, background: T.accentLight, color: T.accentDark, padding: "2px 8px", borderRadius: 20, fontWeight: 600 }}>{c.status?.replace("_", " ")}</span>
                </div>
                <div style={{ fontSize: 12, color: T.textMuted }}>Claimed by <strong>{c.claimantName}</strong></div>
              </div>
            ))}
          </div>
        )}
        {activeTab === "ngos" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>NGOs & shelters near you</h2>
            <NearbyOrgsPanel activeLocation={activeLocation} user={user} onStartChat={org => onStartChat(org.userId, org.locationName || org.name)} />
          </div>
        )}
      </div>
            {showPost && <PostModal user={user} activeLocation={activeLocation} onClose={() => setShowPost(false)} onSuccess={fetchData} />}
      {showScan && <ScanPickupModal onClose={() => setShowScan(false)} onDone={fetchData} />}
    </div>
  );
}

// ── Claims Page

// ── Claims Page ────────────────────────────────────────────────────────────
function ClaimsPage({ user, activeLocation, onStartChat, socket }) {
  const [claims, setClaims] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");

  const fetchClaims = async () => {
    setLoading(true);
    try { setClaims(await api("/api/claims/mine")); } catch {}
    setLoading(false);
  };
    useEffect(() => { fetchClaims(); }, []);
  useEffect(() => {
    if (!socket) return;
    const h = () => fetchClaims();
    socket.on("claim:updated", h);
    return () => socket.off("claim:updated", h);
  }, [socket]);

  const markDone = async (claim) => {
    if (!window.confirm("Mark as completed?")) return;
    try { await api(`/api/claims/${claim._id}/deliver`, { method: "PUT" }); fetchClaims(); } catch (e) { alert(e.message); }
  };

  const filtered = filter === "all" ? claims : claims.filter(c => c.status === filter);

  return (
    <div style={{ marginTop: 56, padding: "28px 32px", background: T.bg, minHeight: "calc(100vh - 56px)" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 20 }}>My claims</h1>
        <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
          {["all", "confirmed", "picked_up", "delivered", "cancelled"].map(s => (
            <button key={s} onClick={() => setFilter(s)}
              style={{ padding: "5px 14px", borderRadius: 20, fontSize: 12, border: filter === s ? `1px solid ${T.primary}` : `1px solid ${T.border}`, background: filter === s ? T.primaryLight : "#fff", color: filter === s ? T.primaryDark : T.textMuted, cursor: "pointer", fontWeight: filter === s ? 700 : 400, textTransform: "capitalize" }}>
              {s.replace("_", " ")}
            </button>
          ))}
        </div>
        {loading ? <div style={{ textAlign: "center", padding: 60, color: T.textLight }}>Loading…</div>
          : filtered.length === 0 ? <div className="card" style={{ padding: 48, textAlign: "center", color: T.textLight }}>No claims found.</div>
          : filtered.map(claim => (
            <div key={claim._id} className="card fade-in" style={{ padding: 18, marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{claim.listing?.foodName || "Food listing"}</div>
                <span style={{ fontSize: 12, background: claim.status === "delivered" ? T.successLight : T.accentLight, color: claim.status === "delivered" ? T.success : T.accentDark, padding: "4px 12px", borderRadius: 20, fontWeight: 700, textTransform: "capitalize" }}>{claim.status?.replace("_", " ")}</span>
              </div>
              <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12 }}>{claim.listing?.restaurantName} · {claim.listing?.quantity} kg</div>
              {claim.status === "confirmed" && <PickupQR claimId={claim._id} />}
              <div style={{ display: "flex", gap: 8 }}>
                {claim.listing?.location?.coordinates && (
                  <a href={`https://maps.google.com/maps?q=${claim.listing.location.coordinates[1]},${claim.listing.location.coordinates[0]}`}
                    target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ textDecoration: "none", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}>
                    <Icon name="brand-google-maps" size={13} /> Navigate
                  </a>
                )}
                {claim.status === "picked_up" && (
                  <button onClick={() => markDone(claim)} className="btn-done" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                    <Icon name="circle-check" size={14} /> Mark Done
                  </button>
                )}
              </div>
              {claim.status === "delivered" && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", background: T.successLight, borderRadius: 10, fontSize: 13, fontWeight: 600, color: T.success, marginTop: 8 }}>
                  <Icon name="circle-check" size={14} /> Completed ✓
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

// ── Chat Page ──────────────────────────────────────────────────────────────
function ChatPage({ user, socket, initialContact }) {
  const [rooms, setRooms] = useState([]);
  const [activeRoom, setActiveRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [searchContact, setSearchContact] = useState("");
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const messagesEndRef = useRef(null);
  const pendingRoomRef = useRef(null);

  const fetchRooms = async () => { try { setRooms(await api("/api/chat/rooms")); } catch {} };
  useEffect(() => { fetchRooms(); }, []);

  useEffect(() => {
    if (!initialContact || rooms.length === 0) return;
    const existing = rooms.find(r => r.otherUserId === initialContact.userId);
    if (existing) setActiveRoom(existing);
    else {
      pendingRoomRef.current = initialContact;
      setActiveRoom({ _id: null, otherUserId: initialContact.userId, otherName: initialContact.name, _new: true });
    }
  }, [initialContact, rooms.length]);

  useEffect(() => {
    if (!activeRoom?._id) return;
    const fetch = async () => {
      setLoadingMsgs(true);
      try { setMessages(await api(`/api/chat/rooms/${activeRoom._id}/messages`)); } catch {}
      setLoadingMsgs(false);
    };
    fetch();
    socket?.emit("join_room", { roomId: activeRoom._id });
    return () => { socket?.emit("leave_room", { roomId: activeRoom._id }); };
  }, [activeRoom?._id]);

  useEffect(() => {
    if (!socket) return;
    const handleMsg = (msg) => {
      if (msg.roomId === activeRoom?._id) setMessages(prev => [...prev, msg]);
      fetchRooms();
    };
    socket.on("chat:message", handleMsg);
    socket.on("room:new", (room) => {
      setRooms(prev => [room, ...prev.filter(r => r._id !== room._id)]);
      // Auto-activate room if it matches the pending new-chat contact
      if (pendingRoomRef.current && room.participants?.includes(pendingRoomRef.current.userId)) {
        setActiveRoom({ ...room, otherUserId: pendingRoomRef.current.userId, otherName: pendingRoomRef.current.name });
        pendingRoomRef.current = null;
      }
    });
    return () => { socket.off("chat:message", handleMsg); socket.off("room:new"); };
  }, [socket, activeRoom?._id]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || !activeRoom) return;
    const text = input.trim();
    setInput("");
    if (activeRoom._new || !activeRoom._id) {
      try {
        const room = await api("/api/chat/rooms", { method: "POST", body: { participantIds: [activeRoom.otherUserId], name: activeRoom.otherName } });
        const updatedRoom = { ...room, otherUserId: activeRoom.otherUserId, otherName: activeRoom.otherName };
        setActiveRoom(updatedRoom);
        setRooms(prev => [updatedRoom, ...prev.filter(r => r._id !== room._id)]);
        socket?.emit("chat_message", { roomId: room._id, text });
      } catch {}
    } else {
      socket?.emit("chat_message", { roomId: activeRoom._id, text });
    }
  };

  const filteredRooms = rooms.filter(r => (r.otherName || "").toLowerCase().includes(searchContact.toLowerCase()));
  const myId = user?._id;

  return (
    <div style={{ display: "flex", height: "calc(100vh - 56px)", marginTop: 56 }}>
      <div style={{ width: 300, background: T.bgCard, borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 16px 10px", borderBottom: `1px solid ${T.border}` }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Messages</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: T.bgMuted, borderRadius: 10, padding: "7px 10px" }}>
            <Icon name="search" size={14} />
            <input placeholder="Search conversations…" value={searchContact} onChange={e => setSearchContact(e.target.value)}
              style={{ background: "transparent", border: "none", outline: "none", fontSize: 13, flex: 1 }} />
          </div>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {filteredRooms.length === 0 && <div style={{ padding: 32, textAlign: "center", color: T.textLight, fontSize: 13 }}><div style={{ fontSize: 32, marginBottom: 8 }}>💬</div>No conversations yet.</div>}
          {filteredRooms.map(room => (
            <div key={room._id || room.otherUserId} onClick={() => { setActiveRoom(room); setMessages([]); }}
              style={{ padding: "12px 16px", borderBottom: `1px solid ${T.borderLight}`, cursor: "pointer", background: activeRoom?._id === room._id ? T.primaryLight : T.bgCard }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{room.otherName || room.name || "User"}</span>
                <span style={{ fontSize: 11, color: T.textLight }}>{room.lastMessageAt ? new Date(room.lastMessageAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
              </div>
              <div style={{ fontSize: 12, color: T.textMuted, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{room.lastMessage || "Start a conversation"}</div>
              {room.unreadCount > 0 && <div style={{ marginTop: 4, display: "flex", justifyContent: "flex-end" }}><span style={{ background: T.danger, color: "#fff", fontSize: 10, padding: "1px 6px", borderRadius: 10, fontWeight: 700 }}>{room.unreadCount}</span></div>}
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: T.bg }}>
        {!activeRoom ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: T.textLight }}>
            <div style={{ fontSize: 52, marginBottom: 14 }}>💬</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: T.textMuted }}>Select a conversation</div>
          </div>
        ) : (
          <>
            <div style={{ background: T.bgCard, padding: "14px 20px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 38, height: 38, borderRadius: "50%", background: T.primaryGrad, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#fff" }}>
                {(activeRoom.otherName || "?")[0]?.toUpperCase()}
              </div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{activeRoom.otherName || "User"}</div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
              {loadingMsgs ? <div style={{ textAlign: "center", color: T.textLight, padding: 40 }}>Loading…</div>
                : messages.map((msg, i) => {
                  const isMine = (msg.senderId || msg.fromUserId) === myId;
                  return (
                    <div key={msg._id || i} style={{ display: "flex", justifyContent: isMine ? "flex-end" : "flex-start" }}>
                      <div style={{ maxWidth: "72%", padding: "10px 14px", borderRadius: isMine ? "16px 16px 4px 16px" : "16px 16px 16px 4px", background: isMine ? T.primaryGrad : T.bgCard, color: isMine ? "#fff" : T.text, fontSize: 13, lineHeight: 1.5, boxShadow: T.shadow, opacity: msg.pending ? 0.65 : 1 }}>
                        {msg.text}
                        <div style={{ fontSize: 10, marginTop: 4, opacity: 0.6, textAlign: "right" }}>
                          {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              <div ref={messagesEndRef} />
            </div>
            <div style={{ background: T.bgCard, padding: "12px 16px", borderTop: `1px solid ${T.border}`, display: "flex", gap: 10, alignItems: "flex-end" }}>
              <textarea value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                placeholder="Type a message… (Enter to send)" rows={1}
                style={{ flex: 1, padding: "10px 14px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 13, resize: "none", outline: "none", lineHeight: 1.5, maxHeight: 100, fontFamily: "'Plus Jakarta Sans', sans-serif" }} />
              <button onClick={sendMessage} disabled={!input.trim()} className="btn-primary" style={{ padding: "10px 16px" }}>
                <Icon name="send" size={14} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Auth Page ──────────────────────────────────────────────────────────────
function AuthPage({ onLogin }) {
  const [mode, setMode] = useState("login");
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", email: "", password: "", confirmPassword: "", locationType: "restaurant", locationName: "", locationAddress: "", locationLat: "", locationLng: "" });
  const [orgCodeInput, setOrgCodeInput] = useState("");
  const [orgCodeLookup, setOrgCodeLookup] = useState(null);
  const [orgCodeLoading, setOrgCodeLoading] = useState(false);
  const [orgCodeError, setOrgCodeError] = useState("");
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isVolunteer = form.locationType === "volunteer";
  const totalSteps = isVolunteer ? 3 : 2;

  const userTypes = [
    { val: "restaurant", label: "Restaurant", icon: "🍽", desc: "Post surplus food for pickup" },
    { val: "hotel", label: "Hotel", icon: "🏨", desc: "Share excess food from your hotel" },
    { val: "ngo", label: "NGO / Charity", icon: "🏛", desc: "Manage volunteers & track pickups" },
    { val: "orphanage", label: "Orphanage / Shelter", icon: "🏠", desc: "Receive food for your residents" },
    { val: "individual", label: "Individual", icon: "👤", desc: "Share or claim food nearby" },
    { val: "volunteer", label: "Volunteer", icon: "🚴", desc: "Deliver food between donors & NGOs" },
  ];

  const lookupOrgCode = async (code) => {
    if (code.length < 4) { setOrgCodeLookup(null); setOrgCodeError(""); return; }
    setOrgCodeLoading(true); setOrgCodeError("");
    try { setOrgCodeLookup(await api(`/api/org/lookup/${code.trim().toUpperCase()}`)); }
    catch (e) { setOrgCodeLookup(null); setOrgCodeError(e.message || "Organisation not found"); }
    setOrgCodeLoading(false);
  };

  useEffect(() => { const t = setTimeout(() => lookupOrgCode(orgCodeInput), 500); return () => clearTimeout(t); }, [orgCodeInput]);

  const handleLogin = async (e) => {
    e.preventDefault(); setLoading(true); setError("");
    try {
      const data = await api("/api/auth/login", { method: "POST", body: { email: form.email, password: form.password } });
      localStorage.setItem("fs_token", data.token); onLogin(data.user);
    } catch (err) { setError(err.message); }
    setLoading(false);
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    if (step === 1) { setStep(2); return; }
    if (step === 2 && isVolunteer) { setStep(3); return; }
    if (form.password !== form.confirmPassword) { setError("Passwords don't match"); return; }
    if (isVolunteer && !orgCodeLookup) { setError("Please enter a valid Org Code from your NGO."); return; }
    setLoading(true); setError("");
    try {
      const body = {
        name: form.name, email: form.email, password: form.password,
        locationType: form.locationType, locationName: form.locationName,
        locationAddress: form.locationAddress,
        coordinates: form.locationLat && form.locationLng ? [parseFloat(form.locationLng), parseFloat(form.locationLat)] : undefined,
        orgCode: isVolunteer ? orgCodeInput.trim().toUpperCase() : undefined,
      };
      const data = await api("/api/auth/register", { method: "POST", body });
      localStorage.setItem("fs_token", data.token); onLogin(data.user);
    } catch (err) { setError(err.message); }
    setLoading(false);
  };

  const handleTypeChange = (val) => { set("locationType", val); set("locationName", ""); setOrgCodeLookup(null); setOrgCodeInput(""); setError(""); };

  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(135deg, ${T.bg} 0%, #FEF0E9 50%, ${T.bg} 100%)`, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ display: "flex", width: "100%", maxWidth: 960, background: T.bgCard, borderRadius: 24, overflow: "hidden", boxShadow: T.shadowLg }}>
        <div style={{ flex: 1, background: `linear-gradient(160deg,#7A1F06 0%,${T.primary} 50%,${T.amber} 100%)`, padding: "48px 40px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 40 }}>
              <BrandIcon size={44} />
              <span style={{ fontFamily: "'Lora', serif", fontSize: 28, color: "#fff" }}>FoodSave</span>
            </div>
            <h1 style={{ fontFamily: "'Lora', serif", fontSize: 36, color: "#fff", lineHeight: 1.2, marginBottom: 14 }}>Rescue food.<br />Feed communities.</h1>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.85)", lineHeight: 1.7, marginBottom: 32 }}>
              Connect restaurants & hotels with surplus food to NGOs, shelters, and individuals — in real time.
            </p>
            {[
              { icon: "🍲", text: "Real-time surplus listings on a live map" },
              { icon: "🚴", text: "Volunteers linked to NGOs for fast delivery" },
              { icon: "💬", text: "Direct chat with donors and receivers" },
              { icon: "✨", text: "Smart assistant, waste forecasting & impact reports" },
            ].map((item, i) => (
              <div key={i} style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <span style={{ fontSize: 16 }}>{item.icon}</span>
                <span style={{ fontSize: 13, color: "rgba(255,255,255,0.88)" }}>{item.text}</span>
              </div>
            ))}
          </div>
          <div style={{ padding: "14px 16px", background: "rgba(255,255,255,0.12)", borderRadius: 12, marginTop: 24 }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", lineHeight: 1.6 }}>
              🌍 Reducing food waste by connecting donors, NGOs and volunteers in your city.
            </div>
          </div>
        </div>
        <div style={{ width: 440, padding: "44px 36px", display: "flex", flexDirection: "column", overflowY: "auto" }}>
          <div style={{ display: "flex", background: T.bgMuted, borderRadius: 12, padding: 4, marginBottom: 28 }}>
            {["login", "register"].map(m => (
              <button key={m} onClick={() => { setMode(m); setStep(1); setError(""); setOrgCodeLookup(null); setOrgCodeInput(""); }}
                style={{ flex: 1, padding: "8px 0", borderRadius: 9, border: "none", background: mode === m ? T.bgCard : "transparent", color: mode === m ? T.text : T.textMuted, fontSize: 13, fontWeight: mode === m ? 700 : 500, cursor: "pointer", boxShadow: mode === m ? T.shadow : "none" }}>
                {m === "login" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>
          {error && <div style={{ background: T.dangerLight, color: T.danger, padding: "10px 14px", borderRadius: 10, fontSize: 13, marginBottom: 14, fontWeight: 500 }}>{error}</div>}
          {mode === "login" ? (
            <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {[{ label: "Email", key: "email", type: "email" }, { label: "Password", key: "password", type: "password" }].map(({ label, key, type }) => (
                <div key={key}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>{label}</label>
                  <input type={type} required value={form[key]} onChange={e => set(key, e.target.value)}
                    style={{ width: "100%", padding: "11px 13px", border: `1.5px solid ${T.border}`, borderRadius: 11, fontSize: 13 }} />
                </div>
              ))}
              <button type="submit" disabled={loading} className="btn-primary" style={{ width: "100%", padding: 13, fontSize: 14, marginTop: 4 }}>
                {loading ? "Signing in…" : "Sign in →"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleRegister}>
              <div style={{ display: "flex", gap: 6, marginBottom: 22 }}>
                {Array.from({ length: totalSteps }).map((_, i) => (
                  <div key={i} style={{ flex: 1, height: 3, borderRadius: 4, background: step > i ? T.primary : step === i + 1 ? `${T.primary}66` : T.border, transition: "background 0.3s" }} />
                ))}
              </div>
              <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 16, fontWeight: 600 }}>
                Step {step} of {totalSteps} — {step === 1 ? "Account details" : step === 2 ? "Your role & location" : "Link your NGO"}
              </div>
              {step === 1 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {[{ label: "Full name", key: "name", type: "text" }, { label: "Email", key: "email", type: "email" }, { label: "Password", key: "password", type: "password" }, { label: "Confirm password", key: "confirmPassword", type: "password" }].map(({ label, key, type }) => (
                    <div key={key}>
                      <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>{label}</label>
                      <input type={type} required value={form[key]} onChange={e => set(key, e.target.value)}
                        style={{ width: "100%", padding: "11px 13px", border: `1.5px solid ${T.border}`, borderRadius: 11, fontSize: 13 }} />
                    </div>
                  ))}
                  <button type="submit" className="btn-primary" style={{ width: "100%", padding: 13, fontSize: 14 }}>Next →</button>
                </div>
              )}
             {step === 2 && (
  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <div>
      <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 8 }}>I am a…</label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {userTypes.map(t => (
          <button key={t.val} type="button" onClick={() => handleTypeChange(t.val)}
            style={{ padding: "10px 8px", borderRadius: 11, border: form.locationType === t.val ? `2px solid ${T.primary}` : `1.5px solid ${T.border}`, background: form.locationType === t.val ? T.primaryLight : "#fff", cursor: "pointer", textAlign: "left" }}>
            <div style={{ fontSize: 18, marginBottom: 3 }}>{t.icon}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: form.locationType === t.val ? T.primaryDark : T.text }}>{t.label}</div>
            <div style={{ fontSize: 10, color: T.textMuted, lineHeight: 1.3 }}>{t.desc}</div>
          </button>
        ))}
      </div>
    </div>
    <div>
      <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>{TYPE_NAME_LABEL[form.locationType] || "Name"} *</label>
      <input required placeholder={TYPE_NAME_PLACEHOLDER[form.locationType]} value={form.locationName} onChange={e => set("locationName", e.target.value)}
        style={{ width: "100%", padding: "11px 13px", border: `1.5px solid ${T.border}`, borderRadius: 11, fontSize: 13 }} />
    </div>
    {!isVolunteer && (
      <>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>Address</label>
          <input value={form.locationAddress} onChange={e => set("locationAddress", e.target.value)} placeholder="Full address"
            style={{ width: "100%", padding: "11px 13px", border: `1.5px solid ${T.border}`, borderRadius: 11, fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>Location pin</label>
          <button type="button" onClick={() => setShowLocationPicker(true)}
            style={{ width: "100%", padding: "11px 13px", border: `1.5px solid ${form.locationLat ? T.accent : T.border}`, borderRadius: 11, fontSize: 13, background: form.locationLat ? T.accentLight : "#fff", color: form.locationLat ? T.accentDark : T.textMuted, textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="map-pin" size={14} />
            {form.locationLat ? `📍 ${parseFloat(form.locationLat).toFixed(4)}, ${parseFloat(form.locationLng).toFixed(4)}` : "Pick on map (optional)"}
          </button>
        </div>
      </>
    )}
    {(form.locationType === "ngo" || form.locationType === "orphanage") && (
      <div style={{ padding: "10px 14px", background: T.accentLight, borderRadius: 10, fontSize: 12, color: T.accentDark }}>
        🏛 After registration, you'll get a unique <strong>Org Code</strong>. Share it with your volunteers so they can link their accounts to yours.
      </div>
    )}
    <div style={{ display: "flex", gap: 8 }}>
      <button type="button" onClick={() => setStep(1)} className="btn-secondary" style={{ flex: 1, padding: 12 }}>← Back</button>
      <button type="submit" className="btn-primary" style={{ flex: 2, padding: 12, fontSize: 14 }}>
        {isVolunteer ? "Next: Link NGO →" : "Create account →"}
      </button>
    </div>
  </div>
)}

              {step === 3 && isVolunteer && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 5 }}>NGO Org Code *</label>
                    <input required value={orgCodeInput} onChange={e => setOrgCodeInput(e.target.value.toUpperCase())}
                      placeholder="e.g. AB12CD34" maxLength={8}
                      style={{ width: "100%", padding: "11px 13px", border: `1.5px solid ${orgCodeLookup ? T.accent : T.border}`, borderRadius: 11, fontSize: 14, letterSpacing: "3px", fontFamily: "monospace", textTransform: "uppercase", textAlign: "center" }} />
                    <p style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>Ask your NGO for their unique Org Code to link your account to their organisation.</p>
                  </div>

                  {orgCodeLoading && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: T.bgMuted, borderRadius: 10, fontSize: 12, color: T.textMuted }}>
                      <Icon name="loader-2" size={13} className="spin" /> Looking up organisation…
                    </div>
                  )}
                  {orgCodeError && !orgCodeLoading && (
                    <div style={{ padding: "10px 14px", background: T.dangerLight, borderRadius: 10, fontSize: 12, color: T.danger }}>
                      ⚠️ {orgCodeError}
                    </div>
                  )}
                  {orgCodeLookup && !orgCodeLoading && (
                    <div className="fade-in" style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: T.accentLight, borderRadius: 12, border: `1.5px solid ${T.accent}33` }}>
                      <div style={{ width: 44, height: 44, borderRadius: 12, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>
                        {TYPE_ICONS[orgCodeLookup.locationType] || "🏛"}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.accentDark }}>{orgCodeLookup.locationName || orgCodeLookup.name}</div>
                        <div style={{ fontSize: 11, color: T.accent, marginTop: 2 }}>
                          {TYPE_LABELS[orgCodeLookup.locationType]}
                          {orgCodeLookup.address ? ` · ${orgCodeLookup.address}` : ""}
                        </div>
                      </div>
                      <div style={{ width: 26, height: 26, borderRadius: "50%", background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <Icon name="check" size={14} style={{ color: "#fff" }} />
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" onClick={() => setStep(2)} className="btn-secondary" style={{ flex: 1, padding: 12 }}>← Back</button>
                    <button type="submit" disabled={loading || !orgCodeLookup} className="btn-primary" style={{ flex: 2, padding: 12, fontSize: 14 }}>
                      {loading ? "Creating…" : "Create account →"}
                    </button>
                  </div>
                </div>
              )}
            </form>
          )}
        </div>
      </div>

      {showLocationPicker && (
        <LocationPickerModal
          initialCoords={{ lat: parseFloat(form.locationLat) || 17.4401, lng: parseFloat(form.locationLng) || 78.3896 }}
          onSelect={(coords) => { set("locationLat", coords.lat.toString()); set("locationLng", coords.lng.toString()); setShowLocationPicker(false); }}
          onClose={() => setShowLocationPicker(false)}
        />
      )}
    </div>
  );
}

// ── Profile Page ───────────────────────────────────────────────────────────
function ProfilePage({ user, onUserUpdate }) {
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [addingLocation, setAddingLocation] = useState(false);
  const [newLocForm, setNewLocForm] = useState({ name: "", type: "restaurant", address: "", lat: "", lng: "" });
  const [saving, setSaving] = useState(false);

  const handleAddLocation = async (e) => {
    e.preventDefault();
    if (!newLocForm.lat || !newLocForm.lng) { alert("Please set a location on the map."); return; }
    setSaving(true);
    try {
      await api("/api/locations", { method: "POST", body: { name: newLocForm.name, type: newLocForm.type, address: newLocForm.address, lat: parseFloat(newLocForm.lat), lng: parseFloat(newLocForm.lng) } });
      setAddingLocation(false);
      setNewLocForm({ name: "", type: "restaurant", address: "", lat: "", lng: "" });
      if (onUserUpdate) onUserUpdate();
    } catch (e) { alert(e.message); }
    setSaving(false);
  };

  const linkedNGO = user?.linkedNGO;

  return (
    <div style={{ marginTop: 56, padding: "32px", background: T.bg, minHeight: "calc(100vh - 56px)" }}>
      <div style={{ maxWidth: 580, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 24 }}>Profile & Locations</h1>
        <div className="card" style={{ padding: 24, marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
            <div style={{ width: 60, height: 60, borderRadius: "50%", background: T.primaryGrad, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 800, color: "#fff" }}>
              {user?.name?.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2)}
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{user?.name}</div>
              <div style={{ fontSize: 13, color: T.textMuted, marginTop: 2 }}>{user?.email}</div>
            </div>
          </div>
          {user?.orgCode && (
            <div style={{ padding: "14px 16px", background: T.accentLight, borderRadius: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Your Org Code</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: T.accentDark, letterSpacing: "3px", fontFamily: "monospace" }}>{user.orgCode}</div>
                <button onClick={() => { navigator.clipboard?.writeText(user.orgCode); alert("Copied!"); }}
                  className="btn-secondary" style={{ fontSize: 11, padding: "4px 10px" }}>
                  <Icon name="copy" size={12} /> Copy
                </button>
              </div>
              <div style={{ fontSize: 11, color: T.accent, marginTop: 4 }}>Share with volunteers so they can link to your organisation</div>
            </div>
          )}
          {linkedNGO && (
            <div style={{ padding: "12px 14px", background: T.primaryLight, borderRadius: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.primary, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>Delivering for</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.primaryDark }}>{linkedNGO.locationName || linkedNGO.name}</div>
              <div style={{ fontSize: 12, color: T.primary, marginTop: 1 }}>{TYPE_ICONS[linkedNGO.locationType]} {TYPE_LABELS[linkedNGO.locationType]}</div>
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 20, marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>My locations</div>
            <button onClick={() => setAddingLocation(!addingLocation)} className="btn-primary" style={{ fontSize: 12, padding: "6px 12px", display: "flex", alignItems: "center", gap: 5 }}>
              <Icon name="plus" size={12} /> Add location</button>
          </div>
          {addingLocation && (
            <form onSubmit={handleAddLocation} style={{ marginBottom: 16, padding: "16px", background: T.bgMuted, borderRadius: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: T.text }}>New location</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <input required placeholder="Location name" value={newLocForm.name} onChange={e => setNewLocForm(f => ({ ...f, name: e.target.value }))}
                  style={{ padding: "9px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13 }} />
                <select value={newLocForm.type} onChange={e => setNewLocForm(f => ({ ...f, type: e.target.value }))}
                  style={{ padding: "9px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13 }}>
                  {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <input placeholder="Address" value={newLocForm.address} onChange={e => setNewLocForm(f => ({ ...f, address: e.target.value }))}
                  style={{ padding: "9px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13 }} />
                <button type="button" onClick={() => setShowLocationPicker(true)}
                  style={{ padding: "9px 12px", border: `1.5px solid ${newLocForm.lat ? T.accent : T.border}`, borderRadius: 10, fontSize: 13, background: newLocForm.lat ? T.accentLight : "#fff", color: newLocForm.lat ? T.accentDark : T.textMuted, textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="map-pin" size={14} />
                  {newLocForm.lat ? `📍 ${parseFloat(newLocForm.lat).toFixed(4)}, ${parseFloat(newLocForm.lng).toFixed(4)}` : "Set location on map *"}
                </button>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" onClick={() => setAddingLocation(false)} className="btn-secondary" style={{ flex: 1, padding: 10 }}>Cancel</button>
                  <button type="submit" disabled={saving} className="btn-primary" style={{ flex: 2, padding: 10 }}>{saving ? "Saving…" : "Add location"}</button>
                </div>
              </div>
            </form>
          )}
          {user?.locations?.map(loc => (
            <div key={loc._id} style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", borderBottom: `1px solid ${T.borderLight}`, alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{loc.name}</div>
                {loc.address && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{loc.address}</div>}
              </div>
              <span style={{ fontSize: 11, background: T.primaryLight, color: T.primaryDark, padding: "2px 8px", borderRadius: 20, fontWeight: 600, whiteSpace: "nowrap", marginLeft: 8 }}>
                {TYPE_ICONS[loc.type]} {TYPE_LABELS[loc.type]}
              </span>
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>📡 Live Location</div>
          <p style={{ fontSize: 13, color: T.textMuted, marginBottom: 14, lineHeight: 1.6 }}>
            {user?.liveLocationEnabled
              ? "Live location is currently ON. Other users will see distances calculated from your current real-time position."
              : "Live location is currently OFF. Enable it via the navbar button for accurate real-time distance calculations."}
          </p>
          <div style={{ padding: "10px 14px", borderRadius: 10, background: user?.liveLocationEnabled ? T.accentLight : T.amberLight, fontSize: 12, color: user?.liveLocationEnabled ? T.accentDark : T.amber, fontWeight: 600 }}>
            {user?.liveLocationEnabled ? "📡 Live location: ON" : "📍 Live location: OFF"}
          </div>
        </div>
      </div>
      {showLocationPicker && (
        <LocationPickerModal
          initialCoords={{ lat: parseFloat(newLocForm.lat) || 17.4401, lng: parseFloat(newLocForm.lng) || 78.3896 }}
          onSelect={(coords) => { setNewLocForm(f => ({ ...f, lat: coords.lat.toString(), lng: coords.lng.toString() })); setShowLocationPicker(false); }}
          onClose={() => setShowLocationPicker(false)}
        />
      )}
    </div>
  );
}

// ── Settings Page ──────────────────────────────────────────────────────────
function SettingsPage() {
  const [notif, setNotif] = useState({ newListing: true, claimUpdate: true, chat: true, urgentOnly: false });
  return (
    <div style={{ marginTop: 56, padding: "32px", background: T.bg, minHeight: "calc(100vh - 56px)" }}>
      <div style={{ maxWidth: 540, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 24 }}>Settings</h1>
        <div className="card" style={{ padding: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Notifications</div>
          {[{ key: "newListing", label: "New nearby listing" }, { key: "claimUpdate", label: "Claim status updates" }, { key: "chat", label: "New messages" }, { key: "urgentOnly", label: "Urgent only mode" }].map(item => (
            <div key={item.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: `1px solid ${T.borderLight}` }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{item.label}</span>
              <div onClick={() => setNotif(n => ({ ...n, [item.key]: !n[item.key] }))}
                style={{ width: 44, height: 24, borderRadius: 12, background: notif[item.key] ? T.primary : T.border, cursor: "pointer", position: "relative", transition: "background 0.2s" }}>
                <div style={{ position: "absolute", top: 3, left: notif[item.key] ? 23 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: T.shadow }} />
              </div>
            </div>
          ))}
        </div>
        <div className="card" style={{ padding: 24, marginTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <AISparkIcon size={16} /> AI Features
          </div>
          <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6 }}>
            Smart features — the FoodSave Assistant, food photo analysis, waste forecasting and route planning — are available for restaurant, hotel, and volunteer accounts.
          </p>
        </div>
        <div className="card" style={{ padding: 24, marginTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>📍 Distance & Location</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ padding: "10px 12px", background: T.bgMuted, borderRadius: 10, fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
              <strong>Restaurants, Hotels, NGOs, Orphanages</strong> — fixed locations. Distances are always from their registered address.
            </div>
            <div style={{ padding: "10px 12px", background: T.bgMuted, borderRadius: 10, fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
              <strong>Volunteers & Individuals</strong> — mobile users. Enable live location (navbar button) to share your real-time position.
            </div>
          </div>
        </div>
        <div className="card" style={{ padding: 24, marginTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>ℹ️ Role Permissions</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { role: "🍽 Restaurant / 🏨 Hotel", perms: "Post food · AI tools · Impact reports" },
              { role: "🏛 NGO / 🏠 Orphanage", perms: "View listings · Manage volunteers · Org dashboard" },
              { role: "🚴 Volunteer", perms: "Claim food · Route planner · Chat" },
              { role: "👤 Individual", perms: "Browse & claim food · Share food · Chat" },
            ].map((r, i) => (
              <div key={i} style={{ padding: "10px 12px", background: T.bgMuted, borderRadius: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 3 }}>{r.role}</div>
                <div style={{ fontSize: 11, color: T.textMuted }}>{r.perms}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activePage, setActivePage] = useState("map");
  const [socket, setSocket] = useState(null);
  const [activeLocation, setActiveLocation] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [chatContact, setChatContact] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [toastNotif, setToastNotif] = useState(null);
  const [togglingLiveLoc, setTogglingLiveLoc] = useState(false);

  const refreshUser = async () => {
    try {
      const data = await api("/api/auth/me");
      setUser(data);
      const activeLocId = typeof data.activeLocationId === "object" ? data.activeLocationId?.$oid : data.activeLocationId;
      const activeLoc = data.locations?.find(l => l._id === activeLocId) || data.locations?.[0] || null;
      setActiveLocation(activeLoc);
    } catch {}
  };

  useEffect(() => {
    const init = async () => {
      const token = localStorage.getItem("fs_token");
      if (!token) { setLoading(false); return; }
      try {
        const data = await api("/api/auth/me");
        setUser(data);
        const activeLocId = typeof data.activeLocationId === "object" ? data.activeLocationId?.$oid : data.activeLocationId;
        const activeLoc = data.locations?.find(l => l._id === activeLocId) || data.locations?.[0] || null;
        setActiveLocation(activeLoc);
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(pos => {
            api("/api/users/me/location", { method: "PUT", body: { lat: pos.coords.latitude, lng: pos.coords.longitude } }).catch(() => {});
          });
        }
        try { setNotifications(await api("/api/notifications")); } catch {}
      } catch { localStorage.removeItem("fs_token"); }
      setLoading(false);
    };
    init();
  }, []);

  useEffect(() => {
    if (!user) return;
    const s = io(API, {
      auth: { token: localStorage.getItem("fs_token") },
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });
    s.on("connect", () => console.log("Socket connected"));
    s.on("connect_error", (err) => console.warn("Socket error:", err.message));
    s.on("unread:count", ({ count }) => setUnreadCount(count));
    s.on("chat:message", () => {
      api("/api/chat/rooms").then(rooms => setUnreadCount(rooms.reduce((sum, r) => sum + (r.unreadCount || 0), 0))).catch(() => {});
    });
    s.on("notification:new", (notif) => {
      setNotifications(prev => [notif, ...prev]);
      if (notif.type === "listing:new") {
        const hoursLeft = notif.data?.expiresAt ? (new Date(notif.data.expiresAt) - new Date()) / 3600000 : null;
        setToastNotif({ ...notif, foodName: notif.data?.foodName || "Food", quantity: notif.data?.quantity || "", restaurantName: notif.data?.restaurantName || "A donor", hoursLeft, urgent: hoursLeft !== null && hoursLeft < 2, userId: notif.data?.donorUserId });
      }
    });
    s.on("notification:deleted", ({ notifId }) => {
      setNotifications(prev => prev.filter(n => n._id !== notifId));
    });
    s.on("notification:cleared", () => setNotifications([]));
    s.on("listing:new", (listing) => {
      const locType = activeLocation?.type;
      if (locType === "volunteer" || locType === "ngo" || locType === "orphanage" || locType === "individual") {
        const hoursLeft = listing.expiresAt ? (new Date(listing.expiresAt) - new Date()) / 3600000 : null;
        setToastNotif({ type: "listing:new", foodName: listing.foodName, quantity: listing.quantity, restaurantName: listing.restaurantName, hoursLeft, urgent: hoursLeft !== null && hoursLeft < 2, userId: listing.userId });
      }
    });
    setSocket(s);
    return () => s.disconnect();
  }, [user, activeLocation?.type]);

  const handleLogin = (userData) => {
    setUser(userData);
    const activeLocId = typeof userData.activeLocationId === "object" ? userData.activeLocationId?.$oid : userData.activeLocationId;
    const activeLoc = userData.locations?.find(l => l._id === activeLocId) || userData.locations?.[0] || null;
    setActiveLocation(activeLoc);
  };

  const handleLogout = () => {
    localStorage.removeItem("fs_token");
    setUser(null);
    setSocket(prev => { prev?.disconnect(); return null; });
    setActivePage("map");
    setActiveLocation(null);
    setNotifications([]);
  };

  const switchLocation = async (locationId) => {
    try {
      const updated = await api(`/api/locations/switch/${locationId}`, { method: "PUT" });
      setUser(updated);
      setActiveLocation(updated.locations?.find(l => l._id === locationId) || null);
    } catch {
      const loc = user?.locations?.find(l => l._id === locationId);
      if (loc) setActiveLocation(loc);
    }
  };

  const startChat = (userId, name) => {
    setChatContact({ userId, name });
    setActivePage("chat");
  };

  const markAllNotificationsRead = async () => {
    try {
      await api("/api/notifications/read-all", { method: "PUT" });
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    } catch {}
  };

  const deleteNotification = async (notifId) => {
    try {
      await api(`/api/notifications/${notifId}`, { method: "DELETE" });
      setNotifications(prev => prev.filter(n => n._id !== notifId));
    } catch (e) { alert(e.message); }
  };

  const deleteAllNotifications = async () => {
    if (!window.confirm("Delete all notifications permanently?")) return;
    try {
      await api("/api/notifications", { method: "DELETE" });
      setNotifications([]);
    } catch (e) { alert(e.message); }
  };

  const toggleLiveLocation = async () => {
    if (!user) return;
    setTogglingLiveLoc(true);
    const enabling = !user.liveLocationEnabled;
    if (enabling) {
      navigator.geolocation?.getCurrentPosition(async (pos) => {
        try {
          const res = await api("/api/users/me/live-location-toggle", {
            method: "PUT",
            body: { enabled: true, lat: pos.coords.latitude, lng: pos.coords.longitude },
          });
          setUser(res.user);
        } catch (e) { alert(e.message); }
        setTogglingLiveLoc(false);
      }, () => {
        alert("Could not get your location. Please allow location access.");
        setTogglingLiveLoc(false);
      });
    } else {
      try {
        const res = await api("/api/users/me/live-location-toggle", { method: "PUT", body: { enabled: false } });
        setUser(res.user);
      } catch (e) { alert(e.message); }
      setTogglingLiveLoc(false);
    }
  };

  if (loading) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: T.bg, flexDirection: "column", gap: 14 }}>
        <BrandIcon size={52} />
        <span style={{ fontFamily: "'Lora', serif", fontSize: 26, color: T.text }}>FoodSave</span>
        <div style={{ fontSize: 13, color: T.textLight }}>Loading…</div>
      </div>
    );
  }

  if (!user) return (<><GlobalStyle /><AuthPage onLogin={handleLogin} /></>);

  const locType = activeLocation?.type;
  const isRestaurant = ["restaurant", "hotel"].includes(locType);
  const isNGO = ["ngo", "orphanage"].includes(locType);
  const isIndividual = locType === "individual";
  const isVolunteer = locType === "volunteer";

  const renderPage = () => {
    switch (activePage) {
      case "map": return <MapPage user={user} activeLocation={activeLocation} socket={socket} setActivePage={setActivePage} onStartChat={startChat} />;
      case "dashboard":
        if (isRestaurant) return <RestaurantDashboard user={user} activeLocation={activeLocation} socket={socket} onStartChat={startChat} />;
        if (isNGO) return <NGOAdminDashboard user={user} activeLocation={activeLocation} onStartChat={startChat} />;
        if (isIndividual) return <IndividualDashboard user={user} activeLocation={activeLocation} onStartChat={startChat} />;
        if (isVolunteer) return <VolunteerDashboard user={user} activeLocation={activeLocation} socket={socket} onStartChat={startChat} />;
        return <div style={{ marginTop: 80, textAlign: "center", color: T.textMuted, padding: 40 }}>Select a location type to view your dashboard.</div>;
      case "org":
        return <NGOAdminDashboard user={user} activeLocation={activeLocation} onStartChat={startChat} />;
      case "chat": return <ChatPage user={user} socket={socket} initialContact={chatContact} />;
      case "ai": return <AIToolsPage user={user} activeLocation={activeLocation} />;
      case "post": return (
        <div style={{ marginTop: 56 }}>
          <PostModal user={user} activeLocation={activeLocation} onClose={() => setActivePage("dashboard")} onSuccess={() => setActivePage("dashboard")} />
        </div>
      );
            case "claims": return <ClaimsPage user={user} activeLocation={activeLocation} onStartChat={startChat} socket={socket} />;
      case "profile": return <ProfilePage user={user} onUserUpdate={refreshUser} />;
      case "settings": return <SettingsPage user={user} />;
      default: return <MapPage user={user} activeLocation={activeLocation} socket={socket} setActivePage={setActivePage} onStartChat={startChat} />;
    }
  };

  return (
    <>
      <GlobalStyle />
      <Navbar
        user={user}
        activePage={activePage}
        setActivePage={(page) => { if (page === "chat") setChatContact(null); setActivePage(page); }}
        activeLocation={activeLocation}
        onSwitchLocation={switchLocation}
        unreadCount={unreadCount}
        onLogout={handleLogout}
        notifications={notifications}
        onMarkAllRead={markAllNotificationsRead}
        onDeleteNotif={deleteNotification}
        onDeleteAll={deleteAllNotifications}
        onStartChat={startChat}
        onToggleLiveLoc={toggleLiveLocation}
        togglingLiveLoc={togglingLiveLoc}
      />
      {renderPage()}
      {toastNotif && (
        <ToastNotification notif={toastNotif} onClose={() => setToastNotif(null)}
          onChat={toastNotif.userId ? (n) => startChat(n.userId, n.restaurantName) : null} />
      )}
    </>
  );
}