// Optional persistence for hosts with ephemeral disks (Koyeb free tier).
// Enabled by UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = process.env.STATE_KEY || "oi-sniper:state";

export const remoteEnabled = Boolean(URL_ && TOKEN);

export async function pullRemoteState() {
  if (!remoteEnabled) return null;
  try {
    const res = await fetch(`${URL_}/get/${encodeURIComponent(KEY)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const json = await res.json();
    return typeof json.result === "string" ? json.result : null;
  } catch (err) {
    console.error("[remote-state] pull failed:", err.message);
    return null;
  }
}

export function pushRemoteState(serialized) {
  if (!remoteEnabled) return;
  fetch(`${URL_}/set/${encodeURIComponent(KEY)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: serialized,
  }).catch((err) => console.error("[remote-state] push failed:", err.message));
}
