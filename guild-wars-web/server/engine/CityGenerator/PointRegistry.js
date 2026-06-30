// Additive shared Point registry — the persistent, deduplicated vertex store that the
// future per-point z-height feature will build on (see docs/adr/0018). Built AFTER the
// existing generators run; it changes NO computed geometry. Each ground Surface keeps its
// `blockCorners` array unchanged and gains a parallel `pointIds` array referencing shared
// points, so a corner shared by abutting surfaces resolves to ONE Point id (and will later
// move together in z). Not persisted — re-derived on load alongside plots (ADR-0018).

const SNAP = 6  // decimals — matches the generators' toFixed(6) topology keys

// Build cityData.points and tag every plot with pointIds. Also runs a contiguity
// diagnostic: points that are near-coincident but did NOT merge reveal residual seams
// (abutting surfaces whose shared corner drifted apart — e.g. a remaining gap bug).
export function buildPointRegistry(cityData, { seamTol = 0.004 } = {}) {
  if (!cityData) return
  if (!cityData.plots?.length) { cityData.points = []; return }

  const points = []
  const idByKey = new Map()
  const idFor = (p) => {
    const k = `${p.x.toFixed(SNAP)},${p.y.toFixed(SNAP)}`
    let id = idByKey.get(k)
    if (id === undefined) {
      id = points.length
      points.push({ id, x: p.x, y: p.y })
      idByKey.set(k, id)
    }
    return id
  }

  for (const plot of cityData.plots) {
    const corners = plot.blockCorners
    plot.pointIds = corners?.length ? corners.map(idFor) : []
  }

  cityData.points = points

  const seams = countSeams(points, seamTol)
  console.log(
    `PointRegistry: ${points.length} points from ${cityData.plots.length} surfaces` +
    (seams.count
      ? `, ${seams.count} near-coincident-but-unmerged point pairs (residual seams, e.g. ${seams.sample})`
      : ', no residual seams')
  )
}

// Spatial-hash points into seamTol-sized buckets; count distinct-id pairs closer than
// seamTol (they SHOULD likely be one shared corner — a residual abutment gap).
function countSeams(points, tol) {
  const cell = tol > 0 ? tol : 0.004
  const buckets = new Map()
  for (const p of points) {
    const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(p)
  }
  const tolSq = cell * cell
  let count = 0, sample = null
  for (const p of points) {
    const gx = Math.floor(p.x / cell), gy = Math.floor(p.y / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = buckets.get(`${gx + dx},${gy + dy}`)
        if (!arr) continue
        for (const q of arr) {
          if (q.id <= p.id) continue  // count each unordered pair once
          const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2
          if (d > 1e-12 && d < tolSq) {
            count++
            if (!sample) sample = `(${p.x.toFixed(4)},${p.y.toFixed(4)})~(${q.x.toFixed(4)},${q.y.toFixed(4)})`
          }
        }
      }
    }
  }
  return { count, sample }
}
