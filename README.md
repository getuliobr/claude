# Skills and agents

Personal collection of reusable skills and agents for coding assistants. Each folder under `skills/` is an independently installable Codex skill, and each file under `agents/` is an independently installable Claude Code subagent.

## Skills

| Skill | Purpose |
| --- | --- |
| [editable-diagrams](skills/editable-diagrams/SKILL.md) | Generate or use a visual reference, rebuild it as named HTML/SVG artwork, inspect the render, and refine through conversation. |

## Agents

| Agent | Purpose |
| --- | --- |
| [relatorio-semanal](agents/relatorio-semanal.md) | Write a short weekly work report from your commits, pull requests and issues on GitHub, in Brazilian Portuguese, with issue numbers as Markdown links. |

### Install an agent

Copy the agent file into your Claude Code agents directory. User-level agents are available in every project:

```bash
mkdir -p ~/.claude/agents
cp agents/relatorio-semanal.md ~/.claude/agents/
```

To share it with a single project instead, copy it into that project's `.claude/agents/`. Start a new Claude Code session, or reload agents with `/agents`, if it does not appear immediately.

### Use relatorio-semanal

Run it from inside the repository you worked on. It needs `git` and an authenticated [GitHub CLI](https://cli.github.com/) (`gh auth status`), and it only reads the repository: it never checks out, stashes or edits anything.

```text
gera meu relatório da semana
```

```text
@relatorio-semanal relatório de 06/04 a 10/04
```

Without a date range it covers Monday of the current week through today. It groups the work by theme instead of by pull request, describes effects rather than code, keeps the technical terms your team already uses untranslated (ledger, webhook, deploy), and does not claim an open issue is in progress unless it finds commits for it. After the report it adds a short note listing what you should check before sending it. If the repository keeps a versioned work journal with an `autor:` field in the frontmatter, it reads your entries for the context behind each issue.

## Install a skill

Copy the desired skill folder into your Codex skills directory:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/editable-diagrams "${CODEX_HOME:-$HOME/.codex}/skills/"
```

If it is already installed, review your local changes before replacing it. Start a new Codex session after installation if the skill does not appear immediately. The skill works with available image-generation and rendering tools; the Python starter itself uses only the standard library.

## Use editable-diagrams

```text
Use $editable-diagrams to generate a concept for a three-stage research
pipeline, then rebuild it as editable HTML/SVG. Keep the background transparent.
```

```text
Use $editable-diagrams to recreate this reference image closely.
Keep the wording exactly as supplied and inspect the exported result.
```

Later edits can use ordinary descriptions:

- “Give the arrow between the first two stages more space.”
- “Remove the title and keep it removed in future exports.”
- “Make the review stage green.”

Stable IDs and saved artifact decisions let the agent locate elements and preserve accepted choices. The working source remains editable; the visual concept is not used as a flattened final image.

## Try the starter

```bash
python3 skills/editable-diagrams/scripts/build_diagram.py \
  skills/editable-diagrams/assets/starter.json \
  --output examples/editable-diagrams/workflow
```

Open `examples/editable-diagrams/workflow.html` in a browser. It contains SVG and 4096px-wide PNG download buttons. The standalone SVG and JSON source are included too.

![Example workflow](examples/editable-diagrams/workflow.svg)

The starter supports horizontal pipelines with forward connections between adjacent nodes. Card text wraps, card heights grow, arrow anchors follow geometry, and gutters expand for labels. It is deliberately small: branching graphs and close reconstruction of complex references need a tailored layout. Font widths are estimated, so visual inspection remains required. SVG text uses Arial with fallbacks; exact metrics can vary by machine. Outlining a separate export is an option when exact font portability is necessary.

`decisions` in each scene records accepted choices; it is descriptive context for the agent, not executable layout configuration. Change the actual scene fields to implement those choices. Preserve IDs when renaming or moving elements. Color accepts six-digit hex codes, and `background` accepts a hex code or `transparent`.

## Develop and verify

```bash
python3 -m unittest discover -s tests -v
```

Tests cover geometry after edits, long labels, text escaping, stable IDs, transparency, invalid connections, and reproducible examples. GitHub Actions runs them on pushes and pull requests. Visual inspection is a separate required part of the skill workflow; these tests do not replace it.

Add future skills under `skills/<skill-name>/` with a `SKILL.md` and only the supporting files they need, and future agents as a single `agents/<agent-name>.md` file whose `name` matches the file name. Keep examples and repository tests outside installable skill folders.

## License

This repository is licensed under the [MIT License](LICENSE).
