---
name: editable-diagrams
description: Generate visual concepts or use supplied references, then rebuild and refine flowcharts and process diagrams as editable HTML with named SVG elements and slide-ready exports. Use for image-to-diagram reconstruction and conversational diagram edits; not for full slide decks or precise logo reconstruction.
---

# Editable Diagrams

Turn a visual idea into artwork that survives exports and conversational edits.

## Establish the visual

- Use the user's image when supplied. When starting from a description, generate a visual concept using the available image-generation capability and its applicable instructions, then inspect the result. Do not generate another concept for every small edit.
- If your own tools cannot generate images (for example in Claude Code or another agent) and the `codex` CLI is installed, delegate only the concept image to Codex, then view the saved file yourself:

  ```bash
  codex exec --skip-git-repo-check -s workspace-write -C /absolute/work/dir \
    "Use your image generation tool to create one <aspect ratio> diagram concept and save it as concept.png in the current directory. Do not write code. <exact wording, connections, language and style>"
  ```

  Spell out every label and connection in the prompt. Codex can still invent or misplace details, so correct them in the rebuild.
- If neither your tools nor Codex can generate images, say so and build a code-native draft; do not claim the image-generation step happened.
- Treat user-specified wording, connections, and content as authoritative over generated pixels. Correct image-generation mistakes instead of transcribing them.
- Distinguish **match the reference** (preserve composition and proportions) from **improve the design** (allow rearrangement). Infer from the request; clarify only when this changes the outcome materially.
- Preserve an existing artifact's aspect ratio and approved choices. For a new slide asset, use generous margins and a composition suited to the requested slide size. Do not invent content to fill the canvas.

## Build editable artwork

- Prefer a self-contained HTML file with inline SVG for flowcharts. SVG groups are editable structural elements; HTML divs are appropriate for controls and layouts that benefit from them. Never embed the concept bitmap as the finished diagram.
- Give meaningful groups stable, semantic kebab-case IDs and readable `data-label` attributes, such as `file-localization`, `top-five-files-arrow`, and `fine-tuning`. Avoid names based only on order, coordinates, or color.
- Give connectors their own IDs and `data-from` / `data-to` references. Name editable subparts when needed, such as `file-localization-title`. Keep IDs stable when moving or restyling elements.
- Interpret requests like "the purple training box" using labels, content, relationships, and the actual render. Inspect the source before changing it; do not require the user to know IDs.
- Keep geometry and accepted preferences in one maintainable source: a scene/configuration file or clear source constants. Store concise artifact decisions such as transparent background, hidden title, or straight arrows. Do not turn one artifact's choices into universal skill rules.
- Compute connectors from element anchors. Allocate real gutters for labels; increase spacing instead of hiding overlaps behind opaque label rectangles. Straight connectors are a useful default for simple pipelines; preserve curved or orthogonal routing when it communicates the intended relationships.
- Keep text as text in the editable master. Use suitable fonts and a fallback. Outline text only when requested or needed for portable exports, retaining the editable master.

For a simple horizontal pipeline, use the bundled builder:

```bash
python3 scripts/build_diagram.py assets/starter.json --output /absolute/output/diagram
```

Paths above are relative to this skill directory. The builder produces JSON, SVG, and HTML with SVG/PNG download controls. It calculates card sizes, gutters, and connector anchors from the scene. Adapt it or write a tailored renderer for branching, nested panels, unusual references, or other layouts; do not flatten a complex diagram to fit this starter.

## Inspect and refine

1. Render the HTML or SVG with a browser or available vector renderer, then inspect the image. Reading markup alone is not visual verification.
2. Compare it with the reference at full size and likely slide size. Check wording, connections, alignment, visual hierarchy, label clearance, clipping, and recognizable proportions.
3. Fix observed problems and render again. Keep iterations focused on demonstrated issues and the user's request; do not redesign approved regions.
4. Verify the exported asset too: dimensions, transparency, text appearance, and inclusion of all diagram content. A checkerboard preview must never enter the export.
5. If rendering or an export cannot be verified, state that limitation. Do not claim a perfect or pixel-identical reconstruction from a low-resolution reference.

For later edits, read the scene and its decisions, update the authoritative source, and regenerate affected deliverables. Preserve stable IDs and previous accepted choices unless the new request changes them. Keep the working source alongside the exported files.

## Deliver

- Provide standalone HTML and SVG, plus a high-resolution PNG when rendering is available. Otherwise provide working browser PNG export and distinguish it from a PNG file already generated.
- Default the outer canvas to transparent for slide assets. Preserve intentional opaque interiors, cards, and panels. Background color should be an explicit choice.
- Export only artwork, excluding controls, preview backgrounds, debug labels, and selection outlines. Embed necessary SVG styles; do not depend on page CSS or network assets.
- Link the artifacts and briefly say what changed and what was verified. Favor the user's requested format over unnecessary extra deliverables.
