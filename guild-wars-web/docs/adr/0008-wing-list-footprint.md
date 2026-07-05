## ADR-0008 — Wing-list footprint in Building Spec

The Building Spec footprint field supports `{type:'wings', wings:[…]}` where each wing is
a pre-computed axis-aligned rectangle supplied by the server. The server decomposes a plot's
footprint into wings; the client assembler processes them without any geometry reasoning.

This contrasts with the alternative of passing a raw polygon and having the client decompose
it into wings (deciding ridge directions, junction faces, etc.). Keeping decomposition on the
server preserves the "assembler is a pure function of spec" guarantee (ADR-0007) and keeps
client code simple. The trade-off is that the server must understand building geometry, and
the spec is slightly more verbose.

The `rect` and `L` convenience types are kept for the gallery preview. All plot-integrated
buildings use `type:'wings'`. Each wing currently must be an axis-aligned rectangle;
non-axis-aligned and non-rectangular wings (wedges, octagons) are accommodated by the schema
but not yet implemented.

**Amendment:** the "server decomposes" description above no longer matches reality. Wing
decomposition (and, per ADR-0019, the Attached/Freestanding/Custom Model rolls that gate it)
now happens client-side in `BuildingRenderer.js`, seeded from plot geometry — there is no
server-side geometry reasoning for buildings. See ADR-0019 and `CONTEXT_BuildingsRoofs.md`'s
Building Spec / Suppressed face entries.
