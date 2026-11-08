// Training analytics (data only, no UI yet): keeps a per-run aim summary for every saved live run.
// The game sends window "aim-run-stats" at the end of each live run (tools/training_stats_patch.py);
// runs with a record id (workshop and community runs) get a summary in localStorage
// "aim-training-analytics-v1", keyed by the run record's id in al-workshop-runs-v1 (never touched
// here). Studio/plaza and Round mode runs have no record and are skipped. The math is in
// training-analytics-core.js (window.aimTrainingAnalyticsCore), loaded just before this file.
// Read access for other shell scripts: window.__aimTrainingAnalytics.get(recordId) / .all()
// (newest first).
(() => {
  if (window.__aimTrainingAnalytics) return;
  const core = window.aimTrainingAnalyticsCore;
  if (!core) return;

  function load() {
    let text = null;
    try {
      text = localStorage.getItem(core.KEY);
    } catch {}
    return core.parse(text);
  }

  window.addEventListener("aim-run-stats", (e) => {
    try {
      const d = e && e.detail;
      const summary = core.summarize(d);
      if (!summary) return;
      const store = load();
      if (!core.add(store, d.recordId, summary)) return;
      localStorage.setItem(core.KEY, JSON.stringify(store));
    } catch (err) {
      console.warn("training analytics:", err);
    }
  });

  window.__aimTrainingAnalytics = {
    get(recordId) {
      const r = load().runs[recordId];
      return r ? { ...r, id: recordId } : null;
    },
    all() {
      return core.list(load());
    },
  };
})();
