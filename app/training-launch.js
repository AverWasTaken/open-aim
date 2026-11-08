// Launch a drill by its share code alone, for other shell scripts (sens finder, routines).
//
// window.__aimLaunchByCode(code, extra?) -> Promise<true/false>
//   Finds the drill's full item and hands it to window.__aimLaunchWorkshop (tools/
//   training_launch_patch.py), exactly like the routines and progress scripts do, so the
//   open-drill guard, the lobby launch wl() and the rank picker gate (__aimPlayGate) behave as
//   for a lobby click. Works for drills the player never played (the hook alone only knows codes
//   that already have runs).
//   Lookup: the lobby's training list (/prod-api/api/v1/public/val/aimlab/workshop: official
//   drills, training set and Studio drills, served by app/main.js), then /aim/drill-variants.json
//   for codes left out of that list (Easy twins and older copies merged into one card,
//   app/drill-variants.js): the twin's own item when its code matches, else the card's item.
//   Both lists are cached for the page session; a code missing from the cache refetches them
//   once. extra: { name, description } replace the item's only when given (not null/undefined;
//   description '' gives a type-only brief subtitle like a lobby click on a non-ball card).
//   For a drill with bots the rank picker still decides what runs (Easy or Hard twin, the
//   server's own item, so extra is dropped then), exactly like a card click.
//   Resolves false (never throws) when: no code, the code is unknown, a fetch fails, the hook is
//   missing, or the hook refuses (a drill is open or loading). true = the launch started; with the
//   rank picker the player can still cancel, so wait for the 'aim-local-scene' event.
(() => {
  if (window.__aimTrainingLaunch) return;
  window.__aimTrainingLaunch = true;
  const LIST = '/prod-api/api/v1/public/val/aimlab/workshop';
  const VARIANTS = '/aim/drill-variants.json';
  let cache = null; // Promise<{ list: item[], variants: object }>

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json();
  }

  function load() {
    if (!cache) {
      const p = Promise.all([getJson(LIST), getJson(VARIANTS)]).then(([list, v]) => ({
        list: Array.isArray(list?.data) ? list.data : [],
        variants: v && typeof v.variants === 'object' && v.variants ? v.variants : {},
      }));
      cache = p;
      p.catch(() => { if (cache === p) cache = null; });
    }
    return cache;
  }

  function find(lists, code) {
    const hit = lists.list.find((x) => x && x.shareCode === code);
    if (hit) return hit;
    const group = Object.prototype.hasOwnProperty.call(lists.variants, code) ? lists.variants[code] : null;
    if (!group) return null;
    const item = group.easy && group.easy.shareCode === code ? group.easy : group.item;
    return item && typeof item.shareCode === 'string' ? item : null;
  }

  window.__aimLaunchByCode = async (code, extra) => {
    try {
      if (typeof code !== 'string' || !code) return false;
      const first = cache;
      let item = find(await load(), code);
      if (!item && first) {
        // Cached lists may be stale (a Studio drill saved since): refetch once.
        if (cache === first) cache = null;
        item = find(await load(), code);
      }
      if (!item || typeof window.__aimLaunchWorkshop !== 'function') return false;
      const launch = { ...item };
      if (extra && extra.name != null) launch.name = extra.name;
      if (extra && extra.description != null) launch.description = extra.description;
      return !!window.__aimLaunchWorkshop(launch);
    } catch (err) {
      console.warn('TRAINING LAUNCH:', err && err.message);
      return false;
    }
  };
})();
