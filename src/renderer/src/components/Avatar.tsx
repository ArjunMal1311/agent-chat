// Avatars: a flat coloured circle with the agent's initials. The colour is picked from the name, so an agent always
// keeps the same one. Plain text only: no images, no network.
import { AVATAR_COLORS } from "../../../constants/ui";

const hash = (name: string) => {
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; // mix the bits so the low ones depend on the whole name
};

/** One letter for a one-word name ("Manager" -> "M"), two for a longer one ("video-maker" -> "VM"). */
const initials = (name: string): string => {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
};

export function Avatar({ name, small, working }: { name: string; small?: boolean; working?: boolean }) {
  const color = AVATAR_COLORS[(hash(name) >>> 8) % AVATAR_COLORS.length];
  return (
    <div className={"avatar" + (small ? " small" : "")} style={{ background: color }}>
      <span aria-hidden="true">{initials(name)}</span>
      {working ? <span className="dot" /> : null}
    </div>
  );
}
