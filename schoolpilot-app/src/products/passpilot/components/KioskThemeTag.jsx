import { Clover, Drumstick, Egg, Flame, Flower2, Ghost, Gift, Heart, Leaf, Snowflake, Sun } from 'lucide-react';

// Small theme glyph before a name on the simple kiosk's roster rows. Decorative
// only: it sits inside the existing button, so tap targets and text size are
// unchanged, and it is hidden from screen readers.
const TAGS = {
  halloween: [Ghost, 'text-orange-300'],
  thanksgiving: [Drumstick, 'text-amber-300'],
  christmas: [Gift, 'text-red-300'],
  advent: [Flame, 'text-violet-300'],
  valentines: [Heart, 'text-pink-300'],
  'st-patricks': [Clover, 'text-green-300'],
  easter: [Egg, 'text-violet-200'],
  spring: [Flower2, 'text-pink-200'],
  summer: [Sun, 'text-yellow-300'],
  fall: [Leaf, 'text-orange-300'],
  winter: [Snowflake, 'text-sky-200'],
};

export default function KioskThemeTag({ themeId }) {
  const tag = TAGS[themeId];
  if (!tag) return null;
  const [Icon, color] = tag;
  return <Icon aria-hidden="true" data-testid="kiosk-theme-tag" className={`mr-2 inline-block h-5 w-5 shrink-0 align-[-0.2em] ${color}`} />;
}
