// Avatars: little characters drawn as inline SVG (no images, no network). The colours come from the agent's name;
// the agents that ship with the app get a character that suits the job, any other agent gets one picked from its name.
// The SVG text is built only from numbers derived from the name, never from message content.
import { FIXED_SPECIES } from "../../../constants/ui";

interface Colors {
  main: string;
  dark: string;
  light: string;
  accent: string;
}
const hue = (name: string) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};
const hash = (name: string, salt: number) => {
  let h = salt;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};
const eye = (x: number, y: number, r: number, look: number, c: Colors) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff"/><circle cx="${x + look * r * 0.28}" cy="${y + r * 0.1}" r="${r * 0.55}" fill="${c.dark}"/>` +
  `<circle cx="${x + look * r * 0.28 + r * 0.2}" cy="${y - r * 0.12}" r="${r * 0.17}" fill="#fff"/>`;
const dotEye = (x: number, y: number, r: number, c: Colors) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${c.dark}"/><circle cx="${x + r * 0.3}" cy="${y - r * 0.3}" r="${r * 0.32}" fill="#fff"/>`;
const mouth = (x: number, y: number, v: number, c: Colors) =>
  [
    `<path d="M${x - 5} ${y} q5 5.5 10 0" fill="none" stroke="${c.dark}" stroke-width="2" stroke-linecap="round"/>`,
    `<path d="M${x - 5} ${y} q5 8 10 0z" fill="${c.dark}"/><path d="M${x - 2.4} ${y + 3.6} q2.4 -2 4.8 0 q-2.4 2.6 -4.8 0" fill="${c.accent}"/>`,
    `<path d="M${x - 4} ${y + 0.5} q2 3 4 0 q2 3 4 0" fill="none" stroke="${c.dark}" stroke-width="2" stroke-linecap="round"/>`,
  ][v];
const blush = (x1: number, x2: number, y: number, c: Colors) =>
  `<circle cx="${x1}" cy="${y}" r="3.2" fill="${c.accent}" opacity=".35"/><circle cx="${x2}" cy="${y}" r="3.2" fill="${c.accent}" opacity=".35"/>`;

