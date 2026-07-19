---
name: extract-uml
description: Generate C4 (and C5 fields) PlantUML architecture documentation for a repository, in the dialect Chartroom parses. Use when the user wants a repo documented as a C4 diagram, a Chartroom diagram generated, or runs "/extract-uml <repo>".
---

# Extract UML — Generate C4 PlantUML Diagram for Chartroom

Generates C4 architecture documentation (PlantUML) for a repository, written in the exact dialect that [Chartroom](../../code/Chartroom/CONTEXT.md) parses, so it can be opened and edited visually. Cover the full depth Chartroom supports: Context → Container → Component → **Code (C4 level)**, plus **C5 Fields** (data-shape rows on Code elements). This is C4/C5-only — never produce Value Stream Mapping (VSM) content.

Trigger on requests like "document \<repo\> as a C4 diagram", "create a Chartroom diagram for \<repo\>", "generate PlantUML architecture docs for \<repo\>", "/extract-uml \<repo\>".

## Step 1 — Identify scope

If the target repo wasn't given, ask for it. Then read its contents (README, top-level folder structure, project/solution files, package manifests) to understand what it's made of.

Default mapping (override only if the repo's own docs say otherwise):

- The repo itself → one `System` (or `SystemExt` if you're referencing it from another repo's diagram without documenting its internals).
- Each top-level module / project / service inside the repo → a `Container`, nested inside a `System_Boundary` for that System.
- Drop to `Component` level where a container has real internal structure worth surfacing (e.g. distinct layers/services/modules) — don't force every file into a Component.
- Go one level deeper to `Code` (C4 level) for the load-bearing types inside a component or container: key classes, interfaces, DB tables, message/DTO shapes. Pick the handful that carry the design — not every class in the codebase.
- On each `Code` element that represents a data shape (DB table, DTO, config record, message contract), add **C5 fields** — one `' chartroom:field=` tag per field (name/type/description), extracted from the actual class/table definition. Fields are only meaningful on Code-level elements; don't put them on Systems/Containers/Components.
- External systems the repo talks to (other repos, SaaS, managed cloud services it depends on but doesn't own) → `SystemExt` / `ContainerExt` placeholders, not fully modeled.

Do not create any VSM elements/relationships (`Process`, `VsmActor`, `KaizenBurst`, `.vsm` files, etc.) — out of scope for this skill.

## Step 2 — Relationship types are constrained — read the source of truth every time

Chartroom restricts the relationship `label` (the "Type" field) to a fixed vocabulary. **Read [`code/Chartroom/src/model/relationshipTypes.ts`](../../code/Chartroom/src/model/relationshipTypes.ts) before writing any `Rel(...)` line** — the list below is a snapshot and may be stale:

- `Runs On`
- `Sends Data To`
- `Requires`
- `Uses` — **only valid when at least one endpoint is a `Person`/`PersonExt`** (Chartroom's UI hides this option for System/Container/Component-to-System/Container/Component relationships)
- `Owns`
- `Deploys`
- `Provisions`
- `Hosts`
- `References`

Map every real relationship to the closest one of these. Use the relationship's 4th argument (`technology`) for the specific mechanism/protocol (e.g. `"HTTPS"`, `"gRPC"`, `"Azure ServiceBus"`) — that field is free text and not constrained.

**Never invent a new label.** If nothing on the list is a good fit, pick the closest reasonable match and note it — see Step 5.

## Step 3 — Write valid Chartroom PlantUML syntax

Chartroom's parser (`c4-parser.ts`) is regex-based and only recognizes these exact macro shapes — match them precisely (double-quoted args, no trailing commas):

```
@startuml <DiagramTitle>
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml

Person(alias, "Label", "Description")
PersonExt(alias, "Label", "Description")
System(alias, "Label", "Description")
SystemExt(alias, "Label", "Description")

System_Boundary(sysAlias, "Label") {
  Container(alias, "Label", "Technology", "Description")
  ContainerDb(alias, "Label", "Technology", "Description")
  ContainerQueue(alias, "Label", "Technology", "Description")
  ContainerExt(alias, "Label", "Technology", "Description")

  Container_Boundary(containerAlias, "Label", $descr="Description") {
    Component(alias, "Label", "Technology", "Description")
    ComponentDb(alias, "Label", "Technology", "Description")
    ComponentExt(alias, "Label", "Technology", "Description")

    ' A Component with Code children reuses Container_Boundary (no Component_Boundary
    ' macro exists) — the boundaryLevel tag tells the parser it's really a Component:
    ' chartroom:boundaryLevel=component
    Container_Boundary(componentAlias, "Label", $descr="Description") {
      ' chartroom:field=f_id1|Name|string|Display name of the thing
      ' chartroom:field=f_id2|CreatedAt|DateTime|UTC creation timestamp
      Code(alias, "Label", "Technology", "Description")
    }

    ' Code can also sit directly in a Container_Boundary (skipping the Component level).
    Code(alias, "Label", "Technology", "Description")
  }
}

' A Code element written flat (its parent Component/Container is elsewhere or absent)
' declares its parent via an explicit tag instead of nesting:
' chartroom:parent=componentAlias
Code(alias, "Label", "Technology", "Description")

Rel(fromAlias, toAlias, "Requires")
Rel_D(fromAlias, toAlias, "Sends Data To", "HTTPS")
BiRel(fromAlias, toAlias, "Requires", "gRPC")

@enduml
```

Rules that matter for parsing (see `c4-parser.ts` / `c4-serializer.ts`):

- Only one `!include` — for the **deepest** C4 level actually used in the file (`C4_Context.puml` / `C4_Container.puml` / `C4_Component.puml`). Don't include all three. There is **no `C4_Code.puml`** — a file containing `Code` elements uses `C4_Component.puml` (that's what Chartroom's serializer emits for code level).
- Person/System macros take `(alias, "Label", "Description")` — no technology arg.
- Container/Component/`Code` macros take `(alias, "Label", "Technology", "Description")`.
- `Code` nesting (C4 level): inside a plain `Container_Boundary`, a `Code` element is parented to that Container. To parent it to a Component, wrap the Component as a `Container_Boundary` preceded by its own `' chartroom:boundaryLevel=component'` comment line (the Component then has no separate flat `Component(...)` line — the boundary *is* the Component). A flat `Code` line whose parent isn't a boundary in this file uses `' chartroom:parent=<alias>'` on the line directly above.
- C5 fields: `' chartroom:field=<alias>|<name>|<type>|<description>'` comment lines directly above a `Code` element, one per field, in order. The alias must be a bare `\w+` identifier unique in the file — use the `f_` prefix convention (e.g. `f_userId`). Escape any literal `|` or `\` inside name/type/description with a backslash. Description may be empty but keep all four `|`-separated parts. Field aliases are valid `Rel(...)` endpoints, so you can draw field-to-field relationships (e.g. a foreign key) — the relationship label vocabulary from Step 2 still applies.
- `Rel` variants: `Rel`, `Rel_D`, `Rel_U`, `Rel_L`, `Rel_R`, `BiRel` — direction suffix is optional and purely cosmetic (layout hint).
- Aliases are bare identifiers (no quotes, no spaces); labels/descriptions/technology are always double-quoted.
- A blank `""` is fine where a field doesn't apply — don't omit the argument.
- Optional: `' chartroom:icon=<icon-key>` as its own comment line immediately above an element assigns it an icon (see `code/Chartroom/src/icons/iconRegistry.ts` for valid keys). Skip this unless asked — it's cosmetic.
- `title`, `SHOW_LEGEND()`, and extra comments are harmless (Chartroom ignores lines it doesn't recognize) but add nothing functionally — prefer the minimal form above.

## Step 4 — Output location

Place the file in a `Documentation/` folder:

- If the target repo already has one (check its root, and `code/<repo>/Documentation/` for in-monorepo projects) with existing `.puml` files, match its naming convention.
- Otherwise create `Documentation/` at the repo root and name the file `<RepoOrSystemName>-architecture.puml`.

## Step 5 — Verify and report back

Summarize what was generated: element counts by level (context / container / component / code), how many Code elements carry C5 fields, and every relationship type used. If any real-world relationship didn't cleanly fit the `relationshipTypes.ts` vocabulary, call it out explicitly and ask the user whether it should be added — do not silently add new types to that file yourself.

Suggest the user open the file in Chartroom's Local Files panel to visually confirm the layout before committing.
