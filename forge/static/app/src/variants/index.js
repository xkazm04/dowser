// Visual prototypes (spark forge-ui-prototypes): three alternative designs of the Custom UI, switchable in the dev
// server only. `#inbox&v=2` picks variant 2; absent or 0 is the current UI. A variant module may override any page
// (inbox, map, reflect, settings) or module (dowser-evidence, dowser-doc-impact); what it leaves out falls back to the
// current component. Everything here sits behind `import.meta.env.DEV`, so a Forge build (vite build) carries none of it.
//
// Variant module contract (src/variants/vN/index.js):
//   export default { name: string, pages?: {inbox?, map?, reflect?, settings?}, modules?: {'dowser-evidence'?, 'dowser-doc-impact'?} }
// Each variant's CSS is scoped under :root[data-variant="N"], which main.jsx sets on <html>.

export const VARIANTS = [
  { id: 0, label: 'Current' },
  { id: 1, label: 'Evolution' },
  { id: 2, label: 'Quiet editorial' },
  { id: 3, label: 'Reading pane' },
];

/** @returns {number} the variant chosen by the URL hash (`v=`), 0 outside the dev server */
export function variantId() {
  if (!import.meta.env.DEV) return 0;
  const m = location.hash.match(/[#&]v=(\d)/);
  const n = m ? Number(m[1]) : 0;
  return VARIANTS.some((v) => v.id === n) ? n : 0;
}

/**
 * @param {number} id
 * @returns {Promise<{name?: string, pages?: Record<string, any>, modules?: Record<string, any>} | null>}
 */
export async function loadVariant(id) {
  if (!import.meta.env.DEV || id === 0) return null;
  const load = {
    1: () => import('./v1/index.js'),
    2: () => import('./v2/index.js'),
    3: () => import('./v3/index.js'),
  }[id];
  return load ? (await load()).default : null;
}