type Draw = (c: Colors, look: number, mood: number) => string;
const SPECIES: Record<string, Draw> = {
  robot: (c, _l, m) =>
    `<line x1="32" y1="17" x2="32" y2="9" stroke="${c.dark}" stroke-width="2.6" stroke-linecap="round"/><circle cx="32" cy="8" r="3.6" fill="${c.accent}"/>` +
    `<rect x="7" y="29" width="7" height="13" rx="3.5" fill="${c.dark}"/><rect x="50" y="29" width="7" height="13" rx="3.5" fill="${c.dark}"/>` +
    `<rect x="12" y="17" width="40" height="35" rx="12" fill="${c.main}"/><rect x="17" y="23" width="30" height="22" rx="9" fill="${c.light}"/>` +
    dotEye(25, 33, 4.2, c) + dotEye(39, 33, 4.2, c) + mouth(32, 39.5, m, c) + blush(20, 44, 40, c),
  cat: (c, l, m) =>
    `<path d="M13 31 L15 10 L29 21z" fill="${c.main}"/><path d="M51 31 L49 10 L35 21z" fill="${c.main}"/>` +
    `<path d="M17.5 25 L18 15.5 L25 21z" fill="${c.accent}" opacity=".6"/><path d="M46.5 25 L46 15.5 L39 21z" fill="${c.accent}" opacity=".6"/>` +
    `<ellipse cx="32" cy="38" rx="21" ry="17" fill="${c.main}"/><ellipse cx="32" cy="45" rx="11" ry="8" fill="${c.light}"/>` +
    eye(23.5, 35, 5.4, l, c) + eye(40.5, 35, 5.4, l, c) + `<path d="M29.4 41 h5.2 l-2.6 3z" fill="${c.accent}"/>` +
    `<path d="M32 44 q-2.6 3.4 -5.4 1.6 M32 44 q2.6 3.4 5.4 1.6" fill="none" stroke="${c.dark}" stroke-width="1.8" stroke-linecap="round"/>` +
    `<path d="M9 40 h9 M9 45 l8 -2 M55 40 h-9 M55 45 l-8 -2" stroke="${c.dark}" stroke-width="1.4" stroke-linecap="round" opacity=".6"/>`,
  owl: (c, l) =>
    `<path d="M13 24 L17 8 L28 19z" fill="${c.dark}"/><path d="M51 24 L47 8 L36 19z" fill="${c.dark}"/>` +
    `<ellipse cx="32" cy="36" rx="22" ry="20" fill="${c.main}"/><ellipse cx="32" cy="48" rx="11.5" ry="8" fill="${c.light}"/>` +
    `<circle cx="23" cy="31" r="9.5" fill="${c.light}"/><circle cx="41" cy="31" r="9.5" fill="${c.light}"/>` +
    eye(23, 31, 6, l, c) + eye(41, 31, 6, l, c) + `<path d="M28.4 38.5 h7.2 l-3.6 6.4z" fill="${c.accent}"/>` +
    `<path d="M27 50 q5 3 10 0 M25 53 q7 3.6 14 0" fill="none" stroke="${c.main}" stroke-width="1.4" stroke-linecap="round" opacity=".55"/>`,
  bear: (c, _l, m) =>
    `<circle cx="16" cy="19" r="8" fill="${c.main}"/><circle cx="16" cy="19" r="4.2" fill="${c.light}"/><circle cx="48" cy="19" r="8" fill="${c.main}"/><circle cx="48" cy="19" r="4.2" fill="${c.light}"/>` +
    `<circle cx="32" cy="36" r="20" fill="${c.main}"/><ellipse cx="32" cy="44" rx="10.5" ry="8.2" fill="${c.light}"/>` +
    dotEye(23.5, 32, 3, c) + dotEye(40.5, 32, 3, c) + `<ellipse cx="32" cy="40.2" rx="4" ry="2.9" fill="${c.dark}"/>` +
    `<path d="M32 43 v2.4" stroke="${c.dark}" stroke-width="1.8" stroke-linecap="round"/>` + mouth(32, 45.4, m === 1 ? 0 : m, c) + blush(17, 47, 41, c),
  fox: (c) =>
    `<path d="M11 30 L14 8 L29 20z" fill="${c.main}"/><path d="M53 30 L50 8 L35 20z" fill="${c.main}"/>` +
    `<path d="M16 24 L16.5 14 L25 20z" fill="${c.dark}"/><path d="M48 24 L47.5 14 L39 20z" fill="${c.dark}"/>` +
    `<path d="M8 33 Q32 17 56 33 Q53 51 32 57 Q11 51 8 33z" fill="${c.main}"/>` +
    `<path d="M16 39 Q32 33 48 39 Q43 53 32 57 Q21 53 16 39z" fill="${c.light}"/>` +
    `<ellipse cx="23.5" cy="38" rx="3" ry="3.8" fill="${c.dark}"/><ellipse cx="40.5" cy="38" rx="3" ry="3.8" fill="${c.dark}"/>` +
    `<circle cx="24.5" cy="36.6" r="1.1" fill="#fff"/><circle cx="41.5" cy="36.6" r="1.1" fill="#fff"/><ellipse cx="32" cy="52" rx="3.4" ry="2.5" fill="${c.dark}"/>`,
  alien: (c, _l, m) =>
    `<path d="M23 15 Q19 6 13 8 M41 15 Q45 6 51 8" fill="none" stroke="${c.dark}" stroke-width="2.2" stroke-linecap="round"/><circle cx="13" cy="8" r="3" fill="${c.accent}"/><circle cx="51" cy="8" r="3" fill="${c.accent}"/>` +
    `<path d="M32 12 C48 12 55 28 51 40 C48 50 41 56 32 56 C23 56 16 50 13 40 C9 28 16 12 32 12z" fill="${c.main}"/>` +
    `<ellipse cx="23" cy="33" rx="6" ry="8.6" transform="rotate(16 23 33)" fill="${c.dark}"/><ellipse cx="41" cy="33" rx="6" ry="8.6" transform="rotate(-16 41 33)" fill="${c.dark}"/>` +
    `<circle cx="21" cy="30" r="2" fill="#fff"/><circle cx="39" cy="30" r="2" fill="#fff"/>` + mouth(32, 47, m === 1 ? 0 : m, c),
  ghost: (c, _l, m) =>
    `<path d="M13 55 V30 C13 18 21 10 32 10 C43 10 51 18 51 30 V55 L44.5 50 L38.5 55 L32 50 L25.5 55 L19.5 50z" fill="#fff" opacity=".96"/>` +
    `<path d="M13 40 Q9 36 11 30 M51 40 Q55 36 53 30" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".7"/>` +
    `<ellipse cx="25" cy="29" rx="3.2" ry="4.6" fill="${c.dark}"/><ellipse cx="39" cy="29" rx="3.2" ry="4.6" fill="${c.dark}"/>` +
    `<circle cx="26" cy="27.4" r="1.1" fill="#fff"/><circle cx="40" cy="27.4" r="1.1" fill="#fff"/>` + blush(20, 44, 37, c) +
    `<ellipse cx="32" cy="38.5" rx="3" ry="${m === 0 ? 2.2 : 3.2}" fill="${c.dark}"/>`,
  frog: (c, l) =>
    `<ellipse cx="32" cy="42" rx="23" ry="15" fill="${c.main}"/><circle cx="20.5" cy="23" r="10" fill="${c.main}"/><circle cx="43.5" cy="23" r="10" fill="${c.main}"/>` +
    eye(20.5, 23, 6.2, l, c) + eye(43.5, 23, 6.2, l, c) + `<circle cx="29.5" cy="35" r="1.1" fill="${c.dark}"/><circle cx="34.5" cy="35" r="1.1" fill="${c.dark}"/>` +
    `<path d="M16 42 Q32 56 48 42" fill="none" stroke="${c.dark}" stroke-width="2.2" stroke-linecap="round"/>` + blush(13, 51, 44, c),
};
const SPECIES_NAMES = Object.keys(SPECIES);

export function Avatar({ name, small, working }: { name: string; small?: boolean; working?: boolean }) {
  const h = name === "manager" ? 14 : hue(name); // the Manager always wears the app's clay colour
  const c: Colors = { main: `hsl(${h} 52% 55%)`, dark: `hsl(${h} 42% 22%)`, light: `hsl(${h} 80% 93%)`, accent: `hsl(${(h + 170) % 360} 85% 58%)` };
  const species = FIXED_SPECIES[name] || SPECIES_NAMES[hash(name, 7) % SPECIES_NAMES.length];
  const look = (hash(name, 3) % 3) - 1;
  const mood = hash(name, 5) % 3;
  const bg = `linear-gradient(145deg, hsl(${h} 80% 91%), hsl(${(h + 30) % 360} 72% 80%))`;
  return (
    <div className={"avatar" + (small ? " small" : "")} style={{ background: bg }}>
      <svg viewBox="0 0 64 64" aria-hidden="true" dangerouslySetInnerHTML={{ __html: SPECIES[species](c, look, mood) }} />
      {working ? <span className="dot" /> : null}
    </div>
  );
}
